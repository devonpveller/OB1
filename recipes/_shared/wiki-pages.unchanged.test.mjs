// node --test recipes/_shared/wiki-pages.unchanged.test.mjs
// rw-wiki-unchanged-rows: a compile of an UNCHANGED vault issues 0 wiki_pages upserts (it re-sent every page, ~3.9k rows
// through the privacy guards, every cycle); a changed page, a missing row and a row whose content differs still land;
// the unsynced ledger backs off and never re-sends a slug whose send is outstanding; a guard refusal stays withheld.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A tiny PostgREST for wiki_pages: rows by slug, GET ?slug=in.(...), POST upsert. Counters are the evidence.
const rows = new Map();
const stat = { posts: 0, postedRows: 0, gets: 0, getRows: 0, maxActive: 0 };
let active = 0;
let delayMs = 0;
let slowMs = 9000;
let getAnswer = 200;
let refuse = new Set(); // slugs the "guard" refuses (42501, the one message)
const GUARD = '{"code":"42501","details":null,"hint":null,"message":"wiki_pages: this page cannot be saved"}';
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    active++; stat.maxActive = Math.max(stat.maxActive, active);
    const done = (code, body, headers = {}) => setTimeout(() => { active--; res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(body); }, delayMs);
    const url = new URL(req.url, "http://x");
    if (req.method === "GET") {
      stat.gets++;
      if (getAnswer !== 200) return done(getAnswer, '{"code":"PGRST001","message":"no connection"}');
      const m = /^in\.\((.*)\)$/.exec(url.searchParams.get("slug") || "");
      const slugs = m ? JSON.parse(`[${m[1]}]`) : [];
      const out = slugs.filter((s) => rows.has(s)).map((s) => ({ slug: s, title: rows.get(s).title, body: rows.get(s).body }));
      stat.getRows += out.length;
      return done(200, JSON.stringify(out));
    }
    if (req.method === "POST") {
      const parsed = JSON.parse(raw || "[]"); const list = Array.isArray(parsed) ? parsed : [];
      stat.posts++; stat.postedRows += list.length;
      if (list.some((r) => refuse.has(r.slug))) return done(400, GUARD);
      if (list.some((r) => r.slug.startsWith("content/source/slow"))) {
        // a slow guard: the statement runs on server-side after the client gave up, and commits at the end
        stat.slowPosts = (stat.slowPosts || 0) + 1;
        return setTimeout(() => { for (const r of list) rows.set(r.slug, r); active--; try { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify(list.map((r) => ({ slug: r.slug })))); } catch { /* client gone */ } }, slowMs);
      }
      for (const r of list) rows.set(r.slug, r);
      return done(201, JSON.stringify(list.map((r) => ({ slug: r.slug }))));
    }
    return done(204, "");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());
process.env.OPEN_BRAIN_URL = `http://127.0.0.1:${server.address().port}`;
process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "2000";
process.env.WIKI_UNSYNCED_BACKOFF_BASE_MS = "60000";
const vault = mkdtempSync(join(tmpdir(), "wp-unch-"));
process.env.WIKI_GIT_DIR = vault;
const outDir = join(vault, "content");
const dir = join(outDir, "source");
mkdirSync(dir, { recursive: true });
const m = await import("./wiki-pages.mjs");
const { writeSourceLeaves } = await import("./source-leaf.mjs");
const FILE = join(outDir, m.UNSYNCED_FILE);

const N = 2000;
const leaf = (i, v = "") => ({ id: `id-${i}`, title: `Source ${i}`, content: `The body of source ${i}. ${v}`, content_type: "web", url: `https://example.org/${i}` });
const compile = async (list, tag = "compile") => {
  for (const key of Object.keys(stat)) stat[key] = 0;
  writeSourceLeaves(list, outDir);
  return { code: await m.finishWikiPages(tag, { outDir }), ...stat };
};
const all = Array.from({ length: N }, (_, i) => leaf(i));
let cur = all;

