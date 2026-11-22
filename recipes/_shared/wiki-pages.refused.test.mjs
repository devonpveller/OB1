// node --test recipes/_shared/wiki-pages.refused.test.mjs
// research-workbench rw-wiki-guarded-pages: the privacy guards (slots 380, 390, 430, 440) REFUSE a note out loud - RAISE
// 42501 "wiki_pages: this page cannot be saved" - and PostgREST then fails the whole request. Live 2026-11-21 that made the
// viewer's repair fail for 29 rows every pass (22 refused notes in the batch) and kept 400 rows in the wiki-service's
// "database outage" retry for ever. A refusal must be WITHHELD: recorded with no text, never retried, its file out of the
// vault; the reconcile counts it as expected - while a page that is genuinely missing still counts as drift.
// Only the public writer and reconcile functions are used, so the same file runs against the base (it must FAIL there).
// Round 2 (review B2, M1): the cleanup moves ONLY regenerable compile output - an owner's note (notes/**) and an AI note
// (content/notebooks/<nb>/<file>, not the hub) keep their files byte for byte - and its manifest is written before the
// first move, so an apply stopped part-way is revertable. isGuardRefusal's negative cases are pinned.
// The fake PostgREST: a POST whose batch holds a slug with "refused" answers 401 + the guards' one message (the whole
// request fails, as in PostgreSQL); a "held" slug is withheld silently (X-Wiki-Withheld), the rest land.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, unlinkSync } from "node:fs";
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

const sha = (f) => crypto.createHash("sha256").update(readFileSync(f)).digest("hex");
const ownerDir = join(vault, "notes", "notebooks", "nb");
const hubDir = join(vault, "content", "notebooks", "refused-hub");
const CL = {
  source: join(src, "refused-c.md"),                // regenerable: a source leaf
  hub: join(hubDir, "refused-hub.md"),               // regenerable: a notebook hub (content/notebooks/<nb>/<nb>)
  owner: join(ownerDir, "refused-owner.md"),         // an owner's note: never moved
  ai: join(nb, "refused-ai.md"),                     // an AI note in a notebook: never moved
};
const loadCleanup = async () => { try { return await import("./withheld-pages-cleanup.mjs"); } catch { assert.fail("there is no cleanup (withheld-pages-cleanup.mjs)"); } };

test("the cleanup moves ONLY regenerable refused files (a source leaf, a notebook hub) to a backup folder; an owner's note and an AI note stay in place byte for byte; counts only; the revert puts the moved ones back byte for byte", async () => {
  const cl = await loadCleanup();
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  try { unlinkSync(join(src, "missing-g.md")); } catch { /* the regression's page: not this test's */ }
  mkdirSync(ownerDir, { recursive: true }); mkdirSync(hubDir, { recursive: true });
  writeFileSync(CL.source, page("Refused C", `An old refused source leaf that carries ${SECRET}.`)); // a file left by the old writer
  writeFileSync(CL.hub, page("Refused hub", `An old refused notebook hub that carries ${SECRET}.`));
  writeFileSync(CL.owner, page("Refused owner", `The owner's own note, citing their private ${SECRET}.`));
  writeFileSync(CL.ai, page("Refused AI", `An AI note in a notebook that carries ${SECRET}.`));
  const before = Object.fromEntries(Object.entries(CL).map(([k, f]) => [k, sha(f)]));
  const backup = join(vault, ".withheld-backup-test");
  const { out: a, lines } = await quiet(() => cl.apply({ vault, backup }));
  assert.equal(existsSync(CL.owner), true, "an OWNER's note was moved out of their notebook (review B2)");
  assert.equal(existsSync(CL.ai), true, "an AI note (not regenerated by the compile) was moved (review B2)");
  assert.equal(sha(CL.owner), before.owner, "the owner's note changed");
  assert.equal(sha(CL.ai), before.ai, "the AI note changed");
  assert.equal(existsSync(join(backup, "files", "notes")), false, "something of notes/ is in the backup");
  assert.equal(existsSync(join(backup, "files", "content", "notebooks", "nb")), false, "an AI note is in the backup");
  assert.equal(a.moved, 2, `only the two regenerable refused files move (${a.moved})`);
  assert.equal(existsSync(CL.source) || existsSync(CL.hub), false, "a refused compile page is still in the served vault");
  assert.equal(existsSync(join(backup, "files", "content", "source", "refused-c.md")), true, "the refused source leaf is not in the backup");
  assert.equal(existsSync(join(backup, "files", "content", "notebooks", "refused-hub", "refused-hub.md")), true, "the refused hub is not in the backup");
  assert.equal(a.report.drift, 0, `drift after the cleanup (${JSON.stringify({ missing: a.report.missing, stale: a.report.stale, orphan: a.report.orphan })})`);
  assert.ok(!lines.join("\n").includes("refused-") && !lines.join("\n").includes(SECRET), "the cleanup's output names a page or its text");
  const { out: r, lines: l2 } = await quiet(() => cl.revert({ vault, backup }));
  assert.equal(r.back, a.moved, "the revert did not put every file back");
  for (const k of Object.keys(CL)) assert.equal(sha(CL[k]), before[k], `${k}: not byte-identical after the revert`);
  assert.ok(!l2.join("\n").includes("refused-") && !l2.join("\n").includes(SECRET), "the revert's output names a page or its text");
});

