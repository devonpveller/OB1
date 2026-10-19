/**
 * nav-tree - the explorer's data, ONE FOLDER AT A TIME (research-workbench
 * P1b; served at the viewer's /__nav and, for the browser, at the workbench's
 * /workbench/nav, which forwards here).
 *
 * WHY PER FOLDER: the explorer used to download the whole vault's index
 * (/static/graphIndex.json: 16.3 MB raw at 48k pages, ~25 MB at today's 76k,
 * > 100 MB at 5x) and build + sort a trie of every page on every navigation
 * (2,165 ms measured, PLAN-VIEWER-PERF). The P1b floor (payload < 2 MB, sort
 * < 200 ms, at five times today's page count) rules out ANY whole-vault index
 * in the browser, so the browser asks for the folders it shows: the root, the
 * open ancestors of the current page, and a folder when it is expanded.
 *
 * WHY HERE (the viewer) and not SQL in the workbench: the explorer must agree
 * with the page chrome on Quartz's URL slugs (quartz-slug.mjs urlSlugOf),
 * which paths are pages at all (isPagePath), folder display names (Quartz's
 * FileTrieNode.displayName) and the one-entry rule for a page named like a
 * folder. All of that already lives in the site index this process holds; a
 * second copy in TypeScript would drift.
 *
 * ORDER = Quartz Explorer's defaults (Explorer.tsx defaultOptions): filter
 * (slugSegment !== "tags"), then sort: folders first, then displayName by
 * localeCompare(undefined, {numeric: true, sensitivity: "base"}) - one cached
 * Intl.Collator with those options is the same comparison (PLAN-VIEWER-PERF V2).
 * Sorted children are memoised per site-index snapshot (and pre-sorted for
 * large folders when a snapshot is built - warmFolders), so a request is a
 * slice of a sorted array.
 *
 * PURE except for the memo: site index in, plain objects out.
 */
import { createHash } from "node:crypto";
import { folderDisplayName, sortYielding, runSync, runYielding } from "./site-index.mjs";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const NAV_DEFAULT_LIMIT = 500;
export const NAV_MAX_LIMIT = 2000;

// Quartz's explorer comparator over our entries.
export function explorerOrder(a, b) {
  if (a.folder === b.folder) return collator.compare(a.title, b.title);
  return a.folder ? -1 : 1;
}

// A folder path from a request: "" (root) or "a/b" (URL slug space). Accepts
// "a/b/", "/a/b", "a/b/index"; refuses ".." and empty segments.
export function normalizeFolder(raw) {
  let f = String(raw ?? "").trim();
  try { f = decodeURIComponent(f); } catch { return null; }
  f = f.replace(/^\/+/, "").replace(/\/+$/, "").replace(/(^|\/)index$/, "");
  if (f === "") return "";
  const segs = f.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return segs.join("/");
}

// Number of direct children an explorer folder node would get (files that are
// not also a subfolder, plus subfolders), after the "tags" filter.
function childCount(site, folder) {
  const node = site.folders.get(folder);
  if (!node) return 0;
  let n = 0;
  for (const s of node.folders) if (s.split("/").pop() !== "tags") n++;
  for (const s of node.files) if (!node.folders.has(s) && s.split("/").pop() !== "tags") n++;
  return n;
}

/**
 * The sorted direct children of `folder`: [{ name, slug, href, title, folder, count }].
 *   slug   Quartz's FileTrieNode.slug ("a/b" for a file, "a/b/index" for a folder)
 *   href   root-relative URL of the page / folder page
 *   count  direct children of a subfolder (0 for a file)
 */
export function folderChildren(site, folder) {
  return runSync(folderChildrenSteps(site, folder));
}

// the same list built in slices (warmFolders: a 96k-child folder at 5x is
// ~1 s of collation, which must not block readers)
function* folderChildrenSteps(site, folder) {
  const node = site?.folders.get(folder);
  if (!node) return null;
  const out = [];
  for (const sub of node.folders) {
    const name = sub.split("/").pop();
    if (name === "tags") continue; // Explorer.tsx default filterFn
    out.push({ name, slug: `${sub}/index`, href: `/${sub}/`, title: folderDisplayName(site, sub), folder: true, count: childCount(site, sub) });
  }
  for (const s of node.files) {
    if (node.folders.has(s)) continue; // a page named like a folder IS that folder's node (Quartz trie)
    const name = s.split("/").pop();
    if (name === "tags") continue;
    const r = site.bySlug.get(s);
    const title = r?.title && r.title !== "index" ? r.title : name;
    out.push({ name, slug: s, href: `/${s}`, title, folder: false, count: 0 });
  }
  return yield* sortYielding(out, explorerOrder);
}

// Per site-index snapshot (a WeakMap: the snapshot being warmed in the
// background and the one being served each keep their own sorted folders).
let _memo = new WeakMap();
function memoChildren(site, folder) {
  let m = _memo.get(site);
  if (!m) { m = new Map(); _memo.set(site, m); }
  if (!m.has(folder)) m.set(folder, folderChildren(site, folder));
  return m.get(folder);
}

/**
 * One page of a folder: { folder, title, total, offset, entries, next }.
 * opts: { offset, limit, focus } (focus: an entry slug whose page is wanted).
 * `next` is the offset of the following page or null. null when the folder is
 * unknown. The ETag is over the response bytes (same rule as nav-index).
 */
export function navPage(site, folder, { offset = 0, limit = NAV_DEFAULT_LIMIT, focus = null } = {}) {
  const all = memoChildren(site, folder);
  if (!all) return null;
  const lim = Math.min(NAV_MAX_LIMIT, Math.max(1, Math.trunc(Number(limit) || NAV_DEFAULT_LIMIT)));
  let off = Math.max(0, Math.trunc(Number(offset) || 0));
  // focus=<slug>: the page that CONTAINS that entry (the explorer opening a
  // large folder on the current page's position, so its active item is shown).
  if (focus) {
    const i = all.findIndex((e) => e.slug === focus);
    if (i >= 0) off = Math.floor(i / lim) * lim;
  }
  const entries = all.slice(off, off + lim);
  const next = off + lim < all.length ? off + lim : null;
  const body = { folder, title: folder ? folderDisplayName(site, folder) : "", total: all.length, offset: off, entries, next };
  const json = JSON.stringify(body);
  return { json, etag: `W/"navf-${createHash("sha1").update(json).digest("hex").slice(0, 16)}"`, body };
}

// Pre-sort the folders a reader may open, largest first, one folder per turn
// of the event loop (the nav refresh calls it on a new snapshot, so the first
// reader of a 19k-child folder does not pay its sort). Folders below `min`
// children are cheap enough to sort on demand.
export async function warmFolders(site, min = 500) {
  if (!site?.folders) return;
  const big = [...site.folders.entries()].filter(([, n]) => n.files.size + n.folders.size >= min)
    .sort((a, b) => (b[1].files.size + b[1].folders.size) - (a[1].files.size + a[1].folders.size));
  for (const [folder] of big) {
    let m = _memo.get(site);
    if (!m) { m = new Map(); _memo.set(site, m); }
    if (!m.has(folder)) m.set(folder, await runYielding(folderChildrenSteps(site, folder)));
  }
}

export function _resetNavTreeForTests() {
  _memo = new WeakMap();
}
