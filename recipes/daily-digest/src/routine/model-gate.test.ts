// Model gate + clock + store + alert-text unit tests (mr-routine-outage).
//
// The gate is exercised through the REAL probeModel against a REAL stub
// gateway over HTTP serving the exact 2026-10-13 502 body.
//
// Run: deno test --allow-net --allow-read --allow-write --allow-env src/routine/model-gate.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { localDate, nextDate, zonedEpoch } from "./clock.ts";
import { isDownAnswer, probeModel, waitForModel } from "./model-gate.ts";
import { RoutineStore } from "./store.ts";
import { buildAlertText, TelegramNotifier } from "./telegram.ts";
import { gatewayStub, guardNetwork, telegramStub, UPSTREAM_DOWN_502, VirtualClock } from "./testing.ts";

guardNetwork();
const TZ = "America/New_York";

Deno.test("clock: 07:00 America/New_York is 11:00Z in EDT and 12:00Z in EST (DST-correct, not a fixed UTC hour)", () => {
  assertEquals(new Date(zonedEpoch("2026-10-13", "07:00", TZ)).toISOString(), "2026-10-13T11:00:00.000Z");
  assertEquals(new Date(zonedEpoch("2026-11-02", "07:00", TZ)).toISOString(), "2026-11-02T12:00:00.000Z");
  // the fall-back day itself (2026-11-01): 07:00 is after the change -> EST
  assertEquals(new Date(zonedEpoch("2026-11-01", "07:00", TZ)).toISOString(), "2026-11-01T12:00:00.000Z");
  // 01:00 local = the cron's 05:00Z in summer
  assertEquals(new Date(zonedEpoch("2026-10-13", "01:00", TZ)).toISOString(), "2026-10-13T05:00:00.000Z");
  // local date at 02:30Z is still the PREVIOUS local day
  assertEquals(localDate(Date.parse("2026-10-14T02:30:00Z"), TZ), "2026-10-13");
  assertEquals(nextDate("2026-12-31"), "2027-01-01");
});

Deno.test("isDownAnswer: the 10-13 body is DOWN; busy / other 5xx are reachable", () => {
  assert(isDownAnswer(502, UPSTREAM_DOWN_502));
  assert(isDownAnswer(500, "Connection refused"));
  assert(!isDownAnswer(502, `{"error":{"message":"queue full"}}`));
  assert(!isDownAnswer(429, UPSTREAM_DOWN_502)); // 429 is never down
  assert(!isDownAnswer(500, "llama-swap: health check timed out after 5m0s")); // a load timeout is reachable
});

Deno.test("probeModel against the stub gateway: down / up / busy / gateway gone - and it NEVER GETs /health", async () => {
  const gw = gatewayStub("down");
  try {
    const o = { chatBase: `${gw.url}/v1`, model: "local-small", probeTimeoutMs: 5_000 };
    const down = await probeModel(o);
    assertEquals(down.state, "down");
    assertMatch(down.reason, /502/);
    gw.mode = "up";
    assertEquals((await probeModel(o)).state, "up");
    gw.mode = "overload502";
    assertEquals((await probeModel(o)).state, "up", "a busy 502 is reachable - waiting would not help");
    gw.mode = "slow";
    gw.slowMs = 400;
    assertEquals((await probeModel(o)).state, "up", "a slow (cold-loading) model is up");
    assertEquals((await probeModel({ ...o, probeTimeoutMs: 100 })).state, "down", "a probe past its bound reads down, bounded");
    // every chat request the probe made was a 1-token probe, liveness is /health/liveliness
    assertEquals(gw.work().length, 0);
    assert(gw.log.some((l) => l.path === "/health/liveliness"));
    assertEquals(gw.healthGets(), 0, "GET /health loads every model; the probe must never call it");
  } finally {
    await gw.close();
  }
  // the gateway itself gone (connection refused on a closed port)
  const gone = await probeModel({ chatBase: "http://127.0.0.1:9/v1", model: "x", livenessTimeoutMs: 2_000 });
  assertEquals(gone.state, "down");
  assertMatch(gone.reason, /gateway unreachable/);
});

