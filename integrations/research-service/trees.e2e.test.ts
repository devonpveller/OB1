/**
 * trees.e2e.test.ts - research-workbench P4a (rw-p4a-trees) against a LAB database.
 *
 * The REAL research service (index.ts, spawned as its own process exactly as the container runs it)
 * against a throwaway Postgres carrying the full initdb chain (260-init-research-trees.sql included),
 * a stub LLM gateway (which also answers llm-queue's GET /observe/queue/estimate pass-through) and a
 * stub curator. The SQL paths (claim order, gap branches, the claim graph, idea engagement, the
 * schema's refusals) run through tree.ts / jobs.ts directly on the same database.
 *
 * IGNORED unless TREES_E2E_DB_HOST is set (run-trees-e2e.ps1 sets it inside a disposable internal
 * network). Never point it at a live database: every test cancels queued/running research_jobs.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { claimNext } from "./jobs.ts";
import { resolveContract } from "./contract.ts";
import { appendEvent, createSteer, interHubGaps, loadClaimGraph, openGapBranches } from "./tree.ts";

const DB_HOST = Deno.env.get("TREES_E2E_DB_HOST") ?? "";
const DB_PORT = Deno.env.get("TREES_E2E_DB_PORT") ?? "5432";
const DB_PASSWORD = Deno.env.get("TREES_E2E_DB_PASSWORD") ?? "test";
const SERVICE_DIR: string | URL = Deno.env.get("TREES_E2E_SERVICE_DIR") ?? new URL(".", import.meta.url);
const KEY = "e2e-test-key";
const ROOT_KEY = "root-llm-key", BRANCH_KEY = "branch-llm-key";
const ignore = !DB_HOST;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };

const pool = ignore ? null : new Pool({ hostname: DB_HOST, port: Number(DB_PORT), database: "openbrain", user: "postgres", password: DB_PASSWORD }, 3, true);
async function sql<T>(q: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(q, args)).rows; } finally { c.release(); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms: number, svc?: { log: string }): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v as T; await sleep(200); }
  throw new Error(`timed out after ${ms}ms waiting for: ${what}${svc ? `\n--- service log (tail) ---\n${svc.log.slice(-3000)}` : ""}`);
}
async function cleanup() {
  await sql(`UPDATE research_jobs SET status='cancelled', finished_at=now(), error='e2e cleanup' WHERE status IN ('queued','running')`);
}

// ── stubs ───────────────────────────────────────────────────────────────────────────────────
const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();
function stubGateway(o: { lane?: () => { status: number; body: unknown } } = {}) {
  const held = new Set<string>();
  let wake: () => void = () => {};
  let gate = new Promise<void>((r) => { wake = r; });
  const seen: Array<{ auth: string; user: string; kind: string }> = [];
  let blocked = 0;
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/observe/queue/estimate")) {
      const l = o.lane ? o.lane() : { status: 200, body: { max_concurrency: 2, capacity_declared: true } };
      return Response.json(l.body, { status: l.status });
    }
    const raw = await req.text();
    // deno-lint-ignore no-explicit-any
    const body: any = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    if (u.pathname.endsWith("/embeddings")) return Response.json({ data: [{ embedding: VEC }] });
    const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const sys = String(body?.messages?.[0]?.content ?? "");
    seen.push({ auth, user: String(body?.user ?? ""), kind: sys.slice(0, 40) });
    if (body?.max_tokens === 1) return Response.json({ choices: [{ message: { content: "ok" } }] });
    // hold a ROOT-key request whose text carries a held token (a branch, under its own key, is never held)
    while (auth === ROOT_KEY && [...held].some((t) => raw.includes(t))) { blocked++; await gate; blocked--; }
    let content = "{}";
    if (sys.includes("CURRENT TOPIC")) content = JSON.stringify({ topic: "Soil pH for tomato beds" });
    else if (sys.includes("INJECTION or CLEAN") || sys.includes("You screen fetched web content")) content = "CLEAN";
    else if (sys.includes("RELEVANT or IRRELEVANT") || sys.includes("You screen a fetched web page")) content = "RELEVANT";
    else if (sys.includes("ENTAILMENT JUDGE")) content = JSON.stringify({ verdict: "supports" });
    else if (sys.includes("grounded synthesizer")) content = "[SOURCED] Loosen the soil and add compost. [Source 1]";
    else if (!body?.response_format) content = "A short report.";
    return Response.json({ choices: [{ message: { content } }] });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}/v1`, seen,
    hold(t: string) { held.add(t); },
    release(t: string) { held.delete(t); const w = wake; gate = new Promise<void>((r) => { wake = r; }); w(); },
    get blocked() { return blocked; },
    async close() { held.clear(); wake(); ac.abort(); await server.finished; },
  };
}
function stubCurator() {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    await req.text();
    return Response.json({ thread_id: null, persist: { sources_written: 1 }, claims: { claimsWritten: 0, filed: [] } });
  });
  return { url: `http://127.0.0.1:${server.addr.port}`, async close() { ac.abort(); await server.finished; } };
}
function freePort(): number { const l = Deno.listen({ port: 0, hostname: "127.0.0.1" }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; }

async function startService(gwBase: string, curatorUrl: string, extraEnv: Record<string, string> = {}) {
  await cleanup();
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", "index.ts"], cwd: SERVICE_DIR,
    env: {
      PORT: String(port), DB_HOST, DB_PORT, DB_NAME: "openbrain", DB_USER: "postgres", DB_PASSWORD,
      MCP_ACCESS_KEY: KEY, CHAT_API_BASE: gwBase, EMBEDDING_API_BASE: gwBase, CURATOR_URL: curatorUrl,
      CHAT_API_KEY: ROOT_KEY, RESEARCH_BRANCH_LLM_KEY: BRANCH_KEY, RESEARCH_LANE_REFRESH_MS: "1000",
      SEARCH_API_BASE: "http://127.0.0.1:9", FETCH_PROXY_URL: "", OWUI_BASE_URL: "", CALLBACK_MIN_AGE_MS: "0",
      CHAT_DOWN_BUDGET_MS: "4000", RESEARCH_MODEL_PROBE_MS: "1000", RESEARCH_MODEL_PROBE_TIMEOUT_MS: "3000", NO_COLOR: "1",
      ...extraEnv,
    },
    stdout: "piped", stderr: "piped",
  }).spawn();
  let log = "";
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const ch of s.pipeThrough(new TextDecoderStream())) log += ch; };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/health`); await r.body?.cancel(); if (r.ok) break; } catch { /* booting */ }
    await sleep(200);
  }
  return { base, get log() { return log; }, async stop() { try { child.kill(); } catch { /* gone */ } await child.status; await pumps.catch(() => {}); } };
}
type Svc = Awaited<ReturnType<typeof startService>>;
async function withStack(fn: (gw: ReturnType<typeof stubGateway>, svc: Svc) => Promise<void>, o: { lane?: () => { status: number; body: unknown }; env?: Record<string, string> } = {}) {
  const gw = stubGateway({ lane: o.lane });
  const cur = stubCurator();
  const svc = await startService(gw.base, cur.url, o.env);
  try { await fn(gw, svc); } finally { await svc.stop(); await gw.close(); await cur.close(); }
}
async function submit(base: string, query: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(`${base}/research`, {
    method: "POST", headers: { "x-brain-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({
      query, origin: "manual", mode: "article", disable_web_search: true, dry_run: true,
      seed_sources: [{ url: "https://garden.example/soil", title: "Preparing soil", content: `${query}. Loosen the soil, add compost, test the pH and water deeply before planting. `.repeat(4) }],
      ...extra,
    }),
  });
  const b = await r.json();
  assertEquals(r.status, 202, JSON.stringify(b));
  return b.job_id;
}
const steer = (base: string, id: string, body: Record<string, unknown>) =>
  fetch(`${base}/research/jobs/${id}/steer`, { method: "POST", headers: { "x-brain-key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
const job = async (id: string) => (await sql<{ status: string; parent_job_id: string | null; root_job_id: string | null; rooted_step_id: string | null; branch_kind: string; anchor: string | null; query: string; options: Record<string, unknown>; started_at: Date | null }>(
  `SELECT status, parent_job_id::text, root_job_id::text, rooted_step_id, branch_kind, anchor, query, options, started_at FROM research_jobs WHERE id=$1`, [id]))[0];
const stageEvents = (id: string) => sql<{ step_id: string; kind: string; payload: Record<string, unknown> }>(
  `SELECT step_id, kind, payload FROM research_job_events WHERE job_id=$1 AND type='stage' ORDER BY id`, [id]);

// ── Cases 1-5, 12: a steer on a running job, through the real service ─────────────────────
Deno.test({ name: "T1 a steer on a RUNNING job opens a child that starts while the parent still runs; record, report, learning records", ...opts, fn: async () => {
  await withStack(async (gw, svc) => {
    gw.hold("HOLDA");
    const parentQ = "HOLDA How do I prepare garden soil?";
    const pid = await submit(svc.base, parentQ, { options: { contract: { sources: { allow: ["garden.example"] }, budget: { max_fetch: 10, rounds: 2 } } } });
    await until("parent running, held in a model call, with a stage event", async () =>
      (await job(pid)).status === "running" && gw.blocked > 0 && (await stageEvents(pid)).length > 0, 30_000, svc);
    const steps = await stageEvents(pid);
    assertEquals(steps[0].step_id, "s1");
    for (const s of steps) assert(s.kind === "steering" || s.kind === "due_process", `stage ${s.step_id} marker ${s.kind}`);

    // refusals: no step, unknown step, a widened contract
    assertEquals((await steer(svc.base, pid, { text: "x" })).status, 400);
    assertEquals((await steer(svc.base, pid, { step_id: "s99", text: "x" })).status, 400);
    const wide = await steer(svc.base, pid, { step_id: "s1", text: "x", contract: { sources: { allow: ["example.com"] } } });
    assertEquals(wide.status, 400, "a widened contract is refused");
    assert(/widens/.test(JSON.stringify(await wide.json())));
    const before = await job(pid);

    const r = await steer(svc.base, pid, { step_id: "s1", text: "focus on soil pH for tomatoes", contract: { budget: { max_fetch: 50, rounds: 1 } } });
    const opened = await r.json();
    assertEquals(r.status, 201, JSON.stringify(opened));
    const child = await job(opened.child_job_id);
    assertEquals([child.parent_job_id, child.root_job_id, child.rooted_step_id, child.branch_kind], [pid, pid, "s1", "steer"]);
    assertEquals(child.anchor, parentQ, "the child's anchor is the parent's research_jobs.query");
    const cc = resolveContract(child.options)!;
    assertEquals(cc.budget, { maxFetch: 10, rounds: 1 }, "child contract clamped against the parent's (max_fetch 50 -> 10)");
    assertEquals(cc.allowDomains, ["garden.example"], "the parent's allow-list is inherited");
    assertEquals((await job(pid)).status, before.status, "the parent's status does not change");

    // the child emits its first stage event WHILE the parent is still running
    await until("child's first stage event", async () => (await stageEvents(opened.child_job_id)).length > 0, 30_000, svc);
    assertEquals((await job(pid)).status, "running", "the parent is still running when the child has emitted a stage event");
    assert(gw.seen.some((s) => s.auth === BRANCH_KEY && s.user === "research-branch"), "the branch called the model under its own key, in the research-branch lane");
    assert(!gw.seen.some((s) => s.auth === ROOT_KEY && s.user === "research-branch"));

    // the steer record: estimate + anchor at the moment of the steer; the event is a human steer
    const st = (await sql<{ steer_kind: string; topic_estimate: string; anchor: string; step_id: string }>(
      `SELECT steer_kind, topic_estimate, anchor, step_id FROM research_steers WHERE child_job_id=$1`, [opened.child_job_id]))[0];
    assertEquals(st, { steer_kind: "human", topic_estimate: parentQ, anchor: parentQ, step_id: "s1" });
    const hs = await sql<{ kind: string; payload: Record<string, unknown> }>(
      `SELECT kind, payload FROM research_job_events WHERE job_id=$1 AND type='human_steer'`, [pid]);
    assertEquals(hs.length, 1);
    assertEquals([hs[0].kind, hs[0].payload.step_id, hs[0].payload.topic_estimate, hs[0].payload.anchor], ["steering", "s1", parentQ, parentQ]);

    await until("child closed", async () => ["done", "error"].includes((await job(opened.child_job_id)).status), 60_000, svc);
    gw.release("HOLDA");
    await until("parent closed", async () => ["done", "error"].includes((await job(pid)).status), 60_000, svc);
    const tree = await until("tree report re-estimated", async () => {
      const t = await (await fetch(`${svc.base}/research/jobs/${pid}/tree`, { headers: { "x-brain-key": KEY } })).json();
      return t.topic_estimate === "Soil pH for tomato beds" ? t : null;
    }, 30_000, svc);
    // the tree report: around the estimate, the prompt as origin, parent + every closed child
    assert(tree.report.markdown.startsWith("# Soil pH for tomato beds\n"), tree.report.markdown.slice(0, 80));
    assert(tree.report.markdown.includes(`_Origin: ${parentQ}_`));
    assertEquals(tree.report.branches.map((b: { job_id: string }) => b.job_id).sort(), [pid, opened.child_job_id].sort());
    const stored = (await sql<{ tree_report: { heading: string } }>(`SELECT tree_report FROM research_jobs WHERE id=$1`, [pid]))[0];
    assertEquals(stored.tree_report.heading, "Soil pH for tomato beds");
    // the session record shows where the operator steered
    assertEquals(tree.steers.map((s: { step_id: string; steer_kind: string }) => [s.steer_kind, s.step_id]), [["human", "s1"]]);
    // exploratory learning records, one per branch, derived from the tree
    assertEquals(tree.learning_records.length, 2);
    const lc = tree.learning_records.find((x: { source_ref: { branch_id: string } }) => x.source_ref.branch_id === opened.child_job_id);
    assert(lc.steer.includes("human steer at s1: focus on soil pH for tomatoes"), lc.steer);
    assertEquals([lc.fidelity, lc.producer], ["exploratory", "job-tree"]);
    const lp = tree.learning_records.find((x: { source_ref: { branch_id: string } }) => x.source_ref.branch_id === pid);
    assert(lp.deviation.includes("a human steer answered it at s1"), lp.deviation);
    // every event carries the marker; a branch_close was logged
    const kinds = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM research_job_events WHERE root_job_id=$1 AND kind NOT IN ('steering','due_process')`, [pid]);
    assertEquals(kinds[0].n, 0);
    assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM research_job_events WHERE job_id=$1 AND type='branch_close'`, [opened.child_job_id]))[0].n, 1);
  });
}});

