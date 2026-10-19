// node --test recipes/_shared/reconcile-wiki-pages.test.mjs
// The files-vs-rows reconciliation (research-workbench D13 item 4): missing,
// stale ("no row older than its file") and orphan, per page_class, by slug;
// and the note-link resolution the repair pass preserves.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffFilesRows, resolveNoteLinks, formatReport, rowState, isEmptyBody, markEmptyFiles, listRows, EMPTY_BODY_PREFILTER,
} from "./reconcile-wiki-pages.mjs";
import { classify } from "./page-classes.mjs";

const T = Date.parse("2026-10-18T00:00:00Z");
const cls = (rel) => classify(rel).page_class;

test("names the missing row, the stale row and the orphan row by slug, per class", () => {
  const files = new Map([
    ["content/person/person-a", { rel: "content/person/person-a.md", mtimeMs: T }],
    ["content/person/person-gone", { rel: "content/person/person-gone.md", mtimeMs: T }],
    ["content/thought/1", { rel: "content/thought/1.md", mtimeMs: T }],
  ]);
  const rows = new Map([
    ["content/person/person-a", { slug: "content/person/person-a", page_class: "entity", updated_at: new Date(T + 1000).toISOString() }],
    ["content/thought/1", { slug: "content/thought/1", page_class: "thought", updated_at: "2020-01-01T00:00:00Z" }],
    ["content/person/person-orphan", { slug: "content/person/person-orphan", page_class: "entity", updated_at: new Date(T).toISOString() }],
  ]);
  const r = diffFilesRows(files, rows, cls);
  assert.deepEqual(r.missing, ["content/person/person-gone"]);
  assert.deepEqual(r.stale, ["content/thought/1"]);
  assert.deepEqual(r.orphan, ["content/person/person-orphan"]);
  assert.equal(r.drift, 3);
  assert.deepEqual(r.byClass.entity, { files: 2, rows: 2, missing: ["content/person/person-gone"], stale: [], empty: [], orphan: ["content/person/person-orphan"], failed: [] });
  assert.match(formatReport(r), /DRIFT.*1 missing, 1 stale, 0 empty, 1 orphan, 0 failed/);
});

test("a clean vault reports clean (and a row newer than its file is not stale)", () => {
  const files = new Map([["notes/n", { rel: "notes/n.md", mtimeMs: T }]]);
  const rows = new Map([["notes/n", { slug: "notes/n", page_class: "note", updated_at: new Date(T + 5).toISOString() }]]);
  const r = diffFilesRows(files, rows, cls);
  assert.equal(r.drift, 0);
  assert.match(formatReport(r), /clean/);
});

test("the repair pass resolves note links like the workbench: exact, else the one suffix match, else raw", () => {
  const slugs = new Set(["content/tool/tool-postgresql", "notes/a", "content/x/dup", "content/y/dup"]);
  assert.deepEqual(resolveNoteLinks(["notes/a", "tool-postgresql", "dup", "nowhere"], slugs),
    ["notes/a", "content/tool/tool-postgresql", "dup", "nowhere"]);
});

// rw-p1a-render attempt 2 (tester near-misses N1, N2; D13 items 5-6).
const NOW = T + 3_600_000;

test("N1: a row with an empty body is drift (empty), except a folder/tag index", () => {
  const files = new Map([
    ["content/thought/2", { rel: "content/thought/2.md", mtimeMs: T }],
    ["notes/f/index", { rel: "notes/f/index.md", mtimeMs: T }],
  ]);
  const rows = new Map([
    ["content/thought/2", { slug: "content/thought/2", page_class: "thought", updated_at: new Date(T + 1000).toISOString(), empty: true }],
    ["notes/f/index", { slug: "notes/f/index", page_class: "note", updated_at: new Date(T + 1000).toISOString(), empty: true }],
  ]);
  const r = diffFilesRows(files, rows, cls, { now: NOW });
  assert.deepEqual(r.empty, ["content/thought/2"]);
  assert.equal(r.drift, 1);
  assert.equal(rowState({ slug: "content/thought/2", body: " \t ", updated_at: new Date(T).toISOString() }, T, { now: NOW }), "empty");
  assert.equal(rowState({ slug: "content/thought/2", body: "# x", updated_at: new Date(T).toISOString() }, T, { now: NOW }), null);
});