test("RED/GREEN: a first compile writes every row; a SECOND compile of the unchanged vault issues 0 upserts (a bounded number of reads)", async () => {
  const first = await compile(all);
  assert.equal(first.code, 0);
  assert.equal(rows.size, N);
  assert.equal(first.postedRows, N, "the first compile creates every row");
  const second = await compile(all);
  assert.equal(second.code, 0);
  assert.equal(second.posts, 0, "0 upsert requests");
  assert.equal(second.postedRows, 0, "0 rows upserted (the old code re-sent all 2000)");
  assert.ok(second.gets <= Math.ceil(N / 40), `reads bounded by the chunk size: ${second.gets}`);
  const third = await compile(all);
  assert.equal(third.postedRows, 0, "and every later cycle: writes per cycle do not grow");
});

test("a changed page lands in the same cycle; a missing row is re-created; a row whose stored content differs is re-written; the rest stay unsent", async () => {
  rows.delete("content/source/id-7");                                                    // a lost row
  rows.set("content/source/id-9", { ...rows.get("content/source/id-9"), body: "stale body from an older compile" }); // a differing row
  const list = all.slice();
  list[5] = leaf(5, "CHANGED"); // a changed file
  cur = list;
  const r = await compile(list);
  assert.equal(r.code, 0);
  assert.equal(r.postedRows, 3, "exactly the changed, the missing and the differing page");
  assert.ok(rows.get("content/source/id-5").body.includes("CHANGED"));
  assert.ok(rows.has("content/source/id-7"));
  assert.ok(!rows.get("content/source/id-9").body.includes("stale"));
  const again = await compile(list);
  assert.equal(again.postedRows, 0);
});

test("a database that cannot be read: unchanged pages are not sent (no load on a sick database), changed pages still go; the next cycle checks again", async () => {
  getAnswer = 503;
  const list = cur.slice();
  list[11] = leaf(11, "CHANGED TOO");
  const r = await compile(list);
  getAnswer = 200;
  assert.equal(r.postedRows, 1, "only the changed page");
  assert.ok(rows.get("content/source/id-11").body.includes("CHANGED TOO"));
  assert.equal((await compile(list)).postedRows, 0);
});

test("a guard refusal (42501) stays WITHHELD: not retried, and a kept unchanged page is not re-sent by later compiles", async () => {
  const notes = join(vault, "notes");
  mkdirSync(notes, { recursive: true });
  const p = join(notes, "private-note.md");
  const note = (t) => ["---", "title: N", "---", "# N", "", t, ""].join("\n");
  writeFileSync(p, note("older text")); // a note already in the vault (a note keeps its file)
  refuse = new Set(["notes/private-note"]);
  for (const key of Object.keys(stat)) stat[key] = 0;
  m.writeWikiPage(p, note("withheld text"));
  assert.equal(await m.finishWikiPages("withheld", { outDir }), 0, "withheld is not a failure");
  assert.ok(m.isWithheldWikiPage("notes/private-note"));
  assert.ok(!rows.has("notes/private-note"));
  assert.ok(stat.posts >= 1);
  let ledger = {};
  try { ledger = JSON.parse(readFileSync(FILE, "utf8")).rows ?? {}; } catch { /* no ledger */ }
  assert.ok(!("notes/private-note" in ledger), "not recorded for retry");
  // the next compile finds the file as it is and does not send it again
  for (const key of Object.keys(stat)) stat[key] = 0;
  const same = readFileSync(p, "utf8");
  m.writeWikiPage(p, same);
  await m.finishWikiPages("withheld-2", { outDir });
  assert.equal(stat.posts, 0, "no POST for a withheld page every cycle");
  refuse = new Set();
});

