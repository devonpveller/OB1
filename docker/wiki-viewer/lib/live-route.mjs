/**
 * live-route - the page route: every page URL is presented from wiki_pages
 * (research-workbench P1a; D13 "ingest -> compile -> present").
 *
 * Order of operations for one request:
 *   1. the page-class registry resolves it (lib/page-classes.mjs); the first
 *      entry that claims it renders it with its template -> x-wiki-render: db
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
import { resolvePage } from "./page-classes.mjs";
import { renderDocument, pendingDocument, databaseDocument, notAvailableDocument } from "./chrome.mjs";
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

const once = (fn) => { let p; return () => (p ??= fn()); };

function respond(status, headers, body) {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

/** Render one page URL. Returns { status, headers, body }. Never throws. */
export async function renderLive(urlPath) {
  const req = keyOf(urlPath);
  if (!req) return respond(400, { "cache-control": "no-store" }, "bad request");
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
    siteUnavailable: () => {
      const s = dbState().state;
      return { unreachable: s === "up" ? "connecting" : s };
    },
  };
  let resolved;
  try {
    resolved = await resolvePage(req, deps);
  } catch (e) {
    console.error(`[wiki-viewer] resolve failed for ${req.key}: ${e?.stack || e}`);
    resolved = { unreachable: dbState().state === "up" ? "connecting" : dbState().state };
  }
  if (resolved?.unreachable) {
    return respond(200, { "cache-control": "no-store", "x-wiki-render": resolved.unreachable }, databaseDocument(resolved.unreachable));
  }
  if (resolved) {
    const { entry, ctx } = resolved;
    // A basename URL that found its row: send the reader to the canonical
    // URL (relative hrefs on the page are computed for that depth).
    if (ctx.row && ctx.row.slug !== req.key && !req.key.includes("/")) {
      return respond(302, { location: "/" + ctx.row.slug.split("/").map(encodeURIComponent).join("/"), "cache-control": "no-store" }, "");
    }
    const model = await entry.template(ctx, deps);
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
