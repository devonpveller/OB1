/**
 * failfast.e2e.test.ts — the REAL research service (index.ts, run as its own
 * process exactly as the container runs it) against a real throwaway Postgres
 * (the OB1 init schema), a stub LLM gateway that can be DOWN (serving the exact
 * 2026-10-13 upstream-down 502 body), UP, 429, or BLOCKING, and a stub curator.
 * The caller side uses the REAL daily-digest ResearchClient.
 *
 * Needs a throwaway DB, so it is IGNORED (reported as ignored, never as passed)
 * unless RESEARCH_E2E_DB_HOST is set. Never point it at a live database: every
 * test cancels all queued/running research_jobs rows before it starts.
 *
 *   docker run -d --rm --name <name> -e POSTGRES_DB=openbrain -e POSTGRES_PASSWORD=test \
 *     -p 127.0.0.1:55432:5432 -v <dir with OB1/docker init-*.sql, numbered>:/docker-entrypoint-initdb.d:ro \
 *     pgvector/pgvector:pg16
 *   RESEARCH_E2E_DB_HOST=127.0.0.1 RESEARCH_E2E_DB_PORT=55432 \
 *     deno test --allow-net --allow-env --allow-read --allow-run failfast.e2e.test.ts
 *
 * RESEARCH_E2E_SERVICE_DIR / RESEARCH_E2E_CLIENT_PATH point it at another
 * checkout of the service / client (used to show RED at the pre-fix base).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { REAL_DOWN_502 } from "./fixtures/upstream-down.ts";
import { GATEWAY_BODIES } from "./fixtures/gateway-bodies.ts";

const DB_HOST = Deno.env.get("RESEARCH_E2E_DB_HOST") ?? "";
const DB_PORT = Deno.env.get("RESEARCH_E2E_DB_PORT") ?? "5432";
const DB_PASSWORD = Deno.env.get("RESEARCH_E2E_DB_PASSWORD") ?? "test";
const SERVICE_DIR: string | URL = Deno.env.get("RESEARCH_E2E_SERVICE_DIR") ?? new URL(".", import.meta.url);
const CLIENT_PATH = Deno.env.get("RESEARCH_E2E_CLIENT_PATH") ??
  new URL("../../recipes/daily-digest/src/enrich/research-client.ts", import.meta.url).href;
const KEY = "e2e-test-key";
const ignore = !DB_HOST;

const pool = ignore ? null : new Pool({ hostname: DB_HOST, port: Number(DB_PORT), database: "openbrain", user: "postgres", password: DB_PASSWORD }, 2, true);

async function sql<T>(q: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(q, args)).rows; } finally { c.release(); }
}

type GwMode = "down" | "up" | "429" | "block" | "down-after-synthesis" | "body";

/** blockAt: block only the n-th model request (1-based) until release.
 *  downFirst: answer the first n model requests with the real down 502.
 *  body: in mode "body", answer every model request with {status, body}. */
