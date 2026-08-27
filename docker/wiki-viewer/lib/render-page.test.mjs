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
  assert.ok(doc.includes("read-only view"));
});

test("live document tolerates missing fields", () => {
  const doc = pageDocument({ slug: "notes/x" });
  assert.ok(doc.includes("<h1>x</h1>"));
  assert.ok(doc.includes("no content yet"));
});
