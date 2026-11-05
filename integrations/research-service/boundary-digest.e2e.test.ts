/**
 * boundary-digest.e2e.test.ts - rw-boundary-digest (plan 09 PD0c): the REAL daily digest (recipes/daily-digest
 * link-enrich.ts, run as openbrain-podcast spawns it) against the REAL research service (index.ts) and a LAB database
 * carrying the full initdb chain, over SEEDED emails whose every personal field carries its own marker:
 *   subject (SUBJ), sender (FROM), body (BODY), label (LABEL), gmail id (GID), thread id (THR), and the article link's
 *   query string (?u=QRY).
 * Two emails: one with a public article link, one body-only newsletter (no link). The digest runs twice - a DRY run,
 * then a COMMIT run with audio (a fake ffmpeg, the stub's PCM speech) - and then THE SWEEP counts every marker:
 *   - in every text / json column of every table in `public` (fixtures/boundary-sweep.ts) except the private ones:
 *     research_handbacks, the archives, ideas / idea_revisions, `thoughts` (the personal inlet: the emails) and
 *     podcast_episodes (the owner's episode: checked separately - only the owner's own unshared row may hold them);
 *   - in the egress: the search gate's log, the public pages' request log, the curator packages;
 *   - in a second user's reads: the research service's job / tree / events / list reads (Open WebUI's key on BEE's
 *     behalf) and the workbench's podcast library query for BEE.
 * And the markers ARE in the private places (the emails, the hand-back, the owner's transcript): the zero is not vacuous.
 *
 * BND_DG_MODE=green (default): every count is zero, the article is still researched and filed shared (sources +
 * claims), the body-only email made no research request but is in the private episode and the email brief, the
 * hand-backs are delivered with the episode, both runs pass.
 * BND_DG_MODE=red: the same run on the pre-PD0c digest - the test PASSES only if the leaks plan 09 names are there
 * (R2: the body in a shared source / job options and the thread id in a source URL; R3: the gmail id and label in
 * sources.metadata; R6: the label and subject in a shared podcast_transcript source). Counts only, never content.
 *
 * Stubs (one server on 127.0.0.1 inside this container): a LiteLLM-shaped gateway (chat, embeddings, speech,
 * /health/liveliness - the research service's model AND the digest's), the search gate, a curator that files the
 * package the way the real one does (find_or_create_source for every cited page and the synthesis, one claim per
 * tagged line, a thread), a Gmail API stub (the seeded emails' HTML: no real mailbox, no Google), the workbench's
 * archive-destination setting, and a pass-through to the lab's real PostgREST (the digest's BRAIN_REST_URL).
 * IGNORED unless BND_DG_DB_HOST is set (run-digest-boundary-lab.ps1 sets it inside a disposable internal network).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";
import { DEFAULT_PRIVATE, describe, sweepTables, sweepText } from "./fixtures/boundary-sweep.ts";

const E = (k: string) => Deno.env.get(k) ?? "";
const DB_HOST = E("BND_DG_DB_HOST");
const DB_PASSWORD = E("BND_DG_DB_PASSWORD");
const APP_PASSWORD = E("BND_DG_APP_PASSWORD");
const PGRST = E("BND_DG_PGRST").replace(/\/+$/, "");
const DIGEST_DIR = E("BND_DG_DIGEST_DIR") || "/digest";
const SERVICE_DIR: string | URL = E("BND_DG_SERVICE_DIR") || new URL(".", import.meta.url);
const PAGES_PORT = E("BND_DG_PAGES_PORT") || "8080";
const MODE = (E("BND_DG_MODE") || "green") as "green" | "red" | "red-share";
const ignore = !DB_HOST;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };
const SHARED = "e2e-shared-key-000000";
const OWUI = "e2e-owui-key-0000000000";
// round 2 (tester F2): the digest's OWN research caller key (RESEARCH_CALLERS digest=notebook:<key>)
const DIGESTKEY = "e2e-digest-key-0000000000";
const BEE = "user-bee-second";

// the digest's markers (plan 09 section 5, the Gmail row)
// round 2 (tester F1): the codes of meeting / share links - NOT id-shaped (a Meet code is letters and hyphens, a Drive id
// letters only, a share code a word), so only the private-host rule can stop them
const SHR: Record<string, string> = {
  MEET: "zqx-mtgc-dqr", DRV: "QvXkTzRmWpLnBqHs", DOCS: "KwPzRtYvNqLsHm", SITE: "quillberryfarm", ZOOM: "8451239876",
  TEAMS: "brindlemeetup", DBX: "plumtreeplanx", SHARE: "brindlewharfz",
};
const DG: Record<string, string> = { SUBJ: MK.SUBJ, FROM: MK.FROM, BODY: MK.BODY, LABEL: MK.LABEL, GID: MK.GID, THR: MK.THR, QRY: MK.QRY, ...SHR };
const LABEL = `brain/${MK.LABEL}`;
const ARTICLE = { gmailId: `${MK.GID}a1`, threadId: `${MK.THR}a1` };
const BODYONLY = { gmailId: `${MK.GID}b2`, threadId: `${MK.THR}b2` };
const INVITE = { gmailId: `${MK.GID}c3`, threadId: `${MK.THR}c3` };
const SHARE_LINKS = [
  `http://meet.google.com:${PAGES_PORT}/${SHR.MEET}`, `http://drive.google.com:${PAGES_PORT}/file/d/${SHR.DRV}/view`,
  `http://docs.google.com:${PAGES_PORT}/document/d/${SHR.DOCS}/edit`, `http://sites.google.com:${PAGES_PORT}/view/${SHR.SITE}`,
  `http://zoom.us:${PAGES_PORT}/j/${SHR.ZOOM}`, `http://teams.microsoft.com:${PAGES_PORT}/l/meetup-join/${SHR.TEAMS}`,
  `http://www.dropbox.com:${PAGES_PORT}/scl/fi/${SHR.DBX}/plan.pdf`, `http://files.example.org:${PAGES_PORT}/share/${SHR.SHARE}`,
];
const ARTICLE_URL = `http://news.example.org:${PAGES_PORT}/solar-roofs?u=${MK.QRY}`;
const FROM_NAME = `${MK.FROM} Letters`, FROM_ADDR = `${MK.FROM.toLowerCase()}@letters.example.com`;

function pool(user: "postgres" | "ob_app_memory") {
  return new Pool({ hostname: DB_HOST, port: 5432, database: "openbrain", user, password: user === "postgres" ? DB_PASSWORD : APP_PASSWORD }, 3, true);
}
const su = ignore ? null : pool("postgres");
const app = ignore ? null : pool("ob_app_memory");
async function q<T = Record<string, unknown>>(p: Pool | null, text: string, args: unknown[] = []): Promise<T[]> {
  const c = await p!.connect();
  try { return (await c.queryObject<T>(text, args)).rows; } finally { c.release(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ── the seeded mail (synthetic; the Gmail stub serves the HTML, the brain holds the stored chunks) ─────────────────
const ARTICLE_HTML = `<html><body><p>${MK.BODY} This week in community energy: what readers asked us about cheap roofs.</p>` +
  `<p><a href="${ARTICLE_URL}">Community solar roofs ${MK.SUBJ} read more</a></p>` +
  // round 2 (F1): the reader's meeting and shared files, linked from an ordinary newsletter
  SHARE_LINKS.map((l, i) => `<p><a href="${l}">Our shared item ${i + 1}</a></p>`).join("") + `</body></html>`;
// round 2 (F1): a calendar invitation - its links are the meeting's, never research
const INVITE_TEXT = `${MK.BODY} You have been invited to a budget review. Join with Google Meet http://meet.google.com:${PAGES_PORT}/${SHR.MEET} ` +
  "or dial in. Agenda: the winter plan, the roof quotes and the budget of the cooperative. ".repeat(6);
const INVITE_HTML = `<html><body><p>${INVITE_TEXT}</p><p><a href="http://meet.google.com:${PAGES_PORT}/${SHR.MEET}">Join with Google Meet</a></p>` +
  `<p><a href="${ARTICLE_URL}">Background reading</a></p></body></html>`;
const BODY_TEXT = `${MK.BODY} Dear reader, this edition is a single long letter with no links at all. ` +
  "We walked through the history of heat pumps, how cooperative buying works, and what the winter looked like for our members. ".repeat(6);
const BODY_HTML = `<html><body><p>${BODY_TEXT}</p></body></html>`;

async function seed() {
  await q(su, `INSERT INTO public.workspace_users (sub, name, email) VALUES ($1, $2, $3) ON CONFLICT (sub) DO NOTHING`, [OWNER.sub, OWNER.name, OWNER.email]);
  const now = new Date().toISOString();
  for (const [m, subj, body] of [[ARTICLE, `${MK.SUBJ} your weekly energy notes`, `${MK.BODY} This week in community energy. ${SHARE_LINKS.join(" ")}`],
    [BODYONLY, `${MK.SUBJ} a long letter`, BODY_TEXT], [INVITE, `Invitation: ${MK.SUBJ} budget review @ Wed 10am`, INVITE_TEXT]] as const) {
    // the gmail pull's shape: an ops-plane thought per email chunk (openbrain-gmail-pull)
    await q(su, `INSERT INTO public.thoughts (content, metadata, exposure, created_at) VALUES ($1, $2::jsonb, 'ops', now())`, [
      `[Email from ${FROM_NAME} <${FROM_ADDR}> | Subject: ${subj} | Date: ${now}]\n${body}`,
      JSON.stringify({ type: "email", gmail_id: m.gmailId, gmail_thread_id: m.threadId, gmail_labels: [LABEL], chunk_index: 0, chunk_count: 1, email_date: now, topics: ["energy"] }),
    ]);
  }
  // the owner's podcast team (the presenter model, init-podcasts.sql)
  await q(su, `INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice) VALUES ('vl-dg', $1, 'local-tts', 'af_lab') ON CONFLICT DO NOTHING`, [OWNER.sub]);
  for (const [id, name] of [["pr-dg-a", "Ada"], ["pr-dg-b", "Bo"]]) {
    await q(su, `INSERT INTO public.podcast_presenters (id, owner_sub, name, voice_link_id) VALUES ($1, $2, $3, 'vl-dg') ON CONFLICT DO NOTHING`, [id, OWNER.sub, name]);
  }
  await q(su, `INSERT INTO public.podcast_teams (id, owner_sub, name) VALUES ('tm-dg', $1, 'lab team') ON CONFLICT DO NOTHING`, [OWNER.sub]);
  await q(su, `INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ('tm-dg', 0, 'pr-dg-a'), ('tm-dg', 1, 'pr-dg-b') ON CONFLICT DO NOTHING`);
}

// ── the stubs ───────────────────────────────────────────────────────────────────────────────
const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();
function stubs() {
  const log = { proposer: [] as string[], chat: [] as string[], search: [] as string[], curator: [] as string[], gmail: [] as string[], speech: 0, rest: [] as string[] };
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    const p = u.pathname;
    // the lab's real PostgREST behind the digest's BRAIN_REST_URL (the compose Caddy strips /rest/v1 the same way)
    if (p.startsWith("/rest/v1/")) {
      log.rest.push(`${req.method} ${p.slice(9)}`);
      const headers = new Headers(req.headers);
      headers.delete("host");
      const r = await fetch(`${PGRST}/${p.slice(9)}${u.search}`, { method: req.method, headers, body: req.method === "GET" ? undefined : await req.arrayBuffer() });
      return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers });
    }
    if (p.startsWith("/gmail/v1/users/me/messages/")) {
      const id = decodeURIComponent(p.split("/").pop() ?? "");
      log.gmail.push(id);
      const html = id === ARTICLE.gmailId ? ARTICLE_HTML : id === BODYONLY.gmailId ? BODY_HTML : id === INVITE.gmailId ? INVITE_HTML : "";
      if (!html) return new Response("not found", { status: 404 });
      return Response.json({ id, payload: { mimeType: "text/html", body: { data: b64url(html) } } });
    }
    if (p === "/workbench/contract/settings/podcast.archive_destination") {
      return Response.json({ value: { mount: "podcast-archive" }, version: 1, resolved: { path: "/tmp/mounts/podcast-archive", reachable: true, via: "mount" } });
    }
    if (p.endsWith("/health/liveliness")) return new Response(`"I'm alive!"`);
    if (p.endsWith("/observe/queue/estimate")) return Response.json({ max_concurrency: 2, capacity_declared: true });
    if (p === "/search") {
      log.search.push(u.searchParams.get("q") ?? "");
      return Response.json({ results: [{ url: `http://news.example.org:${PAGES_PORT}/solar-roofs`, title: "Community solar roofs cut winter bills", content: "solar roofs survey" }] });
    }
    const raw = await req.text();
    if (p.endsWith("/ingest/research-package")) {
      log.curator.push(raw);
      return Response.json(await fileLikeTheCurator(raw));
    }
    if (p.startsWith("/research/filed")) return Response.json({ filed: null });
    // deno-lint-ignore no-explicit-any
    const body: any = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    if (p.endsWith("/audio/speech")) { log.speech++; return new Response(new Uint8Array(4800)); }
    if (p.endsWith("/embeddings")) return Response.json({ data: [{ embedding: VEC }] });
    const sys = String(body?.messages?.[0]?.content ?? "");
    const user = String(body?.messages?.[1]?.content ?? "");
    if (body?.max_tokens === 1) return Response.json({ choices: [{ message: { content: "ok" } }] });
    let content = "{}";
    if (sys.includes("You write research questions for a public research library")) {
      // THE HOSTILE PROPOSER (as rw-boundary-core's lab): every personal field verbatim, then all joined
      log.proposer.push(raw);
      const note = user.slice(user.indexOf("PRIVATE NOTE:") + 13, user.indexOf("PUBLIC PAGES:")).trim().split("\n").map((l) => l.replace(/^[^:]+:\s*/, ""));
      content = JSON.stringify({ questions: [...note, note.join(" "), `What is known about ${note.join(" and ")}?`] });
    } else {
      log.chat.push(sys.slice(0, 60));
      if (sys.includes("advertisement filter")) content = "CONTENT";
      else if (sys.includes("KEEP or DROP a newsletter email body")) content = "VERDICT: KEEP";
      // keep EVERY link (the hostile choice: the share links must be stopped by the filters, not by the POI pass)
      else if (sys.includes("You curate the links in a newsletter")) content = JSON.stringify({ keep: [...user.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])) });
      // the digest's gap triage, HOSTILE: its question restates the email (subject, sender, label)
      else if (sys.includes(`You triage "gap dives"`)) content = JSON.stringify([{ ref: 0, question: `What did ${MK.SUBJ} from ${MK.FROM} in ${MK.LABEL} say about community solar roofs and winter bills?` }]);
      // the episode script, HOSTILE: it echoes the whole segment block (labels, titles, the newsletter's own text) -
      // so the owner's transcript holds every marker, and only the owner may read it
      else if (sys.includes("TWO-HOST morning podcast")) content = `HOST A: Good morning. ${user.replace(/\s+/g, " ").slice(0, 6000)}\nHOST B: That is the show.`;
      else if (sys.includes("INJECTION or CLEAN") || sys.includes("You screen fetched web content")) content = "CLEAN";
      else if (sys.includes("RELEVANT or IRRELEVANT") || sys.includes("You screen a fetched web page")) content = "RELEVANT";
      else if (sys.includes("ENTAILMENT JUDGE")) content = JSON.stringify({ verdict: "supports" });
      else if (sys.includes("research planner")) content = JSON.stringify({ needs: ["How much do community solar roofs cut winter bills?"] });
      else if (sys.includes("web-search queries")) content = JSON.stringify({ entity: "community solar roofs", queries: ["community solar roofs winter bills"] });
      else if (sys.includes("grounded synthesizer") || sys.includes("ARTICLE")) content = "[SOURCED] Community solar roofs cut winter bills by 18 percent in 2024. [Source 1]";
      else if (sys.includes("CURRENT TOPIC")) content = JSON.stringify({ topic: "community solar roofs" });
      else if (!body?.response_format) content = "community solar roofs";
    }
    return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
  });
  return { base: `http://127.0.0.1:${server.addr.port}`, log, async close() { ac.abort(); await server.finished; } };
}

