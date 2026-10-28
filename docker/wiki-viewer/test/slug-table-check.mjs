#!/usr/bin/env node
/**
 * slug-table-check - rw-p1a-deploy-prep (NA4-1), rewritten for rw-p1c-retire2
 * (the Quartz freeze tool is gone): for EVERY .md file of the env's vault, the
 * shared rule (recipes/_shared/quartz-slug.mjs urlSlugOf / isPagePath, and the
 * reconciler's walkVault) must equal QUARTZ'S OWN answer, as recorded ONCE in
 * test/fixtures/quartz-slug-table.json (Quartz v4.5.1 path.ts slugifyFilePath
 * + glob.ts with quartz.config.ts ignorePatterns, emitted by the freeze tool
 * at OB1 5dfa57b before it was deleted). The table and the vault must list
 * the same files (a new fixture file needs a table row: there is no Quartz
 * left to ask), each page must be built in the committed parity reference
 * (<slug>.html), and no non-page may be.
 *
 *   node slug-table-check.mjs [--vault /wiki] [--built /ref]
 * Runs in the viewer image (the OB1 tree at /ob1). Exit 1 on any mismatch.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const VAULT = arg("--vault", "/wiki");
const BUILT = arg("--built", "/ref");
const table = JSON.parse(readFileSync(new URL("./fixtures/quartz-slug-table.json", import.meta.url), "utf8")).files;
const byPath = new Map(table.map((r) => [r.path, r]));
const { urlSlugOf, isPagePath } = await import("/ob1/recipes/_shared/quartz-slug.mjs");
const { walkVault } = await import("/ob1/recipes/_shared/reconcile-wiki-pages.mjs");

let bad = 0;
const all = [];
(function walk(d, r = "") {
  for (const n of readdirSync(d)) {
    const rel = r ? `${r}/${n}` : n;
    if (n === ".git") continue;
    if (statSync(join(d, n)).isDirectory()) walk(join(d, n), rel);
    else if (n.endsWith(".md")) all.push(rel);
  }
})(VAULT);
for (const rel of all.filter((r) => !byPath.has(r)).sort()) { bad++; console.log(`BAD  ${JSON.stringify(rel)} has no row in quartz-slug-table.json`); }
for (const rel of table.map((r) => r.path).filter((p) => !all.includes(p))) { bad++; console.log(`BAD  table row ${JSON.stringify(rel)} is not in the vault`); }
const pages = [];
for await (const rel of walkVault(VAULT)) pages.push(rel);
const walked = new Set(pages);
const quartzPages = table.filter((r) => r.quartzPage);
for (const r of quartzPages) if (!walked.has(r.path)) { bad++; console.log(`BAD  Quartz builds ${JSON.stringify(r.path)}, the walk skips it`); }
for (const rel of pages) if (!byPath.get(rel)?.quartzPage) { bad++; console.log(`BAD  the walk yields ${JSON.stringify(rel)}, Quartz skips it`); }
for (const rel of pages.sort()) {
  const q = byPath.get(rel)?.quartzSlug;
  const ours = urlSlugOf(rel.replace(/\.md$/, ""));
  const built = q !== undefined && existsSync(join(BUILT, `${q}.html`));
  const ok = q === ours && built;
  if (!ok) bad++;
  if (!ok || rel !== `${q}.md`) console.log(`${ok ? "ok  " : "BAD "} ${JSON.stringify(rel)} quartz=${q} shared=${ours} built=${built ? "yes" : "NO"}`);
}
for (const rel of all.sort()) {
  const r = byPath.get(rel);
  if (r && isPagePath(rel) !== r.quartzPage) { bad++; console.log(`BAD  isPagePath(${JSON.stringify(rel)})=${isPagePath(rel)}, Quartz glob: ${r.quartzPage}`); }
}
let skipped = 0;
for (const r of table.filter((x) => !x.quartzPage)) {
  skipped++;
  const built = existsSync(join(BUILT, `${r.quartzSlug}.html`));
  if (built) bad++;
  console.log(`${built ? "BAD " : "ok  "} not a page: ${JSON.stringify(r.path)} built=${built ? "YES" : "no"}`);
}
console.log(bad ? `QUARTZ-SLUG-CHECK: FAIL (${bad})` :
  `QUARTZ-SLUG-CHECK: PASS (${pages.length} pages = Quartz's glob (${quartzPages.length}, quartz-slug-table.json); shared urlSlugOf = Quartz slugifyFilePath, each built; ${skipped} non-pages, none built)`);
process.exitCode = bad ? 1 : 0;
