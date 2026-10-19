/**
 * nav-index — the site's rows from the DATABASE, and `static/graphIndex.json`
 * served from them (Phase C).
 *
 * Since research-workbench P1b the explorer reads one folder at a time
 * (lib/nav-tree.mjs over the site index built from these rows) and search
 * uses the API, so the full `/static/graphIndex.json` is read only by the
 * graph's offline fallback and the notes editor's link autocomplete. There is
 * no published file behind it any more (derive-graph-index.mjs, the publish-
 * time derive, was removed with the builder-era readiness contract - E3).
 *
 * P1b PERF (the floor at five times today's 76,542 pages): a refresh first
 * asks the database for the table's SIGNATURE (row count + newest updated_at,
 * one cheap request) and walks the rows only when it changed; the site index
 * (lib/site-index.mjs) is built IN the refresh, off the request path, so no
 * reader pays for it; the graphIndex.json payload (and its ETag) is built
 * lazily, the first time one of its two readers asks for it.
 *
 * PERF REWORK 2026-08-28 (PLAN-VIEWER-PERF V5). Measured before: a request
 * arriving after the TTL expired paid the WHOLE rebuild inline — 3.4 s TTFB,
 * and 3.4 s even for a 304, because the ETag could not be computed without
 * rebuilding first. Two changes remove that stall:
 *
 *   1. STALE-WHILE-REVALIDATE. A cached copy is returned immediately, always.
 *      When it goes stale the refresh runs in the BACKGROUND (single-flight),
 *      so no reader ever waits behind it. Only a cold cache (first request
 *      after boot) blocks, because there is nothing truthful to serve yet.
 *   2. KEYSET pagination instead of OFFSET. Measured on the live table:
 *      OFFSET 0 = 46 ms but OFFSET 25000 = 289 ms (it re-walks the rows it
 *      skips), while a slug=gt.<cursor> page is 47 ms at ANY depth.
 *
 * The same rows feed the live renderer's site index (lib/site-index.mjs:
 * backlinks, folder and tag listings, link resolution) through getNavIndex's
 * `rows`, so the explorer and the page chrome can never disagree.
 *
 * Freshness trade, stated: a reader can now see a nav up to one refresh
 * behind (the request that finds it stale gets the old copy and starts the
 * refresh; the next one gets the new). The refresh is kicked off at TTL/2 so
 * an actively-used wiki stays fresh, and a page created seconds ago is still
 * served correctly from the DB by serve.mjs regardless of the nav cache.
 */

import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isPagePath } from "./shared/quartz-slug.mjs";
import { buildSiteIndexYielding } from "./site-index.mjs";
import { warmFolders } from "./nav-tree.mjs";

const OB_URL = (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const ENABLED = process.env.WIKI_NAV_API !== "0";
const TTL_MS = Math.max(5_000, Number(process.env.WIKI_NAV_TTL_MS || "30000"));
const PAGE = 5000;
const MIN_ROWS = Math.max(0, Number(process.env.WIKI_NAV_MIN_ROWS || "100"));

let _cache = null; // see makeCache()
let _refreshing = null; // in-flight refresh promise (single-flight)
// NAV-ONLY mode (the nav worker, lib/nav-worker.mjs): the narrow projection,
// a nav-only site index, no rows kept, no graphIndex payload.
let _navOnly = false;
let _status = { ok: false, at: 0, error: "not yet refreshed" };
export function configureNavIndex({ navOnly = false } = {}) {
  _navOnly = !!navOnly;
}
/** The last refresh's outcome: { ok, at, error } (a failed read keeps the previous snapshot). */
export function navIndexStatus() {
  return { ..._status };
}

export function navIndexEnabled() {
  return ENABLED;
}

// The graphIndex.json shape (byte-compatible with the retired publish-time
// derive). `slug` MUST be inside the value: a FileTrieNode.add does
// file.slug.split("/").
// A row for a path Quartz does not build (private/, templates/, a
// dot-directory: quartz-slug.mjs isPagePath) is not offered (rw-p1a-deploy-prep, RV-1).
export function rowsToIndex(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r || !r.slug || !isPagePath(`${r.slug}.md`)) continue;
    out[r.slug] = {
      slug: r.slug,
      title: r.title || r.slug.split("/").pop(),
      filePath: `${r.slug}.md`,
      links: Array.isArray(r.links) ? r.links : [],
      tags: Array.isArray(r.tags) ? r.tags : [],
      ...(r.updated_at ? { date: r.updated_at } : {}),
    };
  }
  return out;
}

