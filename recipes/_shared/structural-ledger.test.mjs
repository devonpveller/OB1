// node --test recipes/_shared/structural-ledger.test.mjs
// The open structural failures (research-workbench D13 item 6; rw-p1a-render
// attempt 2, tester finding A9): a structural failure is skipped until its
// inputs change, and notified once per DISTINCT failure, not once per cycle.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLedger, writeLedger, recordFailure, openFailure, clearFailure, listOpen, inputsKey, codeFingerprint,
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
