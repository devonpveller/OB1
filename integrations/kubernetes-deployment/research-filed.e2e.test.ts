/**
 * research-filed.e2e.test.ts - rw-curator-filed clauses 3 and 4 against a LAB database.
 *
 * The REAL kubernetes-deployment server (index.ts, spawned as the container runs it) against a throwaway
 * Postgres carrying the full initdb chain (280-init-research-filed.sql included) and a stub embeddings
 * endpoint, all inside the test container (127.0.0.1). POST /research/persist is driven over HTTP.
 *
 * IGNORED unless RF_E2E_DB_HOST is set (run-filed-e2e.ps1 sets it inside a disposable internal network).
 * Never point it at a live database. No imports beyond the postgres driver (the image caches only that).
 */
import { Pool } from "postgres";

const DB_HOST = Deno.env.get("RF_E2E_DB_HOST") ?? "";
const DB_PASSWORD = Deno.env.get("RF_E2E_DB_PASSWORD") ?? "test";
const SERVICE_DIR: string | URL = Deno.env.get("RF_E2E_SERVICE_DIR") ?? new URL(".", import.meta.url);
const KEY = "rf-e2e-key";
const ignore = !DB_HOST;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };

function assert(c: unknown, m = "assertion failed"): asserts c {
  if (!c) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function rejects(f: () => Promise<unknown>, m: string) {
  try { await f(); } catch { return; }
  throw new Error(`expected a refusal: ${m}`);
}

const pool = ignore ? null : new Pool({ hostname: DB_HOST, port: 5432, database: "openbrain", user: "postgres", password: DB_PASSWORD }, 3, true);
async function sql<T = Record<string, unknown>>(q: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(q, args)).rows; } finally { c.release(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();
let embedDelayMs = 0;
function stubEmbeddings() {
  const ac = new AbortController();
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    await req.text();
    if (embedDelayMs) await sleep(embedDelayMs);
    return Response.json({ data: [{ embedding: VEC }] });
  });
  return { port: (srv.addr as Deno.NetAddr).port, stop: async () => { ac.abort(); await srv.finished; } };
}

async function startServer(embPort: number) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-net", "--allow-net", "--allow-env", "--allow-read", "index.ts"],
    cwd: SERVICE_DIR instanceof URL ? SERVICE_DIR.pathname.replace(/^\/([A-Za-z]:)/, "$1") : SERVICE_DIR,
    env: {
      PORT: String(port), DB_HOST, DB_PASSWORD, DB_NAME: "openbrain", DB_USER: "postgres",
      MCP_ACCESS_KEY: KEY, EMBEDDING_API_BASE: `http://127.0.0.1:${embPort}`, EMBEDDING_API_KEY: "x",
      CHAT_API_BASE: `http://127.0.0.1:${embPort}`, CHAT_API_KEY: "x", FETCH_PROXY_URL: "",
    },
    stdout: "piped", stderr: "piped",
  });
  const child = cmd.spawn();
  const svc = { log: "" };
  for (const s of [child.stdout, child.stderr]) {
    s.pipeTo(new WritableStream({ write(b) { svc.log += new TextDecoder().decode(b); } })).catch(() => {});
  }
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${base}/research/lookup?key=nope`, { headers: { "x-brain-key": KEY } }); await r.text(); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 60_000) throw new Error(`server did not start\n${svc.log.slice(-2000)}`);
    await sleep(300);
  }
  return {
    base, svc,
    stop: async () => { try { child.kill("SIGTERM"); } catch { /* gone */ } await child.status.catch(() => {}); },
  };
}

const persist = (base: string, body: Record<string, unknown>) =>
  fetch(`${base}/research/persist`, { method: "POST", headers: { "x-brain-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> }));
const mkJob = async () => (await sql<{ id: string }>(`INSERT INTO research_jobs (status, origin, query, started_at) VALUES ('running','manual','rf e2e',now()) RETURNING id::text`))[0].id;
const synthRows = (key: string) => sql<{ id: string }>(`SELECT id::text FROM sources WHERE content_type='research_synthesis' AND research_key=$1`, [key]);
const events = (job: string) => sql<{ id: string; payload: Record<string, unknown> }>(`SELECT id::text, payload FROM research_job_events WHERE job_id=$1 AND type='filed'`, [job]);
const pkg = (key: string, job?: string, extra: Record<string, unknown> = {}) => ({
  research_key: key, query: "q", claim: "c", synthesis: "[SOURCED] a claim. [Source 1]", kind: "deep_research",
  sources: [{ url: `https://example.org/${key}`, title: "t", content: "page text ".repeat(30), domain: "example.org" }],
  ...(job ? { job_id: job } : {}), ...extra,
});

