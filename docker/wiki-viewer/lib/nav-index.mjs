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
 * FRESHNESS BOUND (rw-p1b-ready fix round 1, tester attempt 1 defect 3): a
 * listing (folder, tag, explorer) follows a write within WIKI_NAV_TTL_MS, and
 * no reader pays for it. Before, a refresh started only when a request found
 * the snapshot stale, and that request - the first reader after any quiet
 * period - got the old listing with its old ETag (116 reads / 35.9 s at
 * ~400k rows). Now:
 *   - a background TICK runs every TTL/4 whether or not anyone reads: the
 *     table signature (one cheap request), and when it moved, the rows written
 *     since the snapshot (updated_at >= its newest - 2 min) are applied IN
 *     PLACE (nav-only: nav-tree.mjs applyNavDelta; the page thread:
 *     site-index.mjs applySiteDelta) - milliseconds, at any vault size;
 *   - what a delta cannot apply (a deletion, two files on one URL, an alias
 *     change, a new folder, another page's link to a NEW page) is a FULL
 *     rebuild in the background (single-flight, separate from the tick, so
 *     ticks keep applying deltas while it runs; a catch-up tick follows it);
 *   - a snapshot not confirmed within the TTL is not served while the
 *     database answers: the read waits for the tick (only reachable when the
 *     timer could not run);
 *   - the snapshot's ETag changes with every applied delta.
 * A page created seconds ago is served correctly from the DB by serve.mjs
 * regardless of the nav cache.
 */

import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isPagePath } from "./shared/quartz-slug.mjs";
import { buildSiteIndexYielding } from "./site-index.mjs";
import { warmFolders, applyNavDelta } from "./nav-tree.mjs";
import { applySiteDelta } from "./site-index.mjs";

