/**
 * links — PURE wikilink extraction, shared across runtimes.
 *
 * Lives alone (no env, no I/O, no deps), split out of wiki-pages.mjs because
 * that module reads process.env at load time. The Deno workbench keeps a
 * DELIBERATE MIRROR of this function (docker/workbench/src/util/notes-parse.ts)
 * rather than importing across the /recipes runtime mount — its image-build
 * test gate cannot see this file. Both copies are unit-tested with the same
 * cases; change one, change both.
 */

// Raw [[wikilink]] targets from a markdown body: alias and #anchor stripped,
// de-duplicated, order preserved. Targets are returned AS WRITTEN — resolution
// to full slugs is the caller's job (the workbench resolves against
// wiki_pages; generated content pages already write full-path links).
export function extractLinks(body) {
  const out = [];
  const seen = new Set();
  for (const m of String(body || "").matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split("|")[0].split("#")[0].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}
