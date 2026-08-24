// Derive the lean graph/explorer index from Quartz's full contentIndex.
//
//   node /derive-graph-index.mjs <siteDir>
//
// Quartz's ContentIndex emitter writes ONE static/contentIndex.json carrying
// the FULL text of every page (measured 2026-08-23: 45MB for ~15k pages, 83%
// of it page `content`) — and the graph, the explorer AND search all load it
// on every page visit. The graph/explorer only need slug→{title, filePath,
// links, tags, date}, so the entrypoint derives static/graphIndex.json at
// publish time (no Quartz patch needed) and the head `fetchData` script is
// repointed at it; search lazily fetches the full contentIndex only when a
// search is actually opened.
//
// Runs on the immutable snapshot copy BEFORE the atomic swap, so the derived
// file can never be torn by a concurrent rebuild.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const siteDir = process.argv[2];
if (!siteDir) {
  console.error("usage: derive-graph-index.mjs <siteDir>");
  process.exit(2);
}

const src = join(siteDir, "static", "contentIndex.json");
const dst = join(siteDir, "static", "graphIndex.json");

const full = JSON.parse(readFileSync(src, "utf8"));
const lean = {};
for (const [slug, e] of Object.entries(full)) {
  lean[slug] = {
    // slug is REQUIRED inside the value too: the Explorer's FileTrieNode.add
    // does `file.slug.split("/")` (fileTrie.ts:89) — omitting it crashed the
    // Explorer on every page load (found via headless browser 2026-08-24).
    slug: e.slug ?? slug,
    title: e.title,
    filePath: e.filePath,
    links: e.links ?? [],
    tags: e.tags ?? [],
    ...(e.date ? { date: e.date } : {}),
  };
}
writeFileSync(dst, JSON.stringify(lean), "utf8");
const mb = (n) => (n / 1048576).toFixed(1);
console.log(
  `[derive-graph-index] ${Object.keys(lean).length} entries: ` +
    `${mb(readFileSync(src).length)}MB → ${mb(readFileSync(dst).length)}MB`,
);