test("the ledger backs off: a failed row records attempts and nextAt, and a retry inside the window sends nothing", async () => {
  const slug = "content/source/id-3";
  rows.delete(slug);
  m.rememberUnsyncedRows(outDir, [{ slug, error: "POST wiki_pages: aborted: timed out" }], "generate-wiki");
  const rec = JSON.parse(readFileSync(FILE, "utf8")).rows[slug];
  assert.equal(rec.attempts, 1);
  assert.ok(rec.nextAt > Date.now() + 50_000, "base back-off 60 s");
  m.rememberUnsyncedRows(outDir, [{ slug, error: "again" }], "generate-wiki");
  assert.equal(JSON.parse(readFileSync(FILE, "utf8")).rows[slug].attempts, 2, "attempts accumulate across records");
  assert.ok(JSON.parse(readFileSync(FILE, "utf8")).rows[slug].nextAt > Date.now() + 100_000, "doubles");
  for (const key of Object.keys(stat)) stat[key] = 0;
  const logs = [];
  const r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: (x) => logs.push(x) });
  assert.equal(r.retried, 0);
  assert.equal(r.waiting, 1);
  assert.equal(stat.posts + stat.gets, 0, "nothing sent, nothing read");
  assert.match(logs.at(-1), /waiting out their retry back-off/);
});

test("a due row is retried and removed when it lands; a row that LANDED after the client gave up is removed without a second send", async () => {
  process.env.WIKI_UNSYNCED_BACKOFF_BASE_MS = "0";
  const missing = "content/source/id-3";
  const landedLate = "content/source/id-4";
  assert.ok(!rows.has(missing));
  // the first send timed out client-side but ran on server-side: the row is current
  m.rememberUnsyncedRows(outDir, [{ slug: missing, error: "timed out" }, { slug: landedLate, error: "timed out" }], "notebook-synth");
  for (const key of Object.keys(stat)) stat[key] = 0;
  const r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: () => {} });
  assert.equal(r.retried, 2);
  assert.equal(r.landed, 2);
  assert.equal(stat.postedRows, 1, "only the row that was really missing was sent");
  assert.ok(rows.has(missing));
  assert.deepEqual(JSON.parse(readFileSync(FILE, "utf8")).rows, {}, "the ledger drains");
});

test("a slug is never re-sent while a previous send for it is outstanding (two overlapping retries send it once)", async () => {
  process.env.WIKI_UNSYNCED_BACKOFF_BASE_MS = "0";
  const slug = "content/source/id-20";
  rows.delete(slug);
  m.rememberUnsyncedRows(outDir, [{ slug, error: "timed out" }], "notebook-synth");
  delayMs = 300;
  for (const key of Object.keys(stat)) stat[key] = 0;
  const [a, b] = await Promise.all([
    m.retryUnsyncedRows({ outDir, vaultDir: vault, log: () => {} }),
    new Promise((r) => setTimeout(r, 50)).then(() => m.retryUnsyncedRows({ outDir, vaultDir: vault, log: () => {} })),
  ]);
  delayMs = 0;
  assert.equal(a.landed, 1);
  assert.equal(b.retried, 0, "the second pass saw the slug outstanding");
  assert.equal(stat.postedRows, 1, "one send in total");
  assert.ok(stat.maxActive <= 2);
});

test("a row that keeps failing backs off further each cycle (attempts grow, the window doubles, capped)", async () => {
  process.env.WIKI_UNSYNCED_BACKOFF_BASE_MS = "1000";
  process.env.WIKI_UNSYNCED_BACKOFF_MAX_MS = "4000";
  assert.deepEqual([1, 2, 3, 4, 9].map((n) => m.backoffMs(n)), [1000, 2000, 4000, 4000, 4000]);
  delete process.env.WIKI_UNSYNCED_BACKOFF_MAX_MS;
});

test("lab-ish: 3000 pages over 3 cycles with 20 edits per cycle: writes per cycle stay at the edits, not the vault", async () => {
  rows.clear();
  const big = Array.from({ length: 3000 }, (_, i) => leaf(i, "v0"));
  const written = [];
  written.push((await compile(big)).postedRows);
  for (let c = 1; c <= 2; c++) {
    for (let k = 0; k < 20; k++) big[c * 100 + k] = leaf(c * 100 + k, `edit ${c}`);
    written.push((await compile(big)).postedRows);
  }
  assert.deepEqual(written, [3000, 20, 20]);
  assert.ok(stat.maxActive <= 2, "no stacking of concurrent statements");
});