function stubGateway(initial: GwMode, o: { blockAt?: number; downFirst?: number; body?: { status: number; body: string } } = {}) {
  let mode: GwMode = initial;
  let chats = 0, inFlight = 0, maxInFlight = 0, blocked = 0, synthServed = false;
  let downFirst = o.downFirst ?? 0;
  const kinds: string[] = [];
  let release: () => void = () => {};
  let gate = new Promise<void>((r) => { release = r; });
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    if (u.pathname.endsWith("/embeddings")) {
      const v = new Array(1024).fill(0); v[0] = 1;
      return Response.json({ data: [{ embedding: v }] });
    }
    chats++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const sys = String(body?.messages?.[0]?.content ?? "");
    const kind = body?.max_tokens === 1 ? "probe" : sys.includes("INJECTION or CLEAN") ? "inj" : sys.includes("RELEVANT or IRRELEVANT") ? "rel" : sys.includes("grounded synthesizer") ? "synth" : "other";
    const n = chats;
    let status = 200;
    try {
      if (mode === "block" || o.blockAt === n) { blocked++; await gate; }
      if (downFirst > 0 && kind !== "probe") { downFirst--; status = 502; return new Response(REAL_DOWN_502, { status: 502, headers: { "content-type": "application/json" } }); }
      if (mode === "down-after-synthesis" && synthServed) mode = "down";
      if (mode === "down") { status = 502; return new Response(REAL_DOWN_502, { status: 502, headers: { "content-type": "application/json" } }); }
      if (mode === "body" && o.body) { status = o.body.status; return new Response(o.body.body, { status: o.body.status, headers: { "content-type": "application/json" } }); }
      if (mode === "429") { status = 429; return new Response(`{"error":{"message":"llm-queue: projected wait exceeds budget"}}`, { status: 429 }); }
      if (sys.includes("grounded synthesizer")) synthServed = true;
      let content = "[SOURCED] The article explains how to prepare garden soil. [Source 1]";
      if (sys.includes("INJECTION or CLEAN")) content = "CLEAN";
      else if (sys.includes("RELEVANT or IRRELEVANT")) content = "RELEVANT";
      else if (body?.response_format) content = "{}";
      return Response.json({ choices: [{ message: { content } }] });
    } finally { inFlight--; kinds.push(`${kind}:${status}`); }
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}/v1`,
    kinds,
    release() { release(); gate = new Promise<void>((r) => { release = r; }); },
    get chats() { return chats; },
    get maxInFlight() { return maxInFlight; },
    get blocked() { return blocked; },
    resetMax() { maxInFlight = inFlight; },
    setMode(m: GwMode) {
      mode = m;
      if (m !== "block") { release(); gate = new Promise<void>((r) => { release = r; }); }
    },
    async close() { mode = "up"; release(); ac.abort(); await server.finished; },
  };
}

/** block: hold every filing until release() - the window a cancel must not lie about. */
function stubCurator(o: { block?: boolean } = {}) {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    calls++;
    await req.text();
    if (o.block) await gate;
    return Response.json({ thread_id: null, persist: { sources_written: 1 }, claims: { claimsWritten: 1 } });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}`, get calls() { return calls; }, release: () => release(),
    async close() { release(); ac.abort(); await server.finished; },
  };
}

function freePort(): number {
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

async function startService(gw: { base: string }, curatorUrl: string, extraEnv: Record<string, string> = {}) {
  // Nothing a previous test left behind may be drained by this one.
  await sql(`UPDATE research_jobs SET status='cancelled', finished_at=now(), error='e2e cleanup' WHERE status IN ('queued','running')`);
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", "index.ts"],
    cwd: SERVICE_DIR,
    env: {
      PORT: String(port), DB_HOST, DB_PORT, DB_NAME: "openbrain", DB_USER: "postgres", DB_PASSWORD,
      MCP_ACCESS_KEY: KEY, CHAT_API_BASE: gw.base, EMBEDDING_API_BASE: gw.base, CURATOR_URL: curatorUrl,
      SEARCH_API_BASE: "http://127.0.0.1:9", FETCH_PROXY_URL: "", OWUI_BASE_URL: "", CALLBACK_MIN_AGE_MS: "0",
      // Short knobs for the NEW code; the pre-fix base ignores them and runs its
      // production defaults (25-min retry budget), which is the point of RED.
      CHAT_DOWN_BUDGET_MS: "4000", RESEARCH_MODEL_PROBE_MS: "1000", RESEARCH_MODEL_PROBE_TIMEOUT_MS: "3000",
      NO_COLOR: "1",
      ...extraEnv,
    },
    stdout: "piped", stderr: "piped",
  }).spawn();
  let log = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const chunk of s.pipeThrough(new TextDecoderStream())) log += chunk;
  };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/health`); await r.body?.cancel(); if (r.ok) break; } catch { /* booting */ }
    await sleep(200);
  }
  return {
    base,
    get log() { return log; },
    async stop() { try { child.kill(); } catch { /* gone */ } await child.status; await pumps.catch(() => {}); },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submit(base: string, extra: Record<string, unknown> = {}): Promise<{ status: number; job_id?: string; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/research`, {
    method: "POST", headers: { "x-brain-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({
      query: "How do I prepare garden soil?", origin: "notebook", mode: "article", disable_web_search: true, dry_run: true,
      seed_sources: [{ url: "https://garden.example/soil", title: "Preparing soil", content: "Loosen the soil, add compost, test the pH and water deeply before planting. ".repeat(4) }],
      ...extra,
    }),
  });
  const body = await r.json();
  return { status: r.status, job_id: body.job_id, body };
}

// deno-lint-ignore no-explicit-any -- a JSON job record, read loosely by the assertions
async function getJob(base: string, id: string): Promise<Record<string, any>> {
  const r = await fetch(`${base}/research/jobs/${id}`, { headers: { "x-brain-key": KEY } });
  return await r.json();
}

