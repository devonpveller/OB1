// node --test recipes/_shared/structural-ledger.test.mjs
// The open structural failures (research-workbench D13 item 6; rw-p1a-render
// attempt 2, tester finding A9): a structural failure is skipped until its
// inputs change, and notified once per DISTINCT failure, not once per cycle.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLedger, writeLedger, recordFailure, openFailure, clearFailure, listOpen, inputsKey, codeFingerprint,
  updateLedger, withLedgerLock, clearStructuralKeys,
} from "./structural-ledger.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "structural-"));
const base = { key: "entity:905", slug: "content/person/person-dave-fixture", entity: 905, error: "reply failed the page parser: no heading", replySha256: "aa" };

test("a recorded failure is open while its inputs are unchanged, and not once they change", () => {
  const l = { failures: {} };
  const inputs = inputsKey({ updated_at: "2026-10-18T00:00:00Z", model: "m", code: "c1" });
  recordFailure(l, { ...base, inputs });
  assert.ok(openFailure(l, "entity:905", inputs), "same inputs: skip");
  assert.equal(openFailure(l, "entity:905", inputsKey({ updated_at: "2026-10-19T00:00:00Z", model: "m", code: "c1" })), null, "new source revision: retry");
  assert.equal(openFailure(l, "entity:905", inputsKey({ updated_at: "2026-10-18T00:00:00Z", model: "m", code: "c2" })), null, "a patch landed: retry");
  assert.equal(openFailure(l, "entity:999", inputs), null);
});

test("one notification per DISTINCT failure: the same slug + error + reply is not distinct", () => {
  const l = { failures: {} };
  const a = recordFailure(l, { ...base, inputs: "i1" }, "2026-10-18T01:00:00Z");
  assert.equal(a.distinct, true);
  const b = recordFailure(l, { ...base, inputs: "i2" }, "2026-10-18T02:00:00Z");
  assert.equal(b.distinct, false, "inputs changed, same outcome: no second notification");
  assert.equal(b.entry.first_seen, "2026-10-18T01:00:00Z");
  assert.equal(b.entry.occurrences, 2);
  assert.equal(b.entry.inputs, "i2", "the skip now keys on the newest inputs");
  const c = recordFailure(l, { ...base, replySha256: "bb", inputs: "i3" });
  assert.equal(c.distinct, true, "a different reply is a different failure");
});

test("the ledger is stable on disk, survives a manual clear, and reads a corrupt file as empty (loudly)", () => {
  const d = dir();
  const l = readLedger(d);
  assert.deepEqual(l, { failures: {} });
  recordFailure(l, { ...base, inputs: "i1" }, "2026-10-18T01:00:00Z");
  assert.equal(writeLedger(d, l), true);
  assert.equal(writeLedger(d, l), false, "unchanged: not rewritten");
  assert.deepEqual(listOpen(d).map((e) => e.slug), [base.slug]);
  const again = readLedger(d);
  assert.equal(clearFailure(again, "entity:905"), true);
  writeLedger(d, again);
  assert.deepEqual(listOpen(d), []);
  assert.match(readFileSync(join(d, ".structural-failures.json"), "utf8"), /"failures": \{\}/, "an empty ledger stays on disk");
  writeFileSync(join(d, ".structural-failures.json"), "{not json");
  const lines = [];
  const orig = console.error;
  console.error = (m) => lines.push(String(m));
  try { assert.deepEqual(readLedger(d), { failures: {} }); } finally { console.error = orig; }
  assert.ok(lines.some((x) => /unreadable/.test(x)));
});

test("the code fingerprint is a stable hash over the shared compile code", () => {
  const a = codeFingerprint();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(codeFingerprint(), a);
});

// ── attempt 3 (tester AT2-4, N2-2): the ledger LOCK ─────────────────────────
// Two processes race on one ledger file. Deterministic: process A takes the
// lock and HOLDS it (the test's own transaction function waits inside it) while
// process B is started; B must wait for A, re-read, and add its own entry - so
// both entries survive and B's "distinct" is decided against A's write.
const LEDGER_URL = new URL("./structural-ledger.mjs", import.meta.url).href;
function child(code, env = {}) {
  return spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}
