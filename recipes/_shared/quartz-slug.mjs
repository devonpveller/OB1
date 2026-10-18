/**
 * quartz-slug - Quartz's page URL space and page set, ONE implementation for
 * the compile side (wiki-pages.mjs tag slugs), the reconciliation and the
 * backfill (the vault walk) and the live renderer (row lookup, listings,
 * hrefs) (rw-p1a-deploy-prep, NA4-1 / RV-1).
 *
 * A wiki_pages row is keyed by its VAULT PATH without ".md" (page-classes.mjs
 * classify; the workbench, the reconciliation and every reader key on it).
 * Quartz serves the page at the SLUGIFIED path: spaces -> "-", "&" ->
 * "-and-", "%" -> "-percent", "?" and "#" removed, a trailing "_index" ->
 * "index"; dots in the stem are kept ("pv.1.md" -> "pv.1"). urlSlugOf() maps
 * one to the other; nothing here changes what a row is keyed by.
 *
 * sluggify / slugifyFilePath / getFileExtension / stripSlashes / endsWith are
 * ported verbatim from Quartz 4.5.1 quartz/util/path.ts (MIT, (c) jackyzha0;
 * notice in docker/wiki-viewer/THIRD-PARTY-NOTICES.md) - the exact rule, not
 * an approximation. isPagePath() is Quartz's page set as its build globs it
 * (quartz/util/glob.ts: globby("**\/*.md", { ignore: ignorePatterns,
 * gitignore: true }), quartz.config.ts ignorePatterns ["private",
 * "templates", ".obsidian"]), measured in the image on 2026-10-18: an ignore
 * pattern matches at the vault ROOT only (notes/private/x.md IS a page),
 * every dot-directory and dot-file is skipped (globby's dot: false), and the
 * vault .gitignore's public/ node_modules/ assets/ .quartz-cache/ skip those
 * directories at any depth.
 *
 * PURE, dependency-free ESM (Node and the viewer image import it).
 */

// Quartz path.ts sluggify(): per "/" segment.
export function sluggifySegment(segment) {
  return String(segment)
    .replace(/\s/g, "-")
    .replace(/&/g, "-and-")
    .replace(/%/g, "-percent")
    .replace(/\?/g, "")
    .replace(/#/g, "");
}

export function sluggify(s) {
  return String(s)
    .split("/")
    .map(sluggifySegment)
    .join("/") // always use / as sep
    .replace(/\/$/, "");
}

export function getFileExtension(s) {
  return s.match(/\.[A-Za-z0-9]+$/)?.[0];
}

export function stripSlashes(s, onlyStripPrefix) {
  if (s.startsWith("/")) s = s.substring(1);
  if (!onlyStripPrefix && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

export function endsWith(s, suffix) {
  return s === suffix || s.endsWith("/" + suffix);
}

// Quartz path.ts slugifyFilePath(): a vault-relative file path -> its FullSlug.
export function slugifyFilePath(fp, excludeExt) {
  fp = stripSlashes(fp);
  let ext = getFileExtension(fp);
  const withoutFileExt = fp.replace(new RegExp(ext + "$"), "");
  if (excludeExt || [".md", ".html", undefined].includes(ext)) ext = "";
  let slug = sluggify(withoutFileExt);
  // treat _index as index
  if (endsWith(slug, "_index")) slug = slug.replace(/_index$/, "index");
  return slug + ext;
}

// A row's slug (vault path without ".md") -> the URL slug Quartz builds for it.
export function urlSlugOf(rowSlug) {
  return slugifyFilePath(`${rowSlug}.md`);
}

// Quartz's ignorePatterns (quartz.config.ts), root-anchored as globby applies
// them; the dot rule covers ".obsidian".
export const QUARTZ_IGNORED_ROOTS = new Set(["private", "templates", ".obsidian"]);
// Not content at any depth (the vault .gitignore the wiki-service maintains,
// which Quartz honours with gitignore: true).
export const NON_CONTENT_DIRS = new Set([".git", ".quartz-cache", "public", "node_modules", "assets"]);

// May this DIRECTORY (vault-relative, no trailing slash) hold pages?
export function isContentDir(relDir) {
  const parts = String(relDir || "").split("/").filter(Boolean);
  if (!parts.length) return true;
  if (QUARTZ_IGNORED_ROOTS.has(parts[0])) return false;
  return parts.every((p) => !p.startsWith(".") && !NON_CONTENT_DIRS.has(p));
}

// Is this vault-relative FILE path ("notes/x.md") a page Quartz builds?
export function isPagePath(rel) {
  const s = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = s.split("/");
  const name = parts.at(-1);
  if (!name || !name.endsWith(".md") || name.startsWith(".")) return false;
  return isContentDir(parts.slice(0, -1).join("/"));
}