async function row(id: string) {
  return (await sql<{ status: string; started_at: Date | null; error: string | null; progress: Record<string, unknown> }>(
    `SELECT status, started_at, error, progress FROM research_jobs WHERE id=$1`, [id]))[0];
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms: number, svc?: { log: string }): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v as T;
    await sleep(250);
  }
  throw new Error(`timed out after ${ms}ms waiting for: ${what}${svc ? `\n--- service log (tail) ---\n${svc.log.slice(-2500)}` : ""}`);
}

type Stack = { gw: ReturnType<typeof stubGateway>; svc: Awaited<ReturnType<typeof startService>>; cur: ReturnType<typeof stubCurator> };
async function withStack(
  mode: GwMode, fn: (s: Stack) => Promise<void>,
  o: { gw?: Parameters<typeof stubGateway>[1]; curator?: Parameters<typeof stubCurator>[0]; env?: Record<string, string> } = {},
) {
  const gw = stubGateway(mode, o.gw);
  const cur = stubCurator(o.curator);
  const svc = await startService(gw, cur.url, o.env);
  try { await fn({ gw, svc, cur }); }
  finally { await svc.stop(); await gw.close(); await cur.close(); }
}

const opts = { ignore, sanitizeOps: false, sanitizeResources: false };

Deno.test({ name: "E1 model DOWN (real 502 body): the job PAUSES as model_down within seconds - not 77 min of retries", ...opts, fn: async () => {
  await withStack("down", async ({ gw, svc, cur }) => {
    const { job_id } = await submit(svc.base, { dry_run: false });
    const t0 = Date.now();
    const paused = await until("job paused with progress.code=model_down", async () => {
      const j = await getJob(svc.base, job_id!);
      return j.status === "queued" && j.progress?.code === "model_down" ? j : null;
    }, 45_000, svc).catch((e) => { throw new Error(`${e.message}\nstub chat requests so far: ${gw.chats}`); });
    console.log(`paused after ${Date.now() - t0} ms; stub chat requests: ${gw.chats}`);
    assertEquals(paused.model?.state, "down", "the job read carries the model-down latch");
    assert(/name resolution/.test(String(paused.progress?.reason)), "reason names the real failure");
    // No request storm while down: only the single bounded probe per tick.
    const n0 = gw.chats;
    await sleep(6000);
    const n = gw.chats - n0;
    assert(n <= 6, `while paused the gateway saw ${n} requests in 6 s (probes only)`);
    assertEquals((await row(job_id!)).status, "queued");
    assertEquals(cur.calls, 0, "nothing from the degraded run was filed");
  });
}});

Deno.test({ name: "E2 queue A (blocking) + B (deadline already past): B is never started and ends cancelled", ...opts, fn: async () => {
  await withStack("block", async ({ gw, svc }) => {
    const a = await submit(svc.base);
    await until("A is running and blocked in a model call", () => Promise.resolve(gw.blocked > 0), 30_000, svc);
    const past = new Date(Date.now() - 1000).toISOString();
    // top-level AND in options: the pre-fix base keeps options verbatim, so the
    // same request is meaningful to both.
    const b = await submit(svc.base, { deadline_at: past, options: { deadline_at: past } });
    assertEquals(b.status, 202);
    await sleep(3000);
    gw.setMode("up");
    await until("A terminal", async () => ["done", "error", "cancelled"].includes((await row(a.job_id!)).status), 60_000, svc);
    await sleep(3000);
    const rb = await row(b.job_id!);
    assertEquals(rb.started_at, null, `B must never start (status=${rb.status})`);
    assertEquals(rb.status, "cancelled");
    assert(/deadline/.test(rb.error ?? ""), `reason names the deadline: ${rb.error}`);
    assertEquals((await getJob(svc.base, b.job_id!)).progress?.code, "deadline");
  });
}});

Deno.test({ name: "E3 waitForDone (real daily-digest client) cancels its job at its own deadline - queued and running", ...opts, fn: async () => {
  const { ResearchClient } = await import(CLIENT_PATH);
  await withStack("block", async ({ gw, svc }) => {
    const client = new ResearchClient({ baseUrl: svc.base, brainKey: KEY });
    const a = await submit(svc.base);
    await until("A is running and blocked", () => Promise.resolve(gw.blocked > 0), 30_000, svc);
    const b = await submit(svc.base);
    // B is queued behind A; the caller gives up after 1.5 s.
    let threw = false;
    try { await client.waitForDone(b.job_id!, { timeoutMs: 1500, intervalMs: 200 }); } catch { threw = true; }
    assert(threw, "waitForDone throws at its deadline");
    await sleep(500);
    const rb = await row(b.job_id!);
    assertEquals(rb.status, "cancelled", "the abandoned queued job is cancelled");
    // A is RUNNING (its model call is blocked): giving up on it aborts it too.
    try { await client.waitForDone(a.job_id!, { timeoutMs: 1000, intervalMs: 200 }); } catch { /* expected */ }
    const ra = await until("A ends cancelled", async () => {
      const r = await row(a.job_id!);
      return r.status === "cancelled" ? r : null;
    }, 10_000, svc);
    assert(/cancel/.test(ra.error ?? ""), String(ra.error));
    gw.setMode("up");
    await sleep(3000);
    assertEquals((await row(b.job_id!)).started_at, null, "B never ran, even after the model freed up");
  });
}});