const done = (p) => new Promise((resolve) => {
  let out = "";
  let err = "";
  p.stdout.on("data", (c) => { out += c; });
  p.stderr.on("data", (c) => { err += c; });
  p.on("close", (code) => resolve({ code, out, err }));
});
const recordIn = (dir, key, slug, holdMs) => `
  import { updateLedger, recordFailure } from ${JSON.stringify(LEDGER_URL)};
  const r = updateLedger(${JSON.stringify(dir)}, (l) => {
    process.stdout.write("LOCKED " + Date.now() + "\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
    return recordFailure(l, { key: ${JSON.stringify(key)}, slug: ${JSON.stringify(slug)}, error: "reply failed the page parser", replySha256: "aa", inputs: "i1" });
  });
  process.stdout.write("DONE " + Date.now() + " distinct=" + r.distinct + "\\n");
`;

test("AT2-4: two processes racing on the ledger - both entries survive, the second waits for the first's lock", async () => {
  const d = dir();
  const a = child(recordIn(d, "entity:905", "content/person/person-dave-fixture", 600));
  const ra = done(a);
  // B starts once A HOLDS the lock (A printed LOCKED), so the overlap is certain
  await new Promise((resolve) => a.stdout.once("data", resolve));
  const tB = Date.now();
  const rb = await done(child(recordIn(d, "entity:902", "content/person/person-bob-fixture", 0)));
  const rA = await ra;
  assert.equal(rA.code, 0, rA.err);
  assert.equal(rb.code, 0, rb.err);
  const bLocked = Number(/LOCKED (\d+)/.exec(rb.out)[1]);
  const aDone = Number(/DONE (\d+)/.exec(rA.out)[1]);
  assert.ok(bLocked >= aDone, `B took the lock (${bLocked}) only after A released it (${aDone}); B started ${tB}`);
  assert.deepEqual(Object.keys(readLedger(d).failures).sort(), ["entity:902", "entity:905"], "no lost update");
  assert.ok(!existsSync(join(d, ".structural-failures.json.lock")), "the lock is released");
});

test("AT2-4: the SAME failure recorded by two racing runs is distinct once - one notification, not two", async () => {
  const d = dir();
  const a = child(recordIn(d, "entity:905", "content/person/person-dave-fixture", 400));
  const ra = done(a);
  await new Promise((resolve) => a.stdout.once("data", resolve));
  const rb = await done(child(recordIn(d, "entity:905", "content/person/person-dave-fixture", 0)));
  const rA = await ra;
  assert.match(rA.out, /distinct=true/);
  assert.match(rb.out, /distinct=false/, "the second run sees the first's entry: not notified again");
  assert.equal(readLedger(d).failures["entity:905"].occurrences, 2);
});

test("AT2-4: a manual clear during a run is never resurrected (the run writes deltas against the file as it is, not its start-of-run copy)", () => {
  const d = dir();
  updateLedger(d, (l) => { recordFailure(l, { ...base, inputs: "i1" }); recordFailure(l, { ...base, key: "entity:902", slug: "b", inputs: "i1" }); });
  // a run starts (it used to read the whole ledger here and write it back at its end)
  const r1 = clearStructuralKeys(d, "905"); // the operator clears 905 while the run is going
  assert.deepEqual(r1, { cleared: ["entity:905"], unknown: [], open: 1 });
  // the run then records its own outcome (904 failed) - one transaction, file re-read
  updateLedger(d, (l) => recordFailure(l, { ...base, key: "entity:904", slug: "c", inputs: "i1" }));
  assert.deepEqual(Object.keys(readLedger(d).failures).sort(), ["entity:902", "entity:904"], "905 stays cleared");
});

test("N2-2: --clear-structural of an id that is not open is reported (the CLI exits non-zero naming it); the open ones are cleared", () => {
  const d = dir();
  updateLedger(d, (l) => recordFailure(l, { ...base, inputs: "i1" }));
  assert.deepEqual(clearStructuralKeys(d, "123456,notebook:nope"), { cleared: [], unknown: ["entity:123456", "notebook:nope"], open: 1 });
  assert.deepEqual(clearStructuralKeys(d, "905,77"), { cleared: ["entity:905"], unknown: ["entity:77"], open: 0 });
  assert.deepEqual(clearStructuralKeys(d, "all"), { cleared: [], unknown: [], open: 0 }, "all on an empty ledger is not an error");
});

