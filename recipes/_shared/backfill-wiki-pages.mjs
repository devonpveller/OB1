#!/usr/bin/env node
/**
 * backfill-wiki-pages — (re)build the `wiki_pages` table from the vault.
 *
 * The table is DERIVED data: the markdown on disk is the source of truth.
 * This walks the vault and upserts a row per page, so the table can be
 * rebuilt at any time — after the initial migration, after a sync outage, or
 * whenever the per-compile reconciliation count reports drift.
 *
 * Idempotent (upsert on slug) and resumable (re-running simply rewrites the
 * same rows). Safe to run while the compiler is working: a page written
 * mid-walk is either picked up here or by its own writer's sync.
 *
 * Usage (inside openbrain-wiki, which has the vault + OPEN_BRAIN_URL):
 *   node /recipes/_shared/backfill-wiki-pages.mjs [--dry-run] [--prune]
 *
 *   --prune  also DELETE rows whose page no longer exists on disk. Off by
 *            default: deleting is the sweeps' job, and a half-finished walk
 *            must never be able to empty the table.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { upsertWikiPages, parseWikiPage, countWikiPages } from "./wiki-pages.mjs";

const VAULT = process.env.WIKI_GIT_DIR || "/wiki";
const DRY = process.argv.includes("--dry-run");
const PRUNE = process.argv.includes("--prune");
const BATCH = Math.max(1, Number(process.env.BACKFILL_BATCH || "200"));

// Directories that are not vault content: git internals, build caches, the
// binary assets volume, and Quartz's own output.
const SKIP_DIRS = new Set([".git", ".quartz-cache", "public", "node_modules", "assets", ".obsidian"]);

async function* walk(absDir, relDir = "") {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(absDir, e.name), rel);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      yield rel;
    }
  }
}

const main = async () => {
  const before = await countWikiPages();
  console.log(`[backfill] vault=${VAULT} rows_before=${before ?? "unknown"}${DRY ? " (DRY RUN)" : ""}`);
  let seen = 0;
  let sent = 0;
  let failed = 0;
  const onDisk = [];
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    if (!DRY) {
      const ok = await upsertWikiPages(batch);
      if (ok) sent += batch.length;
      else failed += batch.length;
    }
    batch = [];
    if (seen % 2000 < BATCH) console.log(`[backfill] ${seen} pages walked, ${sent} upserted, ${failed} failed`);
  };

  for await (const rel of walk(VAULT)) {
    seen++;
    let md = "";
    try {
      md = await readFile(join(VAULT, rel), "utf8");
    } catch {
      continue; // vanished mid-walk (a sweep) — its row is the sweep's problem
    }
    const row = parseWikiPage(rel, md);
    onDisk.push(row.slug);
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const after = await countWikiPages();
  console.log(`[backfill] done: walked=${seen} upserted=${sent} failed=${failed} rows_after=${after ?? "unknown"}`);

  if (PRUNE && !DRY) {
    // Guard: never prune off a walk that clearly under-counted (an aborted or
    // permission-broken walk must not empty the table).
    if (seen < 100) {
      console.error(`[backfill] refusing to prune: only ${seen} pages walked (looks truncated)`);
      return;
    }
    const { deleteWikiPages } = await import("./wiki-pages.mjs");
    const keep = new Set(onDisk);
    const r = await fetch(
      `${(process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "")}/rest/v1/wiki_pages?select=slug`,
      { headers: { apikey: "local-trust" } },
    );
    const rows = await r.json();
    const stale = rows.map((x) => x.slug).filter((s) => !keep.has(s));
    if (stale.length) {
      await deleteWikiPages(stale);
      console.log(`[backfill] pruned ${stale.length} row(s) with no page on disk`);
    } else {
      console.log("[backfill] no stale rows");
    }
  }
};

main().catch((e) => {
  console.error("[backfill] FAILED:", e?.message || e);
  process.exit(1);
});
