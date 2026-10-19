/**
 * site-index - what a built Quartz page knows about the WHOLE site, derived
 * from wiki_pages rows instead of a vault walk: the slug set link resolution
 * runs against ("shortest" strategy, aliases included), backlinks, folder
 * children, tag membership, folder display names.
 *
 * PURE: rows in, index out (the rows come from nav-index's keyset walk, so the
 * explorer, the graph and the page chrome all see the same snapshot). Built
 * once per nav refresh and memoised by its ETag.
 *
 * Keyed by QUARTZ'S URL SLUG (rw-p1a-deploy-prep, NA4-1): a row is keyed by
 * its vault path ("notes/sp ace"), Quartz serves it at the slugified path
 * ("notes/sp-ace", quartz-slug.mjs urlSlugOf), and every href, folder,
 * backlink, tag listing and link resolution of a built page is in that URL
 * space. bySlug / slugs / folders / byTag / backlinks are URL slugs;
 * `rowSlugOf` maps a URL slug back to the row (the live route's lookup);
 * `folderHint` is the folder's own name as written in the vault (Quartz's
 * FileTrieNode fileSegmentHint: "deep folder", not "deep-folder"). Where two
 * files slugify to one URL, the LAST in Quartz's path order is the page (its
 * emitter writes the file last), as for aliases. A row whose path Quartz
 * does not build (private/, templates/, a dot-directory: quartz-slug.mjs
 * isPagePath) is not in the index.
 */
import path from "node:path";
import {
  canonicalDest, simplifySlug, slugTag, slugifyFilePath, transformLink, resolveRelative,
  getFileExtension, endsWith,
} from "./quartz-path.mjs";
import { urlSlugOf, isPagePath } from "./shared/quartz-slug.mjs";

function asArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v == null || v === "") return [];
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(String); } catch { /* fall through */ }
      return s.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [String(v)];
}

// Quartz's frontmatter tag normalisation (FrontMatter plugin): slugTag + dedupe.
export function normalizeTags(tags) {
  return [...new Set(asArray(tags).map((t) => slugTag(t)))];
}

// Quartz's alias slugs (FrontMatter getAliasSlugs): vault-root relative.
export function aliasSlugs(aliases) {
  return asArray(aliases).map((a) => slugifyFilePath(/\.md$/i.test(a) ? a : a + ".md"));
}

const permalinkOf = (p) => (p != null && String(p) !== "" ? String(p) : null);

// Quartz isRelativeURL (util/path.ts).
function isRelativeURL(s) {
  return /^\.{1,2}/.test(s) && !endsWith(s, "index") && ![".md", ".html"].includes(getFileExtension(s) ?? "");
}

// Quartz's page order (build.ts: `allFiles.filter((fp) => fp.endsWith(".md"))
// .sort()`): the DEFAULT sort - UTF-16 code units - of the vault-relative
// markdown PATHS. parse, filter and emit keep that order. A row's slug is its
// path without ".md" (page-classes.mjs classify), so the path is slug + ".md";
// it is NOT the slug order where they disagree ("notes/a-b.md" sorts before
// "notes/a.md": '-' 0x2D < '.' 0x2E; by slug "notes/a" is a prefix and first).
export function quartzPathOrder(a, b) {
  const pa = `${a}.md`;
  const pb = `${b}.md`;
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * Quartz AliasRedirects (plugins/emitters/aliases.ts): every alias of a page
 * (frontmatter aliases, else alias - FrontMatter's coalesce - slugged by
 * getAliasSlugs; plus the raw permalink) is a redirect page at the alias's
 * slug pointing at the page. Returns alias slug -> { target: the page's simple
 * slug, redirUrl }. A SHARED alias belongs to the LAST claimant in Quartz's
 * page order (quartzPathOrder): AliasRedirects writes one file per alias in
 * that order, so the last write is the page Quartz serves (rw-p1a-render
 * attempt 4, tester AT3-3: two entities with one canonical name - every
 * entity page carries `aliases: [<canonical_name>]`). Whatever order the rows
 * arrive in. A real page at the alias's slug still wins (the alias class is
 * below every row-backed class); a retired slug yields to an alias, as Quartz
 * writes the redirect there (retired.mjs).
 */
export function aliasRedirects(entries) {
  return runSync(aliasSteps(entries, false));
}

// presorted: the entries already come in Quartz's page order (the site
// index passes them in its own row order - P1b, no second sort).
function* aliasSteps(entries, presorted) {
  const out = new Map();
  // the order is the vault PATHS' (rowSlug), the slugs are URL slugs
  const kept = [...entries].filter((e) => e && e.slug);
  const ordered = presorted ? kept : kept.sort((x, y) => quartzPathOrder(x.rowSlug ?? x.slug, y.rowSlug ?? y.slug));
  let n = 0;
  for (const e of ordered) {
    if (++n % 4096 === 0) yield;
    const ogSlug = simplifySlug(e.slug);
    const targets = [...aliasSlugs(e.aliases), ...(e.permalink ? [String(e.permalink)] : [])];
    for (const aliasTarget of targets) {
      const aliasTargetSlug = isRelativeURL(aliasTarget) ? path.posix.normalize(path.posix.join(ogSlug, "..", aliasTarget)) : aliasTarget;
      if (!aliasTargetSlug) continue;
      // a later claimant overwrites: the last write wins, as in Quartz
      out.set(aliasTargetSlug, { target: ogSlug, redirUrl: resolveRelative(aliasTargetSlug, ogSlug) });
    }
  }
  return out;
}