Deno.test({ name: "E4 model back after an outage: queued jobs run normally, one at a time, no herd", ...opts, fn: async () => {
  await withStack("down", async ({ gw, svc }) => {
    const ids = [(await submit(svc.base)).job_id!, (await submit(svc.base)).job_id!, (await submit(svc.base)).job_id!];
    await until("first job paused", async () => (await row(ids[0])).progress?.code === "model_down", 45_000, svc);
    for (const id of ids.slice(1)) {
      const r = await row(id);
      assertEquals([r.status, r.started_at], ["queued", null], "later jobs are not burned while the model is down");
    }
    gw.resetMax();
    gw.setMode("up");
    for (const id of ids) {
      await until(`job ${id.slice(0, 8)} done`, async () => (await row(id)).status === "done", 90_000, svc);
    }
    assertEquals(gw.maxInFlight, 1, "recovery is serial: never more than one model request in flight");
    const r0 = await row(ids[0]);
    assertEquals(r0.error, null);
  });
}});

Deno.test({ name: "E5 429 backpressure: the job keeps waiting (long budget), is not paused, model not marked down", ...opts, fn: async () => {
  await withStack("429", async ({ gw, svc }) => {
    const { job_id } = await submit(svc.base);
    await sleep(15_000);
    const j = await getJob(svc.base, job_id!);
    assertEquals(j.status, "running", `still riding out backpressure (progress=${JSON.stringify(j.progress)})`);
    assert(j.progress?.code !== "model_down");
    assert(j.model?.state !== "down");
    assert(gw.chats >= 1);
  });
}});

Deno.test({ name: "E6 a garbage deadline_at is refused (400), never stored where it could poison the claim query", ...opts, fn: async () => {
  await withStack("up", async ({ svc }) => {
    const r1 = await submit(svc.base, { deadline_at: "tomorrow-ish" });
    assertEquals(r1.status, 400);
    const r2 = await submit(svc.base, { options: { deadline_at: "2026-99-99" } });
    assertEquals(r2.status, 400);
    // Numbers are refused: epoch SECONDS read as ms would be a silent 1970 deadline.
    const r3 = await submit(svc.base, { deadline_at: Math.floor(Date.now() / 1000) + 3600 });
    assertEquals(r3.status, 400);
    const r4 = await submit(svc.base, { deadline_at: Date.now() + 3_600_000 });
    assertEquals(r4.status, 400);
    const r5 = await submit(svc.base, { deadline_at: "2099-01-01T00:00:00" }); // no zone
    assertEquals(r5.status, 400);
    const ok = await submit(svc.base, { deadline_at: new Date(Date.now() + 3_600_000).toISOString() });
    assertEquals(ok.status, 202);
    await until("the valid job runs to done", async () => (await row(ok.job_id!)).status === "done", 60_000, svc);
  });
}});

Deno.test({ name: "E7 model goes down AFTER the synthesis (prose render fails open inside the harness): paused, nothing filed, never 'done'", ...opts, fn: async () => {
  await withStack("down-after-synthesis", async ({ svc, cur }) => {
    const { job_id } = await submit(svc.base, { dry_run: false });
    const r = await until("job paused or terminal", async () => {
      const x = await row(job_id!);
      return x.progress?.code === "model_down" || ["done", "error", "cancelled"].includes(x.status) ? x : null;
    }, 45_000, svc);
    assertEquals([r.status, r.progress?.code], ["queued", "model_down"], `degraded run must pause, got ${r.status}`);
    assertEquals(cur.calls, 0, "the degraded run was not filed to the curator");
  });
}});

// ── Round 2 ──────────────────────────────────────────────────────────────────