/** The curator's shared writes, as the real one makes them (index.ts /ingest/research-package + /research/persist):
 *  every cited page and the synthesis as `sources` rows, one claim per tagged line, a thread. As ob_app_memory. */
async function fileLikeTheCurator(raw: string) {
  // deno-lint-ignore no-explicit-any
  const pkg: any = JSON.parse(raw);
  const ids: Array<string | null> = [];
  for (const s of (pkg.sources ?? []) as Array<{ url?: string; title?: string; content?: string; domain?: string }>) {
    const r = await q<{ id: string }>(app, `SELECT id::text FROM public.find_or_create_source($1, $2, NULL, $3, 'web_article', NULL, $4)`,
      [String(s.url ?? ""), String(s.content ?? ""), String(s.title ?? ""), s.domain ?? null]).catch(() => [] as { id: string }[]);
    ids.push(r[0]?.id ?? null);
  }
  const syn = await q<{ id: string }>(app, `SELECT id::text FROM public.find_or_create_source($1, $2, NULL, $3, 'research_synthesis')`,
    [`research://job/${pkg.job_id ?? crypto.randomUUID()}`, String(pkg.synthesis ?? ""), String(pkg.query ?? "")]);
  const thread = await q<{ id: string }>(app, `INSERT INTO public.threads (name) VALUES ($1) RETURNING id::text`, [String(pkg.query ?? "research").slice(0, 120)]);
  let claims = 0;
  for (const line of String(pkg.synthesis ?? "").split("\n")) {
    const m = /^\s*\[(SOURCED|INFERRED|UNCERTAIN)\]\s*(.+)$/i.exec(line);
    if (!m) continue;
    await q(app, `INSERT INTO public.claims (text, thread_id, synthesis_id, epistemic_tag) VALUES ($1, $2::uuid, $3::uuid, $4)`,
      [m[2].replace(/\[Source\s*\d+\]/gi, "").trim(), thread[0].id, syn[0]?.id ?? null, m[1].toLowerCase()]);
    claims++;
  }
  return { thread_id: thread[0].id, thread_name: "community solar roofs", thread_decision: "new",
    persist: { sources_written: ids.filter(Boolean).length, source_ids: ids }, claims: { claimsWritten: claims, claimsDeduped: 0, filed: [] } };
}

