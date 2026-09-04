/**
 * Research-package ingestion inlet — Open Brain curator (research-inlet plan).
 *
 * The single front door for deep-research output. deep_research finishes, builds
 * a "package" (synthesis + sources + topic hint) and POSTs it here instead of
 * straight to /research/persist. This service owns the HOUSEKEEPING DECISION —
 * which thread the research belongs to — so the research model never has to, and
 * so OB1 stops fragmenting into one thread per run.
 *
 * Flow (see PLAN-research-inlet-service.md §3):
 *   POST /ingest/research-package
 *     1. embed the synthesis claim (bge-m3, 1024)
 *     2. Stage 1 — shortlist top-K threads by pgvector cosine (threads.embedding)
 *     3. Stage 2 — LLM decides: attach to an existing thread, or create a new one
 *        (conservative-merge bias; explicit thread_id bypasses the resolver)
 *     4. ensure the thread exists (create when decision=new)
 *     5. delegate the WRITE to the existing /research/persist with the resolved
 *        thread_id injected (reuses find_or_create_source / sessions / supersede)
 *     6. refresh the thread's description + embedding so matching improves (§3.5)
 *
 * Persistence is NOT reimplemented here — the curator adds intelligence and
 * delegates the proven write (§3.3). Resolution never hard-fails an ingest: a
 * down LLM falls back to the Stage-1 top candidate or a cold-start new thread.
 *
 * Talks to Postgres DIRECTLY via deno-postgres (like the MCP server and the
 * suggestion worker) so the pgvector distance operator stays server-side.
 *
 * Routes:
 *   GET  /health                  -> {ok, db}                (unauthenticated)
 *   POST /ingest/research-package -> resolve + persist + refresh  (x-brain-key)
 *
 * Env: DB_HOST/PORT/NAME/USER/PASSWORD, EMBEDDING_API_BASE/KEY/MODEL,
 *      CHAT_API_BASE/KEY/MODEL, MCP_ACCESS_KEY (== WORKBENCH/brain key),
 *      PERSIST_URL (default http://openbrain-mcp:8000), SHORTLIST_K (5),
 *      NEW_THREAD_MIN_CONFIDENCE (0.60), MERGE_FLOOR_DISTANCE (0.45), PORT (8000).
 */
import { Pool } from "postgres";
import { writeClaims, detectConflicts, parseSynthesisClaims, type WriteClaimsResult, type ConflictVerdict } from "./claims.ts";
import { ResilientPool } from "./pool.ts";

// --- Config -----------------------------------------------------------------
const DB_HOST = Deno.env.get("DB_HOST") || "openbrain-db";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "postgres";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") || "";

const EMBEDDING_API_BASE = (Deno.env.get("EMBEDDING_API_BASE") || "http://llama-cpp-embed:8080/v1").replace(/\/+$/, "");
const EMBEDDING_API_KEY = Deno.env.get("EMBEDDING_API_KEY") || "not-needed";
const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") || "bge-m3";
const EMBEDDING_MAX_CHARS = parseInt(Deno.env.get("EMBEDDING_MAX_CHARS") || "4000", 10);

const CHAT_API_BASE = (Deno.env.get("CHAT_API_BASE") || "http://llama-cpp:8080/v1").replace(/\/+$/, "");
const CHAT_API_KEY = Deno.env.get("CHAT_API_KEY") || "not-needed";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") || "qwen36-27b:nothink";

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";
const PERSIST_URL = (Deno.env.get("PERSIST_URL") || "http://openbrain-mcp:8000").replace(/\/+$/, "");

