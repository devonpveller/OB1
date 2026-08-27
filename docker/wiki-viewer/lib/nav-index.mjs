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
 * Cached in-process for NAV_TTL_MS: the payload is large and every page load
 * asks for it, so this must not become a query per request.
 */

const OB_URL = (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const ENABLED = process.env.WIKI_NAV_API !== "0";
const TTL_MS = Math.max(5_000, Number(process.env.WIKI_NAV_TTL_MS || "30000"));
const PAGE = 5000;
const MIN_ROWS = Math.max(0, Number(process.env.WIKI_NAV_MIN_ROWS || "100"));

let _cache = { at: 0, json: null, etag: null };

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

async function fetchAllRows(signal) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${OB_URL}/rest/v1/wiki_pages` +
      `?select=slug,title,links,tags,updated_at&order=slug.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: { apikey: "local-trust" }, signal });
    if (!r.ok) throw new Error(`wiki_pages ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Returns { json, etag } or null when unavailable (caller serves the published
// file instead). Never throws.
export async function getNavIndex() {
  if (!ENABLED) return null;
  const now = Date.now();
  if (_cache.json && now - _cache.at < TTL_MS) return _cache;
  try {
    const rows = await fetchAllRows(AbortSignal.timeout(30_000));
    // A tiny result means a half-applied migration or a truncated read, not a
    // real wiki: keep serving whatever we had rather than emptying the nav.
    if (rows.length < MIN_ROWS) return _cache.json ? _cache : null;
    const json = JSON.stringify(rowsToIndex(rows));
    _cache = { at: now, json, etag: `W/"nav-${rows.length}-${json.length}"` };
    return _cache;
  } catch {
    return _cache.json ? _cache : null;
  }
}
