/**
 * llm.test.ts — the REAL chat()/probe() retry loop (llm.ts) and the REAL fail-open
 * classifiers (injection.ts / filtering.ts) against a real stub HTTP gateway that
 * serves the exact 2026-10-13 upstream-down 502 body. Time is a virtual clock:
 * `sleep` advances `now`, so "25 minutes" runs in milliseconds and every elapsed
 * figure below is the time the production loop would have spent.
 *
 * Run: deno test --allow-net llm.test.ts
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyChatFailure, createChat, isModelDownError, ModelDownError, ModelHealth } from "./llm.ts";
import { detectInjection } from "./injection.ts";
import { isRelevant } from "./filtering.ts";
import type { Deps, Page } from "./harness.ts";
import { REAL_DOWN_502 } from "./fixtures/upstream-down.ts";

type Mode = "down" | "up" | "429" | "503" | "bare502" | "hang";

/** A real HTTP gateway on 127.0.0.1:<random>. */
function stubGateway(initial: Mode) {
  let mode: Mode = initial;
  let requests = 0;
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    requests++;
    await req.text();
    switch (mode) {
      case "down": return new Response(REAL_DOWN_502, { status: 502, headers: { "content-type": "application/json" } });
      case "429": return new Response(`{"error":{"message":"llm-queue: projected wait exceeds budget"}}`, { status: 429 });
      case "503": return new Response(`{"error":{"message":"model is loading"}}`, { status: 503 });
      case "bare502": return new Response(`{"error":{"message":"Bad Gateway"}}`, { status: 502 });
      case "hang": await new Promise((r) => setTimeout(r, 2000)); return new Response("late", { status: 200 });
      default: return Response.json({ choices: [{ message: { content: "CLEAN" } }] });
    }
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}/v1`,
    get requests() { return requests; },
    set mode(m: Mode) { mode = m; },
    async close() { ac.abort(); await server.finished; },
  };
}

function virtualClock() {
  let t = 1_760_000_000_000;
  return {
    now: () => t,
    sleep: (ms: number) => { t += ms; return Promise.resolve(); },
    elapsed(from: number) { return t - from; },
  };
}

const MIN = 60_000;

function make(gw: { base: string }, clock = virtualClock(), over: Partial<Parameters<typeof createChat>[0]> = {}) {
  const health = new ModelHealth(() => {});
  const llm = createChat({
    base: gw.base, apiKey: "k", model: "local-large", nothinkSuffix: ":nothink",
    retryBudgetMs: 25 * MIN, downBudgetMs: 3 * MIN, fetchTimeoutMs: 30_000, probeTimeoutMs: 30_000,
    health, now: clock.now, sleep: clock.sleep, log: () => {}, ...over,
  });
  return { llm, health, clock };
}

const page: Page = { url: "https://x.example/a", title: "A", content: "An ordinary article about gardening tools and soil.", domain: "x.example" };

Deno.test("classify: the real 2026-10-13 502 body is DOWN; 429/503/bare 502/504 are OVERLOAD; 400 is fatal", () => {
  assertEquals(classifyChatFailure(502, REAL_DOWN_502), "down");
  assertEquals(classifyChatFailure(502, `{"error":{"type":"upstream_error","message":"llm-queue: boom"}}`), "down");
  assertEquals(classifyChatFailure(500, "litellm.APIConnectionError: Connection error."), "down");
  assertEquals(classifyChatFailure(429, "projected wait exceeds budget"), "overload");
  assertEquals(classifyChatFailure(503, "model is loading"), "overload");
  assertEquals(classifyChatFailure(502, "Bad Gateway"), "overload");
  assertEquals(classifyChatFailure(504, "timeout"), "overload");
  assertEquals(classifyChatFailure(400, "bad request"), "fatal");
  assertEquals(classifyChatFailure(500, "internal"), "fatal");
});

Deno.test("DOWN 502: chat() gives up within the short budget (not 25 min) and latches; the next call fails at once", async () => {
  const gw = stubGateway("down");
  try {
    const { llm, health, clock } = make(gw);
    const t0 = clock.now();
    const e = await assertRejects(() => llm.chat("sys", "user"), ModelDownError);
    const spent = clock.elapsed(t0);
    assert(spent >= 3 * MIN && spent < 3 * MIN + 2 * MIN, `spent ${spent / 1000}s, want ~3 min`);
    assert(e.latched && /name resolution/.test(e.reason), e.message);
    assert(health.isDown, "latched down");
    assert(gw.requests >= 2, `retried within the short budget (${gw.requests} requests)`);

    const before = gw.requests;
    const t1 = clock.now();
    await assertRejects(() => llm.chat("sys", "second call"), ModelDownError);
    assertEquals(gw.requests, before, "latched: no request sent at all");
    assertEquals(clock.elapsed(t1), 0, "latched: no time spent");
    assertEquals(health.snapshot().state, "down");
  } finally { await gw.close(); }
});

Deno.test("fail-open classifiers return at once when the model is down (one request, no retry, no latch)", async () => {
  const gw = stubGateway("down");
  try {
    const { llm, health, clock } = make(gw);
    const deps = { chat: (s: string, u: string, o?: Record<string, unknown>) => llm.chat(s, u, o) } as unknown as Deps;
    const t0 = clock.now();
    assertEquals(await detectInjection(deps, page), { injected: false, reason: "detect-error" });
    assertEquals(await isRelevant(deps, page, "gardening"), true);
    assertEquals(clock.elapsed(t0), 0, "no backoff spent");
    assertEquals(gw.requests, 2, "exactly one request per classifier");
    assertEquals(health.isDown, false, "one classifier answer is not a confirmed outage");
  } finally { await gw.close(); }
});

Deno.test("an article job's three calls (2 classifiers + synthesis) cost ~3 min of model-down, not ~77", async () => {
  const gw = stubGateway("down");
  try {
    const { llm, clock } = make(gw);
    const deps = { chat: (s: string, u: string, o?: Record<string, unknown>) => llm.chat(s, u, o) } as unknown as Deps;
    const t0 = clock.now();
    await detectInjection(deps, page);
    await isRelevant(deps, page, "gardening");
    const e = await assertRejects(() => llm.chat("synth", "article"), ModelDownError);
    assert(isModelDownError(e));
    const spent = clock.elapsed(t0);
    assert(spent < 5 * MIN, `job-level model-down cost ${Math.round(spent / 1000)}s (base: ~75 min)`);
  } finally { await gw.close(); }
});

Deno.test("429 backpressure still retries for the FULL 25-minute budget and never latches", async () => {
  const gw = stubGateway("429");
  try {
    const { llm, health, clock } = make(gw);
    const t0 = clock.now();
    const e = await assertRejects(() => llm.chat("sys", "user"), Error);
    assert(!(e instanceof ModelDownError), "429 is not model_down");
    assert(/^chat 429/.test(e.message), e.message);
    assert(clock.elapsed(t0) >= 25 * MIN, `rode it out for ${clock.elapsed(t0) / MIN} min`);
    assertEquals(health.isDown, false);
    assert(gw.requests > 15, `kept retrying (${gw.requests})`);
  } finally { await gw.close(); }
});

Deno.test("503 (model loading) and a 502 that does not name an unreachable upstream keep the long budget", async () => {
  for (const mode of ["503", "bare502"] as const) {
    const gw = stubGateway(mode);
    try {
      const { llm, health, clock } = make(gw);
      const t0 = clock.now();
      await assertRejects(() => llm.chat("sys", "user"), Error);
      assert(clock.elapsed(t0) >= 25 * MIN, `${mode}: ${clock.elapsed(t0) / MIN} min`);
      assertEquals(health.isDown, false, mode);
    } finally { await gw.close(); }
  }
});

Deno.test("a short blip: down then up inside the short budget -> the call succeeds, no latch", async () => {
  const gw = stubGateway("down");
  try {
    const clock = virtualClock();
    let sleeps = 0;
    const { llm, health } = make(gw, clock, {
      sleep: (ms) => { if (++sleeps === 2) gw.mode = "up"; return clock.sleep(ms); },
    });
    assertEquals(await llm.chat("sys", "user"), "CLEAN");
    assertEquals(health.isDown, false);
  } finally { await gw.close(); }
});

Deno.test("probe: bypasses the latch, stays down on a down answer, clears it when the model answers", async () => {
  const gw = stubGateway("down");
  try {
    const { llm, health } = make(gw);
    await assertRejects(() => llm.chat("sys", "user"), ModelDownError);
    assert(health.isDown);
    const n = gw.requests;
    assertEquals(await llm.probe(), false);
    assertEquals(gw.requests, n + 1, "exactly one probe request");
    assert(health.isDown);
    gw.mode = "up";
    assertEquals(await llm.probe(), true);
    assertEquals(health.isDown, false);
    assertEquals(await llm.chat("sys", "user"), "CLEAN", "calls flow again");
  } finally { await gw.close(); }
});

Deno.test("probe: a reachable-but-busy model (429) counts as up - jobs ride out overload themselves", async () => {
  const gw = stubGateway("down");
  try {
    const { llm, health } = make(gw);
    await assertRejects(() => llm.chat("s", "u"), ModelDownError);
    gw.mode = "429";
    assertEquals(await llm.probe(), true);
    assertEquals(health.isDown, false);
  } finally { await gw.close(); }
});

Deno.test("gateway unreachable (connection refused) is DOWN too", async () => {
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (l.addr as Deno.NetAddr).port;
  l.close(); // nothing listens there now
  // downBudgetMs 1: on Windows a refused localhost connect takes ~2 s per try.
  const { llm, health, clock } = make({ base: `http://127.0.0.1:${port}/v1` }, virtualClock(), { downBudgetMs: 1 });
  const t0 = clock.now();
  await assertRejects(() => llm.chat("s", "u"), ModelDownError);
  assert(clock.elapsed(t0) < 5 * MIN);
  assert(health.isDown);
});

Deno.test("every attempt is bounded: a gateway that never answers times out per attempt (C6)", async () => {
  const gw = stubGateway("hang");
  try {
    const { llm } = make(gw, virtualClock(), { fetchTimeoutMs: 100, retryBudgetMs: 0 });
    const t0 = Date.now();
    const e = await assertRejects(() => llm.chat("s", "u"), Error);
    assert(/no response within 100ms/.test(e.message), e.message);
    assert(Date.now() - t0 < 1500, "did not wait for the 2 s answer");
  } finally { await gw.close(); }
});

Deno.test("a job cancel aborts the in-flight request and the retry loop at once", async () => {
  const gw = stubGateway("hang");
  try {
    const { llm } = make(gw, virtualClock(), { sleep: undefined });
    const ac = new AbortController();
    const reason = new Error("cancelled: test");
    setTimeout(() => ac.abort(reason), 50);
    const t0 = Date.now();
    const e = await assertRejects(() => llm.chat("s", "u", { signal: ac.signal }));
    assertEquals(e, reason);
    assert(Date.now() - t0 < 1500);
  } finally { await gw.close(); }
});
