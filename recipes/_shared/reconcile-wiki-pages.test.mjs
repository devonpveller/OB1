// node --test recipes/_shared/reconcile-wiki-pages.test.mjs
// The files-vs-rows reconciliation (research-workbench D13 item 4): missing,
// stale ("no row older than its file") and orphan, per page_class, by slug;
// and the note-link resolution the repair pass preserves.
import test from "node:test";
import assert from "node:assert/strict";
import { diffFilesRows, resolveNoteLinks, formatReport } from "./reconcile-wiki-pages.mjs";
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
  assert.deepEqual(r.byClass.entity, { files: 2, rows: 2, missing: ["content/person/person-gone"], stale: [], orphan: ["content/person/person-orphan"] });
  assert.match(formatReport(r), /DRIFT.*1 missing, 1 stale, 1 orphan/);
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