/**
 * One page of the keyset walk. `cursor` is the last slug of the previous page
 * (null for the first). Ordering by the PRIMARY KEY makes the cursor total and
 * stable, so no row can be skipped or repeated between pages.
 */
// The site index (backlinks, folders, tags, aliases, link resolution) rides
// the same walk, so it also carries page_class and the two frontmatter keys
// the chrome needs. A database without the frontmatter column (before
// init-wiki-pages.sql is applied) answers the narrow projection instead.
const SELECT_SITE = "select=slug,title,links,tags,updated_at,page_class,aliases:frontmatter->aliases,alias:frontmatter->alias,permalink:frontmatter->>permalink,fm_date:frontmatter->>date";
const SELECT_NAV = "select=slug,title,links,tags,updated_at,page_class";
const SELECT_NAVONLY = "select=slug,title,updated_at";
let _projection = SELECT_SITE;

export function pageUrl(cursor) {
  const params = [
    _navOnly ? SELECT_NAVONLY : _projection,
    "order=slug.asc",
    `limit=${PAGE}`,
  ];
  if (cursor) params.push(`slug=gt.${encodeURIComponent(cursor)}`);
  return `${OB_URL}/rest/v1/wiki_pages?${params.join("&")}`;
}

/**
 * ETag over the PAYLOAD, not over row metadata: it must change when and only
 * when the bytes change, so a browser keeps its copy while the drain writes
 * rows whose projected fields are identical. (The previous count+length form
 * was collision-prone; count+max(updated_at) would have been WORSE — it
 * changes on any row touch, even one this projection ignores.)
 */
export function etagFor(json) {
  return `W/"nav-${createHash("sha1").update(json).digest("hex").slice(0, 16)}"`;
}