function freePort(): number { const l = Deno.listen({ port: 0, hostname: "127.0.0.1" }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; }

async function startService(stubBase: string) {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"], cwd: SERVICE_DIR,
    env: {
      PORT: String(port), DB_HOST, DB_PORT: "5432", DB_NAME: "openbrain", DB_USER: "ob_app_memory", DB_PASSWORD: APP_PASSWORD,
      MCP_ACCESS_KEY: SHARED, RESEARCH_CALLERS: `owui-tool=owui:${OWUI};digest=notebook:${DIGESTKEY}`, RESEARCH_SERVICE_CALLERS: "",
      CHAT_API_BASE: `${stubBase}/v1`, EMBEDDING_API_BASE: `${stubBase}/v1`, CURATOR_URL: stubBase, SEARCH_API_BASE: stubBase,
      CHAT_API_KEY: "lab-stub-key", RESEARCH_BRANCH_LLM_KEY: "lab-stub-branch-key", RESEARCH_LANE_REFRESH_MS: "1000",
      FETCH_PROXY_URL: "", OWUI_BASE_URL: "", CALLBACK_MIN_AGE_MS: "0", CURATOR_FILE_ATTEMPTS: "1",
      CHAT_DOWN_BUDGET_MS: "4000", RESEARCH_MODEL_PROBE_MS: "1000", RESEARCH_MODEL_PROBE_TIMEOUT_MS: "3000", NO_COLOR: "1",
      WORKSPACE_DEFAULT_SUB: "",
    },
    stdout: "piped", stderr: "piped",
  }).spawn();
  let log = "";
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const ch of s.pipeThrough(new TextDecoderStream())) log += ch; };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${base}/health`); await r.body?.cancel(); if (r.ok) break; } catch { /* booting */ }
    await sleep(200);
  }
  return { base, get log() { return log; }, async stop() { try { child.kill(); } catch { /* gone */ } await child.status; await pumps.catch(() => {}); } };
}

/** The digest, exactly as openbrain-podcast spawns it (podcast-server.ts: deno run ... link-enrich.ts <args>). */
async function runDigest(stubBase: string, svcBase: string, dir: string, args: string[]) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-net", "-A", "link-enrich.ts", "--window=48", ...args], cwd: DIGEST_DIR,
    env: {
      MCP_ACCESS_KEY: SHARED, RESEARCH_DIGEST_KEY: DIGESTKEY, RESEARCH_URL: svcBase, BRAIN_REST_URL: stubBase, WORKBENCH_URL: stubBase,
      CHAT_API_BASE: `${stubBase}/v1`, CHAT_API_KEY: "sk-lab", PODCAST_TTS_KEY: "sk-lab-tts", CHAT_MODEL: "local-large",
      REPORTS_DIR: `${dir}/reports`, GMAIL_API_BASE: stubBase,
      GMAIL_READ_CREDENTIALS: `${dir}/gmail-credentials.json`, GMAIL_READ_TOKEN: `${dir}/gmail-token.json`,
      PODCAST_OWNER_SUB: OWNER.sub, PODCAST_TEAM: "lab team", CONTRACT_MOUNTS_ROOT: "/tmp/mounts", FFMPEG_BIN: `${dir}/fake-ffmpeg`,
      PODCAST_SEGMENT_CACHE_DIR: `${dir}/segment-cache`, FETCH_PROXY_URL: "", TARGET_LABEL_PREFIX: "brain/",
      GAP_DIVE_ENABLED: "1", GAP_DIVE_WAIT_MS: "90000", RESEARCH_WAIT_MS: "180000", RESEARCH_POLL_MS: "500",
      MODEL_GATE_INITIAL_MS: "200", MODEL_GATE_MAX_MS: "500", MODEL_WAIT_MAX_MS: "60000", NO_COLOR: "1",
    },
    stdout: "piped", stderr: "piped",
  }).output();
  const td = new TextDecoder();
  return { code: out.code, log: td.decode(out.stdout) + td.decode(out.stderr) };
}

async function pageLog(): Promise<string[]> {
  return ((await (await fetch(`http://news.example.org:${PAGES_PORT}/_log`)).json()).log ?? []) as string[];
}
const add = (acc: Record<string, number>, hits: Record<string, number>) => { for (const [k, n] of Object.entries(hits)) acc[k] = (acc[k] ?? 0) + n; };
/** "where: SUBJ=2 BODY=1" - counts only */
const fmt = (where: string, h: Record<string, number>) => `${where}: ${Object.entries(h).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`;