Deno.test({ name: "clause 4: the filed event commits in the SAME transaction as the filing, with the synthesis id", ...opts, fn: async () => {
  const emb = stubEmbeddings(); const srv = await startServer(emb.port);
  try {
    const job = await mkJob(); const key = `rf-a-${crypto.randomUUID()}`;
    const r = await persist(srv.base, pkg(key, job));
    assert(r.status === 200, `persist ${r.status} ${JSON.stringify(r.json)}\n${srv.svc.log.slice(-1500)}`);
    const syn = await synthRows(key);
    eq(syn.length, 1, "one synthesis");
    const ev = await events(job);
    eq(ev.length, 1, "one filed event");
    eq(ev[0].payload.synthesis_id, syn[0].id, "the event carries the synthesis id");
    eq(ev[0].payload.research_key, key);
    eq(Number(r.json.filed_event_id), Number(ev[0].id), "the response names the event");
    // a persist that names no job (an interactive / legacy caller) writes the filing and no event
    const key2 = `rf-a2-${crypto.randomUUID()}`;
    const r2 = await persist(srv.base, pkg(key2));
    eq(r2.status, 200); eq((await synthRows(key2)).length, 1);
  } finally { await srv.stop(); await emb.stop(); }
} });

Deno.test({ name: "clause 4: a filing that fails leaves NO event and NO synthesis; an event for a missing job rolls the filing back", ...opts, fn: async () => {
  const emb = stubEmbeddings(); const srv = await startServer(emb.port);
  try {
    const key = `rf-b-${crypto.randomUUID()}`;
    const ghost = crypto.randomUUID(); // a job that does not exist
    const r = await persist(srv.base, pkg(key, ghost));
    assert(r.status >= 400, `a filing naming a missing job must be refused, got ${r.status}`);
    eq((await synthRows(key)).length, 0, "the synthesis rolled back with the missing-job event");
    eq((await events(ghost)).length, 0, "no event");
    // a filing that fails AFTER the synthesis upsert (an unknown thread id breaks the link) - nothing of it survives
    const job = await mkJob(); const key2 = `rf-b2-${crypto.randomUUID()}`;
    const r2 = await persist(srv.base, pkg(key2, job, { thread_id: crypto.randomUUID() }));
    assert(r2.status >= 400, `an unfilable package must be refused, got ${r2.status}`);
    eq((await synthRows(key2)).length, 0, "no synthesis");
    eq((await events(job)).length, 0, "no event without the filing");
    // malformed job id is a 400, nothing written
    const key3 = `rf-b3-${crypto.randomUUID()}`;
    const r3 = await persist(srv.base, pkg(key3, "not-a-uuid"));
    eq(r3.status, 400); eq((await synthRows(key3)).length, 0);
  } finally { await srv.stop(); await emb.stop(); }
} });

Deno.test({ name: "clause 3: a late commit racing the retry (same research_key, same job) never produces a duplicate", ...opts, fn: async () => {
  const emb = stubEmbeddings(); const srv = await startServer(emb.port);
  try {
    embedDelayMs = 400; // widen the window: both transactions are open together
    const job = await mkJob(); const key = `rf-c-${crypto.randomUUID()}`;
    const [a, b] = await Promise.all([persist(srv.base, pkg(key, job)), (async () => { await sleep(100); return persist(srv.base, pkg(key, job)); })()]);
    embedDelayMs = 0;
    assert(a.status === 200 && b.status === 200, `both persists answered: ${a.status} / ${b.status} ${JSON.stringify([a.json, b.json])}\n${srv.svc.log.slice(-1500)}`);
    eq((await synthRows(key)).length, 1, "ONE synthesis");
    eq((await events(job)).length, 1, "ONE filed event");
    eq(a.json.synthesis_id, b.json.synthesis_id, "both answers name the same synthesis");
    // and a sequential third (a resend after the fact) is the same row again
    const c = await persist(srv.base, pkg(key, job));
    eq(c.status, 200); eq((await synthRows(key)).length, 1); eq((await events(job)).length, 1);
  } finally { embedDelayMs = 0; await srv.stop(); await emb.stop(); }
} });

Deno.test({ name: "clause 4: the schema refuses a filed event without its synthesis id and a second one for the job", ...opts, fn: async () => {
  const job = await mkJob();
  await rejects(() => sql(`INSERT INTO research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1,$1,'filed','due_process','{}'::jsonb)`, [job]), "filed without synthesis_id");
  await sql(`INSERT INTO research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1,$1,'filed','due_process','{"synthesis_id":"s","research_key":"k"}'::jsonb)`, [job]);
  await rejects(() => sql(`INSERT INTO research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1,$1,'filed','due_process','{"synthesis_id":"s2","research_key":"k"}'::jsonb)`, [job]), "second filed event for the job");
} });