const SHORTLIST_K = parseInt(Deno.env.get("SHORTLIST_K") || "5", 10);
// Below this confidence the resolver will NOT mint a new thread when a candidate
// exists — it attaches to the top candidate instead (conservative-merge bias).
const NEW_THREAD_MIN_CONFIDENCE = parseFloat(Deno.env.get("NEW_THREAD_MIN_CONFIDENCE") || "0.60");
// Cosine-distance floor used only on the LLM-down fallback: if the top candidate
// is at least this close, attach to it; otherwise cold-start a new thread.
const MERGE_FLOOR_DISTANCE = parseFloat(Deno.env.get("MERGE_FLOOR_DISTANCE") || "0.45");
// Conflict detection (#2): a new claim within this cosine distance of an existing
// thread claim (different synthesis) is judged for contradiction.
const CONFLICT_DISTANCE = parseFloat(Deno.env.get("CONFLICT_DISTANCE") || "0.25");
const PORT = parseInt(Deno.env.get("PORT") || "8000", 10);

// A plain `new Pool(...)` here is what cost 244 research runs their entire
// output between 2026-06-19 and 2026-08-31: deno-postgres hands out a pooled
// connection without checking the socket, so the first query after the database
// restarted died with `Broken pipe (os error 32)` and took the whole package
// with it. ResilientPool (pool.ts) probes every checkout and rebuilds on a
// connection-class failure — same contract, so no call site below changes.
const DB_CONFIG = {
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
};
const POOL_SIZE = 8;
type PgClient = Awaited<ReturnType<Pool["connect"]>>;
const pool = new ResilientPool<PgClient>(() => new Pool(DB_CONFIG, POOL_SIZE, true));

// --- Types ------------------------------------------------------------------
interface Pkg {
  research_key?: string;
  query?: string;
  claim?: string; // short standalone summary (required) — used for the resolver embedding
  synthesis?: string; // the FULL detailed research result (tagged claims) — stored as source content
  prose?: string; // human-readable rendering of the synthesis → sources.metadata.prose_synthesis
  report_type?: string; // report template id → sources.metadata.report_type (wiki rendering hint)
  needs?: string[]; // decomposed sub-questions → sources.metadata.needs (breadcrumbs)
  followup_queries?: string[]; // refined/deepen queries → sources.metadata.followup_queries
  kind?: string;
  volatility?: string;
  revalidate_days?: number;
  topic_hint?: string; // was `notebook`; now a hint to the resolver only
  notebook?: string; // back-compat alias for topic_hint
  thread_id?: string; // explicit override -> bypass the resolver
  model?: string;
  sources?: Array<{ url?: string; title?: string; content?: string; summary?: string; domain?: string }>;
}

interface Candidate {
  thread_id: string;
  name: string;
  description: string | null;
  distance: number;
}

interface Decision {
  decision: "existing" | "new";
  thread_id?: string;
  confidence: number;
  new_thread_name?: string;
  new_thread_description?: string;
  reason?: string;
}

// --- LLM / embedding helpers ------------------------------------------------

/** Embed text; halves the input on a physical-batch overflow and retries. */
async function embed(text: string): Promise<number[]> {
  let input = String(text || "").slice(0, EMBEDDING_MAX_CHARS);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
    });
    if (r.ok) {
      const v = (await r.json())?.data?.[0]?.embedding;
      if (!Array.isArray(v)) throw new Error("embedding endpoint returned no vector");
      return v;
    }
    const body = (await r.text()).slice(0, 300);
    if (r.status === 500 && /too large|batch size|n_tokens|exceed/i.test(body) && input.length > 200) {
      input = input.slice(0, Math.floor(input.length / 2));
      continue;
    }
    throw new Error(`embedding ${r.status}: ${body}`);
  }
  throw new Error("embedding failed: input still too large after shrinking");
}

const toVector = (v: number[]): string => `[${v.join(",")}]`;

/** Chat completion that must return a JSON object; returns the parsed object. */
async function chatJson(system: string, user: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CHAT_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const text = d?.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(text);
}

