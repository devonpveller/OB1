// node --test recipes/_shared/page-classes.test.mjs
// The compile half of the page-class registry (research-workbench P1a,
// expansion by registration): the built-ins reproduce the pre-registry
// mapping exactly, and a registered class takes its files without changing
// any existing entry.
import test from "node:test";
import assert from "node:assert/strict";
import { classify, compileClasses, registerCompileClass, unregisterCompileClass } from "./page-classes.mjs";
import { diffFilesRows } from "./reconcile-wiki-pages.mjs";

test("built-in entries reproduce the pre-registry classifySlug mapping value for value", () => {
  const cases = {
    "content/person/person-ada.md": ["entity", "person"],
    "content/source/uuid-1.md": ["source", null],
    "content/thought/9001.md": ["thought", null],
    "content/notebook/nb-x.md": ["notebook", null],
    "content/notebooks/nb/nb.md": ["note", null],
    "content/notebooks/index.md": ["note", null],
    "notes/my-note.md": ["note", null],
    "index.md": ["root", null],
    "content/entities.md": ["root", null],
  };
  for (const [rel, [cls, et]] of Object.entries(cases)) {
    const c = classify(rel);
    assert.equal(c.page_class, cls, rel);
    assert.equal(c.entity_type, et, rel);
  }
});

test("registering a class: its files get its page_class, reconciliation counts it, no existing entry changes", () => {
  const before = compileClasses().map((e) => [e.name, e.version, e.pageClass, e.priority, e.match]);
  assert.equal(classify("content/glossary/term-x.md").page_class, "entity", "before: an entity page");
  registerCompileClass({ name: "glossary", version: 1, pageClass: "glossary", priority: 50, match: (_s, p) => p[0] === "content" && p[1] === "glossary" });
  try {
    assert.equal(classify("content/glossary/term-x.md").page_class, "glossary");
    assert.equal(classify("content/person/person-ada.md").page_class, "entity", "other classes unaffected");
    const files = new Map([["content/glossary/term-x", { rel: "content/glossary/term-x.md", mtimeMs: 0 }]]);
    const rows = new Map([["content/glossary/term-x", { slug: "content/glossary/term-x", page_class: "glossary", updated_at: "2026-10-18T00:00:00Z" }]]);
    const r = diffFilesRows(files, rows, (rel) => classify(rel).page_class);
    assert.deepEqual(r.byClass.glossary, { files: 1, rows: 1, missing: [], stale: [], empty: [], orphan: [], failed: [] });
    const after = compileClasses().filter((e) => e.name !== "glossary").map((e) => [e.name, e.version, e.pageClass, e.priority, e.match]);
    assert.deepEqual(after, before);
    assert.ok(compileClasses().every(Object.isFrozen));
    assert.throws(() => registerCompileClass({ name: "glossary", version: 1, pageClass: "x", priority: 1, match: () => false }), /already registered/);
    assert.throws(() => registerCompileClass({ name: "tied", version: 1, pageClass: "x", priority: 50, match: () => false }), /priority 50 is already glossary's/);
  } finally {
    unregisterCompileClass("glossary");
  }
});

// rw-wiki-guarded-pages-r2 (review B2): what a tidy-up of refused pages may move. Only compile output the compile writes
// again from Open Brain; an owner's note and an AI note in a notebook are their own source of truth.
test("isRegenerable: entity / topic / source / thought pages and the notebook hubs + MOC yes; owner notes, AI notes, roots no", async () => {
  const { isRegenerable } = await import("./page-classes.mjs");
  const yes = ["content/person/person-ada.md", "content/topic/t-x.md", "content/source/uuid-1.md", "content/thought/9001.md",
    "content/notebook/nb-x.md", "content/notebooks/nb/nb.md", "content/notebooks/index.md"];
  const no = ["notes/my-note.md", "notes/notebooks/nb/a-note.md", "notes/notebooks/nb/nb.md", "content/notebooks/nb/an-ai-note.md",
    "content/notebooks/nb/sub/deeper.md", "index.md", "content/entities.md", "other/file.md"];
  for (const rel of yes) assert.equal(isRegenerable(rel), true, rel);
  for (const rel of no) assert.equal(isRegenerable(rel), false, rel);
  registerCompileClass({ name: "silent", version: 1, pageClass: "x", priority: 51, match: (_s, p) => p[1] === "silent" });
  try { assert.equal(isRegenerable("content/silent/a.md"), false, "a class that does not say is not regenerable (fail safe)"); }
  finally { unregisterCompileClass("silent"); }
  assert.throws(() => registerCompileClass({ name: "badregen", version: 1, pageClass: "x", priority: 52, match: () => false, regenerable: "yes" }), /regenerable/);
});
