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
 */
import { stat, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fetchRow, fetchRowByBasename, dbState, probe } from "./wiki-db.mjs";
import { resolvePage, renderTemplate } from "./page-classes.mjs";
import { renderDocument, pendingDocument, databaseDocument, notAvailableDocument, errorDocument } from "./chrome.mjs";
import { rowState } from "./shared/reconcile-wiki-pages.mjs";
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

async function fileExists(rel) {
  const base = normalize(join(WIKI(), rel));
  if (!base.startsWith(WIKI())) return false;
  for (const c of [`${base}.md`, join(base, "index.md")]) {
    try { if ((await stat(c)).isFile()) return true; } catch { /* next */ }
  }
  return false;
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
};
// Is this row presentable as-is? null, or the reason it is pending.
export async function presentable(row, opts = {}) {
  const st = rowState(row, await fileMtimeOf(row.slug), opts);
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

/** Render one page URL. Returns { status, headers, body }. Never throws. */
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
  const rowAt = (slug) => {
    if (!rowCache.has(slug)) rowCache.set(slug, fetchRow(slug));
    return rowCache.get(slug);
  };
  const deps = {
    site,
    rowAt,
    row: once(async () => {
      const exact = await rowAt(req.key);
      if (!exact.ok || exact.row || req.key.includes("/")) return exact;
      return fetchRowByBasename(req.key);
    }),
    fileExists,
    presentable,
    siteUnavailable: () => {
      const s = dbState().state;
      return { unreachable: s === "up" ? "connecting" : s };
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
    // A basename URL that found its row: send the reader to the canonical
    // URL (relative hrefs on the page are computed for that depth).
    if (ctx.row && ctx.row.slug !== req.key && !req.key.includes("/")) {
      return respond(302, { location: "/" + ctx.row.slug.split("/").map(encodeURIComponent).join("/"), "cache-control": "no-store" }, "");
    }
    if (ctx.pending) {
      return respond(200, {
        "cache-control": "no-store", "x-wiki-render": "pending", "x-wiki-page-class": `${entry.name}@${entry.version}`,
      }, pendingDocument({ slug: req.key, reason: ctx.pending }));
    }
    const model = await renderTemplate(entry, ctx, deps, req.key);
    if (!model) { skip.add(entry.name); continue; }
    return respond(200, {
      "cache-control": "no-cache, must-revalidate",
      "x-wiki-render": "db",
      "x-wiki-page-class": `${entry.name}@${entry.version}`,
    }, renderDocument(model));
  }
  // Nobody claimed it. Known (file or planned) -> pending-compile; else not available.
  const planned = await plannedFor(req.key);
  const known = planned ? (planned.unlinked ? "registered, not yet cited by anything" : "queued for synthesis")
    : (await fileExists(req.key)) ? "its file is written" : null;
  if (known) {
    return respond(200, { "cache-control": "no-store", "x-wiki-render": "pending" }, pendingDocument({ slug: req.key, reason: known }));
  }
  return respond(200, { "cache-control": "no-store", "x-wiki-render": "not-available" }, notAvailableDocument({ slug: req.key }));
}