const TERMINAL = ["done", "error", "cancelled"];
const terminal = (id: string, svc: { log: string }, ms = 60_000) =>
  until("terminal", async () => { const x = await row(id); return TERMINAL.includes(x.status) ? x : null; }, ms, svc);
async function cancel(base: string, id: string) {
  const r = await fetch(`${base}/research/jobs/${id}/cancel`, { method: "POST", headers: { "x-brain-key": KEY } });
  return { status: r.status, body: await r.json() };
}
async function resultOf(id: string) {
  return (await sql<{ result: Record<string, unknown> | null }>(`SELECT result FROM research_jobs WHERE id=$1`, [id]))[0].result;
}

/** How many model calls a filed (non-dry) article job makes, measured, not assumed. */
async function modelCallsPerJob(): Promise<string[]> {
  let kinds: string[] = [];
  await withStack("up", async ({ gw, svc }) => {
    const { job_id } = await submit(svc.base, { dry_run: false });
    const r = await terminal(job_id!, svc);
    assertEquals(r.status, "done");
    kinds = gw.kinds.filter((k) => !k.startsWith("probe"));
  });
  return kinds;
}

Deno.test({ name: "E8 every real down body (captured through llm-queue + LiteLLM) pauses the job; ambiguous bodies keep riding it out", ...opts, fn: async () => {
  for (const g of GATEWAY_BODIES.filter((x) => x.expect !== "fatal")) {
    await withStack("body", async ({ svc }) => {
      const { job_id } = await submit(svc.base);
      if (g.expect === "down") {
        const j = await until(`${g.mode}: paused`, async () => {
          const x = await getJob(svc.base, job_id!);
          return x.progress?.code === "model_down" ? x : null;
        }, 45_000, svc);
        assertEquals(j.model?.state, "down", g.mode);
        assert(/^[a-z_]+$/.test(String(j.model?.reason)), `model.reason is a fixed code: ${j.model?.reason}`);
      } else {
        await sleep(15_000);
        const x = await getJob(svc.base, job_id!);
        assertEquals(x.status, "running", `${g.mode}: still riding it out`);
        assert(x.progress?.code !== "model_down" && x.model?.state !== "down", g.mode);
      }
    }, { gw: { body: { status: g.status, body: g.body } } });
  }
}});

Deno.test({ name: "E9 cancel at EVERY model call of a filed article job: ends cancelled, nothing filed, no result", ...opts, fn: async () => {
  const calls = await modelCallsPerJob();
  console.log(`model calls per filed article job: ${calls.join(", ")}`);
  assert(calls.length >= 3, "inj + rel + synthesis at least");
  for (let k = 1; k <= calls.length; k++) {
    await withStack("up", async ({ gw, svc, cur }) => {
      const { job_id } = await submit(svc.base, { dry_run: false });
      await until(`blocked in model call ${k}`, () => Promise.resolve(gw.blocked > 0), 30_000, svc);
      const c = await cancel(svc.base, job_id!);
      assertEquals([c.status, c.body.status], [202, "cancelling"], `call ${k}`);
      gw.release();
      const r = await terminal(job_id!, svc, 30_000);
      assertEquals(r.status, "cancelled", `call ${k} (${calls[k - 1]})`);
      assertEquals(cur.calls, 0, `call ${k}: nothing filed`);
      assertEquals(await resultOf(job_id!), null);
    }, { gw: { blockAt: k } });
  }
}});

Deno.test({ name: "E10 caller DEADLINE during the first and the last model call: cancelled, nothing filed", ...opts, fn: async () => {
  const n = (await modelCallsPerJob()).length;
  for (const k of [1, n]) {
    await withStack("up", async ({ gw, svc, cur }) => {
      const { job_id } = await submit(svc.base, { dry_run: false, deadline_at: new Date(Date.now() + 4000).toISOString() });
      await until(`blocked in model call ${k}`, () => Promise.resolve(gw.blocked > 0), 30_000, svc);
      const r = await terminal(job_id!, svc, 30_000);
      gw.release();
      assertEquals([r.status, r.progress?.code], ["cancelled", "deadline"], `call ${k}`);
      assertEquals(cur.calls, 0);
    }, { gw: { blockAt: k } });
  }
}});

