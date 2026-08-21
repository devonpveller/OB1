/**
 * openbrain-idea-refinery — the Idea Refinery drain + delivery (IR.1 + IR.2).
 *
 * A cron-triggered nightly batch (NOT an always-on loop) that walks the owed-
 * research queue, researches each owed idea via the existing research service
 * (gently), and delivers the gap-centered dossier to the idea's Mattermost
 * thread. Deliberately thin: the real GPU governance is the research service's
 * FIFO drain + the llm-queue budget; this only bounds how many idea jobs it puts
 * in flight at once (submit-on-complete) and rolls the rest over.
 *
 *   POST /run[?wait=1]  -> start the drain (202 {started}); wait=1 awaits + returns the summary
 *   GET  /health        -> {ok, db}
 *
 * Two passes per run:
 *   1. deliver-pending — ideas researched in a prior run whose Mattermost post
 *      failed/crashed (status 'queued', a job id present): refetch the job +
 *      deliver, so a flaky post never loses the research (P25 durability).
 *   2. research-owed   — the owed set (priority research_now -> fresh -> oldest,
 *      attempts-capped): submit -> poll -> deliver. Coalescing is structural
 *      (only the current revision is researched).
 *
 * Design: documentation/implementation-guide/idea-refinery/DESIGN-idea-refinery.md
 *   §3 (research frame), §3.1 (dossier), §6/§6.2 (batch + throttle), §7 (delivery).
 *
 * Env: DB_*, RESEARCH_URL, MCP_ACCESS_KEY, MATTERMOST_URL, MATTERMOST_TOKEN,
 *      MATTERMOST_SITE_URL, IDEA_REFINERY_CHANNEL, PORT, IDEA_* tunables.
 */
import { Pool } from "postgres";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const num = (k: string, d: number) => {
  const n = parseInt(env(k, String(d)), 10);
  return Number.isFinite(n) ? n : d;
};

const DB_HOST = env("DB_HOST", "openbrain-db");
const DB_PORT = num("DB_PORT", 5432);
const DB_NAME = env("DB_NAME", "openbrain");
const DB_USER = env("DB_USER", "postgres");
const DB_PASSWORD = env("DB_PASSWORD");

const PORT = num("PORT", 8080);
const RESEARCH_URL = env("RESEARCH_URL", "http://openbrain-research:8000").replace(/\/+$/, "");
const MCP_ACCESS_KEY = env("MCP_ACCESS_KEY");
// research_jobs.origin is CHECK-constrained to owui|agent|notebook|manual, so we
// ride the un-attributed `agent` lane and throttle ourselves (below).
const RESEARCH_ORIGIN = env("RESEARCH_ORIGIN", "agent");

