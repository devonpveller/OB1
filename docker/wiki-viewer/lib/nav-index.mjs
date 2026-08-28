/**
 * nav-index — serve `static/graphIndex.json` from the DATABASE (Phase C).
 *
 * WHY THIS SHAPE, not a new endpoint: the Explorer, the graph and the notes
 * autocomplete all already consume `/static/graphIndex.json`, which
 * derive-graph-index.mjs builds from `wiki_pages` — but only at PUBLISH time.
 * So a brand-new page was missing from the sidebar until a snapshot swap.
 *
 * Serving the SAME url with the SAME shape from the same table gives the
 * freshness (a new page appears on the next page load, no build involved)
 * without forking three client scripts. Fewer moving parts, no bundle rebuild,
 * and the published file remains the fallback if the DB is unreachable.
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
 * Freshness trade, stated: a reader can now see a nav up to one refresh
 * behind (the request that finds it stale gets the old copy and starts the
 * refresh; the next one gets the new). The refresh is kicked off at TTL/2 so
 * an actively-used wiki stays fresh, and a page created seconds ago is still
 * served correctly from the DB by serve.mjs regardless of the nav cache.
 */

import { createHash } from "node:crypto";

const OB_URL = (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const ENABLED = process.env.WIKI_NAV_API !== "0";
const TTL_MS = Math.max(5_000, Number(process.env.WIKI_NAV_TTL_MS || "30000"));
const PAGE = 5000;
const MIN_ROWS = Math.max(0, Number(process.env.WIKI_NAV_MIN_ROWS || "100"));

let _cache = { at: 0, json: null, etag: null };
let _refreshing = null; // in-flight refresh promise (single-flight)

export function navIndexEnabled() {
  return ENABLED;
}

// Same projection derive-graph-index.mjs emits. `slug` MUST be inside the
// value: the Explorer's FileTrieNode.add does file.slug.split("/").
export function rowsToIndex(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r || !r.slug) continue;
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
export function pageUrl(cursor) {
  const params = [
    "select=slug,title,links,tags,updated_at",
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
    if (!r.ok) throw new Error(`wiki_pages ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    cursor = rows[rows.length - 1]?.slug;
    if (rows.length < PAGE || !cursor) break;
  }
  return out;
}

// Rebuild the cache. Never throws: on any failure the previous copy stays
// exactly as it was (fail-soft is the whole point of this module).
async function refresh(fetchImpl, now) {
  const started = Date.now();
  try {
    const rows = await fetchAllRows(AbortSignal.timeout(30_000), fetchImpl);
    // A tiny result means a half-applied migration or a truncated read, not a
    // real wiki: keep serving whatever we had rather than emptying the nav.
    if (rows.length < MIN_ROWS) return;
    const json = JSON.stringify(rowsToIndex(rows));
    _cache = { at: now(), json, etag: etagFor(json) };
    console.log(
      `[wiki-viewer] nav index refreshed: ${rows.length} rows, ` +
        `${json.length} bytes, ${Date.now() - started}ms`,
    );
  } catch (e) {
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
 * Returns { json, etag } or null when unavailable (caller serves the published
 * file instead). Never throws, and never blocks once warm.
 *
 * opts is for TESTS ONLY (injected clock/fetch/ttl); production calls it bare.
 */
export async function getNavIndex(opts = {}) {
  if (!ENABLED) return null;
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const ttl = opts.ttlMs ?? TTL_MS;

  if (_cache.json) {
    // Refresh at HALF the TTL so an actively-used wiki is refreshed before a
    // reader can observe staleness, and the reader never waits either way.
    if (now() - _cache.at >= ttl / 2) void startRefresh(fetchImpl, now);
    return _cache;
  }
  // Cold: nothing truthful to serve, so this one request does wait.
  await startRefresh(fetchImpl, now);
  return _cache.json ? _cache : null;
}

// Test seam: the module holds process-lifetime state by design.
export function _resetForTests() {
  _cache = { at: 0, json: null, etag: null };
  _refreshing = null;
}
export function _pendingRefresh() {
  return _refreshing;
}
