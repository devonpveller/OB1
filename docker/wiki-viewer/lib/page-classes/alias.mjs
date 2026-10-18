// Page class "alias": Quartz's AliasRedirects page (plugins/emitters/
// aliases.ts). A page's frontmatter aliases (and permalink) are redirect
// pages at the alias slug - e.g. /Ada-Fixture -> the entity page. The alias
// registry is built from the ROWS' frontmatter (site-index.mjs
// aliasRedirects), and the response is Quartz's redirect document byte for
// byte (rw-p1a-render attempt 3, AT2-1 / F7: alias URLs were not-available).
// Below every row-backed and listing class: a real page at the same slug wins.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Quartz's template, whitespace included. Quartz interpolates unescaped; the
// values are slugs, so escaping changes nothing unless a slug carries & < > "
// (parity rule D10-alias-escape).
export function aliasDocument(ogSlug, redirUrl) {
  return `
        <!DOCTYPE html>
        <html lang="en-us">
        <head>
        <title>${esc(ogSlug)}</title>
        <link rel="canonical" href="${esc(redirUrl)}">
        <meta name="robots" content="noindex">
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="0; url=${esc(redirUrl)}">
        </head>
        </html>
        `;
}

export default {
  name: "alias",
  version: 1,
  priority: 30,
  async resolve(req, deps) {
    if (!deps.site) return deps.siteUnavailable();
    const a = deps.site.aliases?.get(req.key);
    if (!a) return null;
    const r = await deps.row();
    if (!r.ok) return deps.unavailable(r);
    if (r.row && r.row.slug === req.key) return null; // a page at this slug is that page
    return { alias: req.key, target: a.target, redirUrl: a.redirUrl };
  },
  async template(ctx) {
    return { rawDocument: aliasDocument(ctx.target, ctx.redirUrl) };
  },
};
