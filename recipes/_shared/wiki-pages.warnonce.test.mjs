// node --test recipes/_shared/wiki-pages.warnonce.test.mjs
// D13 (research-workbench P1a): a row write that does not land is a FAILED
// compile, never a silent `false` - upsertWikiPages throws, the run's flush
// records the page as UNSYNCED, and finishWikiPages() returns a non-zero exit
// code after naming the count and the first slugs. The advisory kinds that
// remain (delete, count) still warn once PER KIND, so a second, different
// failure never hides behind the first (the 08-28 outage survived on stacked
// silence).
//
// Own file: the env must point at a dead endpoint BEFORE the module loads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPEN_BRAIN_URL = "http://127.0.0.1:9"; // nothing listens: fetch rejects fast
process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "1000";
process.env.WIKI_GIT_DIR = "/wiki";
const TMP = mkdtempSync(join(tmpdir(), "wp-notify-"));
const NOTES = join(TMP, "notifications.jsonl");
process.env.WIKI_NOTIFY_FILE = NOTES;
const UNSYNCED = join(TMP, ".unsynced-rows.json");
process.env.WIKI_UNSYNCED_FILE = UNSYNCED;

const m = await import("./wiki-pages.mjs");

test("upsertWikiPages throws when the row does not land (no silent false)", async () => {
  await assert.rejects(() => m.upsertWikiPages({ slug: "content/x", page_class: "root" }));
});

test("a failed flush leaves the pages UNSYNCED and the run's exit code non-zero, naming count + first slugs", async () => {
  m._resetWikiPagesForTests();
  m.queueWikiPage("/wiki/content/person/person-a.md", "---\ntitle: A\n---\n# A\n");
  m.queueWikiPage("/wiki/content/person/person-b.md", "---\ntitle: B\n---\n# B\n");
  const lines = [];
  const orig = console.error;
  console.error = (msg) => lines.push(String(msg));
  let code;
  try {
    const r = await m.flushWikiPages();
    assert.deepEqual(r, { sent: 0, failed: 2 });
    code = await m.finishWikiPages("test");
  } finally {
    console.error = orig;
  }
  assert.equal(code, 1);
  assert.deepEqual(m.unsyncedWikiPages().map((u) => u.slug).sort(), ["content/person/person-a", "content/person/person-b"]);
  const fail = lines.find((l) => l.includes("UNSYNCED"));
  assert.ok(fail && fail.includes("2 page(s) UNSYNCED") && fail.includes("content/person/person-a"), JSON.stringify(lines));
});

test("attempt 3 (AT2-7): rows that failed because the DATABASE was unavailable raise ONE transient notification and are recorded for the next cycle", async () => {
  // (follows the test above: nothing listens on the endpoint - "fetch failed")
  assert.ok(existsSync(NOTES), "a notification was written");
  const n = readFileSync(NOTES, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(n.length, 1, JSON.stringify(n));
  assert.equal(n[0].class, "transient", "a database outage is transient infrastructure, not structural");
  assert.equal(n[0].subject, "row write failed: database unavailable (test)");
  assert.equal(n[0].slug, "content/person/person-a");
  assert.match(n[0].error, /2 page\(s\) unsynced, retried next cycle/);
  const rec = JSON.parse(readFileSync(UNSYNCED, "utf8"));
  assert.deepEqual(Object.keys(rec.rows).sort(), ["content/person/person-a", "content/person/person-b"]);
});

test("attempt 3: the database-unavailable classifier - an answered 4xx is a REJECTION (structural); no answer, a gateway 5xx or a timeout is transient", () => {
  for (const t of ["fetch failed", "POST wiki_pages: 503 {\"code\":\"PGRST001\"}", "POST wiki_pages: 502 bad gateway", "POST wiki_pages: 504 x",
    "The operation was aborted due to timeout", "connect ECONNREFUSED 10.0.0.1:80", "POST wiki_pages: 429 busy"]) {
    assert.equal(m.isDatabaseUnavailableError(t), true, t);
  }
  for (const t of ["POST wiki_pages: 401 {\"code\":\"42501\",\"message\":\"permission denied for table wiki_pages\"}",
    "POST wiki_pages: 400 bad payload", "POST wiki_pages: 409 conflict", "row build failed: x is not defined", "POST wiki_pages: 500 boom"]) {
    assert.equal(m.isDatabaseUnavailableError(t), false, t);
  }
});

test("attempt 3: the 'landed' count is per run - a long-lived caller reports each cycle's own count", async () => {
  m._resetWikiPagesForTests();
  const lines = [];
  const orig = console.log;
  console.log = (msg) => lines.push(String(msg));
  try {
    assert.equal(await m.finishWikiPages("cycle-a"), 0);
    assert.equal(await m.finishWikiPages("cycle-b"), 0);
  } finally { console.log = orig; }
  assert.deepEqual(lines.filter((l) => l.includes("landed")), [
    "[wiki-pages] cycle-a: all 0 written page row(s) landed", "[wiki-pages] cycle-b: all 0 written page row(s) landed"]);
});

test("advisory kinds warn once PER KIND", async () => {
  m._resetWikiPagesForTests();
  const lines = [];
  const orig = console.error;
  console.error = (msg) => lines.push(String(msg));
  try {
    assert.equal(await m.deleteWikiPages(["content/x"]), false);
    assert.equal(await m.countWikiPages("entity"), null);
    assert.equal(await m.deleteWikiPages(["content/y"]), false);
  } finally {
    console.error = orig;
  }
  const warned = lines.filter((l) => l.startsWith("[wiki-pages] ") && l.includes(" failed: "));
  assert.equal(warned.length, 2, JSON.stringify(warned));
  assert.ok(warned[0].includes("delete failed") && warned[1].includes("count failed"));
});

test("F-T4 (kept): a row write the database REJECTED (403) raises exactly ONE 'compile structural failure' notification and is not queued for retry", async () => {
  const http = await import("node:http");
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(403, { "content-type": "application/json" }); res.end('{"code":"42501","message":"permission denied for table wiki_pages"}'); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const saved = process.env.OPEN_BRAIN_URL;
  process.env.OPEN_BRAIN_URL = `http://127.0.0.1:${srv.address().port}`;
  const before = readFileSync(NOTES, "utf8").trim().split(/\r?\n/).length;
  const unsyncedBefore = readFileSync(UNSYNCED, "utf8");
  const { _resetNotifyForTests } = await import("./compile-notify.mjs");
  _resetNotifyForTests();
  m._resetWikiPagesForTests();
  const orig = console.error;
  console.error = () => {};
  try {
    m.queueWikiPage("/wiki/content/person/person-c.md", "---\ntitle: C\n---\n# C\n");
    assert.equal(await m.finishWikiPages("rejected"), 1);
  } finally {
    console.error = orig;
    process.env.OPEN_BRAIN_URL = saved;
    srv.close();
  }
  const n = readFileSync(NOTES, "utf8").trim().split(/\r?\n/).slice(before).map((l) => JSON.parse(l));
  assert.equal(n.length, 1, JSON.stringify(n));
  assert.equal(n[0].class, "structural");
  assert.equal(n[0].subject, "compile structural failure: row write rejected (rejected)");
  assert.equal(n[0].slug, "content/person/person-c");
  assert.equal(readFileSync(UNSYNCED, "utf8"), unsyncedBefore, "a rejection is not a retry candidate");
});