const OB_URL = (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const ENABLED = process.env.WIKI_NAV_API !== "0";
const TTL_MS = Math.max(5_000, Number(process.env.WIKI_NAV_TTL_MS || "30000"));
const PAGE = 5000;
const MIN_ROWS = Math.max(0, Number(process.env.WIKI_NAV_MIN_ROWS || "100"));

let _cache = null; // see makeCache()
let _ticking = null; // in-flight tick (signature + delta), single-flight
let _rebuilding = null; // in-flight full walk + build, single-flight
let _timer = null; // the background tick (production only)
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
/** True once the first snapshot exists (P1c: serve.mjs warms it at start; /__health is "warming" until then). */
export function navIndexWarm() {
  return _cache !== null;
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
// pre-sorted. NO whole-vault JSON string is ever built (rw-p1b-ready fix
// round 1, defect 1: the lazy JSON.stringify of 383k rows on the page thread
// stalled every page for 32 s); graphIndex.json is streamed from indexChunks.
// The ETag names the snapshot and its applied deltas (version).
let _generation = 0;
async function makeCache(rows, at, sig) {
  const c = {
    at, rows: _navOnly ? [] : rows, sig, site: null, version: 0,
    get etag() { return `W/"nav-${createHash("sha1").update(`${this.site?.etag}|${this.version}|${this.sig}`).digest("hex").slice(0, 16)}"`; },
  };
  c.site = await buildSiteIndexYielding(rows, `site-${++_generation}`, { navOnly: _navOnly }); // a new identity per snapshot (nav-tree memo key)
  await warmFolders(c.site);
  // row slug -> its index in rows, so a delta also updates the graphIndex
  // payload's rows (built in slices, as the site index)
  if (!_navOnly) {
    c.rowPos = new Map();
    for (let i = 0; i < rows.length; i++) {
      c.rowPos.set(rows[i]?.slug, i);
      if (i % 8192 === 8191) await new Promise((r) => setImmediate(r));
    }
  }
  return c;
}

// THE DELTA (the nav worker since bd3fedb; the page thread since fix round
// 1): when the signature moved, only the rows written since the snapshot are
// read (with a 2-minute overlap for writers whose clock stamped a little
// earlier) and applied in place. Nav-only (nav-tree.mjs applyNavDelta): a new
// page or a new title in its folder's sorted list. Page thread (site-index.mjs
// applySiteDelta): titles, tags (tag listings), links, dates, and a new page
// in an existing folder (folder listings). A deletion (the count fell short of
// old + new), a large delta or a shape a delta cannot apply -> the full
// rebuild. Measured reason (nav worker): a full rebuild at 5x is a 383k-row
// walk + build; a delta is a few rows.
const DELTA_OVERLAP_MS = 120_000;
const DELTA_MAX = 20_000;
async function tryDelta(cache, sig, fetchImpl) {
  if (!cache?.sig || !sig) return { ok: false };
  const [oldCount, oldMax] = cache.sig.split("|");
  const [newCount] = sig.split("|");
  const since = Date.parse(oldMax);
  if (!Number.isFinite(since)) return { ok: false };
  const from = new Date(since - DELTA_OVERLAP_MS).toISOString();
  const select = _navOnly ? "select=slug,title,updated_at" : _projection;
  const r = await fetchImpl(`${OB_URL}/rest/v1/wiki_pages?${select}&updated_at=gte.${encodeURIComponent(from)}` +
    `&order=updated_at.asc&limit=${DELTA_MAX + 1}`, { headers: { apikey: "local-trust" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return { ok: false };
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length > DELTA_MAX) return { ok: false };
  const expectedNew = Number(newCount) - Number(oldCount);
  const res = _navOnly ? applyNavDelta(cache.site, rows, expectedNew) : applySiteDelta(cache.site, rows, expectedNew);
  if (!res.ok) return { ok: false };
  cache.sig = sig;
  if (res.changed && cache.rowPos) {
    for (const row of rows) {
      if (!row?.slug) continue;
      const i = cache.rowPos.get(row.slug);
      if (i == null) { cache.rowPos.set(row.slug, cache.rows.length); cache.rows.push(row); } else cache.rows[i] = row;
    }
  }
  if (res.changed) {
    cache.version++;
    console.log(`[wiki-viewer] ${_navOnly ? "nav" : "site"} delta applied: ${rows.length} row(s) read, ${res.added} new, ` +
      `${res.retitled ?? res.updated} ${_navOnly ? "retitled" : "updated"}, ${res.folders ?? res.touched} listing(s) touched`);
  }
  return res;
}

// The full walk + build. Never throws: on any failure the previous copy stays
// exactly as it was (fail-soft is the whole point of this module).
async function rebuild(fetchImpl, now, sig, t0) {
  const started = Date.now();
  try {
    // the longest the event loop was blocked during this rebuild: what a reader
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
    _cache = await makeCache(rows, t0, sig).finally(() => lag.disable());
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

function startRebuild(fetchImpl, now, sig, t0) {
  if (_rebuilding) return _rebuilding;
  const started = Date.now();
  _rebuilding = rebuild(fetchImpl, now, sig, t0).finally(() => {
    _rebuilding = null;
    // writes that landed while a long rebuild ran: a catch-up tick at once
    if (_cache && Date.now() - started > 1000) void startTick(fetchImpl, now);
  });
  return _rebuilding;
}

// One tick: confirm or advance the snapshot. Never throws.
async function tick(fetchImpl, now) {
  const t0 = now();
  const sig = await tableSignature(AbortSignal.timeout(10_000), fetchImpl).catch(() => null);
  if (!_cache) { await startRebuild(fetchImpl, now, sig, t0); return; } // cold: the one wait
  if (sig && _cache.sig === sig) { _cache.at = t0; _status = { ok: true, at: Date.now(), error: null }; return; } // unchanged
  // (also while a full rebuild runs: the served snapshot keeps following writes)
  const d = sig ? await tryDelta(_cache, sig, fetchImpl).catch(() => ({ ok: false })) : { ok: false };
  if (d.ok) {
    _cache.at = t0;
    _status = { ok: true, at: Date.now(), error: null };
    // a new page: other pages' links to it (backlinks) need the full build
    if (d.needsRebuild) void startRebuild(fetchImpl, now, sig, now());
    return;
  }
  void startRebuild(fetchImpl, now, sig, t0);
}

function startTick(fetchImpl, now) {
  if (_ticking) return _ticking;
  _ticking = tick(fetchImpl, now).finally(() => {
    _ticking = null;
  });
  return _ticking;
}

function ensureTimer() {
  if (_timer) return;
  _timer = setInterval(() => { void startTick(fetch, Date.now); }, Math.max(1000, Math.floor(TTL_MS / 4)));
  _timer.unref?.();
}

/**
 * Returns the snapshot { rows, site, etag, at } or null when unavailable
 * (the database screen / a 503). Never throws. Once warm it never waits,
 * except for a snapshot older than the TTL while the database answers (the
 * background tick could not run): then the read waits for one tick.
 *
 * opts is for TESTS ONLY (injected clock/fetch/ttl; no background timer);
 * production calls it bare.
 */
export async function getNavIndex(opts = {}) {
  if (!ENABLED) return null;
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const ttl = opts.ttlMs ?? TTL_MS;
  if (!opts.fetchImpl) ensureTimer();

  if (_cache) {
    const age = now() - _cache.at;
    if (age > ttl && _status.ok) await startTick(fetchImpl, now);
    else if (age >= ttl / 4) void startTick(fetchImpl, now);
    return _cache;
  }
  // Cold: nothing truthful to serve, so this one request does wait.
  await startTick(fetchImpl, now);
  return _cache || null;
}

/**
 * The graphIndex.json payload of a snapshot, in slices of `per` rows (the
 * page thread streams it with a yield between slices: serve.mjs). Byte-equal
 * to JSON.stringify(rowsToIndex(rows)).
 */
export function* indexChunks(cache, per = 2000) {
  const rows = cache?.rows || [];
  let first = true;
  yield "{";
  for (let i = 0; i < rows.length; i += per) {
    const part = rowsToIndex(rows.slice(i, i + per));
    let out = "";
    for (const k of Object.keys(part)) { out += (first ? "" : ",") + JSON.stringify(k) + ":" + JSON.stringify(part[k]); first = false; }
    yield out;
  }
  yield "}";
}

// Test seam: the module holds process-lifetime state by design.
export function _resetForTests() {
  _cache = null;
  _navOnly = false;
  _status = { ok: false, at: 0, error: "not yet refreshed" };
  _ticking = null;
  _rebuilding = null;
  _projection = SELECT_SITE;
}
export async function _pendingRefresh() {
  while (_ticking || _rebuilding) await Promise.allSettled([_ticking, _rebuilding]);
}
// what the background timer runs, for tests (injected fetch/clock)
export function _tickForTests({ fetchImpl, now }) {
  return startTick(fetchImpl, now);
}
