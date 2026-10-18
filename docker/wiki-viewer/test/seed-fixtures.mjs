#!/usr/bin/env node
/**
 * seed-fixtures - give the disposable rw-p1a-render database the wiki_pages
 * rows a compile would have written for the SYNTHETIC fixture vault.
 *
 * Runs inside the viewer image (p1a-env.sh seed): the OB1 tree is mounted at
 * /ob1, the vault copy at /wiki. Each row is produced by the COMPILE RULE
 * itself (parseWikiPage from recipes/_shared/wiki-pages.mjs, i.e. the page
 * class registry), so the fixture rows are exactly what compile writes - the
 * renderer is tested against compile's output, not a hand-written copy of it.
 *
 * Fails loudly (non-zero) if any row does not land. Never points anywhere but
 * OPEN_BRAIN_URL (the disposable rest on wt-rw-p1a-render-net).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWikiPage } from "/ob1/recipes/_shared/wiki-pages.mjs";

const VAULT = process.env.WIKI_GIT_DIR || "/wiki";
const OB = (process.env.OPEN_BRAIN_URL || "").replace(/\/+$/, "");
if (!/^wt-/.test(process.env.P1A_DISPOSABLE || "") || !OB) {
  console.error(`[seed] refusing: OPEN_BRAIN_URL=${OB || "(unset)"} is not the disposable rest`);
  process.exit(2);
}

async function* walk(abs, rel = "") {
  for (const e of await readdir(abs, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!e.name.startsWith(".")) yield* walk(join(abs, e.name), r); }
    else if (e.isFile() && e.name.endsWith(".md")) yield r;
  }
}

const rows = [];
for await (const rel of walk(VAULT)) {
  rows.push(parseWikiPage(rel, await readFile(join(VAULT, rel), "utf8")));
}
const now = new Date().toISOString();
const r = await fetch(`${OB}/rest/v1/wiki_pages?on_conflict=slug`, {
  method: "POST",
  headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify(rows.map((x) => ({ ...x, updated_at: now }))),
});
if (!r.ok) {
  console.error(`[seed] FAILED: ${r.status} ${(await r.text()).slice(0, 300)}`);
  process.exit(1);
}
const byClass = {};
for (const x of rows) byClass[x.page_class] = (byClass[x.page_class] || 0) + 1;
console.log(`[seed] ${rows.length} fixture row(s) upserted: ${JSON.stringify(byClass)}`);
