// node --test recipes/_shared/wiki-pages.refused.test.mjs
// research-workbench rw-wiki-guarded-pages: the privacy guards (slots 380, 390, 430, 440) REFUSE a note out loud - RAISE
// 42501 "wiki_pages: this page cannot be saved" - and PostgREST then fails the whole request. Live 2026-11-21 that made the
// viewer's repair fail for 29 rows every pass (22 refused notes in the batch) and kept 400 rows in the wiki-service's
// "database outage" retry for ever. A refusal must be WITHHELD: recorded with no text, never retried, its file out of the
// vault; the reconcile counts it as expected - while a page that is genuinely missing still counts as drift.
// Only the public writer and reconcile functions are used, so the same file runs against the base (it must FAIL there).
// The fake PostgREST: a POST whose batch holds a slug with "refused" answers 401 + the guards' one message (the whole
// request fails, as in PostgreSQL); a "held" slug is withheld silently (X-Wiki-Withheld), the rest land.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = new Map(); // slug -> { page_class, updated_at }
const posts = new Map(); // slug -> times POSTed
const GUARD = '{"code":"42501","details":null,"hint":null,"message":"wiki_pages: this page cannot be saved"}';
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST") {
      const rows = JSON.parse(raw || "[]");
      if (!Array.isArray(rows)) { res.writeHead(204); res.end(); return; }
      for (const r of rows) posts.set(r.slug, (posts.get(r.slug) || 0) + 1);
      if (rows.some((r) => r.slug.includes("refused"))) { res.writeHead(401, { "content-type": "application/json" }); res.end(GUARD); return; }
      const written = rows.filter((r) => !r.slug.includes("held"));
      for (const r of written) db.set(r.slug, { page_class: r.page_class, updated_at: new Date(Date.now() + 1000).toISOString() });
      const heldN = rows.length - written.length;
      res.writeHead(201, { "content-type": "application/json", ...(heldN ? { "x-wiki-withheld": String(heldN) } : {}) });
      res.end(JSON.stringify(written.map((r) => ({ slug: r.slug }))));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      if (url.searchParams.get("body")) { res.end("[]"); return; } // the empty-body prefilter: none empty
      const m = /^in\.\((.*)\)$/.exec(url.searchParams.get("slug") || "");
      const gt = /^gt\.(.*)$/.exec(url.searchParams.get("slug") || "");
      let slugs = [...db.keys()].sort();
      if (m) slugs = m[1].split(",").map((x) => x.replace(/^"|"$/g, "")).filter((s) => db.has(s));
      if (gt) slugs = slugs.filter((s) => s > gt[1]);
      res.end(JSON.stringify(slugs.map((slug) => ({ slug, ...db.get(slug), links: [], body: "x" }))));
      return;
    }
    res.writeHead(204); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());
process.env.OPEN_BRAIN_URL = `http://127.0.0.1:${server.address().port}`;
const vault = mkdtempSync(join(tmpdir(), "wp-guard-"));
process.env.WIKI_GIT_DIR = vault;
process.env.OB_WIKI_OUT_DIR = join(vault, "content");
process.env.WIKI_NOTIFY_FILE = join(vault, "notify.jsonl");
process.env.RECONCILE_MISSING_RECHECK_MS = "0";
const nb = join(vault, "content", "notebooks", "nb");
const src = join(vault, "content", "source");
mkdirSync(nb, { recursive: true });
mkdirSync(src, { recursive: true });
const page = (title, body) => `---\ntitle: ${title}\n---\n${body}\n`;
const SECRET = "planted-private-marker-7f3a";
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const recordFile = join(vault, "content", ".withheld-pages.json");
const record = () => { try { return readFileSync(recordFile, "utf8"); } catch { return ""; } };
const m = await import("./wiki-pages.mjs");
const rc = await import("./reconcile-wiki-pages.mjs");
const quiet = async (fn) => {
  const lines = [];
  const [l, e] = [console.log, console.error];
  console.log = (x) => lines.push(String(x)); console.error = (x) => lines.push(String(x));
  try { return { out: await fn(), lines }; } finally { console.log = l; console.error = e; }
};

