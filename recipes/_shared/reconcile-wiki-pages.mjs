#!/usr/bin/env node
/**
 * reconcile-wiki-pages - measure (and repair) drift between the vault's files
 * and the wiki_pages rows (research-workbench D13 item 4).
 *
 * Drift, per page_class (the value the page-class registry's compile rule
 * writes):
 *   missing  a file with no row          (a failed or skipped compile)
 *   stale    a row older than its file   (D13 item 5: stale is a miss), or a
 *            row dated in the FUTURE (beyond RECONCILE_FUTURE_MS): its time
 *            cannot show that a newer file replaced it, so it is not trusted
 *            (these are also listed under `future`)
 *   empty    a row with an empty body that is not a folder/tag index (an
 *            empty leaf is never a presentable page)
 *   orphan   a row with no file          (a sweep whose delete did not land)
 *   failed   an OPEN structural compile failure (structural-ledger.mjs): the
 *            page stays pending and is listed here until it is fixed (D13
 *            item 6)
 * Non-zero drift is red and names the slugs. rowState() is the same rule the
 * live renderer applies to one row (stale / future / empty are pending there,
 * never presented as-is).
 *
 * Three callers, one implementation:
 *   - after each compile (wiki-service)                 check
 *   - as a health probe (the viewer's /__health)       check
 *   - on (re)connect to the database (the viewer)      repair: every missing,
 *     stale or empty row whose file exists gets its row written now - the
 *     single-slug form of backfill-wiki-pages.mjs; a NOTE keeps its links
 *     resolved the way the workbench resolves them at save (exact slug, else
 *     the one slug ending in "/<target>", else the raw target). Orphans and
 *     open structural failures are reported, never repaired here (deleting is
 *     the sweeps' job; a structural failure needs a patch or new inputs).
 *
 * CLI (inside a container with the vault + OPEN_BRAIN_URL):
 *   node reconcile-wiki-pages.mjs [--repair] [--json] [--vault /wiki]
 * Exit: 0 = no drift (after repair, if --repair), 1 = drift, 2 = cannot check
 * (database or vault unreadable - never reported as "clean").
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWikiPage, upsertWikiPages } from "./wiki-pages.mjs";
import { listOpen, STRUCTURAL_FILE } from "./structural-ledger.mjs";

const OB_URL = () => (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const SKEW_MS = () => Math.max(0, Number(process.env.RECONCILE_SKEW_MS || "2000"));
const FUTURE_MS = () => Math.max(0, Number(process.env.RECONCILE_FUTURE_MS || "60000"));
const SKIP_DIRS = new Set([".git", ".quartz-cache", "public", "node_modules", "assets", ".obsidian", "private", "templates"]);

// A folder or tag index may legitimately have no body (Quartz then shows the
// listing alone); every other page with an empty body is an empty leaf.
export const emptyAllowed = (slug) => slug === "index" || slug.endsWith("/index") || slug.startsWith("tags/");
const isBlank = (body) => !String(body ?? "").trim();

/**
 * PURE: is this row presentable as-is? Returns null when it is, else why it is
 * a miss: "stale" (older than its file, or no valid date), "future" (dated
 * beyond now + RECONCILE_FUTURE_MS: its time cannot be compared with the
 * file's), "empty" (an empty body where one is required). `fileMtimeMs` is
 * null when the row has no file (an orphan, reported separately). `row.empty`
 * (set by listRows from a body filter) stands in for row.body.
 */
export function rowState(row, fileMtimeMs, { now = Date.now(), allowEmpty = emptyAllowed(String(row.slug || "")) } = {}) {
  const blank = row.empty === true || (row.empty === undefined && "body" in row && isBlank(row.body));
  if (!allowEmpty && blank) return "empty";
  const rowMs = Date.parse(row.updated_at);
  if (!Number.isFinite(rowMs)) return "stale";
  if (rowMs > now + FUTURE_MS()) return "future";
  if (fileMtimeMs != null && rowMs + SKEW_MS() < fileMtimeMs) return "stale";
  return null;
}

async function* walk(absDir, relDir = "") {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (e) {
    if (!relDir) throw e; // the vault root itself is unreadable: cannot check
    return;
  }
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      yield* walk(join(absDir, e.name), rel);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      yield rel;
    }
  }
}