// A stable merge sort that YIELDS between bounded slices of work (P1b: the
// site index of a 5x vault - 383k rows - is built while readers are being
// served; one Array.sort over it blocked the event loop for ~0.5 s). Same
// order as Array.prototype.sort with the same comparator (both are stable).
const SLICE = 4096;
export function* sortYielding(arr, cmp) {
  const a = arr.slice();
  for (let i = 0; i < a.length; i += SLICE) {
    const part = a.slice(i, i + SLICE).sort(cmp);
    for (let j = 0; j < part.length; j++) a[i + j] = part[j];
    yield;
  }
  let src = a, dst = new Array(a.length);
  for (let w = SLICE; w < src.length; w *= 2) {
    let n = 0;
    for (let lo = 0; lo < src.length; lo += 2 * w) {
      const mid = Math.min(lo + w, src.length), hi = Math.min(lo + 2 * w, src.length);
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) { dst[k++] = cmp(src[j], src[i]) < 0 ? src[j++] : src[i++]; if (++n % (SLICE * 8) === 0) yield; }
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    [src, dst] = [dst, src];
    yield;
  }
  return src;
}

// Run a build generator to completion: synchronously, or yielding to the
// event loop between its slices (the nav refresh; no reader waits behind it).
export function runSync(gen) {
  for (;;) { const r = gen.next(); if (r.done) return r.value; }
}
export async function runYielding(gen) {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    await new Promise((res) => setImmediate(res));
  }
}

export function buildSiteIndex(rows, etag = "", opts = {}) {
  return runSync(siteIndexSteps(rows, etag, opts));
}
/**
 * The same index, built in slices that yield to the event loop (lib/nav-index.mjs refresh).
 * opts.navOnly: only what the explorer needs (bySlug titles, rowSlugOf,
 * folderHint, folders, slugs) - the nav worker's index (lib/nav-worker.mjs).
 */
export function buildSiteIndexYielding(rows, etag = "", opts = {}) {
  return runYielding(siteIndexSteps(rows, etag, opts));
}

