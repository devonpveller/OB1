/**
 * report-isolation.e2e.test.ts - rw-report-isolation against a LAB database: an idea job's final report is private
 * to the idea's owner; the claims drawn from it stay shared; every other report is filed shared, exactly as before.
 *
 * The REAL curator (index.ts) and the REAL kubernetes-deployment persist route, spawned as the containers run them,
 * against a throwaway Postgres (the full initdb chain, slot 390 included), plus a stub embeddings/chat endpoint
 * whose thread resolver ALWAYS answers "new" (the worst case: every resolve() would mint a thread named and
 * described from the report). Everything is inside the test container (127.0.0.1).
 *
 * IGNORED unless RI_E2E_DB_HOST is set (run-filed-e2e.ps1 sets it in a disposable internal network).
 * Never point it at a live database. Imports: the postgres driver only (the image caches nothing else).
 */
import { Pool } from "postgres";

const DB_HOST = Deno.env.get("RI_E2E_DB_HOST") ?? "";
const DB_PASSWORD = Deno.env.get("RI_E2E_DB_PASSWORD") ?? "test";
const K8S_DIR = Deno.env.get("RI_E2E_K8S_DIR") ?? "/app";
const CURATOR_DIR = Deno.env.get("RI_E2E_CURATOR_DIR") ?? "/curator";
const KEY = "ri-e2e-key";
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
/** a query that may name a table the base (pre-390) chain does not have: absent = no rows */
async function sqlMaybe<T = Record<string, unknown>>(q: string, args: unknown[] = []): Promise<T[]> {
  try { return await sql<T>(q, args); } catch (e) { if (/does not exist/.test(String(e))) return []; throw e; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = () => crypto.randomUUID().slice(0, 8);

const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();
let threadSeq = 0;
function stubModels(runTag: string) {
  const ac = new AbortController();
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    if (u.pathname.endsWith("/embeddings")) return Response.json({ data: [{ embedding: VEC }] });
    const sys = String(body?.messages?.[0]?.content ?? "");
    const user = String(body?.messages?.[1]?.content ?? "");
    let out: Record<string, unknown> = {};
    if (sys.includes("decide which research THREAD")) {
      // the worst case: always "new", fully confident, the new thread named and described from what it was given
      out = { decision: "new", confidence: 1.0, new_thread_name: `${runTag} T${++threadSeq}`, new_thread_description: `described from: ${user.slice(0, 600)}`, reason: "stub" };
    } else if (sys.includes("maintain the scope DESCRIPTION")) {
      out = { description: `${runTag} refreshed from: ${user.slice(0, 600)}` };
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
  const child = new Deno.Command(Deno.execPath(), { args, cwd: dir, env: { ...env, PORT: String(port) }, stdout: "piped", stderr: "piped" }).spawn();
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
  return { cur, k8s, stop: async () => { await cur.stop(); await k8s.stop(); await models.stop(); }, log: () => `--- curator ---\n${cur.svc.log.slice(-1500)}\n--- persist ---\n${k8s.svc.log.slice(-1500)}` };
}

const EMB = `[${Array(1024).fill(0.01).join(",")}]`;
/** an idea captured the way capture_idea captures it (idea_capture); its research job is queued by the revision trigger */
async function ideaWithJob(owner: string, title: string) {
  const idea = (await sql<{ id: string }>(`SELECT public.idea_capture($1, 'service:openbrain-mcp', $2, $3, NULL, $4)::text AS id`,
    [owner, title, `${title} statement`, EMB]))[0].id;
  const job = (await sql<{ id: string }>(
    `SELECT id::text FROM public.research_jobs WHERE refinery_id = $1 AND branch_kind = 'idea' ORDER BY created_at DESC LIMIT 1`, [idea]))[0]?.id;
  assert(job, `the capture queued the idea's research job (${idea})`);
  return { idea, job };
}
const plainJob = async (query = "report isolation e2e", extra: Record<string, unknown> = {}) =>
  (await sql<{ id: string }>(
    `INSERT INTO public.research_jobs (status, origin, query, started_at, inlet_ref) VALUES ('running', 'manual', $1, now(), $2::jsonb) RETURNING id::text`,
    [query, extra.inlet_ref ? JSON.stringify(extra.inlet_ref) : null]))[0].id;

interface Mk { report: string; prose: string; claimWord: string; web: string }
const marks = (tag: string): Mk => ({ report: `ReportSecret${tag}`, prose: `ProseSecret${tag}`, claimWord: `claimword${tag.toLowerCase()}`, web: `webpage${tag.toLowerCase()}` });
const pkgFor = (key: string, job: string, mk: Mk) => ({
  // the query is the DERIVED question (rw-identity round 5: shared by design, stamped on the shared web sources), so it
  // carries no report marker; the claim (the report's first paragraph) and the synthesis do
  research_key: key, job_id: job, query: `the derived question ${key}`, claim: `${mk.report} - the report's first paragraph`,
  kind: "deep_research", claim_kind: "descriptive", credibility_model: "lab",
  prose: `A readable report. ${mk.prose}`, needs: [`need ${mk.report}`], report_type: "deep_research",
  synthesis: [
    `${mk.report} opening line of the report.`,
    `[SOURCED] The ${mk.claimWord} alpha result reproduced in 12 trials across two labs. [Source 1]`,
    `[SOURCED] The ${mk.claimWord} beta result held for 40 participants over six months. [Source 1]`,
  ].join("\n"),
  sources: [{ url: `https://example.org/${mk.web}`, title: `web ${mk.web}`, content: `page text ${mk.web} `.repeat(30), domain: "example.org" }],
});
const send = (base: string, body: unknown) =>
  fetch(`${base}/ingest/research-package`, { method: "POST", headers: { "x-brain-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, text: await r.text() })).then((r) => ({ ...r, json: (() => { try { return JSON.parse(r.text); } catch { return {}; } })() as Record<string, any> }));

/** every shared surface the report could reach, for the markers of one run */
async function sharedHits(mk: Mk, key: string, tag: string) {
  const report = [mk.report, mk.prose];
  const out: Record<string, number> = {};
  for (const m of report) {
    out[`sources:${m}`] = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE content LIKE '%'||$1||'%' OR title LIKE '%'||$1||'%' OR metadata::text LIKE '%'||$1||'%' OR coalesce(research_query,'') LIKE '%'||$1||'%'`, [m]))[0].n;
    out[`chunks:${m}`] = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.source_chunks WHERE content LIKE '%'||$1||'%'`, [m]))[0].n;
    out[`threads:${m}`] = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.threads WHERE name LIKE '%'||$1||'%' OR coalesce(description,'') LIKE '%'||$1||'%'`, [m]))[0].n;
    out[`claims:${m}`] = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.claims WHERE text LIKE '%'||$1||'%' OR metadata::text LIKE '%'||$1||'%'`, [m]))[0].n;
    out[`events:${m}`] = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_job_events WHERE payload::text LIKE '%'||$1||'%'`, [m]))[0].n;
    out[`wiki:${m}`] = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE body LIKE '%'||$1||'%' OR title LIKE '%'||$1||'%'`, [m]))[0].n;
  }
  out.synthesisRows = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE content_type = 'research_synthesis' AND research_key = $1`, [key]))[0].n;
  out.mintedThreads = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.threads WHERE name LIKE $1`, [`${tag} T%`]))[0].n;
  return out;
}
const zeroes = (h: Record<string, number>) => Object.entries(h).filter(([, n]) => n !== 0);

