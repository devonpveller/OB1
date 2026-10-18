/**
 * site-index - what a built Quartz page knows about the WHOLE site, derived
 * from wiki_pages rows instead of a vault walk: the slug set link resolution
 * runs against ("shortest" strategy, aliases included), backlinks, folder
 * children, tag membership, folder display names.
 *
 * PURE: rows in, index out (the rows come from nav-index's keyset walk, so the
 * explorer, the graph and the page chrome all see the same snapshot). Built
 * once per nav refresh and memoised by its ETag.
 */
import path from "node:path";
import {
  basenameIndex, canonicalDest, simplifySlug, slugTag, slugifyFilePath, transformLink, resolveRelative,
  getFileExtension, endsWith,
} from "./quartz-path.mjs";

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

/**
 * Quartz AliasRedirects (plugins/emitters/aliases.ts): every alias of a page
 * (frontmatter aliases, else alias - FrontMatter's coalesce - slugged by
 * getAliasSlugs; plus the raw permalink) is a redirect page at the alias's
 * slug pointing at the page. Returns alias slug -> { target: the page's simple
 * slug, redirUrl }. The FIRST page (slug order) to claim an alias keeps it.
 */
export function aliasRedirects(entries) {
  const out = new Map();
  for (const e of entries) {
    const ogSlug = simplifySlug(e.slug);
    const targets = [...aliasSlugs(e.aliases), ...(e.permalink ? [String(e.permalink)] : [])];
    for (const aliasTarget of targets) {
      const aliasTargetSlug = isRelativeURL(aliasTarget) ? path.posix.normalize(path.posix.join(ogSlug, "..", aliasTarget)) : aliasTarget;
      if (!aliasTargetSlug || out.has(aliasTargetSlug)) continue;
      out.set(aliasTargetSlug, { target: ogSlug, redirUrl: resolveRelative(aliasTargetSlug, ogSlug) });
    }
  }
  return out;
}

export function buildSiteIndex(rows, etag = "") {
  const bySlug = new Map();
  for (const r of rows || []) {
    if (!r || !r.slug) continue;
    bySlug.set(r.slug, {
      slug: r.slug,
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
  const slugs = [...bySlug.keys()].sort();
  const allSlugs = [...slugs];
  for (const s of slugs) for (const a of aliasSlugs(bySlug.get(s).aliases)) allSlugs.push(a);
  const byBase = basenameIndex([...new Set(allSlugs)]);

  // Backlinks: a row's raw wikilink targets resolved exactly as CrawlLinks
  // resolves them on that row's own page, keyed by the SIMPLE slug.
  const backlinks = new Map();
  const opts = { strategy: "shortest", byBase };
  for (const s of slugs) {
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

  // Folder children (direct), tags.
  const folders = new Map(); // folder path ("" = root) -> { files:Set, folders:Set }
  const ensure = (f) => {
    let e = folders.get(f);
    if (!e) { e = { files: new Set(), folders: new Set() }; folders.set(f, e); }
    return e;
  };
  const byTag = new Map();
  for (const s of slugs) {
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
        if (l) { if (!l.includes(s)) l.push(s); } else byTag.set(prefix, [s]);
      }
    }
  }
  const aliases = aliasRedirects(slugs.map((s) => bySlug.get(s)));
  return { etag, bySlug, slugs, allSlugs, byBase, backlinks, folders, byTag, aliases };
}

// Breadcrumb / listing display name of a folder: its index page's title, else
// the folder's last segment (Quartz FileTrieNode.displayName).
export function folderDisplayName(site, folder) {
  const idx = site.bySlug.get(folder ? `${folder}/index` : "index");
  return idx?.title || folder.split("/").pop() || "";
}

export function isFolder(site, path) {
  return site.folders.has(path) && (site.folders.get(path).files.size > 0 || site.folders.get(path).folders.size > 0);
}

let _memo = { etag: null, site: null };
export function siteIndexFor(nav) {
  if (!nav || !nav.rows) return null;
  if (_memo.etag !== nav.etag) _memo = { etag: nav.etag, site: buildSiteIndex(nav.rows, nav.etag) };
  return _memo.site;
}
