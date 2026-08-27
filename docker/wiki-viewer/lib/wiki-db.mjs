/**
 * wiki-db — fetch one page row from `wiki_pages` for the DB-render fallback.
 *
 * I/O edge for Phase B: everything else in lib/ is pure. Speaks PostgREST
 * (openbrain-rest; anon role = service_role on the internal network, same
 * trust posture as the compiler's own sync in recipes/_shared/wiki-pages.mjs).
 *
 * Fail-soft contract: NEVER throws — a DB problem returns null and the caller
 * falls through to the pre-existing behaviour (interim page / planned / 404).
 * A short negative cache keeps a hammered genuine-404 from becoming DB load.
 */

const OB_URL = (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const ENABLED = process.env.WIKI_DB_RENDER !== "0"; // kill switch: restart-only mitigation
const TIMEOUT_MS = Math.max(500, Number(process.env.WIKI_DB_RENDER_TIMEOUT_MS || "3000"));
const NEG_TTL_MS = 10_000;

const _negative = new Map(); // slug -> expiry ts

export function dbRenderEnabled() {
  return ENABLED;
}

// slug: exact ("content/person/person-x", "notes/y") or a bare basename
// ("person-x") — Quartz renders links to missing pages as basename URLs, so
// both forms must answer (same rule as serve.mjs plannedFor).
export async function fetchWikiPage(slug) {
  if (!ENABLED || !slug) return null;
  const now = Date.now();
  const neg = _negative.get(slug);
  if (neg && neg > now) return null;
  if (_negative.size > 500) _negative.clear(); // bound the cache, crudely and safely

  const enc = encodeURIComponent(slug);
  // Exact slug first; if the key has no slash, also try basename suffix match.
  const queries = [`slug=eq.${enc}`];
  if (!slug.includes("/")) queries.push(`slug=like.*%2F${enc}`);
  try {
    for (const q of queries) {
      const r = await fetch(
        `${OB_URL}/rest/v1/wiki_pages?${q}&select=slug,title,body,page_class,updated_at&limit=1`,
        { headers: { apikey: "local-trust" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!r.ok) continue;
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) return rows[0];
    }
    _negative.set(slug, now + NEG_TTL_MS);
    return null;
  } catch {
    return null; // DB unreachable → fall through, never break the page
  }
}