test("a planted private note is REFUSED by the guard: withheld (no file, recorded by hash only), the clean page of the same batch lands, the run ends 0", async () => {
  m.writeWikiPage(join(nb, "refused-a.md"), page("Refused A", `A notebook note that carries ${SECRET}.`));
  m.writeWikiPage(join(nb, "clean-a.md"), page("Clean A", "A notebook note with shared text only."));
  const { out: code, lines } = await quiet(() => m.finishWikiPages("test"));
  assert.equal(code, 0, "a refused row is not a failed run");
  assert.equal(db.has("content/notebooks/nb/clean-a"), true, "the clean page of the batch did not land (one refusal failed the whole request)");
  assert.equal(existsSync(join(nb, "refused-a.md")), false, "the refused page's file stays in the served vault");
  assert.deepEqual(m.unsyncedWikiPages(), [], "a refused row is unsynced (it would be retried)");
  const rec = record();
  assert.ok(rec.includes(hash("content/notebooks/nb/refused-a")), "the refusal is not recorded as withheld");
  assert.ok(!rec.includes("refused-a") && !rec.includes(SECRET) && !rec.includes("Refused A"), "the record carries the slug or the text");
  assert.ok(!lines.join("\n").includes(SECRET) && !lines.join("\n").includes("refused-a"), "the log names the refused page or its text");
});

test("the next cycle's retry: a refused row is withheld and dropped from the record, never retried; the others land", async () => {
  writeFileSync(join(src, "refused-r.md"), page("Refused R", `A source page that carries ${SECRET}.`));
  writeFileSync(join(src, "clean-r.md"), page("Clean R", "A source page with shared text only."));
  const at = new Date().toISOString();
  writeFileSync(join(vault, "content", ".unsynced-rows.json"), JSON.stringify({ rows: {
    "content/source/refused-r": { error: "The operation was aborted due to timeout", tag: "generate-wiki", at },
    "content/source/clean-r": { error: "The operation was aborted due to timeout", tag: "generate-wiki", at },
  } }));
  const { out: r1 } = await quiet(() => m.retryUnsyncedRows({ outDir: join(vault, "content"), vaultDir: vault, log: () => {} }));
  assert.equal(r1.landed, 1, `the clean row did not land beside the refused one (${JSON.stringify(r1)})`);
  assert.equal(db.has("content/source/clean-r"), true);
  const left = JSON.parse(readFileSync(join(vault, "content", ".unsynced-rows.json"), "utf8")).rows;
  assert.deepEqual(Object.keys(left), [], "the refused row stays recorded for the next retry (the 400-failed-again loop)");
  assert.equal(existsSync(join(src, "refused-r.md")), false, "the refused page's file stays in the served vault");
  assert.ok(record().includes(hash("content/source/refused-r")), "the refusal is not recorded as withheld");
  const before = posts.get("content/source/refused-r");
  const { out: r2 } = await quiet(() => m.retryUnsyncedRows({ outDir: join(vault, "content"), vaultDir: vault, log: () => {} }));
  assert.equal(r2.retried, 0, "the next cycle retries the refused row again");
  assert.equal(posts.get("content/source/refused-r"), before, "the refused row was POSTed again");
});

test("the viewer's repair (another process, nothing in its memory): a refused file is counted withheld, the clean missing one is repaired, drift 0", async () => {
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  writeFileSync(join(nb, "refused-v.md"), page("Refused V", `A note that carries ${SECRET}.`));
  writeFileSync(join(nb, "clean-v.md"), page("Clean V", "A note with shared text only."));
  const { out: r } = await quiet(() => rc.reconcile({ vault, repair: true, log: () => {} }));
  const after = r.after || r;
  assert.equal(db.has("content/notebooks/nb/clean-v"), true, "one refused note failed the whole repair batch");
  assert.equal(after.drift, 0, `the reconcile is red with only a refused page left (${JSON.stringify({ missing: after.missing, stale: after.stale, orphan: after.orphan })})`);
  assert.ok(after.withheld >= 1, "the refused page is not counted as withheld");
});