Deno.test("waitForModel: waits with capped backoff while down, resumes on the first up, bounded by `until`", async () => {
  const clock = new VirtualClock(Date.parse("2026-10-13T05:00:00Z"));
  let downUntil = Date.parse("2026-10-13T07:00:00Z");
  const probes: number[] = [];
  const probe = () => {
    probes.push(clock.now());
    return Promise.resolve(clock.now() < downUntil ? { state: "down" as const, reason: "chat 502" } : { state: "up" as const, reason: "chat 200" });
  };
  let downSince = 0;
  const p = waitForModel({ probe, clock, until: Date.parse("2026-10-14T00:00:00Z"), initialMs: 30_000, maxMs: 300_000, log: () => {}, onDown: (s) => {
    downSince = s;
  } });
  await clock.advanceTo(Date.parse("2026-10-13T08:00:00Z"));
  const r = await p;
  assert(r.up);
  assertEquals(downSince, Date.parse("2026-10-13T05:00:00Z"));
  // first up probe within one backoff cap of the model coming back
  assert(probes.at(-1)! >= downUntil && probes.at(-1)! - downUntil <= 300_000, `resumed late: ${new Date(probes.at(-1)!).toISOString()}`);
  const gaps = probes.slice(1).map((t, i) => t - probes[i]);
  assertEquals(gaps.slice(0, 4), [30_000, 60_000, 120_000, 240_000]);
  assert(gaps.every((g) => g <= 300_000), "backoff is capped");
  assert(probes.length < 40, `bounded probe count, got ${probes.length}`);

  // never up: returns down AT the bound, not after it
  probes.length = 0;
  downUntil = Infinity;
  const until = clock.now() + 3_600_000;
  const p2 = waitForModel({ probe, clock, until, initialMs: 30_000, maxMs: 300_000, log: () => {} });
  await clock.advanceTo(until + 3_600_000);
  const r2 = await p2;
  assert(!r2.up);
  assertEquals(probes.at(-1), until, "last probe exactly at the bound");
});

Deno.test("store: the send-once claim has exactly one winner under concurrency, and survives a new store instance", async () => {
  const dir = await Deno.makeTempDir({ prefix: "routine-claim-" });
  try {
    const a = new RoutineStore(dir), b = new RoutineStore(dir);
    const wins = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).claim("2026-10-13", "digest")));
    assertEquals(wins.filter(Boolean).length, 1);
    assert(!(await new RoutineStore(dir).claim("2026-10-13", "digest")), "a restarted process sees the marker");
    assert(await a.claim("2026-10-13", "followup"), "kinds are independent");
    assert(await a.claim("2026-10-14", "digest"), "days are independent");
    await a.release("2026-10-13", "digest");
    assert(await b.claim("2026-10-13", "digest"), "a released (definitely-not-sent) claim can be retaken");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("alert text is content-free: step names, counts, states, times only", async () => {
  const text = buildAlertText({
    date: "2026-10-13",
    tz: TZ,
    checkedAt: "07:15 America/New_York (11:15Z)",
    digest: { sent: false, attempts: 3, state: "send failed" },
    podcast: { produced: false, state: "waiting for the model: down since 01:00 local" },
  });
  assertMatch(text, /digest: NOT sent \(3 attempt\(s\); send failed\)/);
  assertMatch(text, /podcast: NOT produced/);
  assert(!/@|https?:|<|Subject/i.test(text), text);
  // and the notifier puts exactly that text on the wire, to the configured chat only
  const clock = { now: () => 0 };
  const tg = telegramStub(clock);
  try {
    const n = new TelegramNotifier({ token: "123:fake", chatId: "42", apiBase: tg.url });
    assert(await n.send(text));
    assertEquals(tg.messages, [{ chatId: "42", text, at: 0 }]);
    assert(!(await new TelegramNotifier({ token: "", chatId: "42", apiBase: tg.url }).send(text)), "unconfigured = inert");
    assertEquals(tg.messages.length, 1);
  } finally {
    await tg.close();
  }
});
