/**
 * page-document — the self-owned document for DB-rendered pages (Phase B2).
 *
 * DESIGN (audit A-1): this document deliberately borrows NOTHING from built
 * pages. Built pages carry page identity the editing overlay reads back
 * (data-entity-id, editBtn.dataset.notePath, ... — NotesEditor.inline.ts:718-
 * 721); reusing one as a shell would point Edit at the WRONG page: silent
 * data loss. This document therefore:
 *   - links the site's /index.css so theme/typography match,
 *   - ships NO client bundle and NO data-* identity attributes (asserted by
 *     unit test, so reintroducing either fails the image build),
 *   - is READ-ONLY, says so, and polls the real URL to swap itself for the
 *     built page the moment it exists.
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
  // Quartz's own wrapper structure (#quartz-root.page > #quartz-body > .center
  // > article) so index.css actually applies. Without it the page rendered
  // effectively unstyled - a white screen with a title (operator, 2026-08-26).
  // Sidebars are intentionally omitted: they need the client bundle, which this
  // document must not load (audit A-1).
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
<style>
#quartz-body{display:block}
.center{max-width:750px;margin:0 auto;padding:0 1.5rem}
.live-banner{background:var(--lightgray,#2a2b33);border-bottom:1px solid var(--gray,#44454f);
padding:.55rem 1.2rem;font-size:.85rem;color:var(--darkgray,#9a9ba6)}
.live-banner a{color:var(--secondary,#84a9ff)}
</style></head>
<body data-live-page="1" data-slug="${esc(slug || "")}">
<div id="quartz-root" class="page"><div id="quartz-body"><div class="center">
<div class="live-banner">&#9889; Live from Open Brain${when ? ` &middot; updated ${esc(when)}` : ""}${
  editable ? " &middot; the editable page is being prepared and will load automatically"
           : " &middot; read-only; the full page takes over automatically once built"} &middot;
<a href="/">Home</a></div>
<article class="popover-hint"><h1>${safeTitle}</h1>
${bodyHtml || "<p><em>(this page has no content yet)</em></p>"}</article>
${editable ? liveEditor(slug) : ""}
</div></div></div>
<script>
(function () {
  setInterval(function () {
    // Never yank the page out from under an unsaved draft (data loss).
    if (window.__wikiDirty) return;
    fetch(location.pathname, { cache: "no-store" })
      .then(function (r) { return r.text() })
      .then(function (t) { if (t.indexOf("data-live-page") === -1) location.reload() })
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

// A minimal editor for the window BEFORE a note's real page exists (~60s).
//
// SAFE BY CONSTRUCTION (audit A-1): the save target is DERIVED from the slug
// this document was rendered for - never inherited from another page's markup,
// which is the failure mode that made the shell-swap design unacceptable. It
// also loads no client bundle; it is ~40 lines of its own code talking to the
// same /workbench/notes API the full editor uses, including its optimistic
// if_match concurrency check.
function liveEditor(slug) {
  const notePath = String(slug || "").replace(new RegExp("^notes/"), "");
  if (!notePath) return "";
  const api = "/workbench/notes/" + notePath.split("/").map(encodeURIComponent).join("/");
  return `<section class="live-editor">
<h2>Edit now</h2>
<p class="live-editor-hint">The full editor arrives with the built page. Until then you can edit here &mdash; it saves to the same note.</p>
<textarea id="live-md" spellcheck="false" rows="14"></textarea>
<div class="live-editor-bar"><button id="live-save" type="button">Save</button>
<span id="live-status"></span></div>
</section>
<style>
.live-editor{margin:2rem 0 3rem}
.live-editor textarea{width:100%;min-height:16rem;font-family:var(--codeFont,monospace);
font-size:.9rem;line-height:1.5;padding:.75rem;border:1px solid var(--lightgray,#44454f);
border-radius:5px;background:var(--light,#1e1e24);color:var(--dark,#d4d4dc)}
.live-editor-bar{display:flex;gap:.75rem;align-items:center;margin-top:.5rem}
.live-editor-bar button{padding:.4rem 1rem;border-radius:5px;cursor:pointer;
border:1px solid var(--lightgray,#44454f);background:var(--secondary,#84a9ff);color:#fff}
#live-status{font-size:.85rem;color:var(--darkgray,#9a9ba6)}
.live-editor-hint{font-size:.85rem;color:var(--darkgray,#9a9ba6)}
</style>
<script>
(function () {
  var api = ${JSON.stringify(api)};
  var ta = document.getElementById("live-md");
  var btn = document.getElementById("live-save");
  var st = document.getElementById("live-status");
  var hash = null;
  function status(m) { st.textContent = m; }
  fetch(api, { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (j) {
      if (!j) { status("could not load the note"); return }
      ta.value = j.content || "";
      hash = j.hash || null;
    })
    .catch(function () { status("could not load the note") });
  ta.addEventListener("input", function () {
    window.__wikiDirty = true;           // pauses the auto-reload poll
    status("unsaved changes");
  });
  btn.addEventListener("click", function () {
    status("saving...");
    fetch(api, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: ta.value, if_match: hash }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j } }) })
      .then(function (res) {
        if (res.status === 409) { status("someone else changed this note - reload before saving"); return }
        if (!res.ok) { status("save failed"); return }
        hash = res.j.hash || hash;
        window.__wikiDirty = false;      // the poll may take over again
        status("saved");
      })
      .catch(function () { status("save failed") });
  });
})();
</script>`;
}