// --- Stage 1: embedding shortlist -------------------------------------------
async function shortlistThreads(claimEmb: number[], k: number): Promise<Candidate[]> {
  const client = await pool.connect();
  try {
    const r = await client.queryObject<{ thread_id: string; name: string; description: string | null; distance: number }>(
      `SELECT id AS thread_id, name, description,
              (embedding <=> $1::vector) AS distance
         FROM threads
        WHERE status = 'active' AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [toVector(claimEmb), k],
    );
    // pgvector's <=> distance decodes as a string over the wire — coerce so
    // numeric comparisons (.toFixed, thresholds) behave.
    return r.rows.map((row) => ({ ...row, distance: Number(row.distance) }));
  } finally {
    client.release();
  }
}

// --- Stage 2: LLM decision --------------------------------------------------
const RESOLVE_SYS = `You are Open Brain's research curator. You decide which research THREAD a new piece of research belongs to.

A thread is a durable, named line of inquiry that accumulates related sources over time. Your job is to fight fragmentation: prefer attaching new research to an EXISTING thread whenever it plausibly belongs there. Only create a NEW thread when the research is a genuinely distinct line of inquiry that no candidate covers.

You are given the new research and a shortlist of candidate threads (already pre-filtered by semantic similarity; lower distance = more similar). Decide.

Return ONLY a JSON object:
{
  "decision": "existing" | "new",
  "thread_id": "<uuid of the chosen candidate, when decision=existing>",
  "confidence": <0.0-1.0>,
  "new_thread_name": "<short broad name, 2-5 words, when decision=new>",
  "new_thread_description": "<1-3 sentence scope statement, when decision=new>",
  "reason": "<one sentence>"
}

Rules:
- Bias toward "existing". A near-duplicate or same-subject query MUST attach to the existing thread, not spawn a sibling.
- Choose "new" only if you can name the distinct line of inquiry that no candidate represents.
- A new thread name must be BROAD (the topic area), never the specific query, so future related research lands here too.
- confidence reflects how sure you are of the decision.`;

async function decideThread(pkg: Pkg, shortlist: Candidate[]): Promise<Decision> {
  const titles = (pkg.sources || []).map((s) => s.title || s.domain || s.url).filter(Boolean).slice(0, 8);
  const candidatesBlock = shortlist.length
    ? shortlist
      .map((c, i) =>
        `${i + 1}. thread_id=${c.thread_id} | distance=${c.distance.toFixed(3)} | name="${c.name}"\n   description: ${c.description || "(none)"}`
      )
      .join("\n")
    : "(no candidate threads)";
  const user = [
    `NEW RESEARCH`,
    `topic hint: ${pkg.topic_hint || pkg.notebook || "(none)"}`,
    `question: ${(pkg.query || "").slice(0, 400)}`,
    `synthesis: ${(pkg.claim || "").slice(0, 2000)}`,
    titles.length ? `source titles: ${titles.join("; ")}` : "",
    ``,
    `CANDIDATE THREADS (lower distance = more similar):`,
    candidatesBlock,
  ].filter(Boolean).join("\n");

  const out = await chatJson(RESOLVE_SYS, user);
  return {
    decision: out.decision === "new" ? "new" : "existing",
    thread_id: typeof out.thread_id === "string" ? out.thread_id : undefined,
    confidence: typeof out.confidence === "number" ? out.confidence : 0.5,
    new_thread_name: typeof out.new_thread_name === "string" ? out.new_thread_name : undefined,
    new_thread_description: typeof out.new_thread_description === "string" ? out.new_thread_description : undefined,
    reason: typeof out.reason === "string" ? out.reason : undefined,
  };
}

// --- Thread creation / maintenance ------------------------------------------

/** Create a thread. slug is left NULL — the wiki compiler pins the canonical
 *  slug (G5: never slugify outside the shared module). */
async function createThread(name: string, description: string): Promise<string> {
  const emb = toVector(await embed(`${name}\n${description}`));
  const client = await pool.connect();
  try {
    const r = await client.queryObject<{ id: string }>(
      `INSERT INTO threads (name, description, embedding, status)
       VALUES ($1, $2, $3::vector, 'active')
       RETURNING id`,
      [name.slice(0, 200), description.slice(0, 2000), emb],
    );
    return r.rows[0].id;
  } finally {
    client.release();
  }
}

const REFRESH_SYS = `You maintain the scope DESCRIPTION of an Open Brain research thread. Given the thread's current name + description and a newly added piece of research, return an updated description that still captures the thread's overall scope (not just the new research). Keep it 1-3 sentences, broad enough to attract future related research. Return ONLY JSON: {"description": "..."}`;

/** Extend the thread's description with the new research, then recompute its
 *  embedding from name+description. Best-effort: callers ignore failures. */
async function refreshThread(threadId: string, pkg: Pkg): Promise<void> {
  const client = await pool.connect();
  try {
    const cur = await client.queryObject<{ name: string; description: string | null }>(
      `SELECT name, description FROM threads WHERE id = $1`,
      [threadId],
    );
    if (cur.rows.length === 0) return;
    const { name, description } = cur.rows[0];
    let newDesc = description || "";
    try {
      const out = await chatJson(
        REFRESH_SYS,
        `THREAD name: ${name}\ncurrent description: ${description || "(none)"}\n\nNEW RESEARCH\nquestion: ${(pkg.query || "").slice(0, 300)}\nsynthesis: ${(pkg.claim || "").slice(0, 1500)}`,
      );
      if (typeof out.description === "string" && out.description.trim()) {
        newDesc = out.description.trim().slice(0, 2000);
      }
    } catch (e) {
      console.error(`refresh: description LLM failed for ${threadId}:`, (e as Error).message);
    }
    const emb = toVector(await embed(`${name}\n${newDesc}`));
    await client.queryObject(
      `UPDATE threads SET description = $2, embedding = $3::vector, updated_at = now() WHERE id = $1`,
      [threadId, newDesc, emb],
    );
  } finally {
    client.release();
  }
}

// --- Resolution policy ------------------------------------------------------
async function resolve(pkg: Pkg, claimEmb: number[]): Promise<{
  thread_id: string;
  decision: "explicit" | "existing" | "new";
  confidence: number;
  name: string;
  shortlist: Candidate[];
}> {
  // Explicit-thread bypass: a deliberately-set thread_id is honored as-is.
  const explicit = (pkg.thread_id || "").trim();
  if (explicit) {
    const client = await pool.connect();
    try {
      const r = await client.queryObject<{ name: string }>(`SELECT name FROM threads WHERE id = $1`, [explicit]);
      if (r.rows.length) {
        return { thread_id: explicit, decision: "explicit", confidence: 1, name: r.rows[0].name, shortlist: [] };
      }
      // Falls through to resolver if the id is stale/unknown.
    } finally {
      client.release();
    }
  }

  const shortlist = await shortlistThreads(claimEmb, SHORTLIST_K);
  const hint = (pkg.topic_hint || pkg.notebook || "research").trim() || "research";

  let decision: Decision;
  try {
    decision = await decideThread(pkg, shortlist);
  } catch (e) {
    // LLM down -> attach to the Stage-1 top candidate if close enough, else cold-start.
    console.error("resolve: decision LLM failed, using distance fallback:", (e as Error).message);
    const top = shortlist[0];
    if (top && top.distance <= MERGE_FLOOR_DISTANCE) {
      return { thread_id: top.thread_id, decision: "existing", confidence: 1 - top.distance, name: top.name, shortlist };
    }
    const id = await createThread(hint, (pkg.claim || "").slice(0, 400));
    return { thread_id: id, decision: "new", confidence: 0.5, name: hint, shortlist };
  }

  const top = shortlist[0];

  // Attach to an existing candidate.
  if (decision.decision === "existing") {
    const chosen = shortlist.find((c) => c.thread_id === decision.thread_id) || top;
    if (chosen) {
      return { thread_id: chosen.thread_id, decision: "existing", confidence: decision.confidence, name: chosen.name, shortlist };
    }
    // LLM said existing but named nothing valid and shortlist empty -> cold-start.
  }

  // decision = new. Conservative-merge gate: if a candidate exists but the LLM
  // isn't confident enough, attach to the top candidate instead of fragmenting.
  if (top && decision.confidence < NEW_THREAD_MIN_CONFIDENCE) {
    return { thread_id: top.thread_id, decision: "existing", confidence: decision.confidence, name: top.name, shortlist };
  }

  const name = (decision.new_thread_name || hint).slice(0, 200);
  const desc = (decision.new_thread_description || (pkg.claim || "").slice(0, 400)).slice(0, 2000);
  const id = await createThread(name, desc);
  return { thread_id: id, decision: "new", confidence: decision.confidence, name, shortlist };
}

// --- Delegate the write to the existing /research/persist -------------------
async function delegatePersist(pkg: Pkg, threadId: string, notebookLabel: string): Promise<Record<string, unknown>> {
  const body = {
    research_key: pkg.research_key,
    query: pkg.query,
    claim: pkg.claim,
    synthesis: pkg.synthesis, // full detailed result -> stored as source content
    kind: pkg.kind,
    volatility: pkg.volatility,
    revalidate_days: pkg.revalidate_days,
    // CRITICAL: stamp the RESOLVED THREAD NAME (not the raw topic_hint) as the
    // notebook on the persisted sources. The wiki compiler's backfillNotebooks
    // turns any sources.notebook string that matches no thread NAME into a brand
    // new thread — so using the topic_hint here would re-fragment exactly what
    // the curator just consolidated. Matching the thread name makes backfill a
    // no-op for curator-routed research.
    notebook: notebookLabel || pkg.topic_hint || pkg.notebook,
    thread_id: threadId,
    model: pkg.model,
    sources: pkg.sources || [],
  };
  const r = await fetch(`${PERSIST_URL}/research/persist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": MCP_ACCESS_KEY },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`persist ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// --- Grounded-claim ingestion (Research Engine P2.1) ------------------------
// After the verbatim synthesis + sources are persisted, decompose the
// synthesis's own [SOURCED]/[INFERRED]/[Source N] tags into grounded claims +
// typed edges (claims.ts → init-claims.sql helpers). The synthesis blob stays
// the human-readable rendering; the claims are the machine-truth the cache/
// reuse layer trusts. Best-effort: a failure here never fails the ingest, and
// claims are additive + idempotent so a later re-run heals it.
//
// Index contract: source_ids from /research/persist is aligned with pkg.sources
// (source_ids[N-1] == the synthesis's [Source N]); the parser drops any
// citation that doesn't resolve to a real source (rule #1 — nothing ungrounded
// is stored).
async function writeGroundedClaims(
  pkg: Pkg,
  threadId: string,
  synthesisId: string | null,
  sourceIds: Array<string | null>,
): Promise<WriteClaimsResult | null> {
  const synthesis = (pkg.synthesis || "").trim();
  if (!synthesis || !synthesisId) return null; // nothing to parse / nowhere to anchor
  const client = await pool.connect();
  try {
    await client.queryArray("BEGIN");
    const res = await writeClaims(client, synthesis, {
      threadId,
      synthesisId,
      sourceIds,
      volatility: pkg.volatility ?? null,
      revalidateDays: pkg.revalidate_days ?? null,
      embed,
    });
    await client.queryArray("COMMIT");

    // Conflict auto-detection (#2) — separate txn; LLM judge calls shouldn't hold
    // the write lock. Best-effort: a failure never undoes the committed claims.
    if (threadId && res.claimIds.length) {
      try {
        await client.queryArray("BEGIN");
        const conf = await detectConflicts(client, res.claimIds, threadId, conflictJudge, CONFLICT_DISTANCE);
        await client.queryArray("COMMIT");
        (res as WriteClaimsResult & { conflicts?: number }).conflicts = conf.conflicts;
        if (conf.conflicts) console.log(`claims: ${conf.conflicts} conflict(s) flagged in thread ${threadId}`);
      } catch (e) {
        await client.queryArray("ROLLBACK").catch(() => {});
        console.error("claims: conflict detection failed:", (e as Error).message);
      }
    }
    return res;
  } catch (e) {
    // Swallowing this is how a run ends up searchable but never reasoned over,
    // with the only trace a log line nothing reads. Roll back and RETHROW so the
    // ingest handler can report it with the run's identity and the claim count
    // (the ingest still returns 200 — the sources DID land).
    await client.queryArray("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// LLM judge for conflict detection — does claim A contradict claim B?
const CONFLICT_JUDGE_SYS =
  `You compare two factual claims and decide their relationship. Return ONLY JSON: {"verdict":"contradict"|"agree"|"unrelated"}. "contradict" = they cannot both be true. "agree" = same or compatible. "unrelated" = about different things. Be strict: only "contradict" when they are genuinely incompatible.`;
async function conflictJudge(a: string, b: string): Promise<ConflictVerdict> {
  const out = await chatJson(CONFLICT_JUDGE_SYS, `CLAIM A: ${a}\nCLAIM B: ${b}`);
  const v = out.verdict;
  return v === "contradict" || v === "agree" ? v : "unrelated";
}

// --- Failure reporting ------------------------------------------------------
// The single line this replaces was `ingest failed: Broken pipe (os error 32)`.
// It named the plumbing and nothing else: not the run, not the stage, not the
// fact that a complete research package had just been destroyed. It is why the
// same failure ran for two and a half months and 244 runs. Every failure path
// now states which STAGE died, which research_key died with it, and exactly how
// much went unwritten, in the log AND in the response body (which the research
// service stores on the job row as result->'curator').
type Stage = "embed" | "resolve" | "persist" | "claims";

interface Loss {
  stage: Stage;
  research_key: string;
  query: string;
  sources_unwritten: number;
  claims_unwritten: number;
  detail: string;
}

/** How many grounded claims this package WOULD have produced (parser is pure). */
function claimCount(pkg: Pkg): number {
  try {
    return parseSynthesisClaims(pkg.synthesis || "").claims.length;
  } catch {
    return 0;
  }
}

function describeLoss(stage: Stage, pkg: Pkg, e: unknown, sourcesWritten = 0): Loss {
  const totalSources = Array.isArray(pkg.sources) ? pkg.sources.length : 0;
  return {
    stage,
    research_key: (pkg.research_key || "").trim() || "(none)",
    query: (pkg.query || "").replace(/\s+/g, " ").slice(0, 200),
    sources_unwritten: Math.max(0, totalSources - sourcesWritten),
    claims_unwritten: claimCount(pkg),
    detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  };
}

function lossLine(l: Loss): string {
  return `ingest FAILED stage=${l.stage} research_key=${l.research_key} ` +
    `LOST ${l.sources_unwritten} source(s) + ${l.claims_unwritten} grounded claim(s) UNWRITTEN ` +
    `query="${l.query}" cause: ${l.detail}`;
}

// --- HTTP server ------------------------------------------------------------
function authed(req: Request, url: URL): boolean {
  const provided = req.headers.get("x-brain-key") || req.headers.get("X-Brain-Key") || url.searchParams.get("key");
  return !!provided && !!MCP_ACCESS_KEY && provided === MCP_ACCESS_KEY;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ingest/health")) {
    let db = false;
    try {
      const c = await pool.connect();
      try { await c.queryArray("SELECT 1"); db = true; } finally { c.release(); }
    } catch { /* db down */ }
    // pool_rebuilds is the witness for a severed-connection drill: it increments
    // only when the wrapper threw a dead pool away and built a fresh one.
    return Response.json({ ok: db, db, pool_rebuilds: pool.rebuilds }, { status: db ? 200 : 503 });
  }

  if (req.method === "POST" && url.pathname === "/ingest/research-package") {
    if (!authed(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
    let pkg: Pkg;
    try { pkg = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    const claim = (pkg.claim || "").trim();
    if (!claim) return Response.json({ error: "claim required" }, { status: 400 });

    // Which step we are on, so a failure can say what died rather than just how.
    let stage: Stage = "embed";
    try {
      const claimEmb = await embed(claim.slice(0, 1600));
      stage = "resolve";
      const res = await resolve(pkg, claimEmb);

      let persist: Record<string, unknown>;
      stage = "persist";
      // res.name is passed as the notebook label (see delegatePersist).
      try {
        persist = await delegatePersist(pkg, res.thread_id, res.name);
      } catch (e) {
        // Persist failed AFTER we resolved a thread. Surface it so the caller
        // can fall back to its own unthreaded persist (best-effort, never block).
        const loss = describeLoss("persist", pkg, e);
        console.error(lossLine(loss));
        return Response.json(
          { error: "persist_failed", ...loss, detail: loss.detail, thread_id: res.thread_id, thread_decision: res.decision },
          { status: 502 },
        );
      }

      // Decompose the synthesis into grounded claims + edges (P2.1) — awaited
      // so the result is reported, but never fatal to the ingest.
      const synthesisId = (typeof persist.synthesis_id === "string" ? persist.synthesis_id : null);
      const sourceIds = Array.isArray(persist.source_ids) ? persist.source_ids as Array<string | null> : [];

      // Stamp the readable prose + query breadcrumbs onto the synthesis row's
      // metadata, so the wiki renders a readable synthesis + a "Research
      // questions" section (the tagged `content` stays the grounded machine-truth
      // that claim decomposition reads). Best-effort — never fails the ingest.
      if (synthesisId && (pkg.prose || pkg.needs?.length || pkg.followup_queries?.length)) {
        try {
          const c = await pool.connect();
          try {
            // Merge semantics: prose_synthesis/report_type are stamped ONLY
            // when present — a run whose template render failed must not null
            // out a previously-good readable prose (the leaf page would fall
            // back to the raw tagged claim lines).
            const stamp: Record<string, unknown> = {
              needs: pkg.needs || [],
              followup_queries: pkg.followup_queries || [],
              source_ids: sourceIds, // [Source N] → source_ids[N-1] for clickable citations
            };
            if (pkg.prose) stamp.prose_synthesis = pkg.prose;
            if (pkg.report_type) stamp.report_type = pkg.report_type;
            await c.queryObject(
              `UPDATE sources SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
              [synthesisId, JSON.stringify(stamp)],
            );
          } finally { c.release(); }
        } catch (e) {
          console.error(
            `ingest: synthesis metadata stamp failed research_key=${pkg.research_key || "(none)"} ` +
              `(sources kept, readable prose + breadcrumbs lost): ${(e as Error).message}`,
          );
        }
      }

      let claims: WriteClaimsResult | null = null;
      let claimsError: string | null = null;
      try {
        claims = await writeGroundedClaims(pkg, res.thread_id, synthesisId, sourceIds);
      } catch (e) {
        // The sources DID land (persist succeeded above); the grounded claims did
        // not, so this run is searchable but not reasoned over. Say so, with the
        // count, and carry it back to the caller in the body — a claim write that
        // fails silently is the same class of defect as the broken pipe.
        const loss = describeLoss("claims", pkg, e, Number(persist.sources_written ?? 0));
        console.error(lossLine(loss));
        claimsError = loss.detail;
      }

      // Maintain the thread so future matching improves — best-effort.
      refreshThread(res.thread_id, pkg).catch((e) =>
        console.error("ingest: thread refresh failed:", (e as Error).message)
      );

      console.log(
        `ingest: decision=${res.decision} conf=${res.confidence.toFixed(2)} thread="${res.name}" (${res.thread_id}) sources=${persist.sources_written ?? "?"} claims=${claims ? `${claims.claimsWritten}+${claims.claimsDeduped}dup/${claims.gaps.length}gap/${claims.ungroundedSkipped}skip` : "0"}`,
      );
      return Response.json({
        thread_id: res.thread_id,
        thread_decision: res.decision,
        thread_confidence: res.confidence,
        thread_name: res.name,
        shortlist: res.shortlist.map((c) => ({ thread_id: c.thread_id, name: c.name, distance: c.distance })),
        persist,
        claims,
        claims_error: claimsError,
      });
    } catch (e) {
      const loss = describeLoss(stage, pkg, e);
      console.error(lossLine(loss));
      return Response.json({ error: "ingest_failed", ...loss }, { status: 500 });
    }
  }

  return new Response("not found", { status: 404 });
});

console.log(`research-curator listening on :${PORT} (persist=${PERSIST_URL}, k=${SHORTLIST_K}, min_conf=${NEW_THREAD_MIN_CONFIDENCE})`);
