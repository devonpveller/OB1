/**
 * live-route - the page route: every page URL is presented from wiki_pages
 * (research-workbench P1a; D13 "ingest -> compile -> present").
 *
 * Order of operations for one request:
 *   1. the page-class registry resolves it (lib/page-classes.mjs); the first
 *      entry that claims it renders it with its template -> x-wiki-render: db
 *      - unless the row is not presentable as-is (D13 item 5, "stale is a
 *        miss"; never an empty leaf): a row older than its file, a row dated
 *        in the future (its time cannot show a newer file replaced it), or an
 *        empty body -> the pending-compile state (the reconcile names it and
 *        the repair pass on (re)connect rewrites it). Same rule as the
 *        reconciliation (shared rowState()). The file is only stat()ed.
 *   2. the database did not answer -> the ONE front-end screen
 *      ("connecting to database" / "database unreachable") for every URL,
 *      x-wiki-render: connecting|unreachable, no-store; never a page state
 *   3. no entry claimed it, but the page is KNOWN (its file exists in the
 *      vault, or the compiler's planned.json lists it) -> the typed
 *      pending-compile state, x-wiki-render: pending, no-store. The file is
 *      only stat()ed to know it exists; it is NEVER rendered.
 *   4. otherwise -> not-available (x-wiki-render: not-available)
 * The fresh-file interim render (Phase B's compensation for the builder's
 * lag) is gone: a page with no row is pending, never rendered from its file.
 *
 * URLs are Quartz's (rw-p1a-deploy-prep, NA4-1): a page is served at the
 * slugified path of its file ("notes/sp ace.md" -> /notes/sp-ace); the
 * request's key is looked up through the site index's URL -> row map. The
 * raw vault path still answers (the explorer's links come from row slugs):
 * a 302 to the page's Quartz URL. A row whose path Quartz does not build
 * (private/, templates/, a dot-directory) is never presented, and a row
 * whose FILE is gone (an orphan) is not presentable: pending, named by the
 * reconcile (NA4-2).
 */
import { stat, readFile, readdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fetchRow, fetchRowByBasename, dbState, probe } from "./wiki-db.mjs";
import { resolvePage, renderTemplate, makeUnavailable } from "./page-classes.mjs";
import { renderDocument, pendingDocument, databaseDocument, notAvailableDocument, errorDocument } from "./chrome.mjs";
import { rowState, isEmptyBody } from "./shared/reconcile-wiki-pages.mjs";
import { urlSlugOf, isPagePath, isContentDir, sluggifySegment } from "./shared/quartz-slug.mjs";
import { getNavIndex } from "./nav-index.mjs";
import { siteIndexFor } from "./site-index.mjs";

const WIKI = () => process.env.WIKI_VAULT_DIR || "/wiki";

