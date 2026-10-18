#!/usr/bin/env node
/**
 * reconcile-wiki-pages - measure (and repair) drift between the vault's files
 * and the wiki_pages rows (research-workbench D13 item 4).
 *
 * Drift, per page_class (the value the page-class registry's compile rule
 * writes):
 *   missing  a file with no row          (a failed or skipped compile)
 *   stale    a row older than its file   (D13 item 5: stale is a miss)
 *   orphan   a row with no file          (a sweep whose delete did not land)
 * Non-zero drift is red and names the slugs.
 *
 * Three callers, one implementation:
 *   - after each compile (wiki-service)                 check
 *   - as a health probe (the viewer's /__health)       check
 *   - on (re)connect to the database (the viewer)      repair: every missing
 *     or stale file gets its row written now - the single-slug form of
 *     backfill-wiki-pages.mjs; a NOTE keeps its links resolved the way the
 *     workbench resolves them at save (exact slug, else the one slug ending
 *     in "/<target>", else the raw target). Orphans are reported, never
 *     deleted here (deleting is the sweeps' job).
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

const OB_URL = () => (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const SKEW_MS = () => Math.max(0, Number(process.env.RECONCILE_SKEW_MS || "2000"));
const SKIP_DIRS = new Set([".git", ".quartz-cache", "public", "node_modules", "assets", ".obsidian", "private", "templates"]);

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

// Keyset walk of every row's (slug, page_class, updated_at). Throws when the
// database does not answer - the caller must never read that as "no rows".
export async function listRows(fetchImpl = fetch) {
  const rows = new Map();
  let cursor = null;
  for (;;) {
    const q = ["select=slug,page_class,updated_at,links", "order=slug.asc", "limit=5000"];
    if (cursor) q.push(`slug=gt.${encodeURIComponent(cursor)}`);
    const r = await fetchImpl(`${OB_URL()}/rest/v1/wiki_pages?${q.join("&")}`, {
      headers: { apikey: "local-trust" }, signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`wiki_pages ${r.status} ${(await r.text()).slice(0, 160)}`);
    const page = await r.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const x of page) rows.set(x.slug, x);
    cursor = page[page.length - 1].slug;
    if (page.length < 5000) break;
  }
  return rows;
}

/** PURE: files + rows -> the drift report. */
export function diffFilesRows(files, rows, classOf) {
  const byClass = {};
  const bucket = (c) => (byClass[c] ??= { files: 0, rows: 0, missing: [], stale: [], orphan: [] });
  for (const [slug, f] of files) {
    const c = classOf(f.rel);
    const b = bucket(c);
    b.files++;
    const row = rows.get(slug);
    if (!row) { b.missing.push(slug); continue; }
    const rowMs = Date.parse(row.updated_at);
    if (!Number.isFinite(rowMs) || rowMs + SKEW_MS() < f.mtimeMs) b.stale.push(slug);
  }
  for (const [slug, row] of rows) {
    const b = bucket(row.page_class || "root");
    b.rows++;
    if (!files.has(slug)) b.orphan.push(slug);
  }
  const all = (k) => Object.values(byClass).flatMap((b) => b[k]).sort();
  const missing = all("missing");
  const stale = all("stale");
  const orphan = all("orphan");
  return { files: files.size, rows: rows.size, byClass, missing, stale, orphan, drift: missing.length + stale.length + orphan.length };
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

/**
 * Check (and with repair:true, repair) a vault against the table.
 * Returns the report; with repair, `repaired` lists the slugs whose row was
 * written and the report is re-measured afterwards (`after`).
 */
export async function reconcile({ vault = process.env.WIKI_GIT_DIR || "/wiki", repair = false, log = console.log, classOf } = {}) {
  const { classify } = await import("./page-classes.mjs");
  const cls = classOf || ((rel) => classify(rel).page_class);
  const files = await listFiles(vault);
  const rows = await listRows();
  const report = diffFilesRows(files, rows, cls);
  report.checkedAt = new Date().toISOString();
  if (!repair || (!report.missing.length && !report.stale.length)) return report;
  const slugs = new Set([...rows.keys(), ...files.keys()]);
  const todo = [...report.missing, ...report.stale];
  const batch = [];
  const repaired = [];
  const failed = [];
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
      failed.push(...part.map((r) => ({ slug: r.slug, error: String(e?.message || e) })));
    }
  }
  log(`[reconcile] repair pass: ${repaired.length} row(s) written (${report.missing.length} missing, ${report.stale.length} stale)` +
    (failed.length ? `, ${failed.length} FAILED (first ${failed[0].slug}: ${failed[0].error})` : "") +
    (repaired.length ? `; first: ${repaired.slice(0, 5).join(", ")}` : ""));
  const after = diffFilesRows(files, await listRows(), cls);
  return { ...report, repaired, repairFailed: failed, after };
}

export function formatReport(r) {
  const lines = [];
  const red = r.drift > 0;
  lines.push(`[reconcile] ${red ? "DRIFT" : "clean"}: ${r.files} file(s), ${r.rows} row(s); ${r.missing.length} missing, ${r.stale.length} stale, ${r.orphan.length} orphan`);
  for (const [c, b] of Object.entries(r.byClass).sort()) {
    lines.push(`[reconcile]   ${c}: files=${b.files} rows=${b.rows} missing=${b.missing.length} stale=${b.stale.length} orphan=${b.orphan.length}`);
  }
  for (const k of ["missing", "stale", "orphan"]) {
    if (r[k].length) lines.push(`[reconcile]   ${k}: ${r[k].slice(0, 20).join(", ")}${r[k].length > 20 ? ` (+${r[k].length - 20} more)` : ""}`);
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