test("M1: an apply that fails part-way has already written its manifest; --revert restores what moved, and counts what never did", async () => {
  const cl = await loadCleanup();
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  const before = Object.fromEntries(Object.entries(CL).map(([k, f]) => [k, sha(f)]));
  const backup = join(vault, ".withheld-backup-int");
  await assert.rejects(() => quiet(() => cl.apply({ vault, backup, failAfterMoves: 1 })), /stopped after 1 move/);
  assert.equal(existsSync(join(backup, "manifest.json")), true, "no manifest after a part-way failure: the revert cannot run");
  assert.equal([CL.source, CL.hub].filter((f) => !existsSync(f)).length, 1, "the interrupted apply did not stop after one move");
  const { out: r } = await quiet(() => cl.revert({ vault, backup }));
  assert.equal(r.back, 1, `the one moved file is not put back (${JSON.stringify(r)})`);
  assert.equal(r.notMoved, 1, `the file the apply never reached is not counted as such (${JSON.stringify(r)})`);
  assert.equal(r.gone, 0);
  for (const k of Object.keys(CL)) assert.equal(sha(CL[k]), before[k], `${k}: not byte-identical after the part-way revert`);
});

test("the retry never deletes a refused AI note's file (not compile output): it leaves the record, is recorded withheld, its file stays", async () => {
  m._resetWikiPagesForTests(); rc._resetReconcileForTests?.();
  const f = join(nb, "refused-rai.md");
  writeFileSync(f, page("Refused RAI", `An AI note that carries ${SECRET}.`));
  const h = sha(f);
  writeFileSync(join(vault, "content", ".unsynced-rows.json"), JSON.stringify({ rows: {
    "content/notebooks/nb/refused-rai": { error: "The operation was aborted due to timeout", tag: "lab", at: new Date().toISOString() } } }));
  await quiet(() => m.retryUnsyncedRows({ outDir: join(vault, "content"), vaultDir: vault, log: () => {} }));
  assert.equal(existsSync(f) && sha(f) === h, true, "the retry deleted or changed an AI note's file");
  assert.ok(record().includes(hash("content/notebooks/nb/refused-rai")), "the refusal is not recorded as withheld");
  const left = JSON.parse(readFileSync(join(vault, "content", ".unsynced-rows.json"), "utf8")).rows;
  assert.deepEqual(Object.keys(left), [], "the refused AI note stays in the retry record");
});

test("isGuardRefusal: only the guards' own 42501 + message is a refusal; every other failure is a real failure", () => {
  // as upsertWikiPagesReport throws them: "POST wiki_pages: <status> <body, first 200 chars>"
  const post = (status, body) => new Error(`POST wiki_pages: ${status} ${(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200)}`);
  assert.equal(m.isGuardRefusal(post(401, GUARD)), true, "the guard's refusal");
  const MSG = "wiki_pages: this page cannot be saved";
  const real = {
    "42501 permission denied": post(403, { code: "42501", details: null, hint: null, message: "permission denied for table wiki_pages" }),
    "PGRST301 with the guard message": post(401, { code: "PGRST301", details: null, hint: null, message: MSG }),
    "a network error": new TypeError("fetch failed"),
    "a network error (cause)": Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    "23514 echoing code and message in details": post(400, { code: "23514", details: JSON.stringify({ code: "42501", message: MSG }), hint: null, message: "new row for relation wiki_pages violates check constraint" }),
    "23514 echoing code and message in hint and message": post(400, { code: "23514", details: "code 42501", hint: JSON.stringify({ code: "42501" }), message: MSG }),
    "the message with extra words after": post(401, { code: "42501", details: null, hint: null, message: `${MSG} because it is private` }),
    "the message with extra words before": post(401, { code: "42501", details: null, hint: null, message: `error: ${MSG}` }),
  };
  for (const [what, e] of Object.entries(real)) assert.equal(m.isGuardRefusal(e), false, `${what} was taken for a guard refusal (a real failure would be hidden as withheld)`);
});
