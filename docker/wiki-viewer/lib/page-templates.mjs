/**
 * page-templates - the renderer templates page-class entries point at, plus
 * the small resolve helpers they share. A template turns a resolved request
 * into the page model chrome.renderDocument draws. Templates are shared by
 * reference (several classes present as a content page); a class with a
 * different presentation brings its own template in its own entry file.
 */
import { renderPage, EmbedUnavailable } from "./render-page.mjs";
import { unavailableState } from "./page-classes.mjs";
import { normalizeTags, folderDisplayName, isFolder } from "./site-index.mjs";
import { ListingBody, PageList, html } from "./components.mjs";
import { simplifySlug, resolveRelative, urlSlugOf } from "./quartz-path.mjs";
import { h } from "preact";

const asList = (v) => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));

// The date a page presents. Quartz (defaultDateType "modified") takes the
// frontmatter modified/lastmod/updated/last-modified, else git, else the
// file mtime; the live renderer takes the same frontmatter keys, else the
// ROW's updated_at (the compile that landed it) - the row is what is presented.
export function presentedDate(fm, updatedAt) {
  const v = fm?.modified ?? fm?.lastmod ?? fm?.updated ?? fm?.["last-modified"] ?? updatedAt;
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// resolve helper: an entry backed by the row at the requested slug. A row
// that is not presentable as-is (stale: older than its file or dated in the
// future; or an empty body) is this entry's page in the pending-compile state
// (D13 item 5: "stale is a miss"; never an empty leaf) - ctx.pending.
export function rowBacked(match) {
  return async (req, deps) => {
    // A folder URL ("up/") is the folder's page even when a page has the
    // folder's name ("up.md" beside "up/"): Quartz emits up.html AND
    // up/index.html (rw-p1a-deploy-prep, NA4-1).
    if (req?.isDir && deps.site && isFolder(deps.site, req.key)) return null;
    const r = await deps.row();
    if (!r.ok) return deps.unavailable(r);
    if (!r.row || !match(r.row)) return null;
    const why = deps.presentable ? await deps.presentable(r.row) : null;
    return why ? { pending: why, row: r.row } : { row: r.row };
  };
}

// resolve helper for a listing's own index row (folder / tag / notebooks
// index): an empty body is allowed there (Quartz shows the listing alone), a
// stale or future-dated one is not. Returns null (presentable or no row) or
// the pending reason.
export async function indexRowPending(row, deps) {
  if (!row || !deps.presentable) return null;
  return deps.presentable(row, { allowEmpty: true });
}

// Template: a content page from its row (entity, source, report, thought,
// notebook hub, note, root - and any row-backed class without its own).
export async function contentTemplate(ctx, deps) {
  const row = ctx.row;
  // The page is presented at Quartz's URL for its file (NA4-1: "sp ace.md"
  // is /sp-ace); every href on it is relative to that URL.
  const slug = urlSlugOf(row.slug);
  const fm = { ...(row.frontmatter || {}) };
  fm.title = row.title || fm.title || row.slug.split("/").pop();
  let r;
  try {
    // deps.embed: a transcluded page is its row (live-route.mjs); without it
    // (a caller with no database) the placeholder stays.
    r = await renderPage(row.body, { slug, frontmatter: fm, byBase: deps.site?.byBase, embed: deps.embed });
  } catch (e) {
    if (e instanceof EmbedUnavailable) return e.value; // the database screen, never half a page
    throw e;
  }
  return {
    slug,
    layout: "content",
    site: deps.site,
    fm,
    title: fm.title,
    tags: normalizeTags([...(row.tags || []), ...r.inlineTags]),
    text: r.text,
    description: r.description,
    readingMinutes: r.readingMinutes,
    date: presentedDate(fm, row.updated_at),
    toc: r.toc,
    articleHtml: r.html,
    cssclasses: asList(fm.cssclasses),
    breadcrumbsKnown: true,
  };
}

function listItem(site, slug) {
  const r = site.bySlug.get(slug);
  return { slug, title: r?.title || slug.split("/").pop(), tags: r?.tags || [], date: presentedDate({}, r?.updated_at), isFolder: false };
}

// Template: a folder listing (Quartz FolderPage/FolderContent), with the
// folder's own index row as its article when one exists.
export async function folderTemplate(ctx, deps) {
  const site = deps.site;
  const folder = ctx.folder;
  const slug = folder ? `${folder}/index` : "index";
  let model = {
    slug, layout: "list", site, fm: { title: `Folder: ${folder}`, tags: [] }, title: `Folder: ${folder}`,
    tags: [], text: "", toc: null, articleHtml: "", breadcrumbsKnown: true, cssclasses: [],
  };
  if (ctx.indexRow) {
    const c = await contentTemplate({ row: ctx.indexRow }, deps);
    if (unavailableState(c)) return c;
    model = { ...c, slug, layout: "list", tags: [] };
  }
  const node = site.folders.get(folder) || { files: new Set(), folders: new Set() };
  const items = [...node.files].map((s) => listItem(site, s));
  for (const sub of node.folders) {
    // Quartz's trie: a page named like the folder ("up.md" beside "up/") is
    // that node's data, so the folder is listed ONCE, as that page (NA4-1:
    // the live listing had the page and a separate "up/" entry).
    if (node.files.has(sub)) continue;
    // Quartz FolderContent: a subfolder whose index page exists IS that page's
    // data (its title, tags and date); only a subfolder without one gets the
    // synthetic entry (display name, no tags, the newest child's date).
    const idx = site.bySlug.get(`${sub}/index`);
    if (idx) {
      items.push({ ...listItem(site, `${sub}/index`), title: folderDisplayName(site, sub), isFolder: true });
      continue;
    }
    let newest = null;
    for (const s of site.folders.get(sub)?.files || []) {
      const d = presentedDate({}, site.bySlug.get(s)?.updated_at);
      if (d && (!newest || d > newest)) newest = d;
    }
    items.push({ slug: `${sub}/index`, title: folderDisplayName(site, sub), tags: [], date: newest || new Date(), isFolder: true });
  }
  const count = items.length;
  model.listingHtml = ListingBody(model, model.articleHtml,
    count === 1 ? "1 item under this folder." : `${count} items under this folder.`, items, true);
  return model;
}

// Template: a tag page (Quartz TagPage/TagContent), or the tag index.
export async function tagTemplate(ctx, deps) {
  const site = deps.site;
  const tag = ctx.tag;
  const slug = tag === "/" ? "tags/index" : `tags/${tag}`;
  const title = tag === "/" ? "Tag Index" : `Tag: ${tag}`;
  const model = {
    slug, layout: "list", site, fm: { title, tags: [] }, title, tags: [], text: "", toc: null,
    articleHtml: "", breadcrumbsKnown: false, cssclasses: [],
  };
  if (tag !== "/") {
    if (ctx.indexRow) {
      const c = await contentTemplate({ row: ctx.indexRow }, deps);
      if (unavailableState(c)) return c;
      model.articleHtml = c.articleHtml;
    }
    const items = (site.byTag.get(tag) || []).filter((s) => s !== slug).map((s) => listItem(site, s));
    const count = items.length;
    model.listingHtml = ListingBody(model, model.articleHtml, count === 1 ? "1 item with this tag." : `${count} items with this tag.`, items, true);
    return model;
  }
  const tags = [...site.byTag.keys()].sort((a, b) => a.localeCompare(b));
  const NUM = 10;
  model.listingHtml = html(h("div", { class: "popover-hint" },
    h("article", { class: "" }, h("p", null)),
    h("p", null, `Found ${tags.length} total tags.`),
    h("div", null, tags.map((t) => {
      const items = site.byTag.get(t).map((s) => listItem(site, s));
      return h("div", null,
        h("h2", null, h("a", { class: "internal tag-link", href: resolveRelative(slug, `/tags/${t}`) }, t)),
        h("div", { class: "page-listing" },
          h("p", null, items.length === 1 ? "1 item with this tag." : `${items.length} items with this tag.`,
            items.length > NUM && [" ", h("span", null, `Showing first ${NUM} tags.`)]),
          PageList(model, items.slice(0, NUM), true)));
    }))));
  return model;
}

// Template: a RETIRED page class (e.g. the swept content/topic/* pages). Not
// a missing row and not pending: the class is gone on purpose. Presented with
// the full chrome so the reader sees which pages still link here (backlinks).
export async function retiredTemplate(ctx, deps) {
  const name = ctx.key.split("/").pop();
  const from = (deps.site?.backlinks.get(simplifySlug(ctx.key)) || []);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const article =
    `<p><strong>${esc(name)}</strong> belonged to a page class that was retired (${esc(ctx.reason)}).</p>` +
    `<p>${from.length ? `${from.length} page(s) still link here; they are listed under Backlinks.` : "No page links here any more."}</p>`;
  return {
    slug: ctx.key, layout: "content", site: deps.site, fm: { title: `Retired: ${name}` }, title: `Retired: ${name}`,
    tags: [], text: name, description: `${name} belonged to a retired page class.`, readingMinutes: 1, date: null,
    toc: null, articleHtml: article, cssclasses: [], breadcrumbsKnown: false,
  };
}
