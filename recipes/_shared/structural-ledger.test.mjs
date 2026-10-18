// node --test recipes/_shared/structural-ledger.test.mjs
// The open structural failures (research-workbench D13 item 6; rw-p1a-render
// attempt 2, tester finding A9): a structural failure is skipped until its
// inputs change, and notified once per DISTINCT failure, not once per cycle.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
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

test("the lock: a STALE lock (a crashed holder, past its expiry) is taken over; a live one is waited for, bounded, then names its holder", () => {
  const d = dir();
  const file = join(d, ".structural-failures.json");
  writeFileSync(`${file}.lock`, JSON.stringify({ owner: "ghost:1:dead", acquired: "2026-01-01T00:00:00Z", expires: "2026-01-01T00:00:30Z" }));
  const lines = [];
  assert.equal(withLedgerLock(file, () => 42, { log: (m) => lines.push(m) }), 42);
  assert.ok(lines.some((l) => /was stale \(holder ghost:1:dead/.test(l)), JSON.stringify(lines));
  assert.ok(!existsSync(`${file}.lock`));
  const far = new Date(Date.now() + 3600_000).toISOString();
  writeFileSync(`${file}.lock`, JSON.stringify({ owner: "alive:7:beef", acquired: new Date().toISOString(), expires: far }));
  const saved = process.env.WIKI_LEDGER_LOCK_WAIT_MS;
  process.env.WIKI_LEDGER_LOCK_WAIT_MS = "200";
  const t0 = Date.now();
  try {
    assert.throws(() => withLedgerLock(file, () => 1), /held by alive:7:beef/);
  } finally {
    if (saved === undefined) delete process.env.WIKI_LEDGER_LOCK_WAIT_MS; else process.env.WIKI_LEDGER_LOCK_WAIT_MS = saved;
  }
  assert.ok(Date.now() - t0 >= 180, "it waited");
  assert.ok(existsSync(`${file}.lock`), "someone else's live lock is never removed");
});

test("the temp file of a write is unique per writer (pid 1 in every one-off container is not unique)", () => {
  const src = readFileSync(new URL("./structural-ledger.mjs", import.meta.url), "utf8");
  assert.match(src, /\.tmp-\$\{os\.hostname\(\)\}-\$\{process\.pid\}-\$\{crypto\.randomBytes/);
});
