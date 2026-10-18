/**
 * quartz-path - the slug and link algebra the live renderer needs to emit the
 * SAME hrefs a built Quartz page emits.
 *
 * Ported from Quartz 4.5.1 `quartz/util/path.ts` (MIT, (c) jackyzha0; notice in
 * THIRD-PARTY-NOTICES.md). Only the functions the renderer uses, as plain ESM;
 * behaviour is kept byte-for-byte because every built page's hrefs, data-slug
 * attributes, breadcrumbs and backlinks come out of exactly these rules.
 * PURE: no I/O.
 */
import { slug as slugAnchor } from "github-slugger";

function sluggify(s) {
  return s
    .split("/")
    .map((segment) =>
      segment
        .replace(/\s/g, "-")
        .replace(/&/g, "-and-")
        .replace(/%/g, "-percent")
        .replace(/\?/g, "")
        .replace(/#/g, ""),
    )
    .join("/")
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

export function trimSuffix(s, suffix) {
  if (endsWith(s, suffix)) s = s.slice(0, -suffix.length);
  return s;
}

export function slugifyFilePath(fp, excludeExt) {
  fp = stripSlashes(fp);
  let ext = getFileExtension(fp);
  const withoutFileExt = fp.replace(new RegExp(ext + "$"), "");
  if (excludeExt || [".md", ".html", undefined].includes(ext)) ext = "";
  let slug = sluggify(withoutFileExt);
  if (endsWith(slug, "_index")) slug = slug.replace(/_index$/, "index");
  return slug + ext;
}

export function simplifySlug(fp) {
  const res = stripSlashes(trimSuffix(fp, "index"), true);
  return res.length === 0 ? "/" : res;
}

export function joinSegments(...args) {
  if (args.length === 0) return "";
  let joined = args
    .filter((segment) => segment !== "" && segment !== "/")
    .map((segment) => stripSlashes(segment))
    .join("/");
  if (args[0].startsWith("/")) joined = "/" + joined;
  if (args[args.length - 1].endsWith("/")) joined = joined + "/";
  return joined;
}

export function pathToRoot(slug) {
  let rootPath = slug
    .split("/")
    .filter((x) => x !== "")
    .slice(0, -1)
    .map(() => "..")
    .join("/");
  if (rootPath.length === 0) rootPath = ".";
  return rootPath;
}

export function resolveRelative(current, target) {
  return joinSegments(pathToRoot(current), simplifySlug(target));
}

export function splitAnchor(link) {
  let [fp, anchor] = link.split("#", 2);
  if (fp.endsWith(".pdf")) return [fp, anchor === undefined ? "" : `#${anchor}`];
  anchor = anchor === undefined ? "" : "#" + slugAnchor(anchor);
  return [fp, anchor];
}

export function slugTag(tag) {
  return tag
    .split("/")
    .map((tagSegment) => sluggify(tagSegment))
    .join("/");
}

export function isFolderPath(fplike) {
  return (
    fplike.endsWith("/") ||
    endsWith(fplike, "index") ||
    endsWith(fplike, "index.md") ||
    endsWith(fplike, "index.html")
  );
}

function isRelativeSegment(s) {
  return /^\.{0,2}$/.test(s);
}

function addRelativeToStart(s) {
  if (s === "") s = ".";
  if (!s.startsWith(".")) s = joinSegments(".", s);
  return s;
}

export function transformInternalLink(link) {
  const [fplike, anchor] = splitAnchor(decodeURI(link));
  const folderPath = isFolderPath(fplike);
  const segments = fplike.split("/").filter((x) => x.length > 0);
  const prefix = segments.filter(isRelativeSegment).join("/");
  const fp = segments.filter((seg) => !isRelativeSegment(seg) && seg !== "").join("/");
  const simpleSlug = simplifySlug(slugifyFilePath(fp));
  const joined = joinSegments(stripSlashes(prefix), stripSlashes(simpleSlug));
  const trail = folderPath ? "/" : "";
  return addRelativeToStart(joined) + trail + anchor;
}

// strategy "shortest" (quartz.config.ts CrawlLinks markdownLinkResolution).
// `allSlugs` may be an array or a precomputed { byBase: Map<basename, slug[]> }.
export function transformLink(src, target, opts) {
  const targetSlug = transformInternalLink(target);
  if (opts.strategy === "relative") return targetSlug;
  const folderTail = isFolderPath(targetSlug) ? "/" : "";
  const canonicalSlug = stripSlashes(targetSlug.slice(".".length));
  const [targetCanonical, targetAnchor] = splitAnchor(canonicalSlug);
  if (opts.strategy === "shortest") {
    const matches = opts.byBase
      ? opts.byBase.get(targetCanonical) || []
      : (opts.allSlugs || []).filter((slug) => slug.split("/").at(-1) === targetCanonical);
    if (matches.length === 1) return resolveRelative(src, matches[0]) + targetAnchor;
  }
  return joinSegments(pathToRoot(src), canonicalSlug) + folderTail;
}

// The canonical FullSlug a rendered internal href points at (CrawlLinks'
// data-slug), given the page it appears on.
export function canonicalDest(curSlug, href) {
  const url = new URL(href, "https://base.com/" + stripSlashes(simplifySlug(curSlug), true));
  let [destCanonical] = splitAnchor(url.pathname);
  if (destCanonical.endsWith("/")) destCanonical += "index";
  return decodeURIComponent(stripSlashes(destCanonical, true));
}

// basename -> [slugs] index for transformLink's "shortest" strategy.
export function basenameIndex(allSlugs) {
  const byBase = new Map();
  for (const s of allSlugs) {
    const b = s.split("/").at(-1);
    const list = byBase.get(b);
    if (list) list.push(s);
    else byBase.set(b, [s]);
  }
  return byBase;
}