test("the lock: a STALE lock (a crashed holder, past its expiry) is taken over", () => {
  const d = dir();
  const file = join(d, ".structural-failures.json");
  writeFileSync(`${file}.lock`, JSON.stringify({ owner: "ghost:1:dead", acquired: "2026-01-01T00:00:00Z", expires: "2026-01-01T00:00:30Z" }));
  const lines = [];
  assert.equal(withLedgerLock(file, () => 42, { log: (m) => lines.push(m) }), 42);
  assert.ok(lines.some((l) => /was stale \(holder ghost:1:dead/.test(l)), JSON.stringify(lines));
  assert.ok(!existsSync(`${file}.lock`));
  // (a live lock is waited for: the AT2-4 race above; a lock that cannot be
  // taken over names its holder after the bounded wait: NA3-1 below)
});

// ── attempt 4 (tester NA3-1, NA3-2): the lock never spins, never trusts a far
// expiry, and outwaits the stale time. Each case runs in a CHILD process with
// a hard timeout: a spinning takeover blocks its own event loop, so only a
// parent can stop it (the RED run on ad11598 is "killed by the timeout").
function lockChild(file, { env = {}, opts = "{}", timeoutMs = 15000 } = {}) {
  const code = `
    import { withLedgerLock } from ${JSON.stringify(LEDGER_URL)};
    // a late start, as a loaded host gives a spawned child (the attempt-1 flake)
    const delay = Number(process.env.LOCK_CHILD_START_DELAY_MS || 0);
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    const t0 = Date.now(), c0 = process.cpuUsage();
    let out, tookAt = null;
    try { const v = withLedgerLock(${JSON.stringify(file)}, () => { tookAt = Date.now(); return 42; }, ${opts}); out = "OK " + v; }
    catch (e) { out = "THREW " + String(e?.message || e); }
    const ms = Date.now() - t0, c = process.cpuUsage(c0);
    console.log(JSON.stringify({ out, ms, t0, tookAt, cpuMs: Math.round((c.user + c.system) / 1000) }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, encoding: "utf8", timeout: timeoutMs });
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).at(-1) || "";
  let j = null;
  try { j = JSON.parse(line); } catch { /* killed, or no output */ }
  return { ...r, j };
}
const OLD = new Date("2020-01-01T00:00:00Z");

test("NA3-1: a stale lock that CANNOT be removed (the lock path is a directory) - the waiter sleeps, honours the deadline and throws naming it; it never spins", () => {
  const d = dir();
  const file = join(d, ".structural-failures.json");
  mkdirSync(`${file}.lock`);
  writeFileSync(join(`${file}.lock`, "x"), "not a lock file");
  utimesSync(`${file}.lock`, OLD, OLD);
  const r = lockChild(file, { env: { WIKI_LEDGER_LOCK_STALE_MS: "1000", WIKI_LEDGER_LOCK_WAIT_MS: "1500" } });
  assert.ok(r.j, `the child was killed by the timeout or printed nothing (a spin): signal=${r.signal} status=${r.status} ${r.stderr}`);
  assert.match(r.j.out, /^THREW structural ledger lock .* could not be taken over/, r.j.out);
  assert.ok(r.j.ms >= 1400 && r.j.ms < 8000, `bounded by the wait (${r.j.ms} ms)`);
  assert.ok(r.j.cpuMs < r.j.ms / 2, `it slept between attempts (cpu ${r.j.cpuMs} ms of ${r.j.ms} ms)`);
});

test("NA3-1: a stale lock whose removal FAILS (a read-only directory: unlink throws EROFS) - bounded wait, then a loud throw naming the error; never spins", () => {
  const d = dir();
  const file = join(d, ".structural-failures.json");
  writeFileSync(`${file}.lock`, JSON.stringify({ owner: "ghost:1:dead", acquired: "2026-01-01T00:00:00Z", expires: "2026-01-01T00:00:30Z" }));
  const r = lockChild(file, {
    env: { WIKI_LEDGER_LOCK_STALE_MS: "1000", WIKI_LEDGER_LOCK_WAIT_MS: "1500" },
    opts: `{ unlink: () => { const e = new Error("EROFS: read-only file system, unlink"); e.code = "EROFS"; throw e; } }`,
  });
  assert.ok(r.j, `the child was killed by the timeout (a spin): signal=${r.signal}`);
  assert.match(r.j.out, /^THREW structural ledger lock .*held by ghost:1:dead.* could not be taken over \(EROFS/, r.j.out);
  assert.ok(r.j.ms >= 1400 && r.j.ms < 8000, `bounded by the wait (${r.j.ms} ms)`);
  assert.ok(r.j.cpuMs < r.j.ms / 2, `it slept between attempts (cpu ${r.j.cpuMs} ms of ${r.j.ms} ms)`);
  assert.ok(existsSync(`${file}.lock`));
});

test("NA3-2: a lock whose expiry lies beyond a sane ceiling (more than 2 x the stale time from now) is stale - taken over at once, never trusted", () => {
  const d = dir();
  const file = join(d, ".structural-failures.json");
  writeFileSync(`${file}.lock`, JSON.stringify({ owner: "h:1:x", acquired: new Date().toISOString(), expires: "2099-01-01T00:00:00Z" }));
  const r = lockChild(file, { timeoutMs: 10000 }); // the defaults (stale 30 s): the old code waited 20 s and threw
  assert.ok(r.j, `killed by the timeout: signal=${r.signal}`);
  assert.equal(r.j.out, "OK 42");
  assert.ok(r.j.ms < 2000, `taken over at once (${r.j.ms} ms)`);
  assert.match(r.stderr, /ledger lock .* was stale \(holder h:1:x, expires 2099-01-01T00:00:00Z is beyond the ceiling/);
  assert.ok(!existsSync(`${file}.lock`), "released");
});

test("NA3-2: the wait outlasts the stale time - a run starting right after a crashed holder TAKES OVER instead of failing; a configuration that breaks the invariant is refused", async () => {
  const L = await import("./structural-ledger.mjs");
  assert.equal(typeof L.lockTimes, "function", "lockTimes() states the two bounds");
  const t = L.lockTimes({});
  assert.ok(t.waitMs > t.staleMs, `default wait ${t.waitMs} ms > stale ${t.staleMs} ms`);
  assert.deepEqual(L.lockTimes({ WIKI_LEDGER_LOCK_STALE_MS: "1000", WIKI_LEDGER_LOCK_WAIT_MS: "1500" }), { staleMs: 1000, waitMs: 1500 });
  assert.throws(() => L.lockTimes({ WIKI_LEDGER_LOCK_STALE_MS: "30000", WIKI_LEDGER_LOCK_WAIT_MS: "20000" }), /WIKI_LEDGER_LOCK_WAIT_MS \(20000\) must exceed WIKI_LEDGER_LOCK_STALE_MS \(30000\)/);
  // A holder that crashed a moment ago: its lock is fresh, nobody will release
  // it. The INVARIANT, on the lock's own recorded times (rw-p1a-deploy-prep
  // attempt 2: the wall-clock bound "ms >= 700" measured the child's spawn
  // latency too and failed at 662 ms under Docker load): the run takes the lock
  // over (never throws), and never BEFORE the holder's recorded expiry - it
  // waited the stale time out. Run on time and with a late start (a loaded
  // host), where the old bound failed.
  for (const late of [0, 400]) {
    const d = dir();
    const file = join(d, ".structural-failures.json");
    const now = Date.now();
    const expires = now + 1000;
    writeFileSync(`${file}.lock`, JSON.stringify({ owner: "crashed:9:x", acquired: new Date(now).toISOString(), expires: new Date(expires).toISOString() }));
    const r = lockChild(file, { env: { WIKI_LEDGER_LOCK_STALE_MS: "1000", WIKI_LEDGER_LOCK_WAIT_MS: "1500", LOCK_CHILD_START_DELAY_MS: String(late) } });
    assert.ok(r.j, `late=${late}: signal=${r.signal}`);
    assert.equal(r.j.out, "OK 42", `late=${late}: taken over once stale, inside the wait`);
    assert.match(r.stderr, /ledger lock .* was stale \(holder crashed:9:x, expired /, `late=${late}: the takeover is of the crashed holder's lock`);
    assert.ok(r.j.tookAt > expires, `late=${late}: taken ${r.j.tookAt - expires} ms after the recorded expiry (must be after it)`);
  }
});

test("the temp file of a write is unique per writer (pid 1 in every one-off container is not unique)", () => {
  const src = readFileSync(new URL("./structural-ledger.mjs", import.meta.url), "utf8");
  assert.match(src, /\.tmp-\$\{os\.hostname\(\)\}-\$\{process\.pid\}-\$\{crypto\.randomBytes/);
});