test("N2: a row dated in the future cannot hide a newer file - it is stale (and listed as future)", () => {
  const files = new Map([["content/tool/t", { rel: "content/tool/t.md", mtimeMs: NOW - 10 }]]);
  const rows = new Map([["content/tool/t", { slug: "content/tool/t", page_class: "entity", updated_at: "2099-01-01T00:00:00Z", empty: false }]]);
  const r = diffFilesRows(files, rows, cls, { now: NOW });
  assert.deepEqual(r.stale, ["content/tool/t"]);
  assert.deepEqual(r.future, ["content/tool/t"]);
  assert.equal(rowState(rows.get("content/tool/t"), NOW - 10, { now: NOW }), "future");
  // a row a little ahead of the clock (within RECONCILE_FUTURE_MS) is fine
  assert.equal(rowState({ slug: "content/tool/t", updated_at: new Date(NOW + 5_000).toISOString() }, NOW - 10, { now: NOW }), null);
});

test("D13 item 5: a row older than its file is stale for the renderer too (rowState)", () => {
  assert.equal(rowState({ slug: "content/person/p", body: "# p", updated_at: "2020-01-01T00:00:00Z" }, T, { now: NOW }), "stale");
  assert.equal(rowState({ slug: "content/person/p", body: "# p", updated_at: "not a date" }, T, { now: NOW }), "stale");
  assert.equal(rowState({ slug: "content/person/p", body: "# p", updated_at: new Date(T).toISOString() }, null, { now: NOW }), null, "no file: nothing to compare");
});

test("D13 item 6: an open structural failure is listed (failed) until it is fixed", () => {
  const files = new Map();
  const rows = new Map();
  const r = diffFilesRows(files, rows, cls, { failed: [{ slug: "content/person/person-dave-fixture", error: "x" }], now: NOW });
  assert.deepEqual(r.failed, ["content/person/person-dave-fixture"]);
  assert.deepEqual(r.byClass.entity.failed, ["content/person/person-dave-fixture"]);
  assert.equal(r.drift, 1);
  assert.match(formatReport(r), /DRIFT.*1 failed[\s\S]*failed: content\/person\/person-dave-fixture/);
});

// ── attempt 3: ONE emptiness rule (N2-3), a faithfully empty page (N2-4/N2-5) ─
const EMPTY = ["", " \n\t", "\u00a0\u3000", "\u00a0", "\u3000\n", "\ufeff", "\u200b\u2060", "---\ntitle: x\n---\n",
  "---\ntitle: x\n---", "+++\ntitle = 'x'\n+++\n", "%% a comment %%", "%%\nmulti\nline\n%%\n", "<!-- c -->",
  '<div onclick="x()"></div>', "<script>alert(1)</script>", "<style>p{}</style>\n<br>", "  \n%% c %%\n<span></span>\n"];
const NOT_EMPTY = ["text", "# H", "<b>x</b>", "---", "---\n", "- item", "![img](a.png)", "\u00a0x", "%% c %% x", "| a |\n|---|\n| 1 |"];

test("N2-3: isEmptyBody is ONE rule - NBSP, ideographic space, BOM, zero-width, frontmatter-only, comment-only, raw-HTML-only are empty", () => {
  for (const t of EMPTY) assert.equal(isEmptyBody(t), true, JSON.stringify(t));
  for (const t of NOT_EMPTY) assert.equal(isEmptyBody(t), false, JSON.stringify(t));
  // the renderer's rowState uses the same rule on row.body
  for (const t of EMPTY) assert.equal(rowState({ slug: "content/thought/2", body: t, updated_at: new Date(T).toISOString() }, T, { now: NOW }), "empty", JSON.stringify(t));
});

test("N2-3: the database prefilter is a SUPERSET of isEmptyBody (every empty body matches it), so the reconcile never misses one", () => {
  const re = new RegExp(EMPTY_BODY_PREFILTER.replace("[:alnum:]", "\\p{L}\\p{N}"), "u");
  for (const t of EMPTY) assert.ok(re.test(t), `prefilter misses ${JSON.stringify(t)}`);
  assert.equal(re.test("A normal page body."), false, "an ordinary body is not even read");
});

