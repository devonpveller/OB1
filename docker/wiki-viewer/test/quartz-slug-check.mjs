#!/usr/bin/env node
/**
 * quartz-slug-check - rw-p1a-deploy-prep (NA4-1): for EVERY page file in the
 * vault, the URL the shared rule gives its row (recipes/_shared/quartz-slug.mjs
 * urlSlugOf) must equal the slug QUARTZ'S OWN CODE gives the file (the
 * image's quartz/util/path.ts slugifyFilePath, bundled with the image's
 * esbuild), and the built snapshot must hold that page (<slug>.html). Also:
 * every file the walk excludes (private/, templates/, dot entries) has NO
 * built page - the walk is Quartz's page set.
 *
 *   node quartz-slug-check.mjs [--vault /wiki] [--built /srv/current]
 * Runs in the viewer image (the OB1 tree at /ob1). Exit 1 on any mismatch.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const VAULT = arg("--vault", "/wiki");
const BUILT = arg("--built", "/srv/current");
const { build } = await import("/quartz/node_modules/esbuild/lib/main.js");
await build({ entryPoints: ["/quartz/quartz/util/path.ts"], bundle: true, format: "esm", platform: "node", outfile: "/tmp/quartz-path.bundle.mjs", logLevel: "error" });
const quartz = await import("/tmp/quartz-path.bundle.mjs");
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
let skipped = 0;
for (const rel of all.filter((r) => !isPagePath(r)).sort()) {
  skipped++;
  const built = existsSync(join(BUILT, `${quartz.slugifyFilePath(rel)}.html`));
  if (built) bad++;
  console.log(`${built ? "BAD " : "ok  "} not a page: ${JSON.stringify(rel)} built=${built ? "YES" : "no"}`);
}
console.log(bad ? `QUARTZ-SLUG-CHECK: FAIL (${bad})` :
  `QUARTZ-SLUG-CHECK: PASS (${pages.length} pages: shared urlSlugOf = Quartz slugifyFilePath, each built; ${skipped} non-pages, none built)`);
process.exitCode = bad ? 1 : 0;
