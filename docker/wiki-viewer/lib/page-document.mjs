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
</div></div></div>
<script>
(function () {
  setInterval(function () {
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