async function expectPrivate(L: Awaited<ReturnType<typeof lab>>, r: Awaited<ReturnType<typeof send>>, key: string, job: string, owner: string, idea: string, mk: Mk, tag: string, ctx: string) {
  assert(r.status === 200, `${ctx}: answered ${r.status} ${r.text.slice(0, 400)}\n${L.log()}`);
  eq(r.json.persist?.synthesis_id ?? null, null, `${ctx}: persist names no shared synthesis`);
  eq(r.json.persist?.report, "private", `${ctx}: persist says the report is private`);
  eq(zeroes(await sharedHits(mk, key, tag)), [], `${ctx}: nothing of the report on any shared surface`);
  const p = await sqlMaybe<{ id: string; owner_sub: string; idea_id: string; job_id: string; content: string; prose: string | null; claims: number }>(
    `SELECT p.id::text, p.owner_sub, p.idea_id::text, p.job_id::text, p.content, p.metadata ->> 'prose_synthesis' AS prose,
            (SELECT count(*)::int FROM public.research_private_report_claims pc WHERE pc.report_id = p.id) AS claims
       FROM public.research_private_reports p WHERE p.research_key = $1`, [key]);
  eq(p.length, 1, `${ctx}: one private report`);
  eq([p[0].owner_sub, p[0].idea_id, p[0].job_id], [owner, idea, job], `${ctx}: owned by the idea's owner, on the idea and the job`);
  assert(p[0].content.includes(mk.report) && (p[0].prose ?? "").includes(mk.prose), `${ctx}: the private copy holds the report and its readable prose`);
  // the answer (stored on the job by the research service) names neither the private report nor its text
  assert(!r.text.includes(p[0].id) && !r.text.includes(mk.report) && !r.text.includes(mk.prose), `${ctx}: the curator's answer names the private report: ${r.text.slice(0, 300)}`);
  const ev = await sql<{ payload: Record<string, unknown> }>(`SELECT payload FROM public.research_job_events WHERE job_id = $1 AND type = 'filed'`, [job]);
  eq(ev.length, 1, `${ctx}: one filed event`);
  eq([ev[0].payload.synthesis_id ?? null, ev[0].payload.report], [null, "private"], `${ctx}: the filed event says private, names no report`);
  assert(!JSON.stringify(ev[0].payload).includes(p[0].id), `${ctx}: the event names the private report's id`);
  // the claims drawn from it: SHARED (present, no synthesis), linked to the private report for the owner
  const cl = await sql<{ id: string; synthesis_id: string | null; thread_id: string | null }>(
    `SELECT id::text, synthesis_id::text, thread_id::text FROM public.claims WHERE text LIKE '%'||$1||'%'`, [mk.claimWord]);
  assert(cl.length >= 2, `${ctx}: the claims were filed: ${JSON.stringify(cl)}`);
  eq(cl.filter((c) => c.synthesis_id !== null).length, 0, `${ctx}: no claim points at a report`);
  eq(p[0].claims, cl.length, `${ctx}: every claim is linked to the private report (the owner's way back)`);
  const lookup = await fetch(`${L.k8s.base}/research/lookup?key=${encodeURIComponent(key)}`, { headers: { "x-brain-key": KEY } }).then((x) => x.json());
  eq(lookup.found, false, `${ctx}: the shared reuse lookup does not serve it`);
  return { report: p[0], claims: cl };
}