// ── Case 7: the dispatcher's concurrency is the lane, read back from llm-queue ───────────────
Deno.test({ name: "T2 the research service runs as many jobs as the lane says; a raised lane raises it; unreadable = 2 with a warning; RESEARCH_MAX_CONCURRENCY is ignored", ...opts, fn: async () => {
  let lane: { status: number; body: unknown } = { status: 200, body: { max_concurrency: 3, capacity_declared: true } };
  await withStack(async (gw, svc) => {
    gw.hold("HOLDB");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await submit(svc.base, `HOLDB question ${i} about garden soil`));
    const running = async () => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM research_jobs WHERE id = ANY($1::uuid[]) AND status='running'`, [ids]))[0].n;
    await until("3 running (lane 3; RESEARCH_MAX_CONCURRENCY=1 ignored)", async () => (await running()) === 3, 30_000, svc);
    await sleep(2500);
    assertEquals(await running(), 3, "never more than the lane");
    lane = { status: 200, body: { max_concurrency: 4, capacity_declared: true } };
    await until("4 running after the lane is raised", async () => (await running()) === 4, 30_000, svc);
    assert(/lane concurrency 3 -> 4/.test(svc.log), svc.log.slice(-1500));
    lane = { status: 503, body: {} };
    await until("the floor with a warning", async () => /WARNING research-branch capacity unreadable \(HTTP 503\); running at the floor 2/.test(svc.log) && /lane concurrency 4 -> 2/.test(svc.log), 30_000, svc);
    assert(/RESEARCH_MAX_CONCURRENCY is set and IGNORED/.test(svc.log));
    gw.release("HOLDB");
  }, { lane: () => lane, env: { RESEARCH_MAX_CONCURRENCY: "1" } });
}});

// ── Cases 6, 8, 9, 10: gap work, D3 order, inter-hub gaps - on the lab DB ────────────────────
async function rootRow(query: string, status = "running"): Promise<string> {
  const r = await sql<{ id: string }>(`INSERT INTO research_jobs (status, origin, query, started_at) VALUES ($1, 'manual', $2, now()) RETURNING id::text`, [status, query]);
  const c = await pool!.connect();
  try { await appendEvent(c, r[0].id, r[0].id, { type: "stage", kind: "due_process", payload: { phase: "reuse" } }); } finally { c.release(); }
  return r[0].id;
}
Deno.test({ name: "T3 D3: with a gap branch and an inter-hub branch queued first, a later human steer in the same tree is claimed first", ...opts, fn: async () => {
  await cleanup();
  const root = await rootRow("What limits tomato yield?");
  const c = await pool!.connect();
  try {
    const gaps = await openGapBranches(c, root, "s1", [
      { kind: "gap", text: "compost raises pH", query: "Verify: compost raises pH", ref: "claim:x", gap: { claim_id: "x", score: 0.2, threshold: 0.5 } },
      { kind: "interhub", text: "a <-> b", query: "How does a relate to b?", ref: "interhub:a|b", gap: { a: {}, b: {}, density: 0 } },
    ], 5, resolveContract);
    assertEquals(gaps.length, 2);
    // dedupe: the same gap again opens nothing
    assertEquals((await openGapBranches(c, root, "s1", [{ kind: "gap", text: "compost raises pH", query: "q", ref: "claim:x", gap: { claim_id: "x", score: 0.2, threshold: 0.5 } }], 5, resolveContract)).length, 0);
    await sleep(50);
    const s = await createSteer(c, { parentId: root, stepId: "s1", text: "look at watering instead" }, resolveContract);
    const first = await claimNext(c);
    assertEquals(first?.jobId, s.child_job_id, "the human steer's branch is claimed ahead of the older gap work");
    assertEquals(first?.branch_kind, "steer");
    const second = await claimNext(c);
    assert(second && ["gap", "interhub"].includes(second.branch_kind!), "then gap work");
    const ev = await sql<{ type: string; payload: Record<string, unknown> }>(`SELECT type, payload FROM research_job_events WHERE job_id=$1 AND type IN ('human_steer','gap','interhub_gap')`, [root]);
    assertEquals(ev.map((e) => e.type), ["human_steer"], "the steer is logged as a human steer, never as a gap");
    const kinds = await sql<{ steer_kind: string }>(`SELECT steer_kind FROM research_steers WHERE root_job_id=$1 ORDER BY created_at`, [root]);
    assertEquals(kinds.map((k) => k.steer_kind), ["gap", "interhub", "human"]);
  } finally { c.release(); }
}});

Deno.test({ name: "T4 D15 through the real service: a below-threshold recalled claim is a gap event + a gap branch; an above-threshold one is neither", ...opts, fn: async () => {
  await cleanup();
  const vec = `[${VEC.join(",")}]`;
  const low = (await sql<{ id: string }>(`INSERT INTO claims (text, confidence, embedding, volatility) VALUES ('Tomatoes need soil pH between 6.2 and 6.8', 0.2, $1::vector, 'slow') RETURNING id::text`, [vec]))[0].id;
  const high = (await sql<{ id: string }>(`INSERT INTO claims (text, confidence, embedding, volatility) VALUES ('Compost improves the structure of garden soil', 0.9, $1::vector, 'slow') RETURNING id::text`, [vec]))[0].id;
  try {
    await withStack(async (_gw, svc) => {
      const pid = await submit(svc.base, "How do I prepare garden soil for tomatoes?");
      await until("parent closed", async () => ["done", "error"].includes((await job(pid)).status), 60_000, svc);
      const gaps = await sql<{ payload: Record<string, unknown>; kind: string }>(`SELECT payload, kind FROM research_job_events WHERE job_id=$1 AND type='gap'`, [pid]);
      assertEquals(gaps.map((g) => g.payload.claim_id), [low], "exactly one gap event, naming the below-threshold claim");
      assertEquals([Number(gaps[0].payload.score).toFixed(2), gaps[0].payload.threshold, gaps[0].kind], ["0.20", 0.5, "steering"]);
      const branches = await sql<{ gap_ref: string; branch_kind: string }>(`SELECT gap_ref, branch_kind FROM research_jobs WHERE parent_job_id=$1`, [pid]);
      assertEquals(branches, [{ gap_ref: `claim:${low}`, branch_kind: "gap" }], "one gap branch for the low claim, none for the high one");
      assert(!branches.some((b) => b.gap_ref === `claim:${high}`));
    });
  } finally {
    await sql(`UPDATE claims SET status='retracted' WHERE id = ANY($1::uuid[])`, [[low, high]]);
  }
}});

Deno.test({ name: "T5 D1: inter-hub gaps come from link density over the stored claim graph - no topic or hub table", ...opts, fn: async () => {
  const src = async (u: string) => (await sql<{ id: string }>(`INSERT INTO sources (url, title, content) VALUES ($1, $1, 'x') RETURNING id::text`, [u]))[0].id;
  const claim = async (t: string) => (await sql<{ id: string }>(`INSERT INTO claims (text, confidence) VALUES ($1, 0.8) RETURNING id::text`, [t]))[0].id;
  const tag = crypto.randomUUID().slice(0, 8);
  const A = [await claim(`irrigation a1 ${tag}`), await claim(`irrigation a2 ${tag}`), await claim(`irrigation a3 ${tag}`)];
  const B = [await claim(`pests b1 ${tag}`), await claim(`pests b2 ${tag}`), await claim(`pests b3 ${tag}`)];
  const sa = [await src(`https://a1.example/${tag}`), await src(`https://a2.example/${tag}`)];
  const sb = [await src(`https://b1.example/${tag}`), await src(`https://b2.example/${tag}`)];
  const bridge = await src(`https://bridge.example/${tag}`);
  const edge = (c: string, s: string) => sql(`INSERT INTO claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states')`, [c, s]);
  for (const c of A) for (const s of sa) await edge(c, s);
  for (const c of B) for (const s of sb) await edge(c, s);
  await edge(A[2], bridge); await edge(B[0], bridge);
  const c = await pool!.connect();
  try {
    const g = await loadClaimGraph(c, [A[0], B[0]], []);
    assertEquals(g.nodes.length, 6);
    const gaps = interHubGaps(g.nodes, g.edges);
    assertEquals(gaps.length, 1, JSON.stringify(gaps));
    assertEquals(gaps[0].links, 1);
    assert(gaps[0].density > 0 && gaps[0].density < 0.2);
    const t = await sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ~ 'topic' OR table_name ~ 'hub')`);
    assertEquals(t, [], "no topic or hub table");
  } finally { c.release(); }
}});

// ── Case 11: on-demand idea engagement ───────────────────────────────────────────────────────
Deno.test({ name: "T6 an idea captured or changed is queued at once; a change during a run queues exactly one follow-up", ...opts, fn: async () => {
  await cleanup();
  const idea = (await sql<{ id: string }>(`INSERT INTO ideas (title, summary) VALUES ('Soil sensor', 'a cheap soil pH sensor') RETURNING id::text`))[0].id;
  const rev = (n: number, s: string) => sql(`INSERT INTO idea_revisions (idea_id, revision, summary) VALUES ($1, $2, $3)`, [idea, n, s]);
  const jobs = () => sql<{ id: string; status: string; query: string; options: Record<string, unknown>; branch_kind: string }>(
    `SELECT id::text, status, query, options, branch_kind FROM research_jobs WHERE refinery_id=$1 ORDER BY created_at`, [idea]);
  await rev(1, "a cheap soil pH sensor");
  let j = await jobs();
  assertEquals(j.length, 1, "captured -> queued at once, no schedule");
  assertEquals([j[0].status, j[0].branch_kind, j[0].options.lane, j[0].options.idea_revision], ["queued", "idea", "research-branch", 1]);
  assert(j[0].query.includes("Do NOT judge whether it is worth building") && j[0].query.includes("a cheap soil pH sensor"));
  const stamped = await sql<{ research_job_id: string }>(`SELECT research_job_id FROM idea_revisions WHERE idea_id=$1 AND revision=1`, [idea]);
  assertEquals(stamped[0].research_job_id, j[0].id, "the revision is stamped with the job that researches it");
  await rev(2, "a cheap soil pH and moisture sensor");
  j = await jobs();
  assertEquals(j.length, 1, "a change before the run folds into the queued job");
  assertEquals(j[0].options.idea_revision, 2);
  // the run starts (the dispatcher's claim), then two changes arrive during it
  const c = await pool!.connect();
  try { const claimed = await claimNext(c); assertEquals(claimed?.jobId, j[0].id); } finally { c.release(); }
  await rev(3, "v3");
  await rev(4, "v4");
  j = await jobs();
  assertEquals(j.map((x) => x.status), ["running", "queued"], "exactly one follow-up run for the changes during the run");
  assertEquals(j[1].options.idea_revision, 4, "the follow-up researches the latest revision");
  const revs = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM idea_revisions WHERE idea_id=$1`, [idea]);
  assertEquals(revs[0].n, 4, "each change is appended as a revision");
  const last = await sql<{ last_job_id: string }>(`SELECT last_job_id FROM ideas WHERE id=$1`, [idea]);
  assertEquals(last[0].last_job_id, j[1].id);
}});

