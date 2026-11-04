// node --test recipes/_shared/wiki-pages.withheld.test.mjs
// research-workbench rw-idea-privacy round 4 (review R1): a database guard (a BEFORE trigger on wiki_pages that returns
// NULL - slot 380's idea guard, slot 390's report guard) WITHHOLDS a row while PostgREST still answers 2xx. The writer
// must learn which rows were withheld (return=representation), neither count nor commit their files, and not treat
// them as failures; the reconcile must not count such a page as drift, and must not name it.
// A fake PostgREST: a POSTed row whose slug contains "held" is left out of the representation (withheld), as the
// guard does; GET wiki_pages?slug=in.(...) answers which slugs have a row.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rowsInDb = new Set(["content/topic/held-update"]); // an older clean row the guard keeps on an update
let representation = true;
let sayWithheld = true;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST") {
      const rows = JSON.parse(raw || "[]");
      if (!Array.isArray(rows)) { res.writeHead(204); res.end(); return; } // the failure notice the writer posts
      // "held" = a guard withheld it (and says so in the X-Wiki-Withheld count, as slot 430's guards do); "hidden" = a row the
      // database does not return and no guard reports (a later RLS policy)
      const written = rows.filter((r) => !r.slug.includes("held") && !r.slug.includes("hidden"));
      for (const r of written) rowsInDb.add(r.slug);
      const heldN = rows.filter((r) => r.slug.includes("held")).length;
      res.writeHead(201, { "content-type": "application/json", ...(sayWithheld && heldN ? { "x-wiki-withheld": String(heldN) } : {}) });
      res.end(representation ? JSON.stringify(written.map((r) => ({ slug: r.slug }))) : "");
      return;
    }
    if (req.method === "GET") {
      const m = /^in\.\((.*)\)$/.exec(url.searchParams.get("slug") || "");
      const asked = m ? m[1].split(",").map((x) => x.replace(/^"|"$/g, "")) : [...rowsInDb];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(asked.filter((s) => rowsInDb.has(s)).map((slug) => ({ slug, page_class: "entity", updated_at: new Date().toISOString(), links: [], body: "x" }))));
      return;
    }
    res.writeHead(204); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());
process.env.OPEN_BRAIN_URL = `http://127.0.0.1:${server.address().port}`;
const vault = mkdtempSync(join(tmpdir(), "wp-held-"));
process.env.WIKI_GIT_DIR = vault;
const dir = join(vault, "content", "topic");
mkdirSync(dir, { recursive: true });
const page = (title, body) => `---\ntitle: ${title}\n---\n${body}\n`;
// before the run: an older file whose row the guard keeps (an update target), and a stale file with NO row (a page
// withheld before this run whose file was never moved out)
writeFileSync(join(dir, "held-update.md"), page("Held update", "the clean page as it was"));
writeFileSync(join(dir, "held-stale.md"), page("Held stale", "an old copy that shows withheld text"));
const m = await import("./wiki-pages.mjs");

test("a withheld CREATE leaves no file, a clean page in the same batch lands, and the run ends 0 (not unsynced)", async () => {
  m.writeWikiPage(join(dir, "held-new.md"), page("Held new", "a page the guard refuses"));
  m.writeWikiPage(join(dir, "clean-new.md"), page("Clean new", "a page the guard lets through"));
  const code = await m.finishWikiPages("test");
  assert.equal(code, 0, "a withheld row is not a failed row");
  assert.equal(existsSync(join(dir, "held-new.md")), false, "the withheld page's file was written / left");
  assert.equal(existsSync(join(dir, "clean-new.md")), true, "the clean page in the same batch did not land");
  assert.deepEqual(m.unsyncedWikiPages(), [], "a withheld row is not unsynced (no failure loop)");
  assert.equal(m.isWithheldWikiPage("content/topic/held-new"), true);
  assert.equal(m.isWithheldWikiPage("content/topic/clean-new"), false);
});