// Exported for the perf probe (test/): each yielded STRING names the phase that
// follows, so a probe can attribute the longest slice; the runners ignore values.
export function* siteIndexSteps(rows, etag, { navOnly = false } = {}) {
  yield "filter";
  const bySlug = new Map();
  const rowSlugOf = new Map(); // URL slug -> row slug
  const folderHint = new Map(); // URL folder path -> the folder's name in the vault
  const kept = [];
  let n = 0;
  for (const r of rows || []) {
    if (++n % SLICE === 0) yield;
    if (r && r.slug && isPagePath(`${r.slug}.md`)) kept.push(r);
  }
  yield "sort-rows";
  const ordered = yield* sortYielding(kept, (x, y) => quartzPathOrder(x.slug, y.slug));
  yield "entries";
  const winner = []; // [row, its URL slug], in Quartz's page order
  n = 0;
  for (const r of ordered) {
    if (++n % SLICE === 0) yield;
    const slug = urlSlugOf(r.slug);
    winner.push([r, slug]);
    const raw = r.slug.split("/");
    const parts = slug.split("/");
    for (let i = 0; i < parts.length - 1; i++) folderHint.set(parts.slice(0, i + 1).join("/"), raw[i]);
    rowSlugOf.set(slug, r.slug);
    if (navOnly) { bySlug.set(slug, { slug, rowSlug: r.slug, title: r.title || r.slug.split("/").pop() }); continue; }
    bySlug.set(slug, {
      slug,
      rowSlug: r.slug,
      title: r.title || r.slug.split("/").pop(),
      tags: normalizeTags(r.tags),
      links: Array.isArray(r.links) ? r.links : [],
      updated_at: r.updated_at || null,
      date: r.fm_date || null,
      page_class: r.page_class || null,
      // the nav projection's aliases/alias/permalink (frontmatter->...), or
      // those keys of a row that carries its whole frontmatter
      aliases: asArray(r.aliases ?? r.alias ?? r.frontmatter?.aliases ?? r.frontmatter?.alias),
      permalink: permalinkOf(r.permalink ?? r.frontmatter?.permalink),
    });
  }
  yield "sort-slugs";
  const slugs = yield* sortYielding([...bySlug.keys()], (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (navOnly) {
    yield "folders";
    const folders = new Map();
    const ensureF = (f) => { let e = folders.get(f); if (!e) { e = { files: new Set(), folders: new Set() }; folders.set(f, e); } return e; };
    n = 0;
    for (const s of slugs) {
      if (++n % SLICE === 0) yield;
      const parts = s.split("/");
      for (let i = 0; i < parts.length - 1; i++) ensureF(parts.slice(0, i).join("/")).folders.add(parts.slice(0, i + 1).join("/"));
      const dir = parts.slice(0, -1).join("/");
      if (parts.at(-1) !== "index") ensureF(dir).files.add(s);
      ensureF(dir);
    }
    return { etag, navOnly: true, bySlug, slugs, folders, rowSlugOf, folderHint };
  }
  yield "alias-slugs";
  const allSlugs = [...slugs];
  n = 0;
  for (const s of slugs) {
    if (++n % SLICE === 0) yield;
    for (const a of aliasSlugs(bySlug.get(s).aliases)) allSlugs.push(a);
  }
  yield "basenames";
  // basenameIndex (quartz-path.mjs), in slices
  // (a repeat - an alias equal to a slug - is found in its basename's list,
  // which is short; no whole-vault Set: its rehash at 383k was a 0.7 s slice)
  const byBase = new Map();
  n = 0;
  for (const s of allSlugs) {
    if (++n % SLICE === 0) yield;
    const b = s.split("/").at(-1);
    const list = byBase.get(b);
    if (!list) byBase.set(b, [s]);
    else if (!list.includes(s)) list.push(s);
  }

  // Backlinks: a row's raw wikilink targets resolved exactly as CrawlLinks
  // resolves them on that row's own page, keyed by the SIMPLE slug.
  yield "backlinks";
  const backlinks = new Map();
  const opts = { strategy: "shortest", byBase };
  n = 0;
  for (const s of slugs) {
    if (++n % 1024 === 0) yield;
    const seen = new Set();
    for (const target of bySlug.get(s).links) {
      let simple;
      try {
        simple = simplifySlug(canonicalDest(s, transformLink(s, String(target), opts)));
      } catch {
        continue;
      }
      if (seen.has(simple)) continue;
      seen.add(simple);
      const list = backlinks.get(simple);
      if (list) list.push(s);
      else backlinks.set(simple, [s]);
    }
  }

  yield "folders-tags";
  // Folder children (direct), tags.
  const folders = new Map(); // folder path ("" = root) -> { files:Set, folders:Set }
  const ensure = (f) => {
    let e = folders.get(f);
    if (!e) { e = { files: new Set(), folders: new Set() }; folders.set(f, e); }
    return e;
  };
  const byTag = new Map();
  n = 0;
  for (const s of slugs) {
    if (++n % SLICE === 0) yield;
    const parts = s.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = parts.slice(0, i).join("/");
      ensure(parent).folders.add(parts.slice(0, i + 1).join("/"));
    }
    const dir = parts.slice(0, -1).join("/");
    if (parts.at(-1) !== "index") ensure(dir).files.add(s);
    ensure(dir);
    for (const t of bySlug.get(s).tags) {
      const segs = t.split("/");
      for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).join("/");
        const l = byTag.get(prefix);
        // one slug at a time, so a repeat (tags "a/b" and "a/c" both add "a") is
        // always the LAST entry: O(1), not l.includes (O(n) - quadratic for a tag
        // on every page: 28 s of the 76k-page build, rw-p1b-ready)
        if (l) { if (l[l.length - 1] !== s) l.push(s); } else byTag.set(prefix, [s]);
      }
    }
  }
  // Quartz's page order of the presented entries (the row that won its URL)
  const inPathOrder = [];
  for (const [r, slug] of winner) { const e = bySlug.get(slug); if (e && e.rowSlug === r.slug) inPathOrder.push(e); }
  yield;
  yield "aliases";
  const aliases = yield* aliasSteps(inPathOrder, true);
  return { etag, bySlug, slugs, allSlugs, byBase, backlinks, folders, byTag, aliases, rowSlugOf, folderHint };
}

// Breadcrumb / listing display name of a folder (Quartz FileTrieNode
// displayName: the node's own page title unless it is "index" - a page named
// like the folder ("up.md" beside "up/") is that node's data, before its
// index page - else the folder's name as written in the vault, else the last
// URL segment).
export function folderDisplayName(site, folder) {
  const own = folder ? site.bySlug.get(folder) : null;
  const idx = site.bySlug.get(folder ? `${folder}/index` : "index");
  const t = [own?.title, idx?.title].find((x) => x && x !== "index");
  return t || site.folderHint?.get(folder) || folder.split("/").pop() || "";
}

export function isFolder(site, path) {
  return site.folders.has(path) && (site.folders.get(path).files.size > 0 || site.folders.get(path).folders.size > 0);
}

// The site index of a nav snapshot. A snapshot from lib/nav-index.mjs carries
// it prebuilt (built in the background refresh, never on a request - P1b);
// anything else (a test's plain object) is built once and memoised.
let _memo = { rows: null, site: null };
export function siteIndexFor(nav) {
  if (!nav || !nav.rows) return null;
  if (nav.site) return nav.site;
  if (_memo.rows !== nav.rows) _memo = { rows: nav.rows, site: buildSiteIndex(nav.rows, nav.etag) };
  return _memo.site;
}