// ── attempt 2 (tester: the same slug re-sent while its earlier send is outstanding) ──
const slowLeaf = (v = "") => ({ id: "slow-1", title: "Slow", content: `a slow page ${v}`, content_type: "web" });
const SLOW = "content/source/slow-1";

test("1. an UNCHANGED page whose earlier send is still outstanding is not 'repaired' by a later compile; 3. a timed-out chunk is not re-sent at once", async () => {
  process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "300";
  process.env.WIKI_UNSYNCED_BACKOFF_BASE_MS = "60000";
  rows.delete(SLOW);
  for (const key of Object.keys(stat)) stat[key] = 0;
  // compile A: a new page whose statement outlives the 300 ms client timeout
  writeSourceLeaves([slowLeaf()], outDir);
  const codeA = await m.finishWikiPages("A", { outDir });
  assert.equal(codeA, 1, "recorded as unsynced (database unavailable)");
  assert.equal(stat.slowPosts, 1, "ONE send: a timed-out chunk is not retried at once");
  const rec = JSON.parse(readFileSync(FILE, "utf8")).rows[SLOW];
  assert.equal(rec.attempts, 1);
  assert.ok(rec.nextAt > Date.now(), "open ledger entry");
  assert.ok(!rows.has(SLOW), "the statement has not committed: the row reads as missing");
  // compile B (a separate process in the service): the file unchanged; the row still reads as missing, but its send is outstanding
  m._resetWikiPagesForTests();
  for (const key of Object.keys(stat)) stat[key] = 0;
  writeSourceLeaves([slowLeaf()], outDir);
  await m.finishWikiPages("B", { outDir });
  assert.equal(stat.slowPosts || 0, 0, "no second statement while the first runs");
  assert.equal(stat.posts, 0);
  await new Promise((r) => setTimeout(r, slowMs + 300)); // the abandoned statement commits
  assert.ok(rows.has(SLOW));
  process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "2000";
});

test("a CHANGED page is still sent while an earlier send of the slug is open (the new content must land)", async () => {
  process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "300";
  rows.delete(SLOW);
  for (const key of Object.keys(stat)) stat[key] = 0;
  writeSourceLeaves([slowLeaf("v2")], outDir);
  await m.finishWikiPages("C", { outDir }); // timed out, recorded
  for (const key of Object.keys(stat)) stat[key] = 0;
  writeSourceLeaves([slowLeaf("v3")], outDir);
  await m.finishWikiPages("D", { outDir });
  assert.equal(stat.slowPosts, 1, "changed content is a new send (once)");
  await new Promise((r) => setTimeout(r, slowMs + 300));
  process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "2000";
});

test("2. the back-off outlasts the worst statement: default base 360 s; a retry while the statement still runs sends nothing", async () => {
  delete process.env.WIKI_UNSYNCED_BACKOFF_BASE_MS;
  assert.ok(m.backoffMs(1) >= 300_000, "longer than the worst statement seen live (about 5 min)");
  assert.equal(m.backoffMs(2), 2 * m.backoffMs(1));
  // a ledger entry just recorded by a timed-out send is not due until the base has passed
  process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "300";
  const slug = "content/source/slow-2";
  rows.delete(slug);
  writeSourceLeaves([{ id: "slow-2", title: "Slow2", content: "x" }], outDir);
  await m.finishWikiPages("E", { outDir });
  for (const key of Object.keys(stat)) stat[key] = 0;
  const r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: () => {} });
  assert.equal(r.retried, 0);
  assert.ok(r.waiting >= 1);
  assert.equal(stat.posts + stat.gets, 0);
  await new Promise((rr) => setTimeout(rr, slowMs + 300));
  process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "2000";
  process.env.WIKI_UNSYNCED_BACKOFF_BASE_MS = "60000";
});
