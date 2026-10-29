/**
 * resend.e2e.test.ts - rw-curator-filed2 against a LAB database: a RESEND of a research package is idempotent
 * across the whole curator filing, not only the synthesis row.
 *
 * The REAL curator (index.ts) and the REAL kubernetes-deployment persist route, spawned as the containers run
 * them, against a throwaway Postgres (full initdb chain, 280 included), plus a stub embeddings/chat endpoint
 * whose thread resolver ALWAYS answers decision "new" at confidence 1.0 (the worst case for a resend: every
 * resolve() mints a thread). Everything is inside the test container (127.0.0.1).
 *
 * IGNORED unless RESEND_E2E_DB_HOST is set (run-filed-e2e.ps1 sets it in a disposable internal network).
 * Never point it at a live database. Imports: the postgres driver only (the image caches nothing else).
 */
import { Pool } from "postgres";

const DB_HOST = Deno.env.get("RESEND_E2E_DB_HOST") ?? "";
const DB_PASSWORD = Deno.env.get("RESEND_E2E_DB_PASSWORD") ?? "test";
const K8S_DIR = Deno.env.get("RESEND_E2E_K8S_DIR") ?? "/app";
const CURATOR_DIR = Deno.env.get("RESEND_E2E_CURATOR_DIR") ?? "/curator";
const KEY = "resend-e2e-key";
const ignore = !DB_HOST;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };

function assert(c: unknown, m = "assertion failed"): asserts c {
  if (!c) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const pool = ignore ? null : new Pool({ hostname: DB_HOST, port: 5432, database: "openbrain", user: "postgres", password: DB_PASSWORD }, 3, true);
async function sql<T = Record<string, unknown>>(q: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(q, args)).rows; } finally { c.release(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();
let delayMs = 0;
let threadSeq = 0;
function stubModels(runTag: string) {
  const ac = new AbortController();
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    if (delayMs) await sleep(delayMs);
    if (u.pathname.endsWith("/embeddings")) return Response.json({ data: [{ embedding: VEC }] });
    const sys = String(body?.messages?.[0]?.content ?? "");
    let out: Record<string, unknown> = {};
    if (sys.includes("decide which research THREAD")) {
      // the worst-case resolver: always "new", fully confident, a distinct name per call
      out = { decision: "new", confidence: 1.0, new_thread_name: `${runTag} T${++threadSeq}`, new_thread_description: "lab", reason: "stub" };
    } else if (sys.includes("maintain the scope DESCRIPTION")) {
      out = { description: `${runTag} refreshed ${Date.now()}` };
    } else if (sys.includes("compare two factual claims")) {
      out = { verdict: "unrelated" };
    } else if (sys.toLowerCase().includes("meta")) {
      out = { verdict: "WORLD" };
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
  });
  return { port: (srv.addr as Deno.NetAddr).port, stop: async () => { ac.abort(); await srv.finished; } };
}

async function spawn(dir: string, args: string[], env: Record<string, string>, readyPath: string, readyOk: (s: number) => boolean) {
  const port = 18000 + Math.floor(Math.random() * 3000);
  const child = new Deno.Command(Deno.execPath(), {
    args, cwd: dir, env: { ...env, PORT: String(port) }, stdout: "piped", stderr: "piped",
  }).spawn();
  const svc = { log: "" };
  for (const s of [child.stdout, child.stderr]) s.pipeTo(new WritableStream({ write(b) { svc.log += new TextDecoder().decode(b); } })).catch(() => {});
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(base + readyPath, { headers: { "x-brain-key": KEY } }); await r.text(); if (readyOk(r.status)) break; } catch { /* not up */ }
    if (Date.now() - t0 > 60_000) throw new Error(`did not start: ${dir}\n${svc.log.slice(-2000)}`);
    await sleep(300);
  }
  return { base, svc, stop: async () => { try { child.kill("SIGTERM"); } catch { /* gone */ } await child.status.catch(() => {}); } };
}

