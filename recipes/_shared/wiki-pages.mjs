/**
 * wiki-pages - compile writes the page's FILE and its `wiki_pages` ROW; the
 * row is what the viewer presents (research-workbench D13, settled
 * 2026-09-25: "ingest -> compile -> present"; compiled means the row landed).
 *
 * Contract (D13 item 1 - replaces the 2026-08-26 "rows are best-effort,
 * derived" contract that let a compile sync 0 of N rows and still log
 * "compile ok", the 2026-08-28..09-02 outage):
 *   - `parseWikiPage()` is PURE (frontmatter + links + class via the
 *     page-class registry) and unit-tested.
 *   - Writers QUEUE a row as they write the file and FLUSH PER BATCH inside
 *     the run (`maybeFlushWikiPages()`), not once at exit. A failed batch is
 *     retried once; what still does not land is recorded as UNSYNCED with
 *     its error.
 *   - A run ends with `wikiPagesExitCode()`: non-zero when any page is
 *     unsynced, after logging the count and the first slugs. A compile with
 *     unsynced rows is never "ok".
 *   - A run with unsynced rows raises ONE notification per class and ends
 *     with EXIT_COMPLETED_WITH_FAILURES: a row write REJECTED by PostgREST
 *     (a 4xx: permission, constraint, payload) is "compile structural
 *     failure: row write rejected" (D13 item 6); a write that failed because
 *     the DATABASE was unavailable (no connection, a timeout, 502/503/504,
 *     PGRST000-003) is TRANSIENT infrastructure ("row write failed: database
 *     unavailable") - its slugs go to <out-dir>/.unsynced-rows.json and the
 *     next cycle's retryUnsyncedRows() writes them from their files
 *     (rw-p1a-render attempt 3; the tester's AT2-7 outage was notified as
 *     "structural").
 *   - The "all N written page row(s) landed" count is per RUN (a long-lived
 *     caller - the wiki-service - reports each cycle's own count).
 *   - The markdown on disk is the durable copy the same compile writes (git
 *     vault, backups); `reconcile-wiki-pages.mjs` measures files vs rows and
 *     repairs drift on (re)connect.
 */
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import nodePath from "node:path";
import { withLedgerLock } from "./structural-ledger.mjs";
import { extractLinks } from "./links.mjs";
import { classify } from "./page-classes.mjs";
import { sluggifySegment, toPosixPath } from "./quartz-slug.mjs";
export { extractLinks };

// Back-compat name for the class lookup (now registry-driven).
export function classifySlug(relPath) {
  const { slug, page_class, entity_type } = classify(relPath);
  return { slug, page_class, entity_type };
}

// Scalar / inline-list frontmatter value. The compilers write JSON scalars and
// inline lists; that is all this reader promises (no YAML dependency: the
// recipes are Node-builtins-only by design). Block lists read as absent.
function fmValue(raw) {
  let v = raw.trim();
  if (v === "") return "";
  if (/^".*"$/.test(v)) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  if (/^\[.*\]$/.test(v)) {
    try { return JSON.parse(v); } catch { /* YAML flow list */ }
    return v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return v;
}

function readFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md || "");
  if (!m) return { fm: {}, raw: {}, body: String(md || "") };
  const fm = {};
  const raw = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    raw[kv[1]] = kv[2];
    fm[kv[1]] = fmValue(kv[2]);
  }
  return { fm, raw, body: String(md || "").slice(m[0].length) };
}

