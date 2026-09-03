/**
 * page-document — the self-owned document for DB-rendered pages (Phase B2).
 *
 * DESIGN (audit A-1, as CORRECTED 2026-08-28): the A-1 hazard was INHERITED
 * identity — reusing a built page as a shell would point Edit at the WRONG
 * page (silent data loss), because the identity attributes came from another
 * page's markup. The rule that survives is therefore about provenance, not
 * about editors: identity is either GENERATED from the slug this document is
 * rendering, or absent.
 *
 *   - READ-ONLY pages (everything that isn't a user note): no client bundle,
 *     no data-* identity attributes at all. Asserted by unit test.
 *   - EDITABLE note pages: emit the SAME editor contract a built note page
 *     emits (NotesEditor.tsx — data-notes-root + the data-wb-edit button),
 *     with every value derived from the rendered slug, and load the site's
 *     real client bundle so the ONE CodeMirror editor drives both. A second
 *     bespoke editor here was the wrong reading of A-1 (operator, 2026-08-27:
 *     "why two editors?"). Unit tests pin the attribute values to the slug.
 *
 * Every bundle script was audited (2026-08-28) to no-op when its anchor
 * element is absent, so loading the bundle on this reduced DOM is safe;
 * mermaid needs `.center`, which this document has.
 *
 * Caller must send it with `Cache-Control: no-store` (audit A-4): a transient
 * fallback pinned by a browser/CDN over the real page is the exact failure
 * class that broke search on 2026-08-26.
 */

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// data-live-page marks this as the fallback for its own poll script (and for
// probes: distinct from the interim page's data-interim-page).
export function pageDocument({ title, bodyHtml, slug, updatedAt, editable }) {
  const safeTitle = esc(title || (slug || "").split("/").pop() || "Page");
  const when = updatedAt ? new Date(updatedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
  const editor = editable ? editorContract(slug) : null;
  // Quartz's own wrapper structure (#quartz-root.page > #quartz-body > .center
  // > article) so index.css actually applies. Without it the page rendered
  // effectively unstyled - a white screen with a title (operator, 2026-08-26).
  // Sidebars are intentionally omitted: they need the client bundle, which this
  // document must not load (audit A-1).
  //
  // GEOMETRY PARITY (operator, 2026-09-03: "when creating a note the notes are
  // confined within a very narrow window"). index.css makes .page > #quartz-body
  // a THREE-COLUMN grid: 320px auto 320px, areas grid-sidebar-left /
  // grid-center / grid-sidebar-right. A built page puts its sidebars in the
  // outer areas, so its article lands in the middle column. This document has
  // no sidebars, so .center was the grid's ONLY child and CSS auto-placement
  // dropped it into the first cell - the 320px left gutter. THAT is the narrow
  // strip: a 320px column, not a stylesheet that failed to load.
  // The two rules that used to sit in the style block below,
  // "#quartz-body{display:block}" and ".center{max-width:750px}", never applied
  // at all - ".page>#quartz-body ..." out-specifies a bare "#quartz-body" or
  // ".center". They were dead weight that also described the wrong cause, and
  // the symptom (narrow, not full-width) is itself the proof they never won.
  // The fix is to PLACE .center where a built page puts its article. Every
  // number - column widths, the 1500px page cap, the 800px/1200px breakpoints -
  // stays in index.css, so the geometry has one source of truth and a Quartz
  // bump carries over on its own. Do NOT re-introduce a max-width or a display
  // override here; that is exactly how the two dead rules happened. The outer
  // columns stay empty (real sidebars need build-time data and the bundle);
  // empty gutters are the price of a content column that is the same width, in
  // the same place, as the built page's. Pinned by render-page.test.mjs.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<link rel="stylesheet" href="/index.css">
<script>
// Quartz applies light/dark via a saved-theme attribute that its CLIENT
// BUNDLE sets from localStorage. This document deliberately loads no bundle
// (audit A-1), so without this the page always rendered LIGHT and ignored
// the user's theme (operator, 2026-08-26). Inline and first in head so it
// applies before paint. NB: no backticks in here - this whole document is a
// template literal and a stray backtick terminates it.
try {
  var t = localStorage.getItem("theme");
  if (!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("saved-theme", t);
} catch (e) {}
</script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;700&family=Source+Sans+Pro:ital,wght@0,400;0,600;1,400;1,600&family=IBM+Plex+Mono:wght@400;600&display=swap">
${editor ? `<script src="/prescript.js" type="application/javascript" spa-preserve></script>
<script src="/postscript.js" type="module"></script>` : ""}
<style>
/* geometry parity with a built page - see the note in page-document.mjs */
.center{grid-area:grid-center}
.live-banner{background:var(--lightgray,#2a2b33);border-bottom:1px solid var(--gray,#44454f);
padding:.55rem 1.2rem;font-size:.85rem;color:var(--darkgray,#9a9ba6)}
.live-banner a{color:var(--secondary,#84a9ff)}
</style></head>
<body data-live-page="1" data-slug="${esc(slug || "")}">
<div id="quartz-root" class="page"><div id="quartz-body"><div class="center">
<div class="live-banner">&#9889; Live from Open Brain${when ? ` &middot; updated ${esc(when)}` : ""}${
  editor ? " &middot; editable right here; the full page takes over automatically once built"
         : " &middot; read-only; the full page takes over automatically once built"} &middot;
<a href="/">Home</a></div>
${editor || ""}
<article class="popover-hint"><h1>${safeTitle}</h1>
${bodyHtml || "<p><em>(this page has no content yet)</em></p>"}</article>
</div></div></div>
<script>
(function () {
  // SAFE TAKEOVER (operator, 2026-09-03: "the note should refresh safely after
  // the note is saved and the user has been inactive after a short period").
  // The built page can appear at any moment; swapping this document in the
  // instant it does is what yanks a page out from under someone mid-sentence.
  // Reload only when ALL of:
  //   1. this document is still the fallback. With the bundle loaded the SPA
  //      router can navigate AWAY (micromorph swaps the body, so
  //      data-live-page disappears) and the interval must die, or it would
  //      reload a page the user deliberately navigated to;
  //   2. nothing is unsaved - no open editor (window.__neEditing), no save in
  //      flight (__neSaving), no buffer still waiting on the autosave timer
  //      (__neDirty). A reload over any of those loses keystrokes;
  //   3. the user has PAUSED - no key/pointer/wheel/scroll/touch for IDLE_MS.
  //      A hidden tab counts as paused: there is nobody to disturb;
  //   4. the page really is built now.
  // 2 and 3 are re-checked AFTER the readiness fetch, not only before it: the
  // fetch takes time and the user may have started typing during it.
  var IDLE_MS = 4000;
  var lastAct = Date.now();
  var bump = function () { lastAct = Date.now() };
  var acts = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "input", "scroll"];
  for (var i = 0; i < acts.length; i++) {
    window.addEventListener(acts[i], bump, { capture: true, passive: true });
  }
  // Coming BACK to the tab is activity; going away is not.
  document.addEventListener("visibilitychange", function () { if (!document.hidden) bump() });
  var settled = function () {
    if (window.__neEditing || window.__neSaving || window.__neDirty) return false;
    if (document.hidden) return true;
    return (Date.now() - lastAct) >= IDLE_MS;
  };
  var iv = setInterval(function () {
    if (!document.body || document.body.dataset.livePage !== "1") { clearInterval(iv); return }
    if (!settled()) return;
    fetch(location.pathname, { cache: "no-store" })
      .then(function (r) { return r.text() })
      .then(function (t) {
        if (t.indexOf("data-live-page") !== -1) return;
        if (!settled()) return;
        location.reload();
      })
      .catch(function () {});
  }, 3000);
})();
</script>
</body></html>`;
}

// A wiki-looking URL with nothing behind it: no build, no row, not planned.
// In practice this is a link to a RETIRED page class (topic/* was swept in
// P2.3) still baked into older page bodies. A bare 404 rendered as an
// unstyled error AND made the client's popover prefetch log a console error
// (operator, 2026-08-26). Serve a themed, explanatory page instead — same
// no-bundle/no-identity rules as the live document.
export function notAvailableDocument({ slug }) {
  const name = esc((slug || "").split("/").pop() || "This page");
  return pageDocument({
    title: name,
    slug,
    bodyHtml:
      `<p><strong>${name}</strong> isn't in the knowledge base.</p>` +
      `<p>This usually means a link points at a page class that was retired, ` +
      `or at something Open Brain has not captured. Nothing is broken — there ` +
      `is simply nothing to show.</p>` +
      `<p><a href="/">Back to the Knowledge Vault</a></p>`,
  }).replace('data-live-page="1"', 'data-not-available="1"');
}

// The editor contract for a note page, IDENTICAL in shape to what a built
// note page emits (NotesEditor.tsx:48-91) so the site's ONE bundled CodeMirror
// editor wires itself here exactly as it does there. Every value is DERIVED
// from the slug this document is rendering — the corrected A-1 invariant:
// generated identity is safe, inherited identity is the data-loss hazard.
// The bespoke textarea editor that briefly lived here was deleted 2026-08-28
// (operator: "why two editors?"); two write paths to the same file is how
// divergence bugs start.
//
// The create flow's sessionStorage "ne-autoedit" handoff matches
// data-note-path / data-note-slug (NotesEditor.inline.ts:1104), so a freshly
// created note auto-opens CodeMirror HERE, on the fallback, in under a second.
function editorContract(slug) {
  const s = String(slug || "");
  // Mirror NotesEditor.tsx's isUserNote: only leaf pages in the author-owned
  // notes/ tree are editable; the machine-written Changes log is not.
  if (!s.startsWith("notes/") || s.startsWith("notes/Changes")) return null;
  const rel = s.replace(new RegExp("^notes/"), "");
  if (!rel) return null;
  const noteApiPath = rel.endsWith(".md") ? rel : rel + ".md";
  const folderRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  return `<div class="notes-editor-root" data-notes-root data-notebook-id="" data-notebook-slug="" data-notebook-name="" data-folder-rel="${esc(folderRel)}" data-trashed="">
<button class="ne-launch ne-edit" data-wb-edit data-edit-kind="note" data-note-path="${esc(noteApiPath)}" data-note-slug="${esc(s)}">&#9998; Edit this note</button>
</div>`;
}