test("the viewer stays GREEN with a recorded withheld page present (a fresh process: no memory), and its health names no slug", async () => {
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  const { out: r } = await quiet(() => rc.reconcile({ vault, repair: false, log: () => {} }));
  assert.equal(r.drift, 0, `drift with only withheld pages present (${JSON.stringify({ missing: r.missing, stale: r.stale, orphan: r.orphan })})`);
  assert.ok(r.withheld >= 1, `the recorded withheld pages are not counted (${r.withheld})`);
  const text = rc.formatReport(r);
  assert.ok(!/refused-/.test(text) && !text.includes(SECRET), "the report names a withheld page");
});

test("an older row the guard kept, with a newer refused file: not stale while recorded, and not an orphan once the file is moved out", async () => {
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  db.set("content/notebooks/nb/refused-old", { page_class: "note", updated_at: new Date(Date.now() - 3600_000).toISOString() });
  const f = join(nb, "refused-old.md");
  writeFileSync(f, page("Refused old", `A newer note that carries ${SECRET}.`));
  const { out: r0 } = await quiet(() => rc.reconcile({ vault, repair: true, log: () => {} }));
  const a0 = r0.after || r0;
  assert.equal(a0.drift, 0, `the refused update is drift (${JSON.stringify({ stale: a0.stale, missing: a0.missing })})`);
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  (await import("node:fs")).unlinkSync(f);
  const { out: r1 } = await quiet(() => rc.reconcile({ vault, repair: false, log: () => {} }));
  assert.equal(r1.drift, 0, `the kept row is an orphan once its refused file is out (${JSON.stringify({ orphan: r1.orphan })})`);
});

test("REGRESSION: a genuinely missing page (not withheld) still turns the reconcile red, and names it", async () => {
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  const f = join(src, "missing-g.md");
  writeFileSync(f, page("Missing G", "A clean page whose row never landed."));
  const old = new Date(Date.now() - 60_000); utimesSync(f, old, old);
  const { out: r } = await quiet(() => rc.reconcile({ vault, repair: false, log: () => {} }));
  assert.ok(r.drift >= 1, "a genuinely missing page is not drift");
  assert.ok(r.missing.includes("content/source/missing-g"), "the missing page is not named");
});

test("the cleanup moves the refused files already in the vault to a backup folder (counts only) and its revert puts them back", async (t) => {
  let cl;
  try { cl = await import("./withheld-pages-cleanup.mjs"); } catch { assert.fail("there is no cleanup (withheld-pages-cleanup.mjs)"); }
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  (await import("node:fs")).unlinkSync(join(src, "missing-g.md")); // the regression's page: not this test's
  writeFileSync(join(nb, "refused-c.md"), page("Refused C", `An old refused note that carries ${SECRET}.`)); // a file left by the old writer
  const backup = join(vault, ".withheld-backup-test");
  const { out: a, lines } = await quiet(() => cl.apply({ vault, backup }));
  assert.ok(a.moved >= 2, `the refused files were not moved (${a.moved})`);
  assert.equal(existsSync(join(nb, "refused-c.md")), false, "a refused file is still in the served vault");
  assert.equal(existsSync(join(backup, "files", "content", "notebooks", "nb", "refused-c.md")), true, "the refused file is not in the backup");
  assert.equal(a.report.drift, 0, `drift after the cleanup (${JSON.stringify({ missing: a.report.missing, stale: a.report.stale, orphan: a.report.orphan })})`);
  assert.ok(!lines.join("\n").includes("refused-") && !lines.join("\n").includes(SECRET), "the cleanup's output names a page or its text");
  const { out: r, lines: l2 } = await quiet(() => cl.revert({ vault, backup }));
  assert.equal(r.back, a.moved, "the revert did not put every file back");
  assert.equal(existsSync(join(nb, "refused-c.md")), true, "the refused file is not back");
  assert.ok(!l2.join("\n").includes("refused-") && !l2.join("\n").includes(SECRET), "the revert's output names a page or its text");
});