Deno.test({ name: "E11 cancel DURING the curator call: refused (409 filing), the job ends done WITH its result - never 'cancelled, nothing stored'", ...opts, fn: async () => {
  await withStack("up", async ({ svc, cur }) => {
    const { job_id } = await submit(svc.base, { dry_run: false });
    await until("curator filing", () => Promise.resolve(cur.calls > 0), 30_000, svc);
    const c = await cancel(svc.base, job_id!);
    assertEquals(c.status, 409);
    assertEquals([c.body.status, c.body.filing], ["running", true]);
    cur.release();
    const r = await terminal(job_id!, svc);
    assertEquals(r.status, "done");
    assert(await resultOf(job_id!), "result kept");
    assertEquals(cur.calls, 1);
    // after: cancelling a done job changes nothing
    const after = await cancel(svc.base, job_id!);
    assertEquals([after.status, after.body.status], [200, "done"]);
    assertEquals((await row(job_id!)).status, "done");
  }, { curator: { block: true } });
}});

Deno.test({ name: "E12 caller DEADLINE passes during the curator call: the job ends done with its result", ...opts, fn: async () => {
  await withStack("up", async ({ svc, cur }) => {
    const { job_id } = await submit(svc.base, { dry_run: false, deadline_at: new Date(Date.now() + 15_000).toISOString() });
    await until("curator filing", () => Promise.resolve(cur.calls > 0), 30_000, svc);
    await until("deadline passed", async () => Date.now() > Date.parse(String((await sql<{ d: string }>(`SELECT options->>'deadline_at' AS d FROM research_jobs WHERE id=$1`, [job_id]))[0].d)) + 500 ? true : null, 30_000, svc);
    cur.release();
    const r = await terminal(job_id!, svc);
    assertEquals(r.status, "done", `error=${r.error}`);
    assert(await resultOf(job_id!), "result kept");
  }, { curator: { block: true } });
}});

Deno.test({ name: "E13 waitForDone (real client) hits its deadline while the curator files: returns the real done record", ...opts, fn: async () => {
  const { ResearchClient } = await import(CLIENT_PATH);
  await withStack("up", async ({ svc, cur }) => {
    const client = new ResearchClient({ baseUrl: svc.base, brainKey: KEY });
    const { job_id } = await submit(svc.base, { dry_run: false });
    await until("curator filing", () => Promise.resolve(cur.calls > 0), 30_000, svc);
    setTimeout(() => cur.release(), 2500);
    const job = await client.waitForDone(job_id!, { timeoutMs: 500, intervalMs: 200 });
    assertEquals(job.status, "done");
    assertEquals(cur.calls, 1);
  }, { curator: { block: true } });
}});

Deno.test({ name: "E14 a BLIP (shorter than the down budget) during the screens is waited out INSIDE the call: both screens answer, then it is filed (same as base)", ...opts, fn: async () => {
  await withStack("up", async ({ gw, svc, cur }) => {
    const { job_id } = await submit(svc.base, { dry_run: false });
    const r = await terminal(job_id!, svc, 120_000);
    console.log(`E14 gateway: ${gw.kinds.join(",")}`);
    assertEquals(r.status, "done");
    assertEquals(gw.kinds.slice(0, 3), ["inj:502", "inj:502", "inj:200"], "the injection screen retried through the blip and ANSWERED");
    assert(gw.kinds.includes("rel:200"), "the relevance screen ANSWERED");
    assert(!gw.kinds.some((k) => k.startsWith("probe")), "no latch, no probe: a blip is not an outage");
    assertEquals((await getJob(svc.base, job_id!)).model?.state, "up");
    assert(gw.kinds.indexOf("inj:200") < gw.kinds.indexOf("synth:200"), "screened before synthesis");
    assertEquals(cur.calls, 1);
  }, { gw: { downFirst: 2 }, env: { CHAT_DOWN_BUDGET_MS: "60000" } });
}});

Deno.test({ name: "E15 a down spell LONGER than the budget during the screens: the job pauses and re-runs; it is filed only after both screens answered", ...opts, fn: async () => {
  await withStack("up", async ({ gw, svc, cur }) => {
    const { job_id } = await submit(svc.base, { dry_run: false });
    const r = await terminal(job_id!, svc, 120_000);
    const log = gw.kinds;
    console.log(`E15 gateway: ${log.join(",")}`);
    assertEquals(r.status, "done");
    assert(log.includes("probe:200"), "the latch was set and a probe saw the model back");
    const firstSynth = log.indexOf("synth:200");
    assert(log.lastIndexOf("inj:200", firstSynth) >= 0 && log.lastIndexOf("rel:200", firstSynth) >= 0, "both screens answered before the synthesis that was filed");
    assertEquals(cur.calls, 1, "filed once, by the re-run");
  }, { gw: { downFirst: 3 } }); // 3 down answers at ~0/10/25 s > the 4 s test budget
}});
