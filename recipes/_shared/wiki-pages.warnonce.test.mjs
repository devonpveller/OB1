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
const NOTES = join(mkdtempSync(join(tmpdir(), "wp-notify-")), "notifications.jsonl");
process.env.WIKI_NOTIFY_FILE = NOTES;

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

test("F-T4: rejected row writes raise exactly ONE 'compile structural failure' notification for the run", async () => {
  // (follows the test above: two pages are unsynced; the run was finished once)
  assert.ok(existsSync(NOTES), "a notification was written");
  const n = readFileSync(NOTES, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(n.length, 1, JSON.stringify(n));
  assert.equal(n[0].class, "structural");
  assert.equal(n[0].subject, "compile structural failure: row write rejected (test)");
  assert.equal(n[0].slug, "content/person/person-a");
  assert.match(n[0].error, /2 page\(s\) unsynced/);
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
