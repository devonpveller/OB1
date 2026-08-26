// node --test recipes/_shared/wiki-pages.test.mjs
// Pure-logic gate for the wiki_pages sync (the I/O helpers are best-effort by
// contract and are exercised live, not here).
import test from "node:test";
import assert from "node:assert/strict";
import { classifySlug, extractLinks, parseWikiPage, vaultRel, queueWikiPage, queuedWikiPageCount } from "./wiki-pages.mjs";

test("classifySlug maps every page class the compiler emits", () => {
  assert.deepEqual(classifySlug("content/person/person-ada.md"),
    { slug: "content/person/person-ada", page_class: "entity", entity_type: "person" });
  assert.deepEqual(classifySlug("content/organization/organization-acme.md"),
    { slug: "content/organization/organization-acme", page_class: "entity", entity_type: "organization" });
  assert.equal(classifySlug("content/source/uuid-1.md").page_class, "source");
  assert.equal(classifySlug("content/thought/uuid-2.md").page_class, "thought");
  assert.equal(classifySlug("content/notebook/nb-x.md").page_class, "notebook");
  // notebooks/ (plural) = AI-authored notes, NOT entity pages (the sweeps
  // treat these differently too).
  assert.equal(classifySlug("content/notebooks/nb/page.md").page_class, "note");
  assert.equal(classifySlug("notes/my-note.md").page_class, "note");
  // Vault-root MOCs and aggregates are neither entity nor leaf.
  assert.equal(classifySlug("index.md").page_class, "root");
  assert.equal(classifySlug("content/entities.md").page_class, "root");
});

test("classifySlug normalises separators and leading slashes", () => {
  assert.equal(classifySlug("\\content\\person\\person-ada.md").slug, "content/person/person-ada");
  assert.equal(classifySlug("/notes/x.md").slug, "notes/x");
  // Extension-stripping is case-insensitive but only touches a trailing .md
  assert.equal(classifySlug("content/tool/a.md.md").slug, "content/tool/a.md");
});

test("extractLinks takes wikilink targets, dedupes, strips alias + anchor", () => {
  const body = "see [[content/person/person-ada|Ada]] and [[content/tool/tool-x#Usage]] " +
    "and [[content/person/person-ada]] again";
  assert.deepEqual(extractLinks(body), ["content/person/person-ada", "content/tool/tool-x"]);
  assert.deepEqual(extractLinks(""), []);
  assert.deepEqual(extractLinks(null), []);
});

test("parseWikiPage reads frontmatter, strips it from the body, parses tags", () => {
  const md = [
    "---",
    'title: "San Francisco Wiki"',
    "type: wiki",
    "entity_type: place",
    "tags: [wiki, entity]",
    "---",
    "",
    "# San Francisco",
    "",
    "Body text with [[content/organization/organization-acme|Acme]].",
    "",
  ].join("\n");
  const row = parseWikiPage("content/place/place-san-francisco.md", md);
  assert.equal(row.slug, "content/place/place-san-francisco");
  assert.equal(row.page_class, "entity");
  assert.equal(row.entity_type, "place");
  assert.equal(row.title, "San Francisco Wiki");
  assert.deepEqual(row.tags, ["wiki", "entity"]);
  assert.deepEqual(row.links, ["content/organization/organization-acme"]);
  assert.ok(!row.body.includes("title:"), "frontmatter must not leak into the FTS body");
  assert.ok(row.body.includes("# San Francisco"));
});

test("parseWikiPage tolerates missing/!malformed frontmatter without throwing", () => {
  const noFm = parseWikiPage("notes/plain.md", "just text\n");
  assert.equal(noFm.title, "plain");          // falls back to the slug basename
  assert.equal(noFm.body, "just text\n");
  assert.deepEqual(noFm.tags, []);
  const empty = parseWikiPage("notes/empty.md", "");
  assert.equal(empty.body, "");
  assert.equal(empty.title, "empty");
  // Block-style tag lists are not guessed at — absent beats wrong.
  const block = parseWikiPage("notes/b.md", "---\ntitle: B\ntags:\n  - one\n---\nbody\n");
  assert.deepEqual(block.tags, []);
  assert.equal(block.title, "B");
});

test("parseWikiPage keeps CRLF files parseable (Windows bind mounts)", () => {
  const md = "---\r\ntitle: CRLF Page\r\ntags: [a]\r\n---\r\n\r\nbody here\r\n";
  const row = parseWikiPage("notes/crlf.md", md);
  assert.equal(row.title, "CRLF Page");
  assert.deepEqual(row.tags, ["a"]);
  assert.ok(!row.body.includes("title:"));
});

test("frontmatter entity_type overrides the directory-derived one", () => {
  const md = "---\ntitle: T\nentity_type: tool\n---\nbody";
  assert.equal(parseWikiPage("content/person/person-x.md", md).entity_type, "tool");
});

test("vaultRel strips the vault root and normalises separators", () => {
  assert.equal(vaultRel("/wiki/content/person/x.md", "/wiki"), "content/person/x.md");
  assert.equal(vaultRel("/wiki/notes/n.md", "/wiki/"), "notes/n.md");
  // Windows-style separators (bind mount) normalise to forward slashes.
  assert.equal(vaultRel("\\wiki\\notes\\n.md", "/wiki"), "notes/n.md");
  // OUTSIDE the vault (scratch --out-dir) must be null, so probe runs never
  // pollute the table with junk slugs.
  assert.equal(vaultRel("/tmp/greenout/place/x.md", "/wiki"), null);
  assert.equal(vaultRel("/elsewhere/a.md", "/wiki"), null);
});

test("queueWikiPage dedupes by slug (last write wins) and never throws", () => {
  const before = queuedWikiPageCount();
  queueWikiPage("/wiki/notes/dup.md", "---\ntitle: One\n---\nbody");
  queueWikiPage("/wiki/notes/dup.md", "---\ntitle: Two\n---\nbody");
  assert.equal(queuedWikiPageCount(), before + 1);
  assert.doesNotThrow(() => queueWikiPage(null, null));
});

test("queueWikiPage ignores pages outside the vault root", () => {
  const before = queuedWikiPageCount();
  queueWikiPage("/tmp/scratch/place/x.md", "---\ntitle: X\n---\nbody");
  assert.equal(queuedWikiPageCount(), before);
});