async function lab(runTag: string) {
  const models = stubModels(runTag);
  const m = `http://127.0.0.1:${models.port}`;
  const k8s = await spawn(K8S_DIR, ["run", "--unstable-net", "--allow-net", "--allow-env", "--allow-read", "index.ts"], {
    DB_HOST, DB_PASSWORD, DB_NAME: "openbrain", DB_USER: "postgres", MCP_ACCESS_KEY: KEY,
    EMBEDDING_API_BASE: m, EMBEDDING_API_KEY: "x", CHAT_API_BASE: m, CHAT_API_KEY: "x", FETCH_PROXY_URL: "",
  }, "/research/lookup?key=nope", (s) => s === 200);
  const cur = await spawn(CURATOR_DIR, ["run", "--no-lock", "--allow-net", "--allow-env", "--allow-read", "index.ts"], {
    DB_HOST, DB_PASSWORD, DB_NAME: "openbrain", DB_USER: "postgres", MCP_ACCESS_KEY: KEY, PERSIST_URL: k8s.base,
    EMBEDDING_API_BASE: m, EMBEDDING_API_KEY: "x", CHAT_API_BASE: m, CHAT_API_KEY: "x", CHAT_MODEL: "stub",
  }, "/health", (s) => s === 200);
  return { cur, k8s, stop: async () => { await cur.stop(); await k8s.stop(); await models.stop(); delayMs = 0; }, log: () => `--- curator ---\n${cur.svc.log.slice(-1500)}\n--- persist ---\n${k8s.svc.log.slice(-1500)}` };
}