test("a withheld UPDATE keeps the file of the row the guard kept; its staged copy is dropped", async () => {
  m.writeWikiPage(join(dir, "held-update.md"), page("Held update", "new text the guard refuses"));
  assert.equal(await m.finishWikiPages("test"), 0);
  assert.match(readFileSync(join(dir, "held-update.md"), "utf8"), /the clean page as it was/, "the refused text reached the file");
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes("wp-staged")), [], "a staged copy is left behind");
});

test("an older file of a withheld page with NO row is removed (it would be drift and shows what was refused)", async () => {
  m.queueWikiPage(join(dir, "held-stale.md"), page("Held stale", "an old copy that shows withheld text"));
  assert.equal(await m.finishWikiPages("test"), 0);
  assert.equal(existsSync(join(dir, "held-stale.md")), false);
});

test("the reconcile: a withheld page is not drift, and the report names no withheld slug", async () => {
  const { reconcile, formatReport } = await import("./reconcile-wiki-pages.mjs");
  // a withheld page's file put back by hand (the deploy step skipped): the repair tries it, learns it is withheld
  writeFileSync(join(dir, "held-back.md"), page("Held back", "a refused page someone put back"));
  const r = await reconcile({ vault, repair: true, log: () => {}, classOf: () => "entity", structuralFile: join(vault, ".none.json") });
  const after = r.after ?? r;
  const slugsIn = (x) => [...x.missing, ...x.stale, ...x.empty, ...x.orphan];
  assert.ok(!slugsIn(after).some((s) => s.includes("held")), "a withheld slug is reported as drift");
  assert.ok(after.withheld >= 1, "the withheld count is not reported");
  assert.ok(!/topic\/held-/.test(formatReport(after)), `the report names a withheld slug: ${formatReport(after)}`);
  // and a plain check (no repair) in the same process still leaves it out
  const c = await reconcile({ vault, repair: false, log: () => {}, classOf: () => "entity", structuralFile: join(vault, ".none.json") });
  assert.ok(!slugsIn(c).some((s) => s.includes("held")));
});

test("a body that tells nothing (no representation) counts as landed - the behaviour before this change", async () => {
  representation = false;
  try {
    m.writeWikiPage(join(dir, "held-compat.md"), page("Compat", "x"));
    assert.equal(await m.finishWikiPages("test"), 0);
    assert.equal(existsSync(join(dir, "held-compat.md")), true);
  } finally {
    representation = true;
  }
});

test("a row nobody withheld (RLS hides it) is HIDDEN, not withheld: its file is KEPT, it is unsynced, the run does not end 0 (rw-privacy-hardening)", async () => {
  m.writeWikiPage(join(dir, "hidden-new.md"), page("Hidden new", "a page the database does not return and no guard reports"));
  m.writeWikiPage(join(dir, "clean-two.md"), page("Clean two", "a clean page in the same batch"));
  const code = await m.finishWikiPages("test");
  assert.notEqual(code, 0, "a hidden row must fail the run, not be taken for withheld");
  assert.equal(existsSync(join(dir, "hidden-new.md")), true, "the hidden page's file was deleted as if it were withheld");
  assert.equal(existsSync(join(dir, "clean-two.md")), true);
  assert.ok(m.unsyncedWikiPages().some((x) => x.slug === "content/topic/hidden-new"));
  assert.equal(m.isWithheldWikiPage("content/topic/hidden-new"), false);
});

test("a guard that does not say it withheld (no X-Wiki-Withheld count) leaves its rows HIDDEN: nothing is deleted on an inference", async () => {
  sayWithheld = false;
  m.writeWikiPage(join(dir, "held-silent.md"), page("Held silent", "withheld by an old guard that never says so"));
  const code = await m.finishWikiPages("test");
  sayWithheld = true;
  assert.notEqual(code, 0);
  assert.equal(existsSync(join(dir, "held-silent.md")), true);
  assert.equal(m.isWithheldWikiPage("content/topic/held-silent"), false);
});
