/**
 * jobs.test.ts — deadline parsing and the Dispatcher's model-down gating. The
 * SQL itself runs against real Postgres in failfast.e2e.test.ts; here a store
 * that only answers CLAIM_SQL / CANCEL_EXPIRED_SQL by identity checks the
 * dispatcher's ORDER of operations (C4) and that every wait is bounded.
 *
 * Run: deno test jobs.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CANCEL_EXPIRED_SQL, CLAIM_SQL, DeadlineError, deadlineMs, Dispatcher, JobCancelled, parseDeadline, type ClaimedJob, type SqlClient } from "./jobs.ts";
import { ModelHealth } from "./llm.ts";

Deno.test("parseDeadline: ISO-8601 with a zone only; numbers (seconds vs ms), zone-less and bare dates refused", () => {
  assertEquals(parseDeadline(undefined), undefined);
  assertEquals(parseDeadline(""), undefined);
  assertEquals(parseDeadline(null), undefined);
  assertEquals(parseDeadline("2026-10-13T12:00:00Z"), "2026-10-13T12:00:00.000Z");
  assertEquals(parseDeadline("2026-10-13T08:00:00-04:00"), "2026-10-13T12:00:00.000Z");
  assertEquals(parseDeadline("2026-10-13T12:00:00.123456Z"), "2026-10-13T12:00:00.123Z");
  assertThrows(() => parseDeadline(Date.UTC(2026, 9, 13, 12)), DeadlineError); // ms
  assertThrows(() => parseDeadline(Math.floor(Date.now() / 1000) + 3600), DeadlineError); // seconds: the 1970 trap
  assertThrows(() => parseDeadline(String(Date.UTC(2026, 9, 13, 12))), DeadlineError);
  assertThrows(() => parseDeadline("2026-10-13T12:00:00"), DeadlineError); // whose local time?
  assertThrows(() => parseDeadline("2030-01-01"), DeadlineError);
  assertThrows(() => parseDeadline("tomorrow-ish"), DeadlineError);
  assertThrows(() => parseDeadline("2026-99-99"), DeadlineError);
  assertThrows(() => parseDeadline({}), DeadlineError);
  assertThrows(() => parseDeadline(Number.NaN), DeadlineError);
  assertEquals(deadlineMs({ deadline_at: "2026-10-13T12:00:00.000Z" }), Date.UTC(2026, 9, 13, 12));
  assertEquals(deadlineMs({}), null);
});

Deno.test("the stored deadline shape always passes the SQL guard regex", () => {
  const re = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
  for (const v of ["2026-10-13T12:00:00Z", "2030-01-01T00:00+05:30", new Date().toISOString()]) assert(re.test(parseDeadline(v)!), String(v));
  assert(CLAIM_SQL.includes("NOT coalesce("), "claim excludes expired jobs atomically");
});

function fakeStore(queue: ClaimedJob[]) {
  const calls: string[] = [];
  const client: SqlClient = {
    queryObject<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql === CANCEL_EXPIRED_SQL) { calls.push("cancelExpired"); return Promise.resolve({ rows: [] }); }
      if (sql === CLAIM_SQL) {
        calls.push("claim");
        const j = queue.shift();
        return Promise.resolve({ rows: (j ? [{ id: j.jobId, query: j.query, thread_id: null, origin: j.origin, options: j.options }] : []) as T[] });
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
    },
    release() {},
  };
  return { calls, connect: () => Promise.resolve(client) };
}

const job = (id: string, options: Record<string, unknown> = {}): ClaimedJob =>
  ({ jobId: id.padEnd(36, "0"), query: "q", thread_id: null, origin: "notebook", options });

Deno.test("dispatcher: deadlines are swept BEFORE any claim, every tick, even while the model is down", async () => {
  const store = fakeStore([job("a")]);
  const health = new ModelHealth(() => {});
  health.markDown("chat 502: name resolution", 0);
  let probes = 0;
  const d = new Dispatcher({
    connect: store.connect, execute: () => Promise.resolve(), health,
    probe: () => { probes++; return Promise.resolve(false); },
    maxConcurrency: 1, probeIntervalMs: 60_000, log: () => {},
  });
  await d.tick();
  await d.tick();
  assertEquals(store.calls, ["cancelExpired", "cancelExpired"], "no claim while down");
  assertEquals(probes, 1, "one probe per interval, single-flight");
});

Deno.test("dispatcher: a successful probe resumes claiming; claims stay within maxConcurrency (no herd)", async () => {
  const store = fakeStore([job("a"), job("b"), job("c")]);
  const health = new ModelHealth(() => {});
  health.markDown("down", 0);
  const started: string[] = [];
  const releases: Array<() => void> = [];
  const d = new Dispatcher({
    connect: store.connect, health,
    execute: (j) => { started.push(j.jobId[0]); return new Promise<void>((r) => releases.push(r)); },
    probe: () => { health.markUp(1); return Promise.resolve(true); },
    maxConcurrency: 1, probeIntervalMs: 0, log: () => {},
  });
  await d.tick(); // probes
  await new Promise((r) => setTimeout(r, 0));
  await d.tick(); // claims one
  await d.tick(); // slot full: claims none
  assertEquals(started, ["a"]);
  releases.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  await d.tick();
  assertEquals(started, ["a", "b"]);
  releases.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  d.stop();
});

Deno.test("dispatcher: a cancel that races the claim is applied when the job registers", async () => {
  const store = fakeStore([job("a")]);
  let seen: AbortSignal | null = null;
  const d = new Dispatcher({
    connect: store.connect, health: new ModelHealth(() => {}),
    execute: (_j, s) => { seen = s; return Promise.resolve(); },
    probe: () => Promise.resolve(true), maxConcurrency: 1, probeIntervalMs: 0, log: () => {},
  });
  assertEquals(d.cancelRunning("a".padEnd(36, "0"), "caller gave up"), false);
  await d.tick();
  assert(seen !== null && (seen as AbortSignal).aborted, "aborted on registration");
  assert((seen as unknown as AbortSignal).reason instanceof JobCancelled);
});

Deno.test("dispatcher: a running job is aborted when its caller deadline passes", async () => {
  const store = fakeStore([job("a", { deadline_at: new Date(Date.now() + 50).toISOString() })]);
  let signal: AbortSignal | null = null;
  let done: () => void = () => {};
  const d = new Dispatcher({
    connect: store.connect, health: new ModelHealth(() => {}),
    execute: (_j, s) => { signal = s; return new Promise<void>((r) => { done = r; s.addEventListener("abort", () => r()); }); },
    probe: () => Promise.resolve(true), maxConcurrency: 1, probeIntervalMs: 0, log: () => {},
  });
  await d.tick();
  await new Promise((r) => setTimeout(r, 150));
  const s = signal as unknown as AbortSignal;
  assert(s.aborted, "deadline abort fired");
  assertEquals((s.reason as JobCancelled).code, "deadline");
  done();
});
