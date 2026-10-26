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
// TAG SEARCH (research-workbench P1b): `?tag=<t>` returns the pages one of
// whose tags contains <t> (case-insensitive) - the search script's "#tag"
// mode, which used to match against the whole vault's index downloaded into
// the browser; `?tag=<t>&q=<term>` is the full-text search filtered by that
// tag ("#tag term"). The tag is a BOUND value with LIKE's wildcards escaped.
//
// SAFETY: ts_headline defaults to wrapping matches in raw <b> tags, and page
// bodies can legitimately contain markup (raw HTML from ingested sources is
// not stripped — confirmed 2026-08-25). Emitting that into the results panel
// via innerHTML would be an injection vector, so highlights use inert
// <<HL>>/<</HL>> markers: the client escapes the snippet FIRST and only then
// swaps the markers for <b> tags.
import { Hono } from "hono";
import { withTransaction } from "../db/pool.ts";

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
  rawTag?: string | undefined,
): { q: string; limit: number; cls: string; tag: string; tooShort: boolean } {
  const q = (rawQ ?? "").trim();
  const n = Number(rawLimit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(n) && n > 0
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)))
    : DEFAULT_LIMIT;
  const cls = (rawClass ?? "").trim();
  const tag = (rawTag ?? "").trim().replace(/^#/, "").slice(0, 200);
  // A tag alone is a query (one character is a useful tag prefix); a term
  // still needs two characters, with or without a tag.
  return { q, limit, cls, tag, tooShort: tag ? q.length === 1 : q.length < 2 };
}

// LIKE pattern for "a tag containing <tag>": the caller's text is a literal.
export function tagPattern(tag: string): string {
  return "%" + tag.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

search.get("/", async (c) => {
  const { q, limit, cls, tag, tooShort } = parseSearchParams(
    c.req.query("q"),
    c.req.query("limit"),
    c.req.query("class"),
    c.req.query("tag"),
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
  let tagFilter = "";
  if (tag) {
    params.push(tagPattern(tag));
    tagFilter = `AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) AS t(v) WHERE lower(t.v) LIKE $${params.length})`;
  }

  // NB: SET LOCAL must be its OWN statement on the SAME connection - Postgres
  // rejects multiple commands inside a prepared (parameter-bound) statement
  // ("cannot insert multiple commands into a prepared statement"), which is
  // exactly how this failed on its first live call. withTransaction gives us
  // one client for both, and LOCAL scopes the timeout to this transaction.
  const sql = tag && !q ? `
    SELECT slug, title, '' AS snippet, tags, page_class, 0 AS rank
      FROM wiki_pages
     WHERE $1::text = '' ${tagFilter} ${classFilter}
     ORDER BY lower(title), slug
     LIMIT $2` : `
    SELECT slug,
           title,
           ts_headline('english', body, websearch_to_tsquery('english', $1),
                       'StartSel=<<HL>>, StopSel=<</HL>>, MaxWords=30, MinWords=12, ShortWord=3, MaxFragments=1, FragmentDelimiter=" … "') AS snippet,
           tags,
           page_class,
           ts_rank(search_tsv, websearch_to_tsquery('english', $1)) AS rank
      FROM wiki_pages
     WHERE search_tsv @@ websearch_to_tsquery('english', $1)
       ${classFilter} ${tagFilter}
     ORDER BY rank DESC, updated_at DESC
     LIMIT $2`;

  try {
    const rows = await withTransaction(async (client) => {
      await client.queryObject(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      const res = await client.queryObject<Row>(sql, params);
      return res.rows;
    });
    return c.json({
      query: q,
      ...(tag ? { tag } : {}),
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