// ── Cases 3 and 5: the schema refuses an unmarked event, a trail-less source event, a steer without what it was made against
Deno.test({ name: "T7 the schema refuses an event without its marker, a source event without a trail, and a steer record without estimate/anchor", ...opts, fn: async () => {
  const root = await rootRow("schema refusals");
  await assertRejects(() => sql(`INSERT INTO research_job_events (job_id, root_job_id, step_id, type, kind) VALUES ($1, $1, 's9', 'stage', NULL)`, [root]));
  await assertRejects(() => sql(`INSERT INTO research_job_events (job_id, root_job_id, type, kind) VALUES ($1, $1, 'source', 'due_process')`, [root]));
  await assertRejects(() => sql(`INSERT INTO research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'human_steer', 'steering', '{"step_id":"s1"}')`, [root]));
  const child = (await sql<{ id: string }>(`INSERT INTO research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor) VALUES ('cancelled','manual','c',$1,$1,'s1','steer','schema refusals') RETURNING id::text`, [root]))[0].id;
  await assertRejects(() => sql(`INSERT INTO research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor) VALUES ($1,$1,$2,'human','s1','t',NULL,'a')`, [root, child]));
  await assertRejects(() => sql(`INSERT INTO research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor) VALUES ($1,$1,$2,'human','s1','t','e','')`, [root, child]));
  await assertRejects(() => sql(`INSERT INTO research_jobs (status, origin, query, branch_kind) VALUES ('cancelled','manual','orphan branch','steer')`));
  // the service role can write what the service writes (RLS + grants)
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN"); await c.queryObject("SET LOCAL ROLE service_role");
    await appendEvent(c, root, root, { type: "source", kind: "due_process", trail: { url: "https://x.example" }, payload: {} });
    await c.queryObject("ROLLBACK");
  } finally { c.release(); }
}});
