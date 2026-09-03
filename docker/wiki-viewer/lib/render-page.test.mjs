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
  assert.ok(doc.includes("editable right here"));
});

test("THEME: the document applies the user's saved theme before paint", () => {
  const doc = pageDocument({ slug: "notes/x" });
  // Quartz themes via a saved-theme attribute its client bundle sets; this
  // document loads no bundle, so it must set it itself or always render light.
  assert.ok(doc.includes('setAttribute("saved-theme"'), "must set saved-theme");
  assert.ok(doc.indexOf("saved-theme") < doc.indexOf("<body"), "must run before body (no flash)");
  assert.ok(!/<script[^>]*src=/.test(doc), "still no external bundle");
});

test("EDITOR: editable notes emit the BUILT page's editor contract, derived from their own slug", () => {
  const doc = pageDocument({ slug: "notes/folder/my note", editable: true });
  // The corrected A-1 invariant: identity is GENERATED from the rendered
  // slug (never inherited), and it must be the exact contract the bundled
  // NotesEditor wires (NotesEditor.tsx:88). The .md matters: slugs are
  // extension-less but the notes API addresses FILES.
  assert.ok(doc.includes('data-note-path="folder/my note.md"'), "note-path = own slug as a FILE");
  assert.ok(doc.includes('data-note-slug="notes/folder/my note"'), "note-slug = own slug");
  assert.ok(doc.includes("data-wb-edit") && doc.includes('data-edit-kind="note"'), "the real edit button");
  assert.ok(doc.includes("data-notes-root") && doc.includes('data-folder-rel="folder"'), "notes root contract");
  // ONE editor: the real client bundle drives it — no bespoke editor code.
  assert.ok(doc.includes('src="/postscript.js"') && doc.includes('src="/prescript.js"'), "loads the site bundle");
  assert.ok(!doc.includes("live-editor"), "the bespoke textarea editor is gone");
  assert.ok(doc.includes("__neEditing"), "takeover poll defers to the open editor");
  assert.ok(doc.includes('dataset.livePage !== "1"'), "poll self-cancels after SPA nav away");
});

test("LAYOUT: the fallback places .center in the built page's grid column, never a narrow strip", () => {
  const doc = pageDocument({ slug: "notes/x", editable: true });
  // WHY (operator, 2026-09-03: "confined within a very narrow window"):
  // index.css makes `.page > #quartz-body` a 320px/auto/320px grid. This
  // document has no sidebars, so .center was the grid's only child and CSS
  // auto-placement put it in the FIRST cell — the 320px left gutter. Pinning
  // it to grid-center is what makes a not-yet-built note the same width, in
  // the same place, as the built one.
  assert.ok(/\.center\{grid-area:grid-center\}/.test(doc),
    ".center must be placed in the grid-center area or it auto-places into the 320px gutter");
  // The two rules this replaced never applied (`.page>#quartz-body …`
  // out-specifies a bare `#quartz-body`/`.center`), and re-adding either
  // would re-describe the wrong cause AND could win if index.css changes.
  assert.ok(!/#quartz-body\{display:\s*block/.test(doc),
    "must not override Quartz's grid — that was the dead rule that hid the real cause");
  assert.ok(!/\.center\{[^}]*max-width/.test(doc),
    "no hard-coded column width: the geometry lives in index.css, one source of truth");
});

test("REFRESH: the takeover reloads only when the page is built, saved AND the user has paused", () => {
  const doc = pageDocument({ slug: "notes/x", editable: true });
  const poll = doc.slice(doc.lastIndexOf("<script>"));
  // Never over unsaved work: an open editor, an in-flight save, or a buffer
  // still waiting on the autosave debounce (NotesEditor.inline.ts sets all
  // three). Dropping any one of these makes a refresh able to eat keystrokes.
  for (const flag of ["__neEditing", "__neSaving", "__neDirty"]) {
    assert.ok(poll.includes(flag), "poll must defer to " + flag);
  }
  // Never mid-gesture: idle is measured from real user activity.
  for (const ev of ["keydown", "pointermove", "wheel", "scroll", "touchstart"]) {
    assert.ok(poll.includes('"' + ev + '"'), "idle tracking must watch " + ev);
  }
  assert.ok(poll.includes("document.hidden"), "a hidden tab counts as paused");
  // The gate must be re-checked AFTER the readiness fetch, not only before it:
  // the fetch takes time and the user may start typing during it. Two calls to
  // settled() — one before the fetch, one immediately before the reload.
  const settledCalls = poll.match(/settled\(\)/g) || [];
  assert.ok(settledCalls.length >= 2,
    "re-check the gate immediately before location.reload(), not just before the fetch");
  const lastGate = poll.lastIndexOf("!settled()");
  assert.ok(lastGate > poll.indexOf('indexOf("data-live-page")'),
    "the last gate must come AFTER the readiness fetch resolves");
  assert.ok(lastGate < poll.indexOf("location.reload()"),
    "the last gate must come BEFORE the reload");
  // ...but it must still fire: the readiness check is what ends the fallback.
  assert.ok(poll.includes('indexOf("data-live-page")'), "still detects the built page");
  assert.ok(poll.includes("location.reload()"), "the takeover must still happen");
  assert.ok(poll.includes('dataset.livePage !== "1"'), "poll self-cancels after SPA nav away");
});

test("EDITOR: everything that is not a user note stays bundle-free and identity-free", () => {
  for (const [label, doc] of [
    ["read-only entity", pageDocument({ slug: "content/place/place-x" })],
    ["machine-written Changes log", pageDocument({ slug: "notes/Changes/2026", editable: true })],
    ["editable flag on a non-note", pageDocument({ slug: "content/place/place-x", editable: true })],
  ]) {
    assert.ok(!/<script[^>]*src=/.test(doc), label + ": no client bundle");
    assert.ok(!/data-(entity-id|note-path|folder-rel|source-id|notebook-name)=/.test(doc),
      label + ": no identity attributes");
    assert.ok(!doc.includes("data-wb-edit"), label + ": no edit button");
  }
});