const mkJob = async () => (await sql<{ id: string }>(`INSERT INTO research_jobs (status, origin, query, started_at) VALUES ('running','manual','resend e2e',now()) RETURNING id::text`))[0].id;
const pkgFor = (key: string, job: string, runTag: string) => ({
  research_key: key, job_id: job, query: `q ${runTag}`, claim: `claim ${runTag} ${key}`, kind: "deep_research",
  claim_kind: "descriptive", credibility_model: "lab",
  synthesis: [
    `[SOURCED] The ${runTag} alpha result reproduced in 12 trials across two labs. [Source 1]`,
    `[SOURCED] The ${runTag} beta result held for 40 participants over six months. [Source 1]`,
    `[SOURCED] The ${runTag} gamma estimate is 3.5 units per cohort. [Source 1]`,
  ].join("\n"),
  sources: [{ url: `https://example.org/${key}`, title: "t", content: `page text ${runTag} `.repeat(30), domain: "example.org" }],
});
const send = (base: string, body: unknown) =>
  fetch(`${base}/ingest/research-package`, { method: "POST", headers: { "x-brain-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> }));

async function state(key: string, job: string, runTag: string) {
  const syn = await sql<{ id: string }>(`SELECT id::text FROM sources WHERE content_type='research_synthesis' AND research_key=$1`, [key]);
  const sid = syn[0]?.id ?? "00000000-0000-0000-0000-000000000000";
  const threads = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM threads WHERE name LIKE $1`, [`${runTag} T%`]);
  const linked = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM thread_sources WHERE source_id=$1`, [sid]);
  const claims = await sql<{ n: number; t: number; h: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT thread_id)::int AS t, count(DISTINCT content_hash)::int AS h FROM claims WHERE synthesis_id=$1`, [sid]);
  const edges = await sql<{ n: number; d: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT (claim_id, source_id))::int AS d FROM claim_sources WHERE claim_id IN (SELECT id FROM claims WHERE synthesis_id=$1)`, [sid]);
  const sessions = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE metadata->>'research_key'=$1`, [key]);
  const ev = await sql<{ payload: Record<string, unknown> }>(`SELECT payload FROM research_job_events WHERE job_id=$1 AND type='filed'`, [job]);
  return { syntheses: syn.length, threads: threads[0].n, linked: linked[0].n, claims: claims[0], edges: edges[0], sessions: sessions[0].n, events: ev.length, evThread: ev[0]?.payload?.thread_id };
}
function expectOne(s: Awaited<ReturnType<typeof state>>, ctx: string) {
  eq(s.syntheses, 1, `${ctx}: one synthesis`);
  eq(s.threads, 1, `${ctx}: ONE thread minted by the always-new resolver`);
  eq(s.linked, 1, `${ctx}: the synthesis is linked into ONE thread`);
  assert(s.claims.n >= 1, `${ctx}: claims were filed (else the case is vacuous): ${JSON.stringify(s.claims)}`);
  eq(s.claims.t, 1, `${ctx}: every claim is in ONE thread`);
  eq(s.claims.n, s.claims.h, `${ctx}: no claim written twice`);
  eq(s.edges.n, s.edges.d, `${ctx}: no edge written twice`);
  eq(s.sessions, 1, `${ctx}: ONE sessions row`);
  eq(s.events, 1, `${ctx}: one filed event`);
}

Deno.test({ name: "round 2: a slow first attempt, then a resend of the same job -> 1 thread, 1 synthesis in 1 thread, no duplicated claim or edge, 1 sessions row", ...opts, fn: async () => {
  const tag = `RS${crypto.randomUUID().slice(0, 8)}`; const L = await lab(tag);
  try {
    const job = await mkJob(); const key = `rs-${tag}`;
    delayMs = 250; // every model/embedding call is slow: attempt 1 is still working when the resend arrives
    const first = send(L.cur.base, pkgFor(key, job, tag));
    await sleep(400); // "timed out": the research service resends while attempt 1 is mid-filing
    const second = send(L.cur.base, pkgFor(key, job, tag));
    const [a, b] = await Promise.all([first, second]);
    delayMs = 0;
    assert(a.status === 200 && b.status === 200, `both answered: ${a.status}/${b.status} ${JSON.stringify([a.json, b.json])}\n${L.log()}`);
    expectOne(await state(key, job, tag), "slow+resend");
    // and a third resend long after the fact
    const c = await send(L.cur.base, pkgFor(key, job, tag));
    eq(c.status, 200);
    expectOne(await state(key, job, tag), "slow+resend+late resend");
  } finally { await L.stop(); }
} });

Deno.test({ name: "round 2: overlapping attempts (three at once) -> still one of everything", ...opts, fn: async () => {
  const tag = `OV${crypto.randomUUID().slice(0, 8)}`; const L = await lab(tag);
  try {
    const job = await mkJob(); const key = `rs-${tag}`;
    delayMs = 120;
    const rs = await Promise.all([1, 2, 3].map(() => send(L.cur.base, pkgFor(key, job, tag))));
    delayMs = 0;
    assert(rs.every((r) => r.status === 200), `all answered: ${JSON.stringify(rs.map((r) => r.status))}\n${L.log()}`);
    expectOne(await state(key, job, tag), "overlap x3");
  } finally { await L.stop(); }
} });

Deno.test({ name: "round 2: different jobs are not serialised or merged by the lock (two jobs, two threads)", ...opts, fn: async () => {
  const tag = `DJ${crypto.randomUUID().slice(0, 8)}`; const L = await lab(tag);
  try {
    const j1 = await mkJob(), j2 = await mkJob();
    const [a, b] = await Promise.all([send(L.cur.base, pkgFor(`rs-${tag}-1`, j1, tag)), send(L.cur.base, pkgFor(`rs-${tag}-2`, j2, tag))]);
    assert(a.status === 200 && b.status === 200, `${a.status}/${b.status}\n${L.log()}`);
    eq((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM threads WHERE name LIKE $1`, [`${tag} T%`]))[0].n, 2, "two jobs -> two threads (the lock is per job)");
  } finally { await L.stop(); }
} });