export function keyOf(urlPath) {
  let p;
  try {
    p = decodeURIComponent(String(urlPath || "/").split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  const isDir = p.endsWith("/") && p !== "/";
  const key = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return { key: key === "" ? "index" : key, isDir };
}

// Is there a page FILE for this row slug (vault path without .md)? Only a
// path Quartz builds counts (isPagePath).
async function fileExists(rel) {
  const base = normalize(join(WIKI(), rel));
  if (!base.startsWith(WIKI())) return false;
  for (const [c, r] of [[`${base}.md`, `${rel}.md`], [join(base, "index.md"), `${rel}/index.md`]]) {
    if (!isPagePath(r)) continue;
    try { if ((await stat(c)).isFile()) return true; } catch { /* next */ }
  }
  return false;
}

// The page file Quartz serves at this URL key, when the key is not the file's
// own path ("notes/sp-ace" for "notes/sp ace.md"): each segment is matched
// against the directory's entries through Quartz's slug rule. Read only on
// the "nobody claimed it" path (is the page known?), never to render.
async function fileForUrl(key) {
  const segs = String(key || "").split("/");
  let dirs = [""];
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    const next = [];
    for (const d of dirs) {
      let entries;
      try { entries = await readdir(d ? join(WIKI(), d) : WIKI(), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory() && isContentDir(rel) && sluggifySegment(e.name) === segs[i]) next.push(rel);
        if (last && e.isFile() && isPagePath(rel) && urlSlugOf(rel.replace(/\.md$/, "")) === key) return rel;
      }
    }
    if (!next.length) return null;
    dirs = next.slice(0, 32);
  }
  return null;
}

let _planned = { at: 0, mtimeMs: -1, map: {}, byBase: {} };
async function plannedFor(key) {
  const now = Date.now();
  if (now - _planned.at > 10_000) {
    _planned.at = now;
    try {
      const file = join(WIKI(), "planned.json");
      const st = await stat(file);
      if (st.mtimeMs !== _planned.mtimeMs) {
        const map = JSON.parse(await readFile(file, "utf8")).planned ?? {};
        const byBase = {};
        for (const [k, v] of Object.entries(map)) byBase[k.split("/").pop()] = v;
        _planned = { at: now, mtimeMs: st.mtimeMs, map, byBase };
      }
    } catch {
      _planned = { at: now, mtimeMs: -1, map: {}, byBase: {} };
    }
  }
  return _planned.map[key] ?? (key.includes("/") ? null : _planned.byBase[key] ?? null);
}

// The mtime of a row's file (stat only), or null when it has none.
async function fileMtimeOf(slug) {
  const base = normalize(join(WIKI(), slug));
  if (!base.startsWith(WIKI())) return null;
  for (const c of [`${base}.md`, join(base, "index.md")]) {
    try { const st = await stat(c); if (st.isFile()) return st.mtimeMs; } catch { /* next */ }
  }
  return null;
}

const PENDING_WHY = {
  stale: "its row is older than its file (stale: the reconcile names it, the repair pass rewrites it)",
  future: "its row is dated in the future, so it cannot be shown to be newer than its file",
  empty: "its row has an empty body",
  orphan: "its row has no file (an orphan: the reconcile names it; the sweeps delete it)",
};

// The file text of a row's page, or null. Read ONLY to tell a faithfully
// empty page (its source is empty too: a note that is frontmatter only) from
// an empty row standing in for content - never rendered.
async function fileTextOf(slug) {
  const base = normalize(join(WIKI(), slug));
  if (!base.startsWith(WIKI())) return null;
  for (const c of [`${base}.md`, join(base, "index.md")]) {
    try { return await readFile(c, "utf8"); } catch { /* next */ }
  }
  return null;
}

// Is this row presentable as-is? null, or the reason it is pending. One rule
// with the reconciliation (rowState + isEmptyBody, shared), plus: a row whose
// file is gone is an ORPHAN and never presented (rw-p1a-deploy-prep, NA4-2:
// the retire step deleted the file and left the row, and the renderer
// presented it) - the reconcile names it, a sweep or the operator deletes it.
export async function presentable(row, opts = {}) {
  const mtime = await fileMtimeOf(row.slug);
  if (mtime == null) return PENDING_WHY.orphan;
  let st = rowState(row, mtime, opts);
  if (st === "empty" && mtime != null) {
    const text = await fileTextOf(row.slug);
    if (text != null && isEmptyBody(text)) st = rowState(row, mtime, { ...opts, fileEmpty: true });
  }
  return st ? PENDING_WHY[st] : null;
}

// Renderer failures outside an isolated entry (health reports them).
const _routeErrors = { count: 0, last: null };
export function routeErrors() {
  return { ..._routeErrors };
}

const once = (fn) => { let p; return () => (p ??= fn()); };

function respond(status, headers, body) {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

// Does the site index know a page at this URL (its Quartz URL or its row's
// vault path)? For a URL whose extension is an asset type and no published
// file has (serve.mjs): a page named "x.png.md" is still a page.
export async function isKnownPageUrl(urlPath) {
  const req = keyOf(urlPath);
  if (!req) return false;
  const site = siteIndexFor(await getNavIndex());
  return !!site && (site.bySlug.has(req.key) || site.bySlug.has(urlSlugOf(req.key)));
}

/**
 * Render one page URL. Returns { status, headers, body }. Never throws.
 * (research-workbench P2b: the P1b notifications strip is gone from every
 * page - the workspace's title bar bell replaced it, D13.)
 */
export async function renderLive(urlPath) {
  const req = keyOf(urlPath);
  if (!req) return respond(400, { "cache-control": "no-store" }, "bad request");
  try {
    return await renderLiveInner(req);
  } catch (e) {
    // Not a database condition: a renderer bug. Its own state (never the
    // "connecting" screen), counted for the health probe.
    _routeErrors.count++;
    _routeErrors.last = { key: req.key, error: String(e?.message || e).slice(0, 300), at: new Date().toISOString() };
    console.error(`[wiki-viewer] render FAILED for ${req.key}: ${e?.stack || e}`);
    return respond(500, { "cache-control": "no-store", "x-wiki-render": "error" }, errorDocument({ slug: req.key }));
  }
}

async function renderLiveInner(req) {
  // Not known to be up: ask the database first, so a page assembled from a
  // cached site index is never presented while it is down (D13 item 3).
  if (dbState().state !== "up") {
    const st = (await probe()).state;
    if (st !== "up") return respond(200, { "cache-control": "no-store", "x-wiki-render": st }, databaseDocument(st));
  }
  const nav = await getNavIndex();
  const site = siteIndexFor(nav);
  const rowCache = new Map();
  // A URL slug -> its row (the site index's map; a key it does not know is
  // tried as a row slug itself). A row for a path Quartz does not build is
  // no row.
  const visible = (r) => (r && r.ok && r.row && !isPagePath(`${r.row.slug}.md`) ? { ...r, row: null } : r);
  const rowAt = (slug) => {
    const target = site?.rowSlugOf?.get(slug) ?? slug;
    if (!rowCache.has(target)) rowCache.set(target, fetchRow(target).then(visible));
    return rowCache.get(target);
  };
  let looked = null; // the result of deps.row(): the row the request itself found
  const deps = {
    key: req.key,
    site,
    rowAt,
    row: once(async () => {
      const exact = await rowAt(req.key);
      looked = (!exact.ok || exact.row || req.key.includes("/")) ? exact : visible(await fetchRowByBasename(req.key));
      return looked;
    }),
    fileExists,
    presentable,
    // The database did not answer (r = a failed row()/rowAt() result).
    unavailable: (r) => makeUnavailable(r?.state === "unreachable" ? "unreachable" : "connecting"),
    siteUnavailable: () => {
      const s = dbState().state;
      return makeUnavailable(s === "unreachable" ? "unreachable" : "connecting");
    },
    // A transcluded page (![[page]], ![[page#heading]], ![[page#^block]]):
    // its ROW, as Quartz uses the embedded file. { state: "page", row } |
    // { state: "pending", reason } (known - a file - but no presentable row:
    // the pending-compile marker inside the transclude block) | { state:
    // "none" } (no such page: Quartz's placeholder stays, as Quartz leaves it)
    // | { state: "unavailable", value } (the database did not answer: the
    // whole request is the database screen).
    embed: async (slug) => {
      const r = await rowAt(slug);
      if (!r.ok) return { state: "unavailable", value: deps.unavailable(r) };
      if (r.row) {
        const why = await presentable(r.row);
        return why ? { state: "pending", reason: why } : { state: "page", row: r.row };
      }
      return (await fileExists(slug)) || (await fileForUrl(slug)) ? { state: "pending", reason: "its file is written" } : { state: "none" };
    },
  };
  // Resolve; an entry whose resolve() or template() throws is isolated by the
  // registry (logged, reported broken) and resolution falls through to the
  // next entry in the same fixed order.
  const skip = new Set();
  for (;;) {
    const resolved = await resolvePage(req, deps, skip);
    if (resolved?.unreachable) {
      return respond(200, { "cache-control": "no-store", "x-wiki-render": resolved.unreachable }, databaseDocument(resolved.unreachable));
    }
    if (!resolved) break;
    const { entry, ctx } = resolved;
    // The request found its row under another URL - a basename URL, or the
    // raw vault path of a file Quartz slugifies ("notes/sp ace"): send the
    // reader to the page's Quartz URL (relative hrefs on the page are
    // computed for it).
    if (ctx.row && ctx.row === looked?.row && urlSlugOf(ctx.row.slug) !== req.key) {
      return respond(302, { location: "/" + urlSlugOf(ctx.row.slug).split("/").map(encodeURIComponent).join("/"), "cache-control": "no-store" }, "");
    }
    if (ctx.pending) {
      return respond(200, {
        "cache-control": "no-store", "x-wiki-render": "pending", "x-wiki-page-class": `${entry.name}@${entry.version}`,
      }, pendingDocument({ slug: req.key, reason: ctx.pending }));
    }
    const model = await renderTemplate(entry, ctx, deps, req.key);
    if (!model) { skip.add(entry.name); continue; }
    if (model.unreachable) {
      return respond(200, { "cache-control": "no-store", "x-wiki-render": model.unreachable }, databaseDocument(model.unreachable));
    }
    // A class whose page is a whole document of its own (an alias redirect:
    // Quartz's AliasRedirects page, byte for byte).
    if (typeof model.rawDocument === "string") {
      return respond(200, {
        "cache-control": "no-cache, must-revalidate", "x-wiki-render": "db", "x-wiki-page-class": `${entry.name}@${entry.version}`,
      }, model.rawDocument);
    }
    return respond(200, {
      "cache-control": "no-cache, must-revalidate",
      "x-wiki-render": "db",
      "x-wiki-page-class": `${entry.name}@${entry.version}`,
    }, renderDocument(model));
  }
  // Nobody claimed it. Known (file or planned) -> pending-compile; else not available.
  const planned = await plannedFor(req.key);
  const known = planned ? (planned.unlinked ? "registered, not yet cited by anything" : "queued for synthesis")
    : (await fileExists(req.key)) || (await fileForUrl(req.key)) ? "its file is written" : null;
  if (known) {
    return respond(200, { "cache-control": "no-store", "x-wiki-render": "pending" }, pendingDocument({ slug: req.key, reason: known }));
  }
  return respond(200, { "cache-control": "no-store", "x-wiki-render": "not-available" }, notAvailableDocument({ slug: req.key }));
}