export async function listFiles(vault) {
  const files = new Map(); // slug -> { rel, mtimeMs }
  for await (const rel of walk(vault)) {
    try {
      const st = await stat(join(vault, rel));
      files.set(rel.replace(/\.md$/i, ""), { rel, mtimeMs: st.mtimeMs });
    } catch { /* vanished mid-walk: a sweep; not drift */ }
  }
  return files;
}

async function keysetWalk(fetchImpl, select, extra, onPage) {
  let cursor = null;
  for (;;) {
    const q = [`select=${select}`, "order=slug.asc", "limit=5000", ...extra];
    if (cursor) q.push(`slug=gt.${encodeURIComponent(cursor)}`);
    const r = await fetchImpl(`${OB_URL()}/rest/v1/wiki_pages?${q.join("&")}`, {
      headers: { apikey: "local-trust" }, signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`wiki_pages ${r.status} ${(await r.text()).slice(0, 160)}`);
    const page = await r.json();
    if (!Array.isArray(page) || page.length === 0) break;
    onPage(page);
    cursor = page[page.length - 1].slug;
    if (page.length < 5000) break;
  }
}

// Keyset walk of every row's (slug, page_class, updated_at), plus which rows
// have an empty body (a regex filter - `match` is PostgREST's ~ - instead of
// reading every body). Throws when the database does not answer: the caller
// must never read that as "no rows".
export async function listRows(fetchImpl = fetch) {
  const rows = new Map();
  await keysetWalk(fetchImpl, "slug,page_class,updated_at,links", [], (page) => {
    for (const x of page) rows.set(x.slug, { ...x, empty: false });
  });
  await keysetWalk(fetchImpl, "slug", [`body=match.${encodeURIComponent("^[[:space:]]*$")}`], (page) => {
    for (const x of page) if (rows.has(x.slug)) rows.get(x.slug).empty = true;
  });
  return rows;
}

/**
 * PURE: files + rows (+ the open structural failures) -> the drift report.
 * failed: [{ slug, ... }] from structural-ledger listOpen().
 */
export function diffFilesRows(files, rows, classOf, { failed = [], now = Date.now() } = {}) {
  const byClass = {};
  const bucket = (c) => (byClass[c] ??= { files: 0, rows: 0, missing: [], stale: [], empty: [], orphan: [], failed: [] });
  const future = [];
  for (const [slug, f] of files) {
    const b = bucket(classOf(f.rel));
    b.files++;
    const row = rows.get(slug);
    if (!row) { b.missing.push(slug); continue; }
    const st = rowState(row, f.mtimeMs, { now });
    if (st === "stale" || st === "future") b.stale.push(slug);
    if (st === "future") future.push(slug);
    if (st === "empty") b.empty.push(slug);
  }
  for (const [slug, row] of rows) {
    const b = bucket(row.page_class || "root");
    b.rows++;
    if (files.has(slug)) continue;
    b.orphan.push(slug);
    // An orphan has no file to compare with; a future date or an empty body
    // is still drift on top of the orphan.
    const st = rowState(row, null, { now });
    if (st === "future") { b.stale.push(slug); future.push(slug); }
    if (st === "empty") b.empty.push(slug);
  }
  for (const f of failed) {
    if (f && f.slug) bucket(classOf(`${f.slug}.md`)).failed.push(f.slug);
  }
  const all = (k) => Object.values(byClass).flatMap((b) => b[k]).sort();
  const missing = all("missing");
  const stale = all("stale");
  const empty = all("empty");
  const orphan = all("orphan");
  const failedSlugs = all("failed");
  return {
    files: files.size, rows: rows.size, byClass, missing, stale, future: future.sort(), empty, orphan, failed: failedSlugs,
    drift: missing.length + stale.length + empty.length + orphan.length + failedSlugs.length,
  };
}

// The workbench's note-link resolution (repositories/notes.ts resolveLinks):
// exact slug, else the single slug ending in "/<target>", else raw.
export function resolveNoteLinks(links, slugs) {
  const set = slugs instanceof Set ? slugs : new Set(slugs);
  return links.map((t) => {
    if (set.has(t)) return t;
    const hits = [];
    for (const s of set) if (s.endsWith("/" + t)) { hits.push(s); if (hits.length > 1) break; }
    return hits.length === 1 ? hits[0] : t;
  });
}

// The open structural failures of the vault's compile (its out-dir is
// <vault>/content; WIKI_STRUCTURAL_FILE overrides, as it does for the compile).
export function structuralFileFor(vault) {
  return process.env.WIKI_STRUCTURAL_FILE || join(vault, "content", STRUCTURAL_FILE);
}

/**
 * Check (and with repair:true, repair) a vault against the table.
 * Returns the report; with repair, `repaired` lists the slugs whose row was
 * written and the report is re-measured afterwards (`after`).
 */
export async function reconcile({ vault = process.env.WIKI_GIT_DIR || "/wiki", repair = false, log = console.log, classOf, structuralFile } = {}) {
  const { classify } = await import("./page-classes.mjs");
  const cls = classOf || ((rel) => classify(rel).page_class);
  const files = await listFiles(vault);
  const rows = await listRows();
  const failed = listOpen(null, structuralFile || structuralFileFor(vault));
  const report = diffFilesRows(files, rows, cls, { failed });
  report.checkedAt = new Date().toISOString();
  // What a file can fix: a missing, stale / future-dated or empty row whose
  // file exists. Orphans and open structural failures are only reported.
  const todo = [...new Set([...report.missing, ...report.stale, ...report.empty])].filter((s) => files.has(s));
  if (!repair || !todo.length) return report;
  const slugs = new Set([...rows.keys(), ...files.keys()]);
  const batch = [];
  const repaired = [];
  const failedWrites = [];
  for (const slug of todo) {
    const f = files.get(slug);
    let md;
    try { md = await readFile(join(vault, f.rel), "utf8"); } catch { continue; }
    const row = parseWikiPage(f.rel, md);
    if (row.page_class === "note") row.links = resolveNoteLinks(row.links, slugs);
    batch.push(row);
  }
  for (let i = 0; i < batch.length; i += 200) {
    const part = batch.slice(i, i + 200);
    try {
      await upsertWikiPages(part);
      repaired.push(...part.map((r) => r.slug));
    } catch (e) {
      failedWrites.push(...part.map((r) => ({ slug: r.slug, error: String(e?.message || e) })));
    }
  }
  log(`[reconcile] repair pass: ${repaired.length} row(s) written (${report.missing.length} missing, ${report.stale.length} stale, ${report.empty.length} empty)` +
    (failedWrites.length ? `, ${failedWrites.length} FAILED (first ${failedWrites[0].slug}: ${failedWrites[0].error})` : "") +
    (repaired.length ? `; first: ${repaired.slice(0, 5).join(", ")}` : ""));
  const after = diffFilesRows(files, await listRows(), cls, { failed });
  return { ...report, repaired, repairFailed: failedWrites, after };
}

export function formatReport(r) {
  const lines = [];
  const red = r.drift > 0;
  lines.push(`[reconcile] ${red ? "DRIFT" : "clean"}: ${r.files} file(s), ${r.rows} row(s); ${r.missing.length} missing, ` +
    `${r.stale.length} stale, ${r.empty.length} empty, ${r.orphan.length} orphan, ${r.failed.length} failed`);
  for (const [c, b] of Object.entries(r.byClass).sort()) {
    lines.push(`[reconcile]   ${c}: files=${b.files} rows=${b.rows} missing=${b.missing.length} stale=${b.stale.length} ` +
      `empty=${b.empty.length} orphan=${b.orphan.length} failed=${b.failed.length}`);
  }
  for (const k of ["missing", "stale", "future", "empty", "orphan", "failed"]) {
    if (r[k]?.length) lines.push(`[reconcile]   ${k}: ${r[k].slice(0, 20).join(", ")}${r[k].length > 20 ? ` (+${r[k].length - 20} more)` : ""}`);
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  const vi = args.indexOf("--vault");
  const vault = vi >= 0 ? args[vi + 1] : undefined;
  reconcile({ vault, repair: args.includes("--repair") })
    .then((r) => {
      const final = r.after || r;
      if (args.includes("--json")) console.log(JSON.stringify(r));
      else {
        console.log(formatReport(r));
        if (r.after) console.log(formatReport(r.after).replace(/\[reconcile\]/g, "[reconcile:after-repair]"));
      }
      process.exitCode = final.drift > 0 ? 1 : 0;
    })
    .catch((e) => {
      console.error(`[reconcile] CANNOT CHECK: ${e?.message || e}`);
      process.exitCode = 2;
    });
}
