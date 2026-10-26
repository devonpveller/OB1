// node --test recipes/_shared/wiki-pages.order.test.mjs
// rw-p1b-ready round 2 (tester attempt 2, the 24 h soak): two reconcile samples named an entity page STALE - its
// FILE was newer than its ROW. The writers wrote the file, then queued the row, which landed at the next batch
// flush (60-90 ms later in the fixture, measured; a whole batch of LLM calls later in a real compile). The
// reconcile lists files BEFORE it reads rows, so a pass inside that gap saw the new file beside the old row.
// writeWikiPage: an UPDATE is staged and put in place only after its row landed (mtime at or before the row's
// stamp); a CREATE is written at once and flushed at the next maybeFlushWikiPages.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let answer = 201;
let onPost = null;
const posted = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    if (req.method === "POST") posted.push(...JSON.parse(raw || "[]").map((r) => ({ slug: r.slug, updated_at: r.updated_at })));
    if (req.method === "POST" && onPost) await onPost();
    res.writeHead(answer, { "content-type": "application/json" });
    res.end(answer < 300 ? "" : '{"code":"PGRST001","message":"no connection"}');
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());
process.env.OPEN_BRAIN_URL = `http://127.0.0.1:${server.address().port}`;
process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "3000";
const vault = mkdtempSync(join(tmpdir(), "wp-order-"));
process.env.WIKI_GIT_DIR = vault;
const dir = join(vault, "content/person");
mkdirSync(dir, { recursive: true });
const A = join(dir, "person-a.md");
const OLD = "---\ntitle: A\nentity_id: 1\n---\n# A\n\nold body\n";
writeFileSync(A, OLD);
const past = new Date(Date.now() - 3600_000);
utimesSync(A, past, past);
const m = await import("./wiki-pages.mjs");
const visible = () => readdirSync(dir).filter((f) => !f.startsWith(".")).sort();

test("an UPDATE: the file the walk sees keeps its old content and mtime until the row has landed; then mtime <= the row's stamp", async () => {
  const NEW = OLD.replace("old body", "new body");
  let seenDuringPost = null;
  onPost = () => { seenDuringPost = { body: readFileSync(A, "utf8"), mtime: statSync(A).mtimeMs, names: visible() }; };
  assert.equal(m.writeWikiPage(A, NEW), true);
  assert.equal(readFileSync(A, "utf8"), OLD, "before the flush the vault walk still reads the OLD file");
  assert.equal(statSync(A).mtimeMs, past.getTime(), "... with its old mtime: the old row is not older than it");
  assert.deepEqual(visible(), ["person-a.md"], "the staged copy is a dot-file (the walk and Quartz skip it)");
  assert.equal(m.readWikiPageFile(A), NEW, "the compile itself reads its staged content");
  await m.flushWikiPages();
  assert.equal(seenDuringPost.body, OLD, "while the row was being written, the file was still the old one");
  assert.equal(readFileSync(A, "utf8"), NEW, "after the row landed the new file is in place");
  const row = posted.find((p) => p.slug === "content/person/person-a");
  assert.ok(statSync(A).mtimeMs <= Date.parse(row.updated_at), "file mtime at or before the row's stamp: never stale");
  assert.equal(m.stagedWikiPageCount(), 0);
  onPost = null;
});

test("a CREATE is written at once and the next maybeFlushWikiPages flushes it (not a whole batch later)", async () => {
  posted.length = 0;
  const B = join(dir, "person-b.md");
  m.writeWikiPage(B, "---\ntitle: B\n---\n# B\n");
  assert.ok(visible().includes("person-b.md"));
  assert.equal(m.queuedWikiPageCount(), 1);
  const r = await m.maybeFlushWikiPages();
  assert.equal(r.sent, 1, "flushed with one page queued (batch size 25)");
  assert.ok(posted.some((p) => p.slug === "content/person/person-b"));
});

test("an unchanged page is not written (stable keys honoured) and its row is still queued", async () => {
  const before = statSync(A).mtimeMs;
  const same = readFileSync(A, "utf8");
  assert.equal(m.writeWikiPage(A, same), false);
  assert.equal(statSync(A).mtimeMs, before);
  assert.equal(m.queuedWikiPageCount(), 1);
  await m.flushWikiPages();
});

test("a row that does NOT land still puts the file in place, with the current mtime (it reads stale, as it is)", async () => {
  answer = 503;
  const NEW2 = readFileSync(A, "utf8").replace("new body", "third body");
  m.writeWikiPage(A, NEW2);
  const t0 = Date.now();
  await m.flushWikiPages();
  answer = 201;
  assert.equal(readFileSync(A, "utf8"), NEW2);
  assert.ok(statSync(A).mtimeMs >= t0 - 1000, "current mtime: the reconcile reports the row older than its file");
  assert.equal(m.stagedWikiPageCount(), 0);
  assert.ok(m.unsyncedWikiPages().some((u) => u.slug === "content/person/person-a"));
});
