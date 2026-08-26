// /workbench/search (wiki-dynamic-index P3) — full-text search over the wiki,
// served from the database instead of a static index the browser downloads.
//
// WHY: the viewer used to ship the FULL text of every page to the client as
// one static JSON (~75MB at 29.6k pages) and match it with client-side
// FlexSearch. Producing that file was also the last whole-vault step in every
// rebuild. `wiki_pages` (written by the compiler as it writes each page) turns
// search into a ranked SQL query: weighted tsvector, title over body.
//
// Contract with the client: returns the shape search.inline.ts already
// renders — slug, title, content snippet, tags.
//
// SAFETY: ts_headline defaults to wrapping matches in raw <b> tags, and page
// bodies can legitimately contain markup (raw HTML from ingested sources is
// not stripped — confirmed 2026-08-25). Emitting that into the results panel
// via innerHTML would be an injection vector, so highlights use inert
// <<HL>>/<</HL>> markers: the client escapes the snippet FIRST and only then
// swaps the markers for <b> tags.
import { Hono } from "hono";
import { query } from "../db/pool.ts";

export const search = new Hono();

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;
// A single interactive user, debounced client-side: a slow query means a bad
// query, not load. Fail fast rather than pile up connections.
const STATEMENT_TIMEOUT_MS = 3000;

interface Row {
  slug: string;
  title: string;
  snippet: string;
  tags: unknown;
  page_class: string;
  rank: number;
}

// PURE param handling, exported for unit tests: a bad limit must never reach
// the DB as-is, and a too-short query must never rank the whole table.
export function parseSearchParams(
  rawQ: string | undefined,
  rawLimit: string | undefined,
  rawClass: string | undefined,
): { q: string; limit: number; cls: string; tooShort: boolean } {
  const q = (rawQ ?? "").trim();
  const n = Number(rawLimit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(n) && n > 0
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)))
    : DEFAULT_LIMIT;
  const cls = (rawClass ?? "").trim();
  return { q, limit, cls, tooShort: q.length < 2 };
}

search.get("/", async (c) => {
  const { q, limit, cls, tooShort } = parseSearchParams(
    c.req.query("q"),
    c.req.query("limit"),
    c.req.query("class"),
  );
  if (tooShort) return c.json({ query: q, count: 0, results: [] });

  // websearch_to_tsquery takes user input verbatim (quotes, OR, -negation) and
  // never throws on syntax the way to_tsquery does. Values are BOUND, never
  // interpolated — ts_headline options are a constant string.
  const params: unknown[] = [q, limit];
  let classFilter = "";
  if (cls) {
    params.push(cls);
    classFilter = `AND page_class = $${params.length}`;
  }

  const sql = `
    SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS};
    SELECT slug,
           title,
           ts_headline('english', body, websearch_to_tsquery('english', $1),
                       'StartSel=<<HL>>, StopSel=<</HL>>, MaxWords=30, MinWords=12, ShortWord=3, MaxFragments=1, FragmentDelimiter=" … "') AS snippet,
           tags,
           page_class,
           ts_rank(search_tsv, websearch_to_tsquery('english', $1)) AS rank
      FROM wiki_pages
     WHERE search_tsv @@ websearch_to_tsquery('english', $1)
       ${classFilter}
     ORDER BY rank DESC, updated_at DESC
     LIMIT $2`;

  try {
    const rows = await query<Row>(sql, params);
    return c.json({
      query: q,
      count: rows.length,
      results: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        content: r.snippet ?? "",
        tags: Array.isArray(r.tags) ? r.tags : [],
        pageClass: r.page_class,
      })),
    });
  } catch (err) {
    // Fail SOFT: the viewer must stay usable when search is unavailable. The
    // client renders "no results + notice" rather than breaking the page.
    console.error("[search] query failed:", (err as Error).message);
    return c.json({ query: q, count: 0, results: [], error: "search_unavailable" }, 503);
  }
});
