// node --test lib/ - rw-p1a-render attempt 4 (tester NA3-3): a compile that
// cannot run because the DATABASE is down sends exactly ONE transient
// notification (the class of the outage row write), once per outage - and the
// caller holds the watermark (the failure path never persists state).
import test from "node:test";
import assert from "node:assert/strict";
import { createOutageNotifier, OUTAGE_SUBJECT } from "./outage-notify.mjs";

const isUnavailable = (m) => /-> 503|fetch failed|PGRST00[0-3]/.test(String(m));
function harness() {
  const sent = [];
  const forgotten = [];
  const n = createOutageNotifier({
    isUnavailable,
    notify: async (x) => { sent.push(x); return true; },
    forget: (x) => { forgotten.push(x); },
    outDir: "/wiki/content",
  });
  return { n, sent, forgotten };
}
const A = 'Error: GET http://openbrain-rest/rest/v1/entities?select=id -> 503: {"code":"PGRST002"}';

test("NA3-3: a compile that fails because the database is down sends ONE transient notification", async () => {
  const { n, sent } = harness();
  const r = await n.onFailed(A, "");
  assert.equal(r.notified, true);
  assert.deepEqual(sent.map((x) => [x.cls, x.subject]), [["transient", OUTAGE_SUBJECT]]);
  assert.equal(OUTAGE_SUBJECT, "compile failed: database unavailable (wiki-service)");
  assert.match(sent[0].error, /-> 503/);
  assert.equal(sent[0].outDir, "/wiki/content");
});

test("NA3-3: the same outage over several compiles is notified once; a completed compile ends it, the next outage is notified again", async () => {
  const { n, sent, forgotten } = harness();
  await n.onFailed(A, "");
  assert.equal((await n.onFailed("fetch failed", "")).notified, false, "same outage");
  assert.equal(sent.length, 1);
  n.onCompleted();
  assert.deepEqual(forgotten.map((x) => x.subject), [OUTAGE_SUBJECT], "the per-process dedupe is released");
  assert.equal((await n.onFailed(A, "")).notified, true, "a new outage");
  assert.equal(sent.length, 2);
});

test("NA3-3: a failure that is NOT a database outage notifies nothing here; one the compile already notified as transient is not notified twice", async () => {
  const { n, sent } = harness();
  assert.equal((await n.onFailed("git pull --rebase failed: conflict", "")).notified, false);
  const childErr = "[notify] transient: row write failed: database unavailable (generate-wiki) (slug content/person/x)\n" + A;
  assert.equal((await n.onFailed(A, childErr)).notified, false);
  assert.equal(sent.length, 0);
  assert.equal((await n.onFailed(A, "")).notified, false, "that outage counts as notified");
});

test("NA3-3: a notification sink that throws never masks the compile failure", async () => {
  const n = createOutageNotifier({ isUnavailable, notify: async () => { throw new Error("sink down"); }, forget: () => {}, outDir: "/w" });
  const r = await n.onFailed(A, "");
  assert.equal(r.notified, false);
  assert.match(r.reason, /sink down/);
});