test("N2-4/N2-5: a row AND file both empty (a note that is frontmatter only) is presentable, not drift; an empty row over a non-empty file is", () => {
  const files = new Map([
    ["notes/empty-body-note", { rel: "notes/empty-body-note.md", mtimeMs: T, emptyBody: true }],
    ["content/thought/2", { rel: "content/thought/2.md", mtimeMs: T, emptyBody: false }],
  ]);
  const rows = new Map([
    ["notes/empty-body-note", { slug: "notes/empty-body-note", page_class: "note", updated_at: new Date(T + 1000).toISOString(), empty: true }],
    ["content/thought/2", { slug: "content/thought/2", page_class: "thought", updated_at: new Date(T + 1000).toISOString(), empty: true }],
  ]);
  const r = diffFilesRows(files, rows, cls, { now: NOW });
  assert.deepEqual(r.empty, ["content/thought/2"]);
  assert.equal(r.drift, 1);
  assert.equal(rowState({ slug: "notes/empty-body-note", body: "", updated_at: new Date(T + 1000).toISOString() }, T, { now: NOW, fileEmpty: true }), null);
  assert.equal(rowState({ slug: "notes/orphan", body: "", updated_at: new Date(T + 1000).toISOString() }, null, { now: NOW, fileEmpty: true }), "empty",
    "no file: not shown to be meant empty");
});

test("N2-3/N2-5: listRows reads the prefiltered bodies and applies isEmptyBody; markEmptyFiles reads only the empty rows' files", async () => {
  const vault = mkdtempSync(join(tmpdir(), "rec-empty-"));
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "notes/fm-only.md"), "---\ntitle: FM only\ntags: [x]\n---\n");
  writeFileSync(join(vault, "notes/nbsp.md"), "---\ntitle: N\n---\n# Real content\n");
  const all = [
    { slug: "notes/fm-only", page_class: "note", updated_at: new Date(T + 1000).toISOString(), links: [], body: "" },
    { slug: "notes/nbsp", page_class: "note", updated_at: new Date(T + 1000).toISOString(), links: [], body: "\u00a0\u3000" },
    { slug: "notes/full", page_class: "note", updated_at: new Date(T + 1000).toISOString(), links: [], body: "# Full" },
  ];
  const asked = [];
  const fakeFetch = async (url) => {
    const u = new URL(url);
    asked.push(u.searchParams.get("select"));
    const m = u.searchParams.get("body");
    let out = all;
    if (m) {
      assert.equal(m, `match.${EMPTY_BODY_PREFILTER}`);
      const re = new RegExp(EMPTY_BODY_PREFILTER.replace("[:alnum:]", "\\p{L}\\p{N}"), "u");
      out = all.filter((x) => re.test(x.body));
    }
    if (u.searchParams.get("slug")) out = [];
    return { ok: true, json: async () => out.map((x) => Object.fromEntries(u.searchParams.get("select").split(",").map((k) => [k, x[k]]))) };
  };
  const rows = await listRows(fakeFetch);
  assert.deepEqual([...rows.values()].filter((x) => x.empty).map((x) => x.slug).sort(), ["notes/fm-only", "notes/nbsp"]);
  assert.ok(asked.includes("slug,body"), "only the prefiltered rows' bodies are read");
  const files = new Map([
    ["notes/fm-only", { rel: "notes/fm-only.md", mtimeMs: T }],
    ["notes/nbsp", { rel: "notes/nbsp.md", mtimeMs: T }],
    ["notes/full", { rel: "notes/full.md", mtimeMs: T }],
  ]);
  await markEmptyFiles(vault, files, rows);
  assert.equal(files.get("notes/fm-only").emptyBody, true);
  assert.equal(files.get("notes/nbsp").emptyBody, false);
  assert.equal(files.get("notes/full").emptyBody, undefined, "a non-empty row's file is never read");
  const r = diffFilesRows(files, rows, cls, { now: NOW });
  assert.deepEqual(r.empty, ["notes/nbsp"], "NBSP row over a real file is drift (the tester's N2-3); the frontmatter-only note is not (N2-5)");
});