function parseTags(raw) {
  if (!raw) return [];
  const m = /^\[(.*)\]$/.exec(String(raw).trim());
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

// Inline #tags, as Quartz's Obsidian-flavoured-markdown transform reads them
// (same expression; code fences and inline code skipped; numeric-only tags
// ignored), normalised the way Quartz slugs a tag. The viewer's tag pages are
// generated from rows, so the row must carry them. The segment rule is
// Quartz's sluggify (quartz-slug.mjs - one copy for compile and renderer).
const TAG_RE = /(?<=^| )#((?:[-_\p{L}\p{Emoji}\p{M}\d])+(?:\/[-_\p{L}\p{Emoji}\p{M}\d]+)*)/gu;
const slugTagSeg = sluggifySegment;
export function inlineTags(body) {
  const text = String(body || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out = [];
  for (const m of text.matchAll(TAG_RE)) {
    if (/^[\/\d]+$/.test(m[1])) continue;
    const t = m[1].split("/").map(slugTagSeg).join("/");
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// PURE: markdown + vault-relative path -> the row this page should have.
export function parseWikiPage(relPath, markdown) {
  const { slug, page_class, entity_type } = classifySlug(relPath);
  const { fm, raw, body } = readFrontmatter(markdown);
  const tags = parseTags(raw.tags);
  for (const t of inlineTags(body)) if (!tags.includes(t)) tags.push(t);
  return {
    slug,
    page_class,
    entity_type: (typeof fm.entity_type === "string" && fm.entity_type) || entity_type,
    title: (fm.title != null && String(fm.title)) || slug.split("/").pop() || slug,
    body,
    tags,
    links: extractLinks(body),
    // The row is what is presented, so it carries what the page shows (D13):
    // ids the hydrated cards key on, dates, aliases, cssclasses.
    frontmatter: fm,
  };
}

// ── I/O ────────────────────────────────────────────────────────────────────
// Speaks PostgREST like the rest of the recipe layer (openbrain-rest strips
// auth; PostgREST's anon role is service_role, so the apikey is nominal).
const OB_URL = () => (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const TIMEOUT_MS = () => Math.max(1000, Number(process.env.WIKI_PAGES_SYNC_TIMEOUT_MS || "10000"));
const BATCH = () => Math.max(1, Number(process.env.WIKI_PAGES_BATCH || "25"));

// Delete/count stay advisory (sweeps, diagnostics): one line per KIND so a
// second, different failure never hides behind the first.
const warnedKinds = new Set();
function warnOnce(what, e) {
  if (warnedKinds.has(what)) return;
  warnedKinds.add(what);
  console.error(`[wiki-pages] ${what} failed: ${e?.message || e} - the reconciliation check reports what it left behind`);
}

async function obFetch(method, pathq, body, headers = {}) {
  const r = await fetch(`${OB_URL()}/rest/v1/${pathq}`, {
    method,
    headers: { "content-type": "application/json", apikey: "local-trust", prefer: "return=minimal", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS()),
  });
  if (!r.ok) throw new Error(`${method} ${pathq.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return true;
}

export function toRestRow(r, now = new Date().toISOString()) {
  return {
    slug: r.slug,
    page_class: r.page_class || "root",
    entity_type: r.entity_type ?? null,
    title: r.title || "",
    body: r.body || "",
    tags: r.tags || [],
    links: r.links || [],
    frontmatter: r.frontmatter || {},
    updated_at: now,
  };
}

/**
 * Upsert rows (on_conflict=slug, merge-duplicates; updated_at refreshed - the
 * column default only applies on INSERT). THROWS on failure: a row that did
 * not land is a failed compile, never a silent `false`.
 */
export async function upsertWikiPages(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.slug);
  if (!list.length) return 0;
  const now = new Date().toISOString();
  await obFetch("POST", "wiki_pages?on_conflict=slug", list.map((r) => toRestRow(r, now)),
    { prefer: "resolution=merge-duplicates,return=minimal" });
  return list.length;
}

// A compile run that COMPLETED but with structural failures or unsynced rows
// exits with this code (a crash exits 1). The wiki-service tells the two
// apart: a completed run still advances the watermark and the rest of the
// cycle (synthesis, sweeps, planned manifest, reconcile, commit) runs.
export const EXIT_COMPLETED_WITH_FAILURES = 3;

// ── the run's write queue and its unsynced ledger ──────────────────────────
const _queue = new Map();     // slug -> row (last write wins)
const _unsynced = new Map();  // slug -> error (the page's file exists; its row did not land)
let _synced = 0;

// Vault-relative path from an absolute one; null OUTSIDE the vault root (a
// scratch --out-dir must never write junk slugs, observed 2026-08-26). The
// OS's separator becomes "/" (Quartz's toPosixPath); on Linux a "\" stays a
// character of the name (rw-p1a-deploy-prep attempt 2). `sep`: a test seam.
export function vaultRel(absPath, vaultDir = process.env.WIKI_GIT_DIR || "/wiki", sep = nodePath.sep) {
  const abs = toPosixPath(String(absPath || ""), sep);
  const root = toPosixPath(String(vaultDir), sep).replace(/\/+$/, "");
  if (!root || !abs.startsWith(root + "/")) return null;
  return abs.slice(root.length + 1);
}

// Sync, no I/O. A page whose row cannot even be built (a parse-path bug - the
// 08-28 extractLinks ReferenceError) is UNSYNCED, structural, and fails the run.
export function queueWikiPage(absPath, markdown) {
  const rel = vaultRel(absPath);
  if (!rel) return null;
  try {
    const row = parseWikiPage(rel, markdown);
    _queue.set(row.slug, row);
    _unsynced.delete(row.slug);
    return row;
  } catch (e) {
    const slug = rel.replace(/\.md$/i, "");
    _unsynced.set(slug, `row build failed: ${e?.message || e}`);
    console.error(`[wiki-pages] row build failed for ${slug}: ${e?.message || e}`);
    return null;
  }
}

export function queuedWikiPageCount() {
  return _queue.size;
}

/**
 * Flush the queue now: chunks of 200, each retried once. Returns
 * { sent, failed }; failed slugs land in the unsynced ledger with the error.
 */
export async function flushWikiPages() {
  if (!_queue.size) return { sent: 0, failed: 0 };
  const rows = [..._queue.values()];
  _queue.clear();
  const CHUNK = 200;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    let err = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await upsertWikiPages(part);
        err = null;
        break;
      } catch (e) {
        err = e;
      }
    }
    if (err) {
      failed += part.length;
      for (const r of part) _unsynced.set(r.slug, String(err?.message || err));
      console.error(`[wiki-pages] row flush FAILED for ${part.length} page(s) after one retry: ${err?.message || err}`);
    } else {
      sent += part.length;
      _synced += part.length;
      for (const r of part) _unsynced.delete(r.slug);
    }
  }
  if (sent) console.log(`[wiki-pages] synced ${sent} page row(s)`);
  return { sent, failed };
}

// Per-batch flush: call after each page write. Flushes when the queue holds a
// batch (WIKI_PAGES_BATCH, default 25), so rows land during the run.
export async function maybeFlushWikiPages() {
  if (_queue.size >= BATCH()) return flushWikiPages();
  return { sent: 0, failed: 0 };
}

export function unsyncedWikiPages() {
  return [..._unsynced.entries()].map(([slug, error]) => ({ slug, error }));
}

/**
 * End of a compile run: flush what is left, then report. Returns the exit code
 * the run must end with: 0 when every written page's row landed, 1 otherwise
 * (after logging the unsynced count and the first slugs).
 */
export async function finishWikiPages(tag = "compile", { outDir } = {}) {
  await flushWikiPages();
  const u = unsyncedWikiPages();
  const synced = _synced;
  _synced = 0; // per run: the next run (or wiki-service cycle) counts its own
  if (!u.length) {
    console.log(`[wiki-pages] ${tag}: all ${synced} written page row(s) landed`);
    return 0;
  }
  const first = u.slice(0, 10).map((x) => x.slug).join(", ");
  console.error(`[wiki-pages] ${tag} FAILED: ${u.length} page(s) UNSYNCED (file written, row did not land); first: ${first}; error: ${u[0].error}`);
  const transient = u.filter((x) => isDatabaseUnavailableError(x.error));
  const rejected = u.filter((x) => !isDatabaseUnavailableError(x.error));
  if (transient.length) {
    try {
      const n = rememberUnsyncedRows(outDir, transient, tag);
      console.error(`[wiki-pages] ${tag}: ${transient.length} row(s) failed because the database was unavailable; ` +
        `recorded for the next cycle's retry (${n} pending in ${UNSYNCED_FILE})`);
    } catch (e) {
      console.error(`[wiki-pages] ${tag}: recording the unsynced rows for retry FAILED: ${e?.message || e}`);
    }
  }
  // One notification per class for the run (not one per page): the
  // reconciliation names every unsynced slug. Loaded lazily - the viewer
  // image carries this module for parseWikiPage and never finishes a run.
  try {
    const { notify } = await import("./compile-notify.mjs");
    if (rejected.length) {
      const f = rejected.slice(0, 10).map((x) => x.slug).join(", ");
      await notify({
        cls: "structural", subject: `compile structural failure: row write rejected (${tag})`, slug: rejected[0].slug,
        error: `${rejected.length} page(s) unsynced; first: ${f}; error: ${rejected[0].error}`, outDir,
      });
    }
    if (transient.length) {
      const f = transient.slice(0, 10).map((x) => x.slug).join(", ");
      await notify({
        cls: "transient", subject: `row write failed: database unavailable (${tag})`, slug: transient[0].slug,
        error: `${transient.length} page(s) unsynced, retried next cycle; first: ${f}; error: ${transient[0].error}`, outDir,
      });
    }
  } catch (e) {
    console.error(`[wiki-pages] ${tag}: notification for the unsynced rows FAILED: ${e?.message || e}`);
  }
  return 1;
}

// A database read or write that failed because the DATABASE was not there
// (transient infrastructure), as opposed to one PostgREST answered and
// REFUSED (structural: any 4xx other than 408/429). Status codes are read in
// both error shapes the recipes produce: "POST wiki_pages: 503 ..." and
// "GET <url> -> 503: ...".
export function isDatabaseUnavailableError(msg) {
  const m = String(msg ?? "");
  if (/(?::|->) 4\d\d\b/.test(m) && !/(?::|->) (?:408|429)\b/.test(m)) return false;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|socket hang up|other side closed|aborted|timed? ?out|(?::|->) (?:408|429|502|503|504)\b|PGRST00[0-3]/i.test(m);
}

// The next cycle's retry of rows that failed transiently:
// <out-dir>/.unsynced-rows.json (WIKI_UNSYNCED_FILE overrides).
// rw-p1a-render attempt 4 (tester NA3-4): every change to the record is one
// LOCKED read-modify-write (the structural ledger's lock, on this file), so
// two racing runs never drop each other's entries; the retry applies its
// outcome as deltas under the lock (a slug recorded while its upsert was in
// flight stays); a recorded slug must be a vault slug (no "..", no absolute
// path, no backslash, no NUL - it is joined to the vault and read) or it is
// rejected, never read; an unreadable record is logged loudly and read as
// empty (a row it named is still named by the reconciliation as drift).
export const UNSYNCED_FILE = ".unsynced-rows.json";
const unsyncedFile = (outDir) => process.env.WIKI_UNSYNCED_FILE ||
  nodePath.join(outDir || process.env.OB_WIKI_OUT_DIR || "./wikis", UNSYNCED_FILE);
function readUnsynced(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") console.error(`[wiki-pages] unsynced-row record ${file} is unreadable (${e?.code || e?.message || e}); treated as empty`);
    return {};
  }
  try {
    const j = JSON.parse(raw);
    if (j && j.rows && typeof j.rows === "object" && !Array.isArray(j.rows)) return j.rows;
  } catch { /* below */ }
  console.error(`[wiki-pages] unsynced-row record ${file} is unreadable (not {"rows":{...}} JSON); treated as empty - ` +
    "the rows it named are still listed by the reconciliation as drift");
  return {};
}
function writeUnsynced(file, rows) {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const sorted = Object.fromEntries(Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(tmp, JSON.stringify({ rows: sorted }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
// One locked transaction on the record: fn(rows) changes it in place.
function updateUnsynced(file, fn) {
  return withLedgerLock(file, () => {
    const rows = readUnsynced(file);
    const out = fn(rows);
    writeUnsynced(file, rows);
    return out;
  });
}
// A vault slug: relative, forward slashes, no "." / ".." segment, no NUL.
export function isVaultSlug(slug) {
  const s = String(slug ?? "");
  if (!s || s.includes("\\") || s.includes("\0") || s.startsWith("/") || /^[A-Za-z]:/.test(s)) return false;
  return s.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
export function rememberUnsyncedRows(outDir, list, tag) {
  const at = new Date().toISOString();
  return updateUnsynced(unsyncedFile(outDir), (rows) => {
    for (const x of list) rows[x.slug] = { error: String(x.error).slice(0, 300), tag, at };
    return Object.keys(rows).length;
  });
}

/**
 * The next cycle: retry the rows an earlier run left unsynced because the
 * database was unavailable. Each slug's row is written from its file (the
 * compile wrote the file; the row is what did not land); a slug whose file is
 * gone is dropped; a slug that is not a vault slug is rejected (never read).
 * Returns { retried, landed, failed, dropped, rejected }; what fails again
 * stays recorded for the cycle after.
 */
export async function retryUnsyncedRows({ outDir, vaultDir = process.env.WIKI_GIT_DIR || "/wiki", log = console.log } = {}) {
  const file = unsyncedFile(outDir);
  const seen = readUnsynced(file); // a snapshot; the outcome is applied under the lock below
  const slugs = Object.keys(seen);
  if (!slugs.length) return { retried: 0, landed: 0, failed: 0, dropped: 0, rejected: 0 };
  const root = nodePath.resolve(vaultDir);
  const batch = [];
  const gone = [];
  const rejected = [];
  for (const slug of slugs) {
    if (!isVaultSlug(slug)) { rejected.push(slug); continue; }
    let md = null;
    let rel = null;
    for (const r of [`${slug}.md`, `${slug}/index.md`]) {
      const abs = nodePath.resolve(root, r);
      if (!abs.startsWith(root + nodePath.sep)) continue; // belt and braces: never outside the vault
      try { md = fs.readFileSync(abs, "utf8"); rel = r; break; } catch { /* next */ }
    }
    if (md == null) { gone.push(slug); continue; }
    batch.push(parseWikiPage(rel, md));
  }
  if (rejected.length) {
    console.error(`[wiki-pages] unsynced-row record ${file}: ${rejected.length} slug(s) rejected (not a vault slug; never read): ` +
      rejected.slice(0, 5).map((x) => JSON.stringify(x)).join(", "));
  }
  const landedSlugs = [];
  const failedAgain = new Map();
  for (let i = 0; i < batch.length; i += 200) {
    const part = batch.slice(i, i + 200);
    try {
      await upsertWikiPages(part);
      for (const r of part) landedSlugs.push(r.slug);
    } catch (e) {
      for (const r of part) failedAgain.set(r.slug, String(e?.message || e).slice(0, 300));
    }
  }
  // Apply the outcome to the record AS IT IS NOW: an entry is removed only if
  // it is still the one this retry read (a run that re-recorded the slug
  // meanwhile keeps its newer entry); entries recorded meanwhile stay.
  updateUnsynced(file, (rows) => {
    const same = (slug) => rows[slug] && seen[slug] && rows[slug].at === seen[slug].at;
    for (const slug of [...landedSlugs, ...gone, ...rejected]) if (same(slug)) delete rows[slug];
    for (const [slug, error] of failedAgain) if (rows[slug]) rows[slug] = { ...rows[slug], error, at: new Date().toISOString() };
  });
  log(`[wiki-pages] retried ${slugs.length} row(s) left unsynced by a database outage: ${landedSlugs.length} landed, ` +
    `${failedAgain.size} failed again, ${gone.length} dropped (file gone), ${rejected.length} rejected (not a vault slug)`);
  return { retried: slugs.length, landed: landedSlugs.length, failed: failedAgain.size, dropped: gone.length, rejected: rejected.length };
}

// Test seam.
export function _resetWikiPagesForTests() {
  _queue.clear();
  _unsynced.clear();
  _synced = 0;
  warnedKinds.clear();
}

// Delete rows for swept/removed pages. Chunked so a big sweep cannot build a
// URL past PostgREST's limits. Advisory: a failed delete leaves an orphan row
// the reconciliation check names.
export async function deleteWikiPages(slugs) {
  const list = [...new Set((slugs || []).filter(Boolean))];
  if (!list.length) return true;
  const CHUNK = 100;
  try {
    for (let i = 0; i < list.length; i += CHUNK) {
      const inList = list.slice(i, i + CHUNK).map((s) => `"${String(s).replace(/"/g, '""')}"`).join(",");
      await obFetch("DELETE", `wiki_pages?slug=in.(${encodeURIComponent(inList)})`);
    }
    return true;
  } catch (e) {
    warnOnce("delete", e);
    return false;
  }
}

/**
 * Delete EVERY row under these slug prefixes (each a folder: "content/topic/"
 * deletes content/topic/<anything>, plus the folder's own "content/topic"
 * row). The retire step's DELETE half (rw-p1a-deploy-prep, NA4-2): a retired
 * layer is removed wholesale, so its rows go wholesale too - with or without a
 * file, including rows a writer racing the sweep (a backfill) left behind.
 * Returns the number of rows deleted, or null when the delete did not land
 * (logged: the reconciliation names what is left, and an orphan row is never
 * presented).
 */
export async function deleteWikiPagesUnder(prefixes) {
  const list = [...new Set((prefixes || []).map((p) => String(p).replace(/\/+$/, "")).filter(Boolean))];
  if (!list.length) return 0;
  // A prefix is a plain folder slug: no PostgREST or LIKE metacharacter can
  // widen the delete.
  const bad = list.find((p) => !/^[A-Za-z0-9][A-Za-z0-9/-]*$/.test(p));
  if (bad) throw new Error(`deleteWikiPagesUnder: refusing prefix ${JSON.stringify(bad)} (a folder slug of [A-Za-z0-9/-] only)`);
  const or = list.flatMap((p) => [`slug.eq.${p}`, `slug.like.${p}/*`]).join(",");
  try {
    const r = await fetch(`${OB_URL()}/rest/v1/wiki_pages?or=(${encodeURIComponent(or)})&select=slug`, {
      method: "DELETE",
      headers: { apikey: "local-trust", prefer: "return=representation" },
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
    if (!r.ok) throw new Error(`DELETE wiki_pages: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) {
    console.error(`[wiki-pages] delete of the rows under ${list.join(", ")} FAILED: ${e?.message || e} - ` +
      "the reconciliation names the orphan rows left behind (never presented)");
    return null;
  }
}

// Row count (optionally per page_class); null when unavailable - never "0".
export async function countWikiPages(pageClass) {
  const filter = pageClass ? `&page_class=eq.${encodeURIComponent(pageClass)}` : "";
  try {
    const r = await fetch(`${OB_URL()}/rest/v1/wiki_pages?select=slug&limit=1${filter}`, {
      method: "HEAD",
      headers: { apikey: "local-trust", prefer: "count=exact" },
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
    const cr = r.headers.get("content-range");
    const total = cr && cr.includes("/") ? Number(cr.split("/")[1]) : NaN;
    return Number.isFinite(total) ? total : null;
  } catch (e) {
    warnOnce("count", e);
    return null;
  }
}
