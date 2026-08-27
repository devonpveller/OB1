// Build-time patch: route BASIC search at the DB-backed endpoint (Phase D).
//
// The viewer used to ship the full text of every page to the browser and match
// it with client-side FlexSearch. `/workbench/search` ranks the same corpus in
// Postgres (weighted tsvector, ~180ms end-to-end) with no payload at all.
//
// Scope is deliberately narrow: only the `basic` branch is redirected. TAG
// search keeps using the local index, and ANY failure falls through to it, so
// search can never be worse than before this patch.
//
// A SCRIPT, not a sed: the insertion is multi-line with braces, quotes and
// regex literals. An earlier sed attempt injected a stray control character
// and broke esbuild for the whole site (2026-08-26). Anchor-asserted and
// verified after write, so a QUARTZ_REF bump fails the build loudly.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "/quartz/quartz/components/scripts/search.inline.ts";

const FROM = `    } else if (searchType === "basic") {
      searchResults = await index.searchAsync({
        query: currentSearchTerm,
        limit: numSearchResults,
        index: ["title", "content"],
      })
    }`;

// Highlights arrive as inert <<HL>> markers: page bodies can contain raw
// markup, so we escape FIRST and only then swap the markers for <b>.
const TO = `    } else if (searchType === "basic") {
      const apiResults = await (async () => {
        try {
          const resp = await fetch(
            "/workbench/search?q=" + encodeURIComponent(currentSearchTerm) +
              "&limit=" + numSearchResults,
            { cache: "no-store" },
          )
          if (!resp.ok) return null
          const payload = await resp.json()
          return Array.isArray(payload.results) ? payload.results : null
        } catch {
          return null
        }
      })()
      if (apiResults) {
        const escapeHtml = (value: string) =>
          String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
        const withHighlights = (value: string) =>
          escapeHtml(value)
            .split("&lt;&lt;HL&gt;&gt;")
            .join("<b>")
            .split("&lt;&lt;/HL&gt;&gt;")
            .join("</b>")
        await displayResults(
          apiResults.map((hit: any, i: number) => ({
            id: -1 - i,
            slug: hit.slug,
            title: escapeHtml(hit.title),
            content: withHighlights(hit.content),
            tags: [],
          })),
        )
        return
      }
      searchResults = await index.searchAsync({
        query: currentSearchTerm,
        limit: numSearchResults,
        index: ["title", "content"],
      })
    }`;

const src = readFileSync(FILE, "utf8");
if (src.includes("/workbench/search?q=")) {
  console.log("[search-api] already applied");
  process.exit(0);
}
const count = src.split(FROM).length - 1;
if (count !== 1) {
  console.error(`[search-api] anchor found ${count} times (expected 1) in ${FILE}`);
  process.exit(1);
}
const out = src.replace(FROM, TO);
writeFileSync(FILE, out, "utf8");
const check = readFileSync(FILE, "utf8");
if (!check.includes("/workbench/search?q=") || /[\u0000-\u0008]/.test(check)) {
  console.error("[search-api] verification failed (missing call or control char)");
  process.exit(1);
}
console.log("[search-api] applied: basic search now queries the database");
