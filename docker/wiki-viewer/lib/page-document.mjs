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
export function pageDocument({ title, bodyHtml, slug, updatedAt }) {
  const safeTitle = esc(title || (slug || "").split("/").pop() || "Page");
  const when = updatedAt ? new Date(updatedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<link rel="stylesheet" href="/index.css">
<style>
body{margin:0}
.live-banner{position:sticky;top:0;background:#2a2b33;border-bottom:1px solid #44454f;
padding:.55rem 1.2rem;font-size:.85rem;color:#9a9ba6;z-index:10}
.live-banner a{color:#84a9ff}
main.live-page{max-width:46rem;margin:0 auto;padding:1.5rem 1.2rem;line-height:1.6}
</style></head>
<body data-live-page="1">
<div class="live-banner">&#9889; Live from Open Brain${when ? ` &middot; updated ${esc(when)}` : ""} &middot;
read-only view; the full page (with editing) takes over automatically once built.
<a href="/">Home</a></div>
<main class="live-page"><h1>${safeTitle}</h1>
${bodyHtml || "<p><em>(this page has no content yet)</em></p>"}</main>
<script>
(function () {
  setInterval(function () {
    fetch(location.pathname, { cache: "no-store" })
      .then(function (r) { return r.text() })
      .then(function (t) { if (t.indexOf("data-live-page") === -1 && t.indexOf("data-interim-page") === -1) location.reload() })
      .catch(function () {});
  }, 5000);
})();
</script>
</body></html>`;
}
