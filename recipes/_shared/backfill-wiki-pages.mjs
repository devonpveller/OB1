#!/usr/bin/env node
/**
 * backfill-wiki-pages — (re)build the `wiki_pages` table from the vault.
 *
 * The one-time FULL backfill (research-workbench D13 item 4: precedes P1b).
 * Since D13 the row is what the viewer presents and compile owns both file
 * and row; day-to-day drift is measured and repaired slug by slug by
 * reconcile-wiki-pages.mjs (after each compile, as the viewer's health probe,
 * and as its repair pass on (re)connect). This walks the vault and upserts a
 * row for EVERY page, so rows written before the frontmatter column existed
 * get it.
 *
 * Which files (rw-p1a-deploy-prep, RV-1): the reconciliation's own walk
 * (reconcile-wiki-pages.mjs walkVault - Quartz's page set: no private/ or
 * templates/ at the vault root, no dot-directory or dot-file, no non-content
 * directory, .md only). A file the walk excludes never gets a row.
 *
 * Notes are NOT excluded; they are written exactly as the repair pass writes
 * them (reconcile-wiki-pages.mjs rowFromFile): the compile rule, and the
 * note's [[links]] resolved the way the workbench resolves them at save
 * (resolveNoteLinks: exact slug, else the one slug ending in "/<target>",
 * else the raw target) against every row slug and every file slug. A raw
 * link target in a note row is the 2026-08-31 graph regression (journal note
 * wiki-pages-extractlinks-outage-2026-08-31.md section 3); a row written here
 * never carries one the repair pass would have resolved. The row slugs are
 * read first: a database that does not answer stops the run (exit 2) before
 * anything is written - resolving against the files alone could differ from
 * the repair pass.
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
 *            must never be able to empty the table (a walk of fewer than
 *            BACKFILL_PRUNE_MIN pages, default 100, refuses to prune). A row
 *            whose path the walk EXCLUDES (private/, templates/, a
 *            dot-directory, ...) is never pruned: it is listed for the
 *            operator, who decides.
 * Exit: 0 = every row landed; 1 = a batch failed; 2 = cannot run (the
 * database's row list or the vault root is unreadable).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { upsertWikiPages, countWikiPages, deleteWikiPages } from "./wiki-pages.mjs";
import { walkVault, listRows, rowFromFile } from "./reconcile-wiki-pages.mjs";
import { isPagePath } from "./quartz-slug.mjs";

export async function backfill({
  vault = process.env.WIKI_GIT_DIR || "/wiki",
  dry = false,
  prune = false,
  batchSize = Math.max(1, Number(process.env.BACKFILL_BATCH || "200")),
  pruneMin = Math.max(1, Number(process.env.BACKFILL_PRUNE_MIN || "100")),
  log = console.log,
  logErr = console.error,
} = {}) {
  const before = await countWikiPages();
  log(`[backfill] vault=${vault} rows_before=${before ?? "unknown"}${dry ? " (DRY RUN)" : ""}`);

  // 1. Every page path the walk yields (the slug set note links resolve against).
  const rels = [];
  try {
    for await (const rel of walkVault(vault)) rels.push(rel);
  } catch (e) {
    logErr(`[backfill] CANNOT RUN: the vault ${vault} is unreadable: ${e?.message || e}`);
    return { exitCode: 2 };
  }
  // 2. Every row slug, as the repair pass sees them.
  let rows;
  try {
    rows = await listRows();
  } catch (e) {
    logErr(`[backfill] CANNOT RUN: the row list could not be read (${e?.message || e}); nothing written`);
    return { exitCode: 2 };
  }
  const fileSlugs = rels.map((r) => r.replace(/\.md$/i, ""));
  const slugs = new Set([...rows.keys(), ...fileSlugs]);

  let seen = 0;
  let sent = 0;
  let failed = 0;
  let notes = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    if (!dry) {
      try {
        await upsertWikiPages(batch);
        sent += batch.length;
      } catch (e) {
        failed += batch.length;
        logErr(`[backfill] batch of ${batch.length} FAILED (first ${batch[0]?.slug}): ${e?.message || e}`);
      }
    }
    batch = [];
    if (seen % 2000 < batchSize) log(`[backfill] ${seen} pages walked, ${sent} upserted, ${failed} failed`);
  };
  for (const rel of rels) {
    let md;
    try {
      md = await readFile(join(vault, rel), "utf8");
    } catch {
      continue; // vanished mid-walk (a sweep) - its row is the sweep's problem
    }
    seen++;
    const row = rowFromFile(rel, md, slugs);
    if (row.page_class === "note") notes++;
    batch.push(row);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  const after = await countWikiPages();
  log(`[backfill] done: walked=${seen} upserted=${sent} failed=${failed} (notes=${notes}, links resolved as the repair pass) rows_after=${after ?? "unknown"}`);
  let exitCode = failed ? 1 : 0; // rows that did not land are a failure, never a clean run (D13)

  // Rows whose path the walk excludes: never pruned, always named.
  const excluded = [...rows.keys()].filter((s) => !isPagePath(`${s}.md`)).sort();
  if (excluded.length) {
    log(`[backfill] ${excluded.length} row(s) for a path the walk EXCLUDES (kept; the operator decides): ` +
      `${excluded.slice(0, 10).join(", ")}${excluded.length > 10 ? ` (+${excluded.length - 10} more)` : ""}`);
  }
  if (prune && !dry) {
    // Guard: never prune off a walk that clearly under-counted (an aborted or
    // permission-broken walk must not empty the table).
    if (seen < pruneMin) {
      logErr(`[backfill] refusing to prune: only ${seen} pages walked (looks truncated; BACKFILL_PRUNE_MIN=${pruneMin})`);
      return { exitCode, seen, sent, failed, excluded };
    }
    const keep = new Set(fileSlugs);
    const stale = [...rows.keys()].filter((s) => !keep.has(s) && isPagePath(`${s}.md`));
    if (stale.length) {
      const ok = await deleteWikiPages(stale);
      log(`[backfill] pruned ${stale.length} row(s) with no page on disk${ok ? "" : " - the DELETE FAILED (the reconciliation names them)"}`);
      if (!ok) exitCode = 1;
    } else {
      log("[backfill] no stale rows");
    }
  }
  return { exitCode, seen, sent, failed, excluded };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  backfill({ dry: process.argv.includes("--dry-run"), prune: process.argv.includes("--prune") })
    .then((r) => { process.exitCode = r.exitCode; })
    .catch((e) => {
      console.error("[backfill] FAILED:", e?.message || e);
      process.exit(1);
    });
}
