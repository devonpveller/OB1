// node --test lib/  — image-build gate for the DB-render fallback (Phase B).
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, rewriteWikilinks } from "./render-page.mjs";
import { pageDocument } from "./page-document.mjs";

test("renders headings, lists, tables, code (GFM)", () => {
  const html = renderMarkdown("# H1\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n`code`\n");
  assert.ok(html.includes("<h1>H1</h1>"));
  assert.ok(html.includes("<li>a</li>"));
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes("<code>code</code>"));
});

test("wikilinks become hrefs; alias + anchor + basename label", () => {
  assert.equal(
    rewriteWikilinks("see [[content/person/person-ada|Ada]]"),
    "see [Ada](/content/person/person-ada)");
  assert.equal(
    rewriteWikilinks("[[content/tool/tool-x#Usage]]"),
    "[tool-x](/content/tool/tool-x#Usage)");
  const html = renderMarkdown("go [[notes/my note]]");
  assert.ok(html.includes('href="/notes/my%20note"'), html);
});

test("a bare % in a wikilink target is encoded, never raw in the href", () => {
  const html = renderMarkdown("bad [[content/tool/50% off]]");
  assert.ok(html.includes("50%25%20off"), html);
});

test("SECURITY: raw HTML from source content is dropped, not executed", () => {
  const html = renderMarkdown('before <script>alert(1)</script> <img src=x onerror="x()"> after');
  assert.ok(!html.includes("<script"), "script tag must not survive");
  assert.ok(!html.includes("onerror"), "event handler must not survive");
  assert.ok(html.includes("before"), "surrounding text survives");
});

test("frontmatter is not rendered; CRLF and empty bodies are fine", () => {
  const html = renderMarkdown("---\r\ntitle: X\r\n---\r\n\r\nbody\r\n");
  assert.ok(!html.includes("title: X"));
  assert.ok(html.includes("body"));
  assert.equal(typeof renderMarkdown(""), "string");
  assert.equal(typeof renderMarkdown(null), "string");
});

test("SECURITY: the live document carries no identity attrs and no client bundle", () => {
  const doc = pageDocument({
    title: "T <script>", bodyHtml: "<p>x</p>",
    slug: "content/person/person-x", updatedAt: "2026-08-26T12:00:00Z",
  });
  // The audit A-1 invariant, as regexes so a future edit FAILS the build:
  assert.ok(!/data-(entity-id|note-path|folder-rel|source-id|notebook-name)/.test(doc),
    "identity attributes are forbidden in the fallback document");
  assert.ok(!/<script[^>]*src=/.test(doc), "no external scripts (no client bundle)");
  assert.ok(doc.includes("data-live-page"), "must self-identify for the poll/probe");
  assert.ok(doc.includes('href="/index.css"'), "site css for theme parity");
  assert.ok(doc.includes("&lt;script&gt;"), "title is escaped");
  assert.ok(/read-only|editable page is being prepared/.test(doc), "states what this view is");
  // Theme parity: without Quartz's wrapper structure index.css does not
  // apply and the page renders as a white screen (operator, 2026-08-26).
  assert.ok(doc.includes('id="quartz-root"') && doc.includes('class="center"'),
    "must use Quartz wrapper structure so the theme applies");
});

test("live document tolerates missing fields", () => {
  const doc = pageDocument({ slug: "notes/x" });
  assert.ok(doc.includes("<h1>x</h1>"));
  assert.ok(doc.includes("no content yet"));
});

test("editable notes get the note-specific banner", () => {
  const doc = pageDocument({ slug: "notes/x", editable: true });
  assert.ok(doc.includes("editable page is being prepared"));
  // still no bundle, even on the note variant
  assert.ok(!/<script[^>]*src=/.test(doc));
});

test("THEME: the document applies the user's saved theme before paint", () => {
  const doc = pageDocument({ slug: "notes/x" });
  // Quartz themes via a saved-theme attribute its client bundle sets; this
  // document loads no bundle, so it must set it itself or always render light.
  assert.ok(doc.includes('setAttribute("saved-theme"'), "must set saved-theme");
  assert.ok(doc.indexOf("saved-theme") < doc.indexOf("<body"), "must run before body (no flash)");
  assert.ok(!/<script[^>]*src=/.test(doc), "still no external bundle");
});

test("EDITOR: notes get a save target derived from their OWN slug", () => {
  const doc = pageDocument({ slug: "notes/folder/my note", editable: true });
  // Derived, never inherited (audit A-1): the save path must be this note's.
  assert.ok(doc.includes("/workbench/notes/folder/my%20note"), "save target from own slug");
  assert.ok(doc.includes("if_match"), "uses optimistic concurrency like the full editor");
  assert.ok(doc.includes("__wikiDirty"), "pauses the reload poll while unsaved");
  assert.ok(!/<script[^>]*src=/.test(doc), "still no client bundle");
  // and the read-only variant must NOT get an editor
  const ro = pageDocument({ slug: "content/place/place-x" });
  assert.ok(!ro.includes("live-editor"), "non-note pages stay read-only");
});
