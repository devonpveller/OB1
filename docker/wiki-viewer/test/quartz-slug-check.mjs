#!/usr/bin/env node
/**
 * quartz-slug-check - rw-p1a-deploy-prep (NA4-1): for EVERY page file in the
 * vault, the URL the shared rule gives its row (recipes/_shared/quartz-slug.mjs
 * urlSlugOf) must equal the slug QUARTZ'S OWN CODE gives the file (the
 * image's quartz/util/path.ts slugifyFilePath, bundled with the image's
 * esbuild), and the built snapshot must hold that page (<slug>.html). Also:
 * every file the walk excludes (private/, templates/, dot entries) has NO
 * built page - the walk is Quartz's page set.
 * rw-p1a-deploy-prep attempt 2 (tester: the page-set check took the shared
 * rule's view of which files are pages): the page set is now QUARTZ'S OWN -
 * the image's quartz/util/glob.ts glob() with quartz.config.ts's
 * ignorePatterns over the same vault - and the walk, and isPagePath() on
 * every .md file, must equal it exactly (a backslash name included).
 *
 *   node quartz-slug-check.mjs [--vault /wiki] [--built /srv/current]
 * Runs in the viewer image (the OB1 tree at /ob1). Exit 1 on any mismatch.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const VAULT = arg("--vault", "/wiki");
const BUILT = arg("--built", "/srv/current");
const { build } = await import("/quartz/node_modules/esbuild/lib/main.js");
await build({ entryPoints: ["/quartz/quartz/util/path.ts"], bundle: true, format: "esm", platform: "node", outfile: "/tmp/quartz-path.bundle.mjs", logLevel: "error" });
const quartz = await import("/tmp/quartz-path.bundle.mjs");
// Quartz's own page set: glob.ts bundled with its packages left external, next
// to /quartz/node_modules so it resolves the image's globby.
await build({ entryPoints: ["/quartz/quartz/util/glob.ts"], bundle: true, format: "esm", platform: "node", packages: "external", outfile: "/quartz/.slug-check-glob.bundle.mjs", logLevel: "error" });
const { glob } = await import("/quartz/.slug-check-glob.bundle.mjs");
const cfg = readFileSync("/quartz/quartz.config.ts", "utf8");
const ignorePatterns = JSON.parse((/ignorePatterns:\s*(\[[^\]]*\])/.exec(cfg) || [])[1] || "null");
if (!Array.isArray(ignorePatterns)) { console.log("QUARTZ-SLUG-CHECK: FAIL (ignorePatterns not found in quartz.config.ts)"); process.exit(1); }
const quartzPages = new Set(await glob("**/*.md", VAULT, ignorePatterns));
const { urlSlugOf, isPagePath } = await import("/ob1/recipes/_shared/quartz-slug.mjs");
const { walkVault } = await import("/ob1/recipes/_shared/reconcile-wiki-pages.mjs");

let bad = 0;
const pages = [];
for await (const rel of walkVault(VAULT)) pages.push(rel);
for (const rel of pages.sort()) {
  const q = quartz.slugifyFilePath(rel);
  const ours = urlSlugOf(rel.replace(/\.md$/, ""));
  const built = existsSync(join(BUILT, `${q}.html`));
  const ok = q === ours && built;
  if (!ok) bad++;
  if (!ok || rel !== `${q}.md`) {
    console.log(`${ok ? "ok  " : "BAD "} ${JSON.stringify(rel)} quartz=${q} shared=${ours} built=${built ? "yes" : "NO"}`);
  }
}
// every .md the walk skips: Quartz built nothing for it
const all = [];
(function walk(d, r = "") {
  for (const n of readdirSync(d)) {
    const rel = r ? `${r}/${n}` : n;
    if (n === ".git") continue;
    if (statSync(join(d, n)).isDirectory()) walk(join(d, n), rel);
    else if (n.endsWith(".md")) all.push(rel);
  }
})(VAULT);
// the page set: the walk = Quartz's glob, and the shared predicate agrees with
// Quartz on every .md file in the vault
const walked = new Set(pages);
for (const rel of [...quartzPages].filter((r) => !walked.has(r)).sort()) { bad++; console.log(`BAD  Quartz builds ${JSON.stringify(rel)}, the walk skips it`); }
for (const rel of pages.filter((r) => !quartzPages.has(r))) { bad++; console.log(`BAD  the walk yields ${JSON.stringify(rel)}, Quartz skips it`); }
for (const rel of all.sort()) {
  if (isPagePath(rel) !== quartzPages.has(rel)) { bad++; console.log(`BAD  isPagePath(${JSON.stringify(rel)})=${isPagePath(rel)}, Quartz glob: ${quartzPages.has(rel)}`); }
}
let skipped = 0;
for (const rel of all.filter((r) => !isPagePath(r)).sort()) {
  skipped++;
  const built = existsSync(join(BUILT, `${quartz.slugifyFilePath(rel)}.html`));
  if (built) bad++;
  console.log(`${built ? "BAD " : "ok  "} not a page: ${JSON.stringify(rel)} built=${built ? "YES" : "no"}`);
}
console.log(bad ? `QUARTZ-SLUG-CHECK: FAIL (${bad})` :
  `QUARTZ-SLUG-CHECK: PASS (${pages.length} pages = Quartz's glob (${quartzPages.size}); shared urlSlugOf = Quartz slugifyFilePath, each built; ${skipped} non-pages, none built)`);
process.exitCode = bad ? 1 : 0;
