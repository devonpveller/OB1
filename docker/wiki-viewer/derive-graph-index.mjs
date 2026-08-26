// Build the lean graph/explorer index from the DATABASE.
//
//   node /derive-graph-index.mjs <siteDir>
//
// HISTORY / WHY (wiki-dynamic-index P2, 2026-08-26)
//   This used to derive graphIndex.json by parsing Quartz's static
//   contentIndex.json. That file is produced by ContentIndex — the ONLY
//   non-incremental emitter left — which re-walks every page and re-serialises
//   the full text of the whole vault on EVERY rebuild (measured: ~75MB, ~120s
//   per rebuild on a 29.6k-page vault, running back-to-back forever). It was
//   the reason a new note took >15 minutes to appear.
//
//   The compiler now publishes each page into `wiki_pages` as it writes it
//   (recipes/_shared/wiki-pages.mjs), so this index is a QUERY. ContentIndex
//   is switched off and the rebuild collapses to per-page partial emits.
//
// Shape is byte-compatible with the old output: slug -> {slug, title,
// filePath, links, tags, date}. `slug` MUST stay inside the value — the
// Explorer's FileTrieNode.add does `file.slug.split("/")` (fileTrie.ts:89)
// and omitting it crashed the Explorer on every page load (2026-08-24).
//
// Runs on the immutable snapshot copy BEFORE the atomic swap. Exits non-zero
// on any doubt (DB unreachable, implausibly small result), which makes the
// entrypoint DISCARD that snapshot and keep serving the last good one — a
// wrong index is worse than a stale one.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const siteDir = process.argv[2];
if (!siteDir) {
  console.error("usage: derive-graph-index.mjs <siteDir>");
  process.exit(2);
}

const OB_URL = (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const PAGE = Math.max(500, Number(process.env.GRAPH_INDEX_PAGE_SIZE || "5000"));
// A vault this size never legitimately drops to a handful of pages; a tiny
// result means a half-applied migration or a truncated read, not a real wiki.
const MIN_ROWS = Math.max(0, Number(process.env.GRAPH_INDEX_MIN_ROWS || "100"));
const dst = join(siteDir, "static", "graphIndex.json");
const legacy = join(siteDir, "static", "contentIndex.json");

// Offset-paginated fetch-ALL. A partial read here would silently shrink the
// nav tree and the graph, so any failure aborts the whole publish.
async function fetchAllRows() {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${OB_URL}/rest/v1/wiki_pages` +
      `?select=slug,title,links,tags,updated_at&order=slug.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, {
      headers: { apikey: "local-trust" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`wiki_pages ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function toIndex(rows) {
  const lean = {};
  for (const row of rows) {
    const slug = row.slug;
    if (!slug) continue;
    lean[slug] = {
      slug,
      title: row.title || slug.split("/").pop(),
      filePath: `${slug}.md`,
      links: Array.isArray(row.links) ? row.links : [],
      tags: Array.isArray(row.tags) ? row.tags : [],
      ...(row.updated_at ? { date: row.updated_at } : {}),
    };
  }
  return lean;
}

const mb = (n) => (n / 1048576).toFixed(1);

try {
  const rows = await fetchAllRows();
  if (rows.length < MIN_ROWS) {
    throw new Error(`only ${rows.length} row(s) returned (min ${MIN_ROWS}) — refusing to publish`);
  }
  const lean = toIndex(rows);
  writeFileSync(dst, JSON.stringify(lean), "utf8");
  console.log(
    `[derive-graph-index] ${Object.keys(lean).length} entries from wiki_pages -> ${mb(readFileSync(dst).length)}MB`,
  );
} catch (e) {
  // Transitional fallback: while ContentIndex is still enabled its output is
  // on disk, so a DB blip degrades to the old behaviour instead of blocking
  // the publish. Once the emitter is off this branch simply cannot fire.
  if (existsSync(legacy)) {
    console.error(`[derive-graph-index] DB read failed (${e?.message || e}) — falling back to contentIndex.json`);
    try {
      const full = JSON.parse(readFileSync(legacy, "utf8"));
      const lean = {};
      for (const [slug, v] of Object.entries(full)) {
        lean[slug] = {
          slug: v.slug ?? slug,
          title: v.title,
          filePath: v.filePath,
          links: v.links ?? [],
          tags: v.tags ?? [],
          ...(v.date ? { date: v.date } : {}),
        };
      }
      writeFileSync(dst, JSON.stringify(lean), "utf8");
      console.log(`[derive-graph-index] ${Object.keys(lean).length} entries (legacy fallback)`);
      process.exit(0);
    } catch (e2) {
      console.error(`[derive-graph-index] legacy fallback also failed: ${e2?.message || e2}`);
    }
  }
  console.error(`[derive-graph-index] FAILED: ${e?.message || e} — snapshot will be discarded`);
  process.exit(1);
}