// Mattermost delivery (§7). Mattermost runs in the agent-org compose project,
// published on the host at :8065; an OB container reaches it via host.docker.internal.
const MM_URL = env("MATTERMOST_URL", "http://host.docker.internal:8065").replace(/\/+$/, "");
const MM_TOKEN = env("MATTERMOST_TOKEN", "");
const MM_SITE_URL = env("MATTERMOST_SITE_URL", "").replace(/\/+$/, "");
const MM_CHANNEL = env("IDEA_REFINERY_CHANNEL", "#ideas").replace(/^#/, ""); // slug, no '#'
const MM_MAX_CHARS = num("IDEA_MM_MAX_CHARS", 12000);

// Throttle (§6.2). One in-flight job at a time by default: submit, wait for it to
// finish, deliver, submit the next — so we never stampede the shared research
// queue, and whatever doesn't fit the window rolls over to the next cycle.
const RUN_MAX = num("IDEA_RUN_MAX", 25);
const RUN_BUDGET_MS = num("IDEA_RUN_BUDGET_MS", 4 * 60 * 60 * 1000);
const POLL_MS = num("IDEA_POLL_MS", 5000);
const JOB_TIMEOUT_MS = num("IDEA_JOB_TIMEOUT_MS", 2 * 60 * 60 * 1000);
const MAX_ATTEMPTS = num("IDEA_MAX_ATTEMPTS", 3);
const BACKPRESSURE_MS = num("IDEA_BACKPRESSURE_MS", 30000);
const BACKPRESSURE_RETRIES = num("IDEA_BACKPRESSURE_RETRIES", 3);

// IR.5 fizzle/resurface knobs (DT-5): dormancy horizon (days) + resurface cosine
// distance (<=; tighter than the research engine's 0.55 reuse cutoff).
const DORMANCY_DAYS = num("IDEA_DORMANCY_DAYS", 14);
const RESURFACE_MAX_DIST = Number(env("IDEA_RESURFACE_MAX_DIST", "0.40"));

const pool = new Pool(
  { hostname: DB_HOST, port: DB_PORT, database: DB_NAME, user: DB_USER, password: DB_PASSWORD },
  4,
  true,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type OwedIdea = {
  id: string;
  title: string;
  summary: string;
  current_revision: number;
  domain: string;
  thread_root: string | null;
  last_job_id: string | null;
  priority: boolean;
};

type JobResult = { synthesis?: string; cited_sources?: unknown[]; thread_id?: string | null; [k: string]: unknown };

// ── the research frame (§3): gather evidence, do NOT judge worth ────────────────
function ideaQuery(idea: OwedIdea): string {
  return [
    `Gather evidence to help the user decide whether to build this idea for the ${idea.domain}. ` +
    `Do NOT judge whether it is worth building — present the evidence and the gaps only; the value ` +
    `decision is the user's.`,
    `Idea: "${idea.title}" — ${idea.summary}`,
    `Find and cite: (1) existing products or tools in industry that already do this or something ` +
    `adjacent, and for each, its value proposition (the problem it claims to solve and how it ` +
    `positions itself); (2) what prior research already established about this feature, directly or ` +
    `adjacently. Surface where this idea differs from what already exists (gaps in the landscape) as ` +
    `open questions.`,
  ].join("\n\n");
}

// IR.3 — a dirty re-research is seeded with the prior dossier so the model builds on
// what was already found (continuation), focusing on what changed. First research of
// an idea (no prior thread/job) uses the base query unchanged.
async function ideaQuerySeeded(idea: OwedIdea): Promise<string> {
  const base = ideaQuery(idea);
  if (!idea.thread_root || !idea.last_job_id) return base;
  try {
    const jr = await jobResult(idea.last_job_id);
    const prior = jr.status === "done" ? String(jr.result?.synthesis ?? "").trim().slice(0, 2000) : "";
    if (prior) {
      return `${base}\n\nThe user previously explored this idea; prior research found:\n${prior}\n\n` +
        `The idea has since been updated (see it above). Build on the prior findings — focus on what ` +
        `is new or changed, and note anything the prior research missed.`;
    }
  } catch { /* prior unavailable → fall back to the base query */ }
  return base;
}

const OWED_COLS =
  `i.id, i.title, i.summary, i.current_revision, i.domain, i.thread_root, i.last_job_id,
   (i.metadata->>'research_now' = 'true') AS priority`;

// ── the owed-research queue read (§6.2): priority, then fresh, then oldest ───────
async function selectOwed(limit: number): Promise<OwedIdea[]> {
  const c = await pool.connect();
  try {
    const r = await c.queryObject<OwedIdea>(
      `SELECT ${OWED_COLS}
         FROM ideas i
         JOIN idea_revisions rev
           ON rev.idea_id = i.id AND rev.revision = i.current_revision
        WHERE i.status <> 'archived'
          AND COALESCE((i.metadata->>'research_attempts')::int, 0) < $2
          AND (rev.research_job_id IS NULL OR i.metadata->>'research_now' = 'true')
        ORDER BY (i.metadata->>'research_now' = 'true') DESC,
                 (i.status IN ('new','dirty')) DESC,
                 i.created_at ASC
        LIMIT $1`,
      [limit, MAX_ATTEMPTS],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

// Pass 1 (P25 durability): research succeeded but delivery didn't (status still
// 'queued' with a job id) — refetch + deliver so a flaky post never loses work.
async function selectPending(limit: number): Promise<OwedIdea[]> {
  const c = await pool.connect();
  try {
    const r = await c.queryObject<OwedIdea>(
      `SELECT ${OWED_COLS}
         FROM ideas i
        WHERE i.status = 'queued' AND i.last_job_id IS NOT NULL
        ORDER BY i.updated_at ASC
        LIMIT $1`,
      [limit],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

async function markQueued(idea: OwedIdea, jobId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.queryArray(
      `UPDATE idea_revisions SET research_job_id=$3 WHERE idea_id=$1 AND revision=$2`,
      [idea.id, idea.current_revision, jobId],
    );
    await c.queryArray(
      `UPDATE ideas SET status='queued', last_job_id=$2, metadata = metadata - 'research_now' WHERE id=$1`,
      [idea.id, jobId],
    );
  } finally {
    c.release();
  }
}

// On failure: re-owe (clear the stamp) + count the attempt. After MAX_ATTEMPTS the
// selectOwed filter drops it, so a persistently-failing idea stops looping.
async function markFailed(idea: OwedIdea): Promise<void> {
  const c = await pool.connect();
  try {
    await c.queryArray(
      `UPDATE idea_revisions SET research_job_id=NULL WHERE idea_id=$1 AND revision=$2`,
      [idea.id, idea.current_revision],
    );
    await c.queryArray(
      `UPDATE ideas
          SET status='new',
              metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{research_attempts}',
                         to_jsonb(COALESCE((metadata->>'research_attempts')::int,0)+1))
                         - 'research_now'
        WHERE id=$1`,
      [idea.id],
    );
  } finally {
    c.release();
  }
}

async function markDelivered(ideaId: string, threadRoot: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.queryArray(`UPDATE ideas SET status='researched', thread_root=$2 WHERE id=$1`, [ideaId, threadRoot]);
  } finally {
    c.release();
  }
}

// IR.5 fizzle — a researched idea with no engagement for DORMANCY_DAYS goes dormant,
// silently (no nag). Run BEFORE the research passes so ideas delivered THIS run aren't
// immediately aged. Editing an idea (update_idea -> 'dirty') revives it; resurfacing
// (nearDormant) cross-links it into a related new idea's dossier.
async function ageIdeas(): Promise<number> {
  const c = await pool.connect();
  try {
    const r = await c.queryObject<{ id: string }>(
      `UPDATE ideas SET status='dormant', dormant_at=now()
        WHERE status='researched' AND engaged_at IS NULL
          AND updated_at < now() - make_interval(days => $1)
        RETURNING id`,
      [DORMANCY_DAYS],
    );
    return r.rows.length;
  } finally {
    c.release();
  }
}

// IR.5 resurface — dormant ideas semantically near this one, for a "you parked
// something related" cross-link in the NEW idea's dossier (surfaced in the new
// thread, never a cold ping on the old one).
async function nearDormant(ideaId: string): Promise<string[]> {
  const c = await pool.connect();
  try {
    const r = await c.queryObject<{ title: string }>(
      `SELECT title FROM ideas
        WHERE status='dormant' AND id <> $1 AND embedding IS NOT NULL
          AND embedding <=> (SELECT embedding FROM ideas WHERE id=$1) <= $2
        ORDER BY embedding <=> (SELECT embedding FROM ideas WHERE id=$1) ASC
        LIMIT 2`,
      [ideaId, RESURFACE_MAX_DIST],
    );
    return r.rows.map((x) => x.title);
  } catch {
    return [];
  } finally {
    c.release();
  }
}

// ── research service client ─────────────────────────────────────────────────────
class Backpressure extends Error {}

async function submitResearch(query: string): Promise<string> {
  const r = await fetch(`${RESEARCH_URL}/research`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-key": MCP_ACCESS_KEY },
    body: JSON.stringify({ query, origin: RESEARCH_ORIGIN }),
  });
  if (r.status === 429) throw new Backpressure("research queue 429");
  if (!r.ok) throw new Error(`research submit ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const d = await r.json();
  if (!d.job_id) throw new Error("research submit: no job_id in response");
  return String(d.job_id);
}

async function submitWithBackpressure(query: string): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await submitResearch(query);
    } catch (e) {
      if (e instanceof Backpressure && i < BACKPRESSURE_RETRIES) {
        await sleep(BACKPRESSURE_MS);
        continue;
      }
      throw e;
    }
  }
}

async function jobResult(jobId: string): Promise<{ status: string; result?: JobResult; error?: string }> {
  const r = await fetch(`${RESEARCH_URL}/research/jobs/${jobId}`, { headers: { "x-brain-key": MCP_ACCESS_KEY } });
  if (!r.ok) return { status: "unknown" };
  const j = await r.json();
  return { status: j.status, result: j.result, error: j.error };
}

async function pollJob(jobId: string): Promise<{ ok: boolean; result?: JobResult; error?: string }> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const jr = await jobResult(jobId);
      if (jr.status === "done") return { ok: true, result: jr.result ?? {} };
      if (jr.status === "error" || jr.status === "cancelled") return { ok: false, error: jr.error || jr.status };
    } catch { /* transient; poll again */ }
    await sleep(POLL_MS);
  }
  return { ok: false, error: "poll timeout" };
}

// ── Mattermost REST v4 (mirrors agent-bridge MattermostAdapter) ─────────────────
let _mmTeamId: string | null = null;
let _mmTeamName: string | null = null;
const _chanCache = new Map<string, string>();
const mmHeaders = () => ({ Authorization: `Bearer ${MM_TOKEN}`, "content-type": "application/json" });

async function mmTeam(): Promise<string> {
  if (_mmTeamId) return _mmTeamId;
  const r = await fetch(`${MM_URL}/api/v4/users/me/teams`, { headers: mmHeaders() });
  if (!r.ok) throw new Error(`mm teams ${r.status}`);
  const teams = await r.json();
  if (!Array.isArray(teams) || !teams.length) {
    throw new Error("the idea-refinery bot is not on any Mattermost TEAM yet — add it to your team");
  }
  const id = String(teams[0].id);
  _mmTeamId = id;
  _mmTeamName = teams[0].name ?? "";
  return id;
}

async function ensureChannel(name: string): Promise<string> {
  const cached = _chanCache.get(name);
  if (cached) return cached;
  const teamId = await mmTeam();
  let r = await fetch(`${MM_URL}/api/v4/teams/${teamId}/channels/name/${name}`, { headers: mmHeaders() });
  if (r.ok) { const c = await r.json(); _chanCache.set(name, c.id); return c.id; }
  r = await fetch(`${MM_URL}/api/v4/channels`, {
    method: "POST",
    headers: mmHeaders(),
    body: JSON.stringify({
      team_id: teamId, name,
      display_name: name.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
      type: "O",
    }),
  });
  if (!r.ok) throw new Error(`mm ensureChannel ${name} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 150)}`);
  const c = await r.json();
  _chanCache.set(name, c.id);
  return c.id;
}

async function mmPost(channelId: string, message: string, rootId: string | null): Promise<{ id: string }> {
  const body: Record<string, unknown> = { channel_id: channelId, message: message.slice(0, MM_MAX_CHARS) };
  if (rootId) body.root_id = rootId;
  const r = await fetch(`${MM_URL}/api/v4/posts`, { method: "POST", headers: mmHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`mm post ${r.status}: ${(await r.text().catch(() => "")).slice(0, 150)}`);
  return await r.json();
}

function permalink(postId: string): string | null {
  if (!MM_SITE_URL || !_mmTeamName || !postId) return null;
  return `${MM_SITE_URL}/${_mmTeamName}/pl/${postId}`;
}

// ── the gap-centered dossier (§3.1) ─────────────────────────────────────────────
function renderDossier(idea: OwedIdea, result: JobResult, isUpdate: boolean, related: string[] = []): string {
  const synthesis = String(result.synthesis ?? "").trim() || "_(the research returned no synthesis)_";
  const sources = Array.isArray(result.cited_sources) ? result.cited_sources as Array<Record<string, unknown>> : [];
  const srcLines = sources.slice(0, 8).map((s, i) => {
    const title = String(s.title ?? s.url ?? `source ${i + 1}`);
    return `${i + 1}. ${title}${s.url ? ` — ${s.url}` : ""}`;
  });
  const head = isUpdate
    ? `↻ **Updated: ${idea.title}** — you changed this idea; here's fresh research.`
    : `💡 **${idea.title}**\n\n${idea.summary}`;
  const parts = [head, `**The landscape + what we already know**\n\n${synthesis}`];
  if (srcLines.length) parts.push(`**Sources**\n${srcLines.join("\n")}`);
  if (related.length) parts.push(`🔗 _This connects to ideas you parked earlier: ${related.join(", ")}. Worth revisiting?_`);
  parts.push(`_The value call is yours. What would you want to explore? Reply here to hone this idea._`);
  return parts.join("\n\n");
}

// Deliver the dossier to the idea's thread (create the root on first research, or
// append an UPDATE on a dirty re-research). Sets thread_root + status on success.
async function deliverForIdea(idea: OwedIdea, result: JobResult): Promise<void> {
  const isUpdate = !!idea.thread_root;
  const channelId = await ensureChannel(MM_CHANNEL);
  const related = isUpdate ? [] : await nearDormant(idea.id); // resurface only on a new idea's first dossier
  const msg = renderDossier(idea, result, isUpdate, related);
  let rootId = idea.thread_root;
  if (isUpdate) {
    await mmPost(channelId, msg, rootId);
  } else {
    const post = await mmPost(channelId, msg, null);
    rootId = post.id;
  }
  await markDelivered(idea.id, rootId!);
  const link = permalink(rootId!);
  console.log(`delivered idea ${idea.id} ("${idea.title}") -> thread ${rootId}${link ? " " + link : ""}`);
}

// ── the drain ───────────────────────────────────────────────────────────────────
type Summary = {
  selected: number; processed: number; succeeded: number; failed: number;
  delivered_pending: number; dormant: number; budget_hit: boolean; backpressure: boolean;
};

async function deliverPending(): Promise<number> {
  let delivered = 0;
  for (const idea of await selectPending(RUN_MAX)) {
    const jr = await jobResult(idea.last_job_id!);
    if (jr.status === "done") {
      try { await deliverForIdea(idea, jr.result ?? {}); delivered++; }
      catch (e) { console.error(`redeliver failed for ${idea.id}: ${(e as Error).message}`); }
    } else if (jr.status === "error" || jr.status === "cancelled") {
      await markFailed(idea);
    } // running/unknown → leave for next run
  }
  return delivered;
}

async function runDrain(): Promise<Summary> {
  const started = Date.now();
  const dormant = await ageIdeas();          // IR.5: fizzle BEFORE research, so fresh work isn't aged
  const delivered_pending = await deliverPending();
  const selected = await selectOwed(RUN_MAX);
  const s: Summary = {
    selected: selected.length, processed: 0, succeeded: 0, failed: 0,
    delivered_pending, dormant, budget_hit: false, backpressure: false,
  };
  for (const idea of selected) {
    if (Date.now() - started > RUN_BUDGET_MS) { s.budget_hit = true; break; }
    let jobId: string;
    try {
      jobId = await submitWithBackpressure(await ideaQuerySeeded(idea));
    } catch (e) {
      if (e instanceof Backpressure) { s.backpressure = true; break; }
      console.error(`submit failed for ${idea.id}: ${(e as Error).message}`);
      await markFailed(idea); s.failed++; s.processed++; continue;
    }
    await markQueued(idea, jobId);
    const res = await pollJob(jobId);
    if (res.ok) {
      try { await deliverForIdea(idea, res.result ?? {}); s.succeeded++; }
      catch (e) { console.error(`deliver failed for ${idea.id}: ${(e as Error).message}`); } // stays 'queued' → pass 1 retries
    } else {
      console.error(`research failed for ${idea.id}: ${res.error}`);
      await markFailed(idea); s.failed++;
    }
    s.processed++;
  }
  console.log(`drain complete: ${JSON.stringify(s)}`);
  return s;
}

// Single-flight: a second /run while a drain is in progress is a no-op.
let draining = false;
async function handleRun(wait: boolean): Promise<Record<string, unknown>> {
  if (draining) return { already_running: true };
  draining = true;
  const p = runDrain().finally(() => { draining = false; });
  if (wait) return await p as unknown as Record<string, unknown>;
  p.catch((e) => console.error(`drain error: ${(e as Error).message}`));
  return { started: true };
}

// ── Grounded brainstorm (§7.2) — a LOCAL research consultant, nothing leaves the box ──
// An operator reply under a dossier in #ideas is honed by the LOCAL model (qwen via the
// llm-gateway) with the SAME Open Brain MCP tooling OWUI has (Option A) — but every reply is
// GROUNDED: force search_claims first (Gate A), draft from cited evidence only, then a validation
// pass strips any line not supported by the evidence it cites (Gate B); if nothing grounds the
// answer, that's a GAP → research (never answer from model memory). No cloud model, no cloud MCP.
const CHAT_API_BASE = env("CHAT_API_BASE", "http://llama-cpp:8080/v1").replace(/\/+$/, "");
// :nothink — a direct reply. The thinking variant emits ~700 reasoning tokens first, which risk
// eating max_tokens and leaving `content` empty → a silent non-reply. :nothink is fast + robust.
const CHAT_MODEL = env("CHAT_MODEL", "qwen36-27b:nothink");
const CHAT_API_KEY = env("CHAT_API_KEY", "not-needed");
const BRAINSTORM_ON = env("IDEA_BRAINSTORM", "1") !== "0" && !!MM_TOKEN;
const BRAINSTORM_POLL_MS = num("IDEA_BRAINSTORM_POLL_MS", 4000);
const BRAINSTORM_MAX_TOKENS = num("IDEA_BRAINSTORM_MAX_TOKENS", 1200);
const OPERATORS = new Set(
  env("IDEA_BRAINSTORM_OPERATORS", "profnovice").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

// MCP client to openbrain-mcp (OWUI parity: the same core tools OWUI reaches). search_claims is
// always forced (Gate A). TOOL_MODE: "read" = grounding/read set (default, no writes), "all" = every
// core tool, or a CSV of explicit tool names.
const MCP_URL = env("OPENBRAIN_MCP_URL", "http://openbrain-mcp:8000").replace(/\/+$/, "");
const TOOL_MODE = env("IDEA_BRAINSTORM_TOOLS", "read");
const READ_TOOLS = new Set(["search_claims", "search", "fetch", "search_thoughts", "list_thoughts", "find_idea", "get_thread_sources", "thought_stats"]);
const MAX_TOOL_ITERS = num("IDEA_BRAINSTORM_TOOL_ITERS", 2); // extra tool-gathering rounds after the forced seed
const EV_CAP = num("IDEA_BRAINSTORM_EV_CAP", 18);            // bound the evidence pool so validation stays reliable
const VAL_BATCH = num("IDEA_BRAINSTORM_VAL_BATCH", 6);       // validate lines in small batches (each vs only its cited evidence)
const CLAIM_SEARCH_LIMIT = num("IDEA_CLAIM_SEARCH_LIMIT", 8);

const GATHER_SYSTEM =
  "You are gathering GROUNDING for an Idea Refinery discussion. Use the Open Brain tools (search_claims is primary) " +
  "to collect claims/sources relevant to the user's latest message. Make focused tool calls; stop when you have enough. Do not answer yet.";
const GROUNDED_SYSTEM = [
  "You are the Idea Refinery's research consultant in a Mattermost thread, running on the user's LOCAL model.",
  "You hone a captured idea by GROUNDING every statement in the numbered EVIDENCE (researched claims/sources) — never your own memory.",
  "You are unbiased and fact-driven: you do NOT flatter the idea or continue the user's assumptions; you report what the evidence supports and name what it does not.",
  "Answer the user's SPECIFIC question focusedly in 3-8 NUMBERED lines (not a knowledge dump). One assertion per line, each ending with the evidence id(s) it rests on: `1. <assertion> [E2]`.",
  "Assert ONLY what a cited item states; invent nothing; cite the FEWEST ids that actually support the line.",
  "If the question is not answered by any evidence, write `GAP: <what needs research>` (no citation).",
].join("\n");
const VALIDATION_SYSTEM =
  "You are a strict fact-checker. For EACH line you are given the line and ONLY the evidence it cites. Decide if the line is SUPPORTED by " +
  "that evidence — using ONLY what the evidence states (no outside knowledge). Overstatement or an added detail the evidence does not state = " +
  'not supported. Reply ONLY as JSON: {"lines":[{"id":"1","supported":true|false},...]} covering every line id given.';
const GAP_QUERY_SYSTEM =
  'The user asked something our grounded claims do not yet cover. Phrase ONE focused research question that would fill the gap. Reply ONLY as JSON: {"gap_query":"..."}.';

let _botId = "";
const _userNames = new Map<string, string>();

// deno-lint-ignore no-explicit-any
async function mmGet(path: string): Promise<any> {
  const r = await fetch(`${MM_URL}/api/v4${path}`, { headers: mmHeaders() });
  if (!r.ok) throw new Error(`mm GET ${path} ${r.status}`);
  return await r.json();
}

async function botId(): Promise<string> {
  if (_botId) return _botId;
  const me = await mmGet("/users/me");
  _botId = String(me.id);
  return _botId;
}

async function userName(id: string): Promise<string> {
  const c = _userNames.get(id);
  if (c !== undefined) return c;
  try {
    const u = await mmGet(`/users/${id}`);
    const n = String(u.username ?? "").toLowerCase();
    _userNames.set(id, n);
    return n;
  } catch { return ""; }
}

// A chat completion (optionally tool-enabled). Returns the raw first choice.message.
// deno-lint-ignore no-explicit-any
async function chatRaw(messages: any[], opts: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CHAT_API_KEY}` },
    body: JSON.stringify({ model: CHAT_MODEL, messages, max_tokens: BRAINSTORM_MAX_TOKENS, user: "idea-brainstorm", ...opts }),
  });
  if (!r.ok) throw new Error(`local chat ${r.status}: ${(await r.text().catch(() => "")).slice(0, 150)}`);
  const d = await r.json();
  return d.choices?.[0]?.message ?? {};
}
// A JSON-mode chat that returns a parsed object (validation + gap-query). Empty/parse-fail -> {}.
// deno-lint-ignore no-explicit-any
async function chatJson(messages: any[]): Promise<any> {
  const m = await chatRaw(messages, { temperature: 0, response_format: { type: "json_object" }, max_tokens: 600 });
  try { return JSON.parse(String(m.content ?? "").trim()); } catch { return {}; }
}

// ── MCP client to openbrain-mcp (streamable-HTTP JSON-RPC; ported from tools/…/promote.py) ──
let _mcpSid: string | null = null;
// deno-lint-ignore no-explicit-any
let _mcpTools: any[] | null = null;
// deno-lint-ignore no-explicit-any
async function mcpRpc(method: string, params: unknown, notif = false): Promise<any> {
  const payload: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (!notif) payload.id = 1;
  const h: Record<string, string> = { "x-brain-key": MCP_ACCESS_KEY, "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (_mcpSid) h["mcp-session-id"] = _mcpSid;
  const r = await fetch(MCP_URL, { method: "POST", headers: h, body: JSON.stringify(payload) });
  const sid = r.headers.get("mcp-session-id");
  if (sid) _mcpSid = sid;
  if (notif) { await r.body?.cancel(); return null; }
  const ct = r.headers.get("content-type") ?? "";
  const raw = await r.text();
  if (ct.includes("text/event-stream")) {
    let obj = null;
    for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) obj = JSON.parse(line.slice(5).trim());
    return obj;
  }
  return raw.trim() ? JSON.parse(raw) : null;
}
// Handshake once + fetch the OpenAI-format tool specs qwen may call (allowlist-filtered).
// deno-lint-ignore no-explicit-any
async function mcpTools(): Promise<any[]> {
  if (_mcpTools) return _mcpTools;
  await mcpRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "idea-refinery", version: "1" } });
  try { await mcpRpc("notifications/initialized", {}, true); } catch { /* */ }
  const tl = await mcpRpc("tools/list", {});
  // deno-lint-ignore no-explicit-any
  const all = (tl?.result?.tools ?? []) as any[];
  // deno-lint-ignore no-explicit-any
  const allow = (t: any) => TOOL_MODE === "all" ? true
    : TOOL_MODE === "read" ? READ_TOOLS.has(t.name)
    : TOOL_MODE.split(",").map((s) => s.trim()).includes(t.name);
  _mcpTools = all.filter(allow).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: "object", properties: {} } },
  }));
  return _mcpTools;
}
async function mcpCall(name: string, args: unknown): Promise<string> {
  const resp = await mcpRpc("tools/call", { name, arguments: args });
  if (!resp) return "(no response)";
  if (resp.error) return `(tool error: ${JSON.stringify(resp.error).slice(0, 200)})`;
  const res = resp.result ?? resp;
  for (const c of (res.content ?? [])) if (c.type === "text") return String(c.text ?? "");
  return "(no text content)";
}

// ── evidence registry: search_claims text -> discrete items; other tools -> one item each ──
function toEvidence(tool: string, text: string, start: number): { id: string; text: string }[] {
  const items: { id: string; text: string }[] = [];
  const t = (text ?? "").trim();
  if (!t || /^No grounded claims found/i.test(t) || /^\(no /.test(t) || /^\(tool error/i.test(t)) return items;
  if (tool === "search_claims") {
    const blocks = t.split(/\n(?=--- Claim )/).map((b) => b.trim()).filter((b) => b.startsWith("--- Claim"));
    for (const b of blocks) items.push({ id: `E${start + items.length + 1}`, text: b });
    if (!blocks.length) items.push({ id: `E${start + 1}`, text: t.slice(0, 1200) });
  } else items.push({ id: `E${start + 1}`, text: `[${tool}] ${t.slice(0, 1200)}` });
  return items;
}
// deno-lint-ignore no-explicit-any
function addEv(ev: any[], tool: string, text: string) {
  for (const it of toEvidence(tool, text, ev.length)) { if (ev.length >= EV_CAP) break; if (!ev.some((x) => x.text === it.text)) ev.push(it); }
}
function citedIds(line: string): string[] { return [...new Set([...line.matchAll(/E(\d+)/g)].map((m) => `E${m[1]}`))]; }

// Gate B — validate lines in small batches, each against ONLY its cited evidence (retry once on parse fail).
// A line with no citation, or one the model does not confirm, is dropped. Fail-closed per batch.
async function validateLines(numbered: { id: string; text: string }[], evById: Map<string, string>): Promise<Set<string>> {
  const ok = new Set<string>();
  for (let i = 0; i < numbered.length; i += VAL_BATCH) {
    const batch = numbered.slice(i, i + VAL_BATCH);
    const payload = batch.map((l) => {
      const ids = citedIds(l.text);
      const ev = ids.map((id) => `  ${id}: ${evById.get(id) ?? "(missing)"}`).join("\n") || "  (no evidence cited)";
      return `LINE ${l.id}: ${l.text}\nCITED EVIDENCE:\n${ev}`;
    }).join("\n\n---\n\n");
    let verdict = new Map<string, boolean>();
    for (let attempt = 0; attempt < 2 && !verdict.size; attempt++) {
      const v = await chatJson([{ role: "system", content: VALIDATION_SYSTEM }, { role: "user", content: payload }]);
      // deno-lint-ignore no-explicit-any
      verdict = new Map((v.lines ?? []).map((x: any) => [String(x.id), x.supported !== false]));
    }
    for (const l of batch) if (citedIds(l.text).length && verdict.get(l.id) === true) ok.add(l.id);
  }
  return ok;
}

// A short human-readable label for an evidence item (the source it is grounded in).
function evLabel(text: string): string {
  const m = text.match(/Grounded in:\s*(.+)$/m);
  if (m) return m[1].replace(/\s*\(https?:[^)]*\)/g, "").slice(0, 100).trim();
  const t = text.match(/^\[(\w+)\]/);
  return t ? `${t[1]} result` : "claim";
}

// The grounded enforcement loop (§7.2.2). 0 bind+load -> 1 RETRIEVE (Gate A: force search_claims)
// -> 2 tool loop (OWUI parity) -> 3 draft from evidence -> 4 VALIDATE (Gate B: strip unsupported)
// -> 5 post the grounded synthesis, or collapse to a research GAP. Never answers from model memory.
// deno-lint-ignore no-explicit-any
async function brainstormReply(channelId: string, threadRoot: string, bid: string): Promise<void> {
  // 0 · bind + load — dossier root = context; operator posts = user, our posts = assistant.
  const th = await mmGet(`/posts/${threadRoot}/thread`);
  const order: string[] = th.order ?? [];
  const posts = th.posts ?? {};
  // deno-lint-ignore no-explicit-any
  const ordered = order.map((id) => posts[id]).filter(Boolean).sort((a: any, b: any) => (a.create_at ?? 0) - (b.create_at ?? 0));
  if (!ordered.length) return;
  const dossier = String(ordered[0].message ?? "").slice(0, 6000);
  // deno-lint-ignore no-explicit-any
  const turns: any[] = [];
  for (const p of ordered.slice(1)) {
    if (p.type) continue;
    const content = String(p.message ?? "").trim();
    if (content) turns.push({ role: p.user_id === bid ? "assistant" : "user", content });
  }
  const recent = turns.slice(-10);
  // deno-lint-ignore no-explicit-any
  const lastUser = [...recent].reverse().find((t: any) => t.role === "user");
  if (!lastUser) return;

  // 1 · RETRIEVE — Gate A: force search_claims before any prose.
  // deno-lint-ignore no-explicit-any
  const evidence: any[] = [];
  const tools = await mcpTools();
  const seed = await mcpCall("search_claims", { query: lastUser.content, limit: CLAIM_SEARCH_LIMIT, min_confidence: 0 });
  addEv(evidence, "search_claims", seed);

  // 2 · gather (OWUI parity) — qwen may call more tools for additional grounding.
  // deno-lint-ignore no-explicit-any
  const gather: any[] = [
    { role: "system", content: `${GATHER_SYSTEM}\n\nIDEA:\n${dossier}` },
    ...recent,
    { role: "system", content: `Initial claim search results:\n${seed.slice(0, 2500)}\nGather ADDITIONAL grounding via tools if useful, else stop.` },
  ];
  for (let i = 0; i < MAX_TOOL_ITERS; i++) {
    const m = await chatRaw(gather, { tools, tool_choice: "auto", temperature: 0.2, max_tokens: 400 });
    const calls = m.tool_calls ?? [];
    if (!calls.length) break;
    gather.push({ role: "assistant", content: m.content ?? "", tool_calls: calls });
    for (const tc of calls) {
      // deno-lint-ignore no-explicit-any
      let args: any = {};
      try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* */ }
      const out = await mcpCall(tc.function?.name ?? "", args);
      addEv(evidence, tc.function?.name ?? "", out);
      gather.push({ role: "tool", tool_call_id: tc.id, content: out.slice(0, 3000) });
    }
  }

  // If nothing grounds it, don't draft — go straight to the gap.
  if (evidence.length) {
    // 3 · DRAFT — grounded numbered lines, cite by evidence id.
    const evText = evidence.map((e) => `${e.id}: ${e.text}`).join("\n\n");
    const dm = await chatRaw([
      { role: "system", content: `${GROUNDED_SYSTEM}\n\n--- IDEA DOSSIER (context) ---\n${dossier}\n--- END DOSSIER ---` },
      ...recent,
      { role: "user", content: `EVIDENCE (cite by id):\n${evText}\n\nUsing ONLY this evidence, answer my last message as grounded numbered lines; mark anything unsupported as a GAP line.` },
    ], { temperature: 0.2 });
    const draft = String(dm.content ?? "").trim();

    // 4 · VALIDATE — Gate B: strip any line not supported by the evidence it cites.
    const evById = new Map<string, string>(evidence.map((e) => [e.id, e.text]));
    const lines = draft.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const numbered = lines.filter((l) => /^\d+[.)]/.test(l)).map((l, i) => ({ id: String(i + 1), text: l.replace(/^\d+[.)]\s*/, "") }));
    const gapLines = lines.filter((l) => /^GAP:/i.test(l)).map((l) => l.replace(/^GAP:\s*/i, "").trim());
    const okIds = numbered.length ? await validateLines(numbered, evById) : new Set<string>();
    const survivors = numbered.filter((l) => okIds.has(l.id));

    // 5 · OUTCOME — post the grounded synthesis with visible provenance.
    if (survivors.length) {
      const used = new Set<string>();
      for (const s of survivors) for (const id of citedIds(s.text)) used.add(id);
      const key = [...used].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        .map((id) => `${id} — ${evLabel(evById.get(id) ?? "")}`).join("\n");
      const body = survivors.map((s) => `• ${s.text}`).join("\n");
      const tail = gapLines.length ? `\n\n_Open (needs research): ${gapLines.join("; ")}_` : "";
      await mmPost(channelId, `${body}${tail}\n\n**Grounded in:**\n${key}\n\n_Every point above is checked against a researched claim. Reply to keep honing._`, threadRoot);
      return;
    }
  }

  // GAP — nothing grounded survived: open research on the specific gap (never answer from memory).
  const gq = await chatJson([{ role: "system", content: GAP_QUERY_SYSTEM }, { role: "user", content: `IDEA:\n${dossier.slice(0, 1500)}\n\nUSER ASKED:\n${lastUser.content}` }]);
  const gapQuery = String(gq.gap_query ?? "").trim() || lastUser.content;
  await mmPost(channelId, `🔎 No grounded claims cover that yet — I won't answer from guesswork. I've started research on:\n> ${gapQuery}\n\nI'll follow up in this thread when it lands, then we can hone it on solid ground.`, threadRoot);
  gapResearch(channelId, threadRoot, gapQuery).catch((e) => console.error(`gap research failed (${threadRoot.slice(0, 8)}): ${(e as Error).message}`));
}

// Detached: run the LOCAL research engine on a gap, then post the synthesis back to the thread.
// The research curator persists new claims, so subsequent turns in this thread can ground on them.
async function gapResearch(channelId: string, threadRoot: string, query: string): Promise<void> {
  const jobId = await submitWithBackpressure(query);
  const jr = await pollJob(jobId);
  if (!jr.ok) { await mmPost(channelId, `⚠ Research on that gap didn't complete (${jr.error ?? "unknown"}). Try again or rephrase.`, threadRoot); return; }
  const synthesis = String(jr.result?.synthesis ?? "").trim() || "_(the research returned no synthesis)_";
  // deno-lint-ignore no-explicit-any
  const sources = Array.isArray(jr.result?.cited_sources) ? jr.result!.cited_sources as any[] : [];
  const srcLines = sources.slice(0, 6).map((s, i) => `${i + 1}. ${String(s.title ?? s.url ?? "source")}${s.url ? ` — ${s.url}` : ""}`);
  const parts = [`🔬 **Research landed on that gap** — now grounded, so we can keep honing:`, synthesis];
  if (srcLines.length) parts.push(`**Sources**\n${srcLines.join("\n")}`);
  await mmPost(channelId, parts.join("\n\n"), threadRoot);
}

// The brainstorm poll loop: watch #ideas for operator replies under a dossier + respond LOCALLY.
async function brainstormLoop(): Promise<void> {
  let bid: string;
  let channelId: string;
  try {
    bid = await botId();
    channelId = await ensureChannel(MM_CHANNEL);
  } catch (e) {
    console.error(`brainstorm: cannot start (${(e as Error).message}); retrying in 60s`);
    setTimeout(brainstormLoop, 60000);
    return;
  }
  console.log(`brainstorm loop live on #${MM_CHANNEL} (LOCAL model ${CHAT_MODEL} @ ${CHAT_API_BASE})`);
  let since = Date.now();
  const seen = new Set<string>();
  while (true) {
    try {
      const d = await mmGet(`/channels/${channelId}/posts?since=${since}`);
      const arr = Object.values(d.posts ?? {}).sort((a: any, b: any) => (a.create_at ?? 0) - (b.create_at ?? 0));
      for (const p of arr as any[]) {
        since = Math.max(since, p.create_at ?? 0);
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        if (p.type) continue;                        // system posts
        if (p.user_id === bid) continue;             // our own (dossiers + brainstorm replies)
        const props = p.props ?? {};
        if (props.from_bridge || props.from_claude || props.from_webhook) continue;
        if (!p.root_id) continue;                    // only an operator REPLY under a dossier
        const uname = await userName(p.user_id);
        if (OPERATORS.size && !OPERATORS.has(uname)) continue;
        try { await brainstormReply(channelId, p.root_id, bid); }
        catch (e) { console.error(`brainstorm reply failed (${String(p.root_id).slice(0, 8)}): ${(e as Error).message}`); }
      }
      if (seen.size > 2000) seen.clear(); // `since` already guards re-processing
    } catch (e) {
      console.error(`brainstorm poll error: ${(e as Error).message}`);
    }
    await sleep(BRAINSTORM_POLL_MS);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────────
Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    let db = false;
    try { const c = await pool.connect(); try { await c.queryArray("SELECT 1"); db = true; } finally { c.release(); } } catch { /* */ }
    return Response.json({ ok: db, db, service: "openbrain-idea-refinery" }, { status: db ? 200 : 503 });
  }
  if (req.method === "POST" && url.pathname === "/run") {
    try {
      return Response.json(await handleRun(url.searchParams.get("wait") === "1"));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }
  return new Response("not found", { status: 404 });
});

console.log(`openbrain-idea-refinery listening on :${PORT} (research=${RESEARCH_URL}, mm=${MM_URL})`);

// IR.4/IR.6 — the LOCAL brainstorm loop (fire-and-forget; retries its own startup).
if (BRAINSTORM_ON) brainstormLoop();
else console.log("brainstorm loop OFF (no Mattermost token or IDEA_BRAINSTORM=0)");