Deno.test({ name: "RI1: an idea job's report (the idea's branch) is private to the owner: no shared synthesis, thread, chunk, event or wiki text; its claims shared with no report", ...opts, fn: async () => {
  const tag = `RI1${rnd()}`; const L = await lab(tag); const mk = marks(tag);
  try {
    const owner = `owner-a-${rnd()}`;
    const { idea, job } = await ideaWithJob(owner, `idea ${tag}`);
    const key = `rs-${tag}`;
    const r = await send(L.cur.base, pkgFor(key, job, mk));
    const { claims } = await expectPrivate(L, r, key, job, owner, idea, mk, tag, "RI1");
    eq(claims.filter((c) => c.thread_id !== null).length, 0, "RI1: the always-new resolver minted no thread: the claims are unthreaded");
    eq(r.json.thread_decision, "unthreaded", "RI1: the curator says unthreaded");
    // the web source the run gathered is shared knowledge, as for any run
    eq((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE url = $1`, [`https://example.org/${mk.web}`]))[0].n, 1, "RI1: its web source is a shared source");
    // a resend of the same job: still one private report, still nothing shared
    const again = await send(L.cur.base, pkgFor(key, job, mk));
    await expectPrivate(L, again, key, job, owner, idea, mk, tag, "RI1 resend");
  } finally { await L.stop(); }
} });

Deno.test({ name: "RI2: the live shape - a job tied to the idea only by a revision stamp (no refinery_id) - is private too; so is a steer branch of an idea's tree", ...opts, fn: async () => {
  const tag = `RI2${rnd()}`; const L = await lab(tag);
  try {
    const owner = `owner-a-${rnd()}`;
    const { idea } = await ideaWithJob(owner, `idea ${tag}`);
    const job = await plainJob();
    await sql(`UPDATE public.idea_revisions SET research_job_id = $2 WHERE idea_id = $1 AND revision = 1`, [idea, job]);
    await sql(`UPDATE public.research_jobs SET refinery_id = NULL, inlet_ref = NULL WHERE id = $1`, [job]);
    eq((await sql<{ r: string | null }>(`SELECT refinery_id::text AS r FROM public.research_jobs WHERE id = $1`, [job]))[0].r, null, "RI2: the job carries no refinery");
    const mk = marks(tag);
    await expectPrivate(L, await send(L.cur.base, pkgFor(`rs-${tag}`, job, mk)), `rs-${tag}`, job, owner, idea, mk, tag, "RI2 stamp");
    // a steer branch rooted in that idea's research (its tree is the idea's)
    const steer = (await sql<{ id: string }>(
      `INSERT INTO public.research_jobs (status, origin, query, branch_kind, parent_job_id, root_job_id, rooted_step_id, anchor, started_at)
       VALUES ('running', 'manual', 'a steer', 'steer', $1, $1, 'step-1', 'anchor', now()) RETURNING id::text`, [job]))[0].id;
    const mk2 = marks(`${tag}s`);
    await expectPrivate(L, await send(L.cur.base, pkgFor(`rs-${tag}-s`, steer, mk2)), `rs-${tag}-s`, steer, owner, idea, mk2, `${tag}s`, "RI2 steer");
  } finally { await L.stop(); }
} });

Deno.test({ name: "RI3: a non-idea job's report is still a shared source exactly as before - even one whose text and inlet claim to be an idea's", ...opts, fn: async () => {
  const tag = `RI3${rnd()}`; const L = await lab(tag);
  try {
    const { idea } = await ideaWithJob(`owner-a-${rnd()}`, `idea ${tag}`);
    for (const [name, job] of [
      ["plain", await plainJob()],
      // the caller names the inlet (research POST inlet_ref) and the query reads like an idea's: neither makes it one
      ["idea-looking", await plainJob(`Gather evidence to help the user decide whether to build this idea for the ai-stack. Idea: "${tag}"`, { inlet_ref: { kind: "idea", id: idea } })],
    ] as const) {
      const mk = marks(`${tag}${name}`); const key = `rs-${tag}-${name}`;
      const r = await send(L.cur.base, pkgFor(key, job, mk));
      assert(r.status === 200, `${name}: ${r.status} ${r.text.slice(0, 300)}\n${L.log()}`);
      eq(r.json.persist?.report, "shared", `${name}: persist says shared`);
      const s = await sql<{ id: string; content: string; prose: string | null }>(
        `SELECT id::text, content, metadata ->> 'prose_synthesis' AS prose FROM public.sources WHERE content_type = 'research_synthesis' AND research_key = $1`, [key]);
      eq(s.length, 1, `${name}: one shared synthesis source`);
      eq(r.json.persist?.synthesis_id, s[0].id, `${name}: persist names it`);
      assert(s[0].content.includes(mk.report) && (s[0].prose ?? "").includes(mk.prose), `${name}: the shared row carries the report and its prose`);
      eq((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.thread_sources WHERE source_id = $1`, [s[0].id]))[0].n, 1, `${name}: linked into its (new) thread`);
      eq(r.json.thread_decision, "new", `${name}: the resolver minted its thread as before`);
      const cl = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.claims WHERE synthesis_id = $1`, [s[0].id]);
      assert(cl[0].n >= 2, `${name}: its claims point at it`);
      eq((await sqlMaybe<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_private_reports WHERE research_key = $1`, [key]))[0]?.n ?? 0, 0, `${name}: no private copy`);
      const lookup = await fetch(`${L.k8s.base}/research/lookup?key=${encodeURIComponent(key)}`, { headers: { "x-brain-key": KEY } }).then((x) => x.json());
      eq(lookup.found, true, `${name}: the reuse lookup serves it`);
    }
  } finally { await L.stop(); }
} });

Deno.test({ name: "RI4: an idea job attached to an EXISTING thread stays private and never rewrites that thread's description", ...opts, fn: async () => {
  const tag = `RI4${rnd()}`; const L = await lab(tag);
  try {
    const owner = `owner-a-${rnd()}`;
    const { idea, job } = await ideaWithJob(owner, `idea ${tag}`);
    const thread = (await sql<{ id: string }>(`INSERT INTO public.threads (name, description, status) VALUES ($1, 'the shared description', 'active') RETURNING id::text`, [`${tag} existing`]))[0].id;
    const mk = marks(tag); const key = `rs-${tag}`;
    const r = await send(L.cur.base, { ...pkgFor(key, job, mk), thread_id: thread });
    await expectPrivate(L, r, key, job, owner, idea, mk, tag, "RI4");
    eq(r.json.thread_id, thread, "RI4: filed into the explicit thread");
    await sleep(1500); // the (skipped) refresh would be fire-and-forget
    eq((await sql<{ d: string }>(`SELECT description AS d FROM public.threads WHERE id = $1`, [thread]))[0].d, "the shared description", "RI4: the thread's description is untouched");
  } finally { await L.stop(); }
} });

Deno.test({ name: "RI5 (round 2, tester F1): two users whose ideas read alike share a research_key - each keeps their own private report, claims and prose, in either filing order", ...opts, fn: async () => {
  const tag = `RI5${rnd()}`; const L = await lab(tag);
  try {
    const ownerA = `owner-a-${rnd()}`, ownerB = `owner-b-${rnd()}`;
    const a = await ideaWithJob(ownerA, `Dark mode ${tag}`);
    const b = await ideaWithJob(ownerB, `Dark mode ${tag}`);
    const qs = await sql<{ q: string }>(`SELECT query AS q FROM public.research_jobs WHERE id IN ($1::uuid, $2::uuid)`, [a.job, b.job]);
    eq(qs[0].q, qs[1].q, "RI5: the two ideas' research questions are identical (so the research service keys them alike)");
    const key = `rs-${tag}`; const mkA = marks(`${tag}a`), mkB = marks(`${tag}b`);
    const rows = async () => await sql<{ owner_sub: string; idea_id: string; job_id: string; content: string; prose: string | null; claims: string[] }>(
      `SELECT p.owner_sub, p.idea_id::text, p.job_id::text, p.content, p.metadata ->> 'prose_synthesis' AS prose,
              coalesce((SELECT array_agg(c.text ORDER BY c.text) FROM public.research_private_report_claims pc JOIN public.claims c ON c.id = pc.claim_id WHERE pc.report_id = p.id), '{}') AS claims
         FROM public.research_private_reports p WHERE p.research_key = $1 ORDER BY p.owner_sub`, [key]);
    const check = async (ctx: string, proseA: string, proseB: string) => {
      const r = await rows();
      eq(r.map((x) => [x.owner_sub, x.idea_id, x.job_id]), [[ownerA, a.idea, a.job], [ownerB, b.idea, b.job]], `${ctx}: one private row per user`);
      assert(r[0].content.includes(mkA.report) && !r[0].content.includes(mkB.report), `${ctx}: A's row holds A's report only`);
      assert(r[1].content.includes(mkB.report) && !r[1].content.includes(mkA.report), `${ctx}: B's row holds B's report only`);
      eq([r[0].prose, r[1].prose], [`A readable report. ${proseA}`, `A readable report. ${proseB}`], `${ctx}: each row carries its own prose`);
      assert(r[0].claims.length >= 2 && r[0].claims.every((t) => t.includes(mkA.claimWord)), `${ctx}: A's claims link to A's report only: ${JSON.stringify(r[0].claims)}`);
      assert(r[1].claims.length >= 2 && r[1].claims.every((t) => t.includes(mkB.claimWord)), `${ctx}: B's claims link to B's report only: ${JSON.stringify(r[1].claims)}`);
    };
    let ra = await send(L.cur.base, pkgFor(key, a.job, mkA));
    assert(ra.status === 200, `A: ${ra.status} ${ra.text.slice(0, 300)}\n${L.log()}`);
    const rb = await send(L.cur.base, pkgFor(key, b.job, mkB));
    assert(rb.status === 200, `B: ${rb.status} ${rb.text.slice(0, 300)}\n${L.log()}`);
    await check("A then B", mkA.prose, mkB.prose);
    // the stamp order: A files again AFTER B (a resend, new prose) - A's own row moves, B's does not
    const proseA2 = `${mkA.prose}-second`;
    ra = await send(L.cur.base, { ...pkgFor(key, a.job, mkA), prose: `A readable report. ${proseA2}` });
    assert(ra.status === 200, `A again: ${ra.status}\n${L.log()}`);
    await check("A again after B", proseA2, mkB.prose);
  } finally { await L.stop(); }
} });

const RESEARCH_DIR = Deno.env.get("RI_E2E_RESEARCH_DIR") ?? "/research";
Deno.test({ name: "RI6 (round 2): the research service's job view (GET /research/jobs/:id) withholds an idea job's report from anyone but the idea's owner - the default subject included", ...opts, fn: async () => {
  const v = await import(`file://${RESEARCH_DIR}/viewer.ts`) as {
    FOREIGN_PROMPTS_SQL: string; sharedJobView: (job: Record<string, unknown>, o?: { privateReport?: boolean }) => Record<string, unknown>;
  };
  const tag = `RI6${rnd()}`; const owner = `owner-a-${rnd()}`;
  const { job } = await ideaWithJob(owner, `idea ${tag}`);
  const secret = `JobReportSecret${tag}`;
  await sql(`UPDATE public.research_jobs SET status = 'done', result = jsonb_build_object('outcome', 'complete', 'synthesis', $2::text, 'cited_sources', '[]'::jsonb) WHERE id = $1`, [job, secret]);
  const row = (await sql<Record<string, unknown>>(`SELECT id::text AS id, status, result FROM public.research_jobs WHERE id = $1`, [job]))[0];
  // the viewer: another user, the default subject (an ownerless job is the default subject's), the owner
  for (const [who, viewer, dflt, foreign] of [["another user", `other-${rnd()}`, "", true], ["the default subject", "operator", "operator", true], ["the owner", owner, "operator", false]] as const) {
    const s = (await sql<{ foreign_: boolean; private_report: boolean | undefined }>(v.FOREIGN_PROMPTS_SQL, [job, viewer, dflt]))[0];
    eq(!!s.foreign_, foreign, `RI6 ${who}: foreign`);
    const view = s.foreign_ ? v.sharedJobView(row, { privateReport: !!s.private_report }) : row;
    eq(JSON.stringify(view).includes(secret), !foreign, `RI6 ${who}: the report ${foreign ? "is withheld" : "is the owner's"}`);
  }
} });