Deno.test({ name: `PD0c ${MODE.toUpperCase()}: a digest run (dry, then commit) over marked emails - the sweep, the egress and a second user's reads`, ...opts, fn: async () => {
  await seed();
  const st = stubs();
  const svc = await startService(st.base);
  const dir = await Deno.makeTempDir({ prefix: "digest-lab-" });
  await Deno.mkdir("/tmp/mounts/podcast-archive", { recursive: true });
  await Deno.writeTextFile(`${dir}/gmail-credentials.json`, JSON.stringify({ installed: { client_id: "lab", client_secret: "lab", redirect_uris: [] } }));
  await Deno.writeTextFile(`${dir}/gmail-token.json`, JSON.stringify({ access_token: "lab-token", refresh_token: "lab", token_type: "Bearer", expiry_date: Date.now() + 86_400_000 }));
  // a fake ffmpeg (the encode is not under test here; the podcast image's own gate runs the real one): drain the PCM,
  // write the output file it was asked for
  await Deno.writeTextFile(`${dir}/fake-ffmpeg`, `#!/bin/sh\ncat > /dev/null\nfor a in "$@"; do last="$a"; done\nprintf 'lab-audio' > "$last"\n`);
  await Deno.chmod(`${dir}/fake-ffmpeg`, 0o755);
  const out: string[] = [];
  try {
    const sources0 = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.sources`))[0].n;
    // ── the DRY run
    const dry = await runDigest(st.base, svc.base, dir, []);
    await Deno.writeTextFile(`${dir}/dry.log`, dry.log);
    out.push(`dry run: exit ${dry.code}`);
    const sourcesDry = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.sources`))[0].n;
    out.push(`dry run: shared sources ${sources0} -> ${sourcesDry}`);
    // ── the COMMIT run (with audio, as the chain runs it: --commit --audio)
    const com = await runDigest(st.base, svc.base, dir, ["--commit", "--audio"]);
    await Deno.writeTextFile(`${dir}/commit.log`, com.log);
    out.push(`commit run: exit ${com.code}`);
    for (let i = 0; i < 240; i++) {
      const left = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_jobs WHERE status IN ('queued','running')`))[0].n;
      if (!left) break;
      await sleep(500);
    }
    const jobs = await q<{ id: string; kind: string; status: string; dry: boolean; mode: string | null }>(su,
      `SELECT id::text, request_kind AS kind, status, coalesce((options->>'dry_run')::boolean, false) AS dry, options->>'mode' AS mode FROM public.research_jobs ORDER BY created_at`);
    out.push(`jobs: ${jobs.map((j) => `${j.kind}/${j.status}${j.dry ? "/dry" : ""}${j.mode ? "/" + j.mode : ""}`).join(" ")}`);

    // ── THE SWEEP (counts only)
    const isPrivate = (t: string) => DEFAULT_PRIVATE(t) || t === "thoughts" || t === "podcast_episodes";
    const sc = await su!.connect();
    let res: Awaited<ReturnType<typeof sweepTables>>;
    try { res = await sweepTables(sc, DG, isPrivate); } finally { sc.release(); }
    out.push(describe(res));
    const hasTranscript = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'podcast_episodes' AND column_name = 'transcript'`))[0].n === 1;
    const eps = await q<{ owner_sub: string; shared: boolean; t: string }>(su,
      `SELECT owner_sub, shared, ${hasTranscript ? "coalesce(transcript, '')" : "''"} || ' ' || title AS t FROM public.podcast_episodes`);
    const epForeign: Record<string, number> = {}, epOwn: Record<string, number> = {};
    for (const e of eps) add(e.owner_sub === OWNER.sub && !e.shared ? epOwn : epForeign, sweepText(e.t, DG));
    out.push(fmt("podcast_episodes, the owner's own unshared rows (private)", epOwn));
    out.push(fmt("podcast_episodes, any other row", epForeign));
    // the egress: search queries, page fetches (path + query), the curator packages
    const pages = await pageLog();
    const egress: Record<string, number> = {};
    add(egress, sweepText(st.log.search.join("\n"), DG));
    add(egress, sweepText(pages.join("\n"), DG));
    add(egress, sweepText(st.log.curator.join("\n"), DG));
    out.push(fmt("egress (search, page fetches, curator packages)", egress));
    // a second user's reads: the research service's job reads (Open WebUI's key on BEE's behalf) and the podcast library
    const reads: Record<string, number> = {};
    const asBee = { "x-brain-key": OWUI, "x-on-behalf-of": BEE };
    for (const j of jobs) {
      for (const suffix of ["", "/tree", "/events"]) {
        const r = await fetch(`${svc.base}/research/jobs/${j.id}${suffix}`, { headers: asBee });
        add(reads, sweepText(await r.text(), DG));
      }
    }
    add(reads, sweepText(await (await fetch(`${svc.base}/research/jobs?limit=100`, { headers: asBee })).text(), DG));
    const library = await q<{ t: string }>(su, `SELECT e.title AS t FROM public.podcast_episodes e WHERE e.origin = 'render' AND (e.owner_sub = $1 OR e.shared)`, [BEE]);
    add(reads, sweepText(library.map((x) => x.t).join("\n"), DG));
    out.push(fmt("second user's reads (job, tree, events, list, podcast library)", reads));
    const privateEmails = res.private.filter((h) => h.table === "thoughts").map((h) => h.marker);
    out.push(`private: emails hold ${[...new Set(privateEmails)].sort().join(",")}; hand-back hits ${res.private.filter((h) => h.table === "research_handbacks").length}`);

    // ── the shared, public-article side and the private side
    const article = await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.sources WHERE url LIKE 'http://news.example.org%/solar-roofs%'`);
    const claims = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.claims`))[0].n;
    const transcriptSources = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.sources WHERE content_type = 'podcast_transcript'`))[0].n;
    out.push(`shared: article sources ${article[0].n}, claims ${claims}, podcast_transcript sources ${transcriptSources}; curator packages ${st.log.curator.length}; proposer calls ${st.log.proposer.length}; speech calls ${st.log.speech}; gmail reads ${st.log.gmail.length}`);
    const brief = JSON.parse(await Deno.readTextFile(`${dir}/reports/podcast-brief-latest.json`).catch(() => "{}"));
    const items = (brief.segments ?? []).flatMap((s: { items: Array<{ title: string; emailOnly: boolean }> }) => s.items);
    out.push(`brief: ${items.length} item(s): ${items.map((i: { emailOnly: boolean }) => (i.emailOnly ? "email-only" : "researched")).join(" ")}`);

    if (MODE === "red-share") {
      // round 1's code (the item as attempt 1 tested it): the meeting / Drive codes reached shared rows
      const leaked = [...new Set(res.hits.map((h) => h.marker))].filter((m) => m in SHR);
      out.push(`RED-SHARE: share-link codes in shared rows: ${leaked.sort().join(",") || "none"}; in the second user's reads: ${Object.keys(reads).filter((k) => k in SHR).sort().join(",") || "none"}`);
      assert(leaked.includes("MEET") && leaked.includes("DRV"), "RED-SHARE: round 1 lets the Meet code and the Drive id into shared rows (tester F1)");
      return;
    }
    if (MODE === "red") {
      // the leaks plan 09 names, on today's code (counts by marker and table)
      const at = (m: string, t: string, c?: string) => res.hits.some((h) => h.marker === m && h.table === t && (!c || h.column === c));
      const r2 = at("BODY", "research_jobs", "options") && at("BODY", "sources") && at("THR", "sources", "url");
      const r3 = at("GID", "sources", "metadata") && at("LABEL", "sources", "metadata");
      const r6 = transcriptSources > 0 && at("LABEL", "sources", "content") && at("SUBJ", "sources", "content");
      out.push(`RED: R2 ${r2 ? "reproduced" : "NOT reproduced"}; R3 ${r3 ? "reproduced" : "NOT reproduced"}; R6 ${r6 ? "reproduced" : "NOT reproduced"}`);
      assert(r2 && r3 && r6, "RED: today's digest leaks as plan 09 says (R2, R3, R6)");
      return;
    }

    // ── GREEN
    assertEquals([dry.code, com.code], [0, 0], `both runs pass\n--- dry ---\n${dry.log.slice(-3000)}\n--- commit ---\n${com.log.slice(-3000)}`);
    assertEquals(sourcesDry, sources0, "the dry run wrote no shared source");
    assertEquals(res.hits, [], "no marker in any shared table");
    assertEquals(epForeign, {}, "no marker in any episode row but the owner's own unshared one");
    assertEquals(egress, {}, "no marker leaves the box (search, page fetches, curator packages)");
    assertEquals(reads, {}, "no marker reaches the second user");
    assert(Object.keys(epOwn).includes("LABEL") && Object.keys(epOwn).includes("BODY"), "the owner's transcript holds the episode (labels, the newsletter's text): private, not vacuous");
    for (const m of ["SUBJ", "FROM", "BODY", "LABEL", "GID", "THR"]) assert(privateEmails.includes(m), `the emails hold ${m} (the run had something to leak)`);
    assert(res.private.some((h) => h.table === "research_handbacks" && h.marker === "GID"), "the gmail id is in the private hand-back's deliver record");
    assertEquals(transcriptSources, 0, "no shared podcast_transcript source (R6)");
    assert(article[0].n >= 1 && claims >= 1, "the public article is still researched and filed as a shared source with claims (acceptance 2)");
    assert(jobs.every((j) => j.kind === "derived"), "every job the digest made is derived (no POST /research)");
    assert(jobs.some((j) => j.mode === "article" && j.dry) && jobs.some((j) => j.mode === "article" && !j.dry), "an article job in each run (dry and commit)");
    assert(items.some((i: { emailOnly: boolean }) => !i.emailOnly) && items.some((i: { emailOnly: boolean }) => i.emailOnly), "the brief covers the researched article and the body-only email (private side)");
    assert(!com.log.includes("researching") || !/newsletter-body/.test(com.log), "the body-only email made no research request");
    const hb = await q<{ purpose: string; state: string; ep: boolean }>(su, `SELECT purpose, state, (deliver ? 'episode_id') AS ep FROM public.research_handbacks ORDER BY created_at`);
    out.push(`hand-backs: ${hb.map((h) => `${h.purpose}/${h.state}${h.ep ? "+episode" : ""}`).join(" ")}`);
    assert(hb.some((h) => h.purpose === "digest-article" && h.state === "delivered" && h.ep), "the commit run's article hand-back is delivered with the episode");
    assert(!hb.some((h) => h.state === "queued" && h.purpose === "digest-article"), "no article hand-back is left open");
    for (const m of Object.keys(SHR)) assert(privateEmails.includes(m), `the emails hold ${m} (the share link was really there)`);

    // round 2 (F1), at THE GATE (not only the digest's filter): each share / meeting link sent straight to the door is
    // refused with no job
    const door = (key: string, body: unknown) => fetch(`${svc.base}/research/derived`, { method: "POST", headers: { "x-brain-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
    const gateAnswers: string[] = [];
    for (const [i, l] of SHARE_LINKS.entries()) {
      const a = await (await door(DIGESTKEY, { item: { kind: "gmail", id: `probe-share-${i}`, owner_sub: OWNER.sub, fields: { subject: "s" }, links: [l] }, purpose: "digest-article", deliver: {} })).json();
      gateAnswers.push(a.refused ?? `JOB ${a.job_id}`);
    }
    out.push(`gate: the ${SHARE_LINKS.length} share / meeting links sent straight to the door -> ${gateAnswers.join(" ")}`);
    assert(gateAnswers.every((a) => a === "link_not_public"), "the boundary refuses every share / meeting link (420's gate, pd0c-1)");

    // round 2 (F2): the digest's hand-backs carry the digest's own caller; another caller's key cannot close one
    const callers = await q<{ c: string; n: number }>(su, `SELECT deliver ->> 'caller' AS c, count(*)::int AS n FROM public.research_handbacks WHERE inlet_id NOT LIKE 'probe-%' GROUP BY 1`);
    out.push(`hand-back callers: ${callers.map((x) => `${x.c}=${x.n}`).join(" ")}`);
    assert(callers.length === 1 && callers[0].c === "digest", "every hand-back the digest opened names the digest's own caller");
    const open = await (await door(DIGESTKEY, { item: { kind: "gmail", id: "probe-f2", owner_sub: OWNER.sub, fields: { subject: "s" }, links: [`http://news.example.org:${PAGES_PORT}/solar-roofs`] },
      purpose: "digest-article", deliver: { segment: "x" }, run: { dry_run: true } })).json();
    assert(open.job_id, `the digest's key opens a hand-back: ${JSON.stringify(open)}`);
    const forge = { deliveries: [{ job_id: open.job_id, ok: true, episode_id: "11111111-2222-4333-8444-555555555555" }] };
    const by = async (key: string) => (await (await fetch(`${svc.base}/research/derived/delivered`, { method: "POST", headers: { "x-brain-key": key, "content-type": "application/json" }, body: JSON.stringify(forge) })).json()).delivered;
    const f2 = { shared: await by(SHARED), owui: await by(OWUI), digest: await by(DIGESTKEY) };
    out.push(`F2: delivered by the shared key ${f2.shared}, by Open WebUI's key ${f2.owui}, by the digest's own key ${f2.digest}`);
    assertEquals(f2, { shared: 0, owui: 0, digest: 1 }, "only the digest's own key closes the digest's hand-back");
  } finally {
    for (const l of out) console.log(l);
    try { await Deno.copyFile(`${dir}/commit.log`, "/evidence/commit.log"); await Deno.copyFile(`${dir}/dry.log`, "/evidence/dry.log"); } catch { /* no evidence mount */ }
    await svc.stop().catch(() => {});
    try { await Deno.writeTextFile("/evidence/research-service.log", svc.log.replace(/sk-[A-Za-z0-9-]+/g, "sk-***")); } catch { /* */ }
    await st.close();
  }
}});

Deno.test({ name: "teardown", ...opts, fn: async () => { await su?.end(); await app?.end(); } });
