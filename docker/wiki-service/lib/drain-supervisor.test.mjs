// node --test lib/ — gate for the drain supervisor (incident 2026-08-29).
import test from "node:test";
import assert from "node:assert/strict";
import { shouldSupervisorCompile } from "./drain-supervisor.mjs";

const MIN = 60_000;
const base = { running: false, queued: 6274, msSinceCompile: 40 * MIN, idleFloorMs: 30 * MIN };

test("kicks the drain when pages are queued and nothing has compiled for too long", () => {
  // This is the incident: 6,274 queued, last compile 3h35m earlier, idle.
  assert.equal(shouldSupervisorCompile({ ...base, msSinceCompile: 215 * MIN }), true);
});

test("stays quiet while a compile is running", () => {
  // compile() has its own running guard; firing here would just no-op, and
  // a chain mid-flight is by definition not stalled.
  assert.equal(shouldSupervisorCompile({ ...base, running: true }), false);
});

test("stays quiet when nothing is queued", () => {
  assert.equal(shouldSupervisorCompile({ ...base, queued: 0 }), false);
});

test("stays quiet while the chain is still cycling normally", () => {
  // The backfill chain re-arms every BACKFILL_CONTINUE_MIN (default 10 min),
  // and a viewer-deferred compile still COMPLETES (only the backfill slice is
  // skipped) - so a healthy system keeps msSinceCompile well under the floor
  // and the supervisor must never pre-empt it.
  assert.equal(shouldSupervisorCompile({ ...base, msSinceCompile: 11 * MIN }), false);
});

test("fires exactly at the floor, not before", () => {
  assert.equal(shouldSupervisorCompile({ ...base, msSinceCompile: 30 * MIN - 1 }), false);
  assert.equal(shouldSupervisorCompile({ ...base, msSinceCompile: 30 * MIN }), true);
});

test("fails QUIET on a missing or nonsense clock rather than compiling every tick", () => {
  for (const bad of [NaN, undefined, null, -1, Infinity]) {
    assert.equal(
      shouldSupervisorCompile({ ...base, msSinceCompile: bad }),
      false,
      `msSinceCompile=${String(bad)} must not trigger a compile`,
    );
  }
  for (const bad of [NaN, undefined, null, 0, -5]) {
    assert.equal(
      shouldSupervisorCompile({ ...base, idleFloorMs: bad }),
      false,
      `idleFloorMs=${String(bad)} must not trigger a compile`,
    );
  }
});

test("a non-numeric queue depth is treated as no work", () => {
  for (const bad of [NaN, undefined, null, "6274"]) {
    assert.equal(shouldSupervisorCompile({ ...base, queued: bad }), false);
  }
});