export async function fetchAllRows(signal, fetchImpl = fetch) {
  const out = [];
  let cursor = null;
  for (;;) {
    const r = await fetchImpl(pageUrl(cursor), { headers: { apikey: "local-trust" }, signal });
    if (!r.ok && r.status === 400 && _projection === SELECT_SITE) {
      _projection = SELECT_NAV; // pre-migration database: no frontmatter column
      continue;
    }
    if (!r.ok) throw new Error(`wiki_pages ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    cursor = rows[rows.length - 1]?.slug;
    if (rows.length < PAGE || !cursor) break;
  }
  return out;
}

// The table's signature: row count (PostgREST exact count) + the newest
// updated_at. Every writer stamps updated_at = now() and a delete changes the
// count, so an unchanged signature means unchanged rows. null when the answer
// does not carry it (then the rows are walked, as before P1b).
export async function tableSignature(signal, fetchImpl = fetch) {
  const r = await fetchImpl(`${OB_URL}/rest/v1/wiki_pages?select=updated_at&order=updated_at.desc.nullslast&limit=1`, {
    headers: { apikey: "local-trust", prefer: "count=exact" }, signal,
  });
  if (!r.ok) throw new Error(`wiki_pages signature ${r.status}`);
  const range = r.headers?.get?.("content-range") || "";
  const m = /\/(\d+)$/.exec(range);
  if (!m) return null;
  const rows = await r.json();
  return `${m[1]}|${Array.isArray(rows) && rows[0] ? rows[0].updated_at : ""}`;
}

// One snapshot of the rows: its site index is built now, in slices that
// yield to the event loop (off the request path - readers keep being served
// from the previous snapshot meanwhile), and the explorer's large folders are
// pre-sorted; the graphIndex.json payload and its ETag only when first asked.
let _generation = 0;
async function makeCache(rows, at, sig) {
  const c = {
    at, rows: _navOnly ? [] : rows, sig, site: null, _json: null, _etag: null,
    get json() { return (this._json ??= JSON.stringify(rowsToIndex(this.rows))); },
    get etag() { return (this._etag ??= etagFor(this.json)); },
  };
  c.site = await buildSiteIndexYielding(rows, `site-${++_generation}`, { navOnly: _navOnly }); // a new identity per snapshot (nav-tree memo key)
  await warmFolders(c.site);
  return c;
}

// Rebuild the cache. Never throws: on any failure the previous copy stays
// exactly as it was (fail-soft is the whole point of this module).
async function refresh(fetchImpl, now) {
  const started = Date.now();
  try {
    const sig = await tableSignature(AbortSignal.timeout(10_000), fetchImpl).catch(() => null);
    if (sig && _cache && _cache.sig === sig) { _cache.at = now(); _status = { ok: true, at: Date.now(), error: null }; return; } // unchanged: nothing to walk
    // the longest the event loop was blocked during this refresh: what a reader
    // arriving meanwhile could have waited (logged; the P1b floor is 300 ms)
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const rows = await fetchAllRows(AbortSignal.timeout(60_000), fetchImpl).finally(() => lag.disable());
    // A tiny result means a half-applied migration or a truncated read, not a
    // real wiki: keep serving whatever we had rather than emptying the nav.
    if (rows.length < MIN_ROWS) { _status = { ok: false, at: Date.now(), error: `only ${rows.length} rows (< ${MIN_ROWS})` }; return; }
    const walked = Date.now();
    const walkLag = lag.max / 1e6;
    lag.reset(); lag.enable();
    _cache = await makeCache(rows, now(), sig).finally(() => lag.disable());
    _status = { ok: true, at: Date.now(), error: null };
    console.log(
      `[wiki-viewer] nav index refreshed: ${rows.length} rows, walk ${walked - started}ms, ` +
        `site index ${Date.now() - walked}ms, longest event-loop block ${Math.round(Math.max(walkLag, lag.max / 1e6))}ms`,
    );
  } catch (e) {
    _status = { ok: false, at: Date.now(), error: String(e?.message || e).slice(0, 200) };
    console.warn(`[wiki-viewer] nav index refresh failed (serving previous): ${e?.message || e}`);
  }
}

function startRefresh(fetchImpl, now) {
  if (_refreshing) return _refreshing;
  _refreshing = refresh(fetchImpl, now).finally(() => {
    _refreshing = null;
  });
  return _refreshing;
}

/**
 * Returns the snapshot { rows, site, json, etag } or null when unavailable
 * (the database screen / a 503). Never throws, and never blocks once warm.
 *
 * opts is for TESTS ONLY (injected clock/fetch/ttl); production calls it bare.
 */
export async function getNavIndex(opts = {}) {
  if (!ENABLED) return null;
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const ttl = opts.ttlMs ?? TTL_MS;

  if (_cache) {
    // Refresh at HALF the TTL so an actively-used wiki is refreshed before a
    // reader can observe staleness, and the reader never waits either way.
    if (now() - _cache.at >= ttl / 2) void startRefresh(fetchImpl, now);
    return _cache;
  }
  // Cold: nothing truthful to serve, so this one request does wait.
  await startRefresh(fetchImpl, now);
  return _cache || null;
}

// Test seam: the module holds process-lifetime state by design.
export function _resetForTests() {
  _cache = null;
  _navOnly = false;
  _status = { ok: false, at: 0, error: "not yet refreshed" };
  _refreshing = null;
  _projection = SELECT_SITE;
}
export function _pendingRefresh() {
  return _refreshing;
}
