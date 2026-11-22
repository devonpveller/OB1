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
import { classify, isRegenerable } from "./page-classes.mjs";
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
// Speaks PostgREST like the rest of the recipe layer, through openbrain-rest with the caller's own token
// (restAuth(), end of file; rw-rest-door-auth).
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
    headers: { "content-type": "application/json", ...restAuth(), prefer: "return=minimal", ...headers },
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
  return (await upsertWikiPagesReport(rows)).written.length;
}

// ── WITHHELD ROWS (research-workbench rw-idea-privacy round 4, review R1) ──
// A database guard can WITHHOLD a row: a BEFORE trigger on wiki_pages that
// returns NULL (slot 380's trg_idea_privacy_wiki_guard: a page that shows an
// idea's text; slot 390's trg_report_isolation_wiki_guard: a private report).
// PostgREST then answers 2xx and the row is NOT written - so "2xx" no longer
// means "landed". The upsert asks for the slugs it wrote (return=representation,
// select=slug): a slug it does not get back was withheld. Generic: any guard of
// that shape is covered, with no change to the guard. A body that is not a JSON
// array (a stub, an old proxy) tells nothing, and everything counts as landed
// (the behaviour before this change). Withheld slugs are remembered for this
// process (the reconcile leaves them out of its drift) and never logged by name.
const _withheld = new Set();
export function isWithheldWikiPage(slug) { return _withheld.has(slug); }
export function withheldWikiPageCount() { return _withheld.size; }

// rw-privacy-hardening (380, "withheld" vs "hidden"): a slug missing from the answer is WITHHELD only when the guards
// (slot 430) said they withheld that many rows - the response header X-Wiki-Withheld, a count. A row missing that no
// guard accounts for is HIDDEN (a later row-level-security policy on wiki_pages, a lost write): it is reported in
// `hidden`, and the callers treat it as unsynced - its file is KEPT, never deleted as a withheld page's would be. When
// some rows are withheld and some hidden the writer cannot tell which, so every missing row counts as hidden.
/** Upsert rows; returns { written: [slug], withheld: [slug], hidden: [slug] }. THROWS on a failed request, like upsertWikiPages. */
export async function upsertWikiPagesReport(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.slug);
  if (!list.length) return { written: [], withheld: [], hidden: [] };
  const now = new Date().toISOString();
  const r = await fetch(`${OB_URL()}/rest/v1/wiki_pages?on_conflict=slug&select=slug`, {
    method: "POST",
    headers: { "content-type": "application/json", ...restAuth(), prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(list.map((x) => toRestRow(x, now))),
    signal: AbortSignal.timeout(TIMEOUT_MS()),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST wiki_pages: ${r.status} ${text.slice(0, 200)}`);
  let back = null;
  try { const j = JSON.parse(text); if (Array.isArray(j)) back = new Set(j.map((x) => x && x.slug)); } catch { /* not JSON: tells nothing */ }
  const written = [];
  let missing = [];
  for (const x of list) (back && !back.has(x.slug) ? missing : written).push(x.slug);
  const said = parseInt(r.headers.get("x-wiki-withheld") || "0", 10) || 0;
  const withheld = missing.length && said === missing.length ? missing : [];
  const hidden = missing.length && !withheld.length ? missing : [];
  for (const s of withheld) _withheld.add(s);
  for (const s of written) _withheld.delete(s);
  return { written, withheld, hidden };
}

// ── REFUSED ROWS (rw-wiki-guarded-pages) ────────────────────────────────────
// The same guards (slots 380, 390, 430, 440) do not withhold a NOTE silently: they RAISE 42501 ("wiki_pages: this page
// cannot be saved"), and PostgREST fails the WHOLE request - every other row of the batch with it (live 2026-11-21: the
// viewer's repair of 29 rows refused because 22 notebook notes in it carry withheld text). A refusal is the guard's
// decision, not an outage: the batch is split until the refused row stands alone, the others land, and the refused row is
// WITHHELD like a silent one (no row, its file left out, never retried). Nothing about the guard changes.
// Only the guards' ONE message counts (slot 430 R3: it names no guard and no reason); any other 42501 - a missing grant,
// "permission denied for table wiki_pages" - stays a structural failure of the run (D13 item 6).
export const GUARD_REFUSAL_MESSAGE = "wiki_pages: this page cannot be saved";
// (the negative cases - another 42501, a PGRST code, a network error, an echo in another error's details, a longer
// message - are pinned by wiki-pages.refused.test.mjs, round 2)
export function isGuardRefusal(e) {
  const m = String(e?.message ?? e ?? "");
  return /"code"\s*:\s*"42501"/.test(m) && m.includes(`"message":"${GUARD_REFUSAL_MESSAGE}"`);
}
// Rows per write request (flush, retry, repair). The guards cost a lookup per 8-word window of a body (slot 440's text
// rule): 200 rows of long source pages measured ~10 s of guard time live - the 10 s request timeout - so the retry's
// 200-row chunks timed out every cycle and were recorded again as a "database outage" (rw-wiki-guarded-pages).
export const WRITE_CHUNK = () => Math.max(1, Number(process.env.WIKI_PAGES_WRITE_CHUNK || "25"));
/**
 * Upsert rows so that a guard's refusal fails only the refused row. Returns { written, withheld, hidden, refused, failed:
 * [{slug, error}] }; never throws. `refused` rows are also remembered as withheld (isWithheldWikiPage).
 */
export async function upsertWikiPagesIsolated(rows) {
  const out = { written: [], withheld: [], hidden: [], refused: [], failed: [] };
  const go = async (part) => {
    if (!part.length) return;
    try {
      const rep = await upsertWikiPagesReport(part);
      out.written.push(...rep.written); out.withheld.push(...rep.withheld); out.hidden.push(...(rep.hidden || []));
    } catch (e) {
      if (isGuardRefusal(e) && part.length > 1) {
        const mid = Math.ceil(part.length / 2);
        await go(part.slice(0, mid)); await go(part.slice(mid));
      } else if (isGuardRefusal(e)) {
        out.refused.push(part[0].slug); _withheld.add(part[0].slug);
      } else {
        out.failed.push(...part.map((r) => ({ slug: r.slug, error: String(e?.message || e) })));
      }
    }
  };
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.slug);
  for (let i = 0; i < list.length; i += WRITE_CHUNK()) await go(list.slice(i, i + WRITE_CHUNK()));
  return out;
}

// ── the WITHHELD RECORD (rw-wiki-guarded-pages) ─────────────────────────────
// What a guard withheld or refused is remembered across processes - the compile learns it, the viewer's reconcile (another
// process, a read-only vault) must count the page as expected, not drift. <vault>/content/.withheld-pages.json holds the
// SHA-256 of each slug and nothing else of the page: no slug, no title, no text (which pages are withheld is itself
// private). A slug leaves the record when its row lands again. A dot-file: never walked, served or committed.
export const WITHHELD_FILE = ".withheld-pages.json";
export function withheldFileFor(vault = process.env.WIKI_GIT_DIR || "/wiki") {
  return process.env.WIKI_WITHHELD_FILE || nodePath.join(vault, "content", WITHHELD_FILE);
}
export const slugHash = (slug) => crypto.createHash("sha256").update(String(slug)).digest("hex");
export function readWithheldRecord(file = withheldFileFor()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && j.pages && typeof j.pages === "object" && !Array.isArray(j.pages)) {
      return Object.fromEntries(Object.entries(j.pages).filter(([k]) => /^[0-9a-f]{64}$/.test(k)));
    }
  } catch (e) {
    if (e?.code !== "ENOENT") warnOnce("withheld-record read", e);
  }
  return {};
}
function updateWithheldRecord(file, fn) {
  try {
    return withLedgerLock(file, () => {
      const pages = readWithheldRecord(file);
      const changed = fn(pages);
      if (!changed) return false;
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      const sorted = Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)));
      fs.writeFileSync(tmp, JSON.stringify({ pages: sorted }, null, 2) + "\n");
      fs.renameSync(tmp, file);
      return true;
    });
  } catch (e) {
    // a read-only vault (the viewer): this process still remembers the slugs (isWithheldWikiPage)
    warnOnce("withheld-record write", e);
    return false;
  }
}
/** Record slugs as withheld (hashes only). Returns the number added. */
export function recordWithheldPages(slugs, { file = withheldFileFor(), pageClassOf = () => null } = {}) {
  const list = [...new Set((slugs || []).filter(Boolean))];
  if (!list.length) return 0;
  for (const s of list) _withheld.add(s);
  let added = 0;
  const at = new Date().toISOString();
  updateWithheldRecord(file, (pages) => {
    for (const s of list) {
      const k = slugHash(s);
      if (!pages[k]) added++;
      pages[k] = { at, ...(pageClassOf(s) ? { page_class: pageClassOf(s) } : {}) };
    }
    return true;
  });
  return added;
}
/** A slug whose row landed is no longer withheld. Returns the number removed. */
export function forgetWithheldPages(slugs, { file = withheldFileFor() } = {}) {
  const list = [...new Set((slugs || []).filter(Boolean))];
  if (!list.length) return 0;
  let have;
  try { have = fs.existsSync(file) ? readWithheldRecord(file) : null; } catch { have = null; }
  if (!have || !list.some((s) => have[slugHash(s)])) return 0;
  let removed = 0;
  updateWithheldRecord(file, (pages) => {
    for (const s of list) { const k = slugHash(s); if (pages[k]) { delete pages[k]; removed++; } }
    return removed > 0;
  });
  return removed;
}

// The withheld rows' files: a staged update is dropped (the file keeps the content of the row the guard kept); a file
// this run CREATED is removed (it holds the withheld content); an older file whose slug has no row any more (a page
// withheld before this run, its file not yet moved out) is removed too - a file with no row is reconcile drift and
// shows what the database refused. A file whose slug still has a row is left (it is that row's page).
// Round 2 (review B2): the older file goes only when it is regenerable compile output (page-classes.mjs isRegenerable); an
// owner's or an AI note keeps its file (recorded withheld: the viewer neither serves nor counts it).
async function leaveOutWithheld(slugs) {
  const paths = new Map();
  for (const s of slugs) {
    const p = _pathOf.get(s);
    _pathOf.delete(s);
    _unsynced.delete(s);
    if (!p) continue;
    const tmp = _staged.get(p);
    if (tmp) { _staged.delete(p); try { fs.unlinkSync(tmp); } catch { /* gone */ } }
    paths.set(s, p);
  }
  if (!paths.size) return;
  let hasRow = null;
  try {
    const inList = [...paths.keys()].map((s) => `"${s.replace(/"/g, '\\"')}"`).join(",");
    const r = await fetch(`${OB_URL()}/rest/v1/wiki_pages?select=slug&slug=in.(${encodeURIComponent(inList)})`, {
      headers: { ...restAuth() }, signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
    if (r.ok) hasRow = new Set((await r.json()).map((x) => x.slug));
  } catch { /* unknown: only the files this run created go */ }
  for (const [s, p] of paths) {
    const created = _created.has(p);
    _created.delete(p);
    if (created || (hasRow && !hasRow.has(s) && regenerableFile(p))) { try { fs.unlinkSync(p); } catch { /* gone */ } }
  }
}
function regenerableFile(abs) { const rel = abs && vaultRel(abs); return !!rel && isRegenerable(rel); }
// rw-wiki-guarded-pages: every withheld or refused slug of a flush is RECORDED (hashes only), so another process's
// reconcile (the viewer's) counts it as expected
function recordHeld(slugs) {
  const cls = new Map();
  for (const s of slugs) { const p = _pathOf.get(s); const rel = p && vaultRel(p); if (rel) { try { cls.set(s, classifySlug(rel).page_class); } catch { /* none */ } } }
  recordWithheldPages(slugs, { pageClassOf: (s) => cls.get(s) || null });
}

// A compile run that COMPLETED but with structural failures or unsynced rows
// exits with this code (a crash exits 1). The wiki-service tells the two
// apart: a completed run still advances the watermark and the rest of the
// cycle (synthesis, sweeps, planned manifest, reconcile, commit) runs.
export const EXIT_COMPLETED_WITH_FAILURES = 3;

// ── the run's write queue and its unsynced ledger ──────────────────────────
const _queue = new Map();     // slug -> row (last write wins)
const _unsynced = new Map();  // slug -> error (the page's file exists; its row did not land)
const _pathOf = new Map();    // slug -> the absolute path it was queued from (round 2: staged files)
let _synced = 0;
let _hiddenRun = 0; // rows neither returned nor reported withheld this run (unsynced, nothing written)
let _heldRun = 0; // rows a database guard withheld this run (not synced, not unsynced)

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
    _pathOf.set(row.slug, absPath);
    _unsynced.delete(row.slug);
    return row;
  } catch (e) {
    const slug = rel.replace(/\.md$/i, "");
    commitStaged(absPath, null); // no row will land: the file goes in place now (it reads stale, as it is)
    _unsynced.set(slug, `row build failed: ${e?.message || e}`);
    console.error(`[wiki-pages] row build failed for ${slug}: ${e?.message || e}`);
    return null;
  }
}


// ── ROW FIRST, THEN THE FILE (rw-p1b-ready round 2) ────────────────────────
// Tester attempt 2's 24 h soak: two reconcile samples named
// content/person/person-ada-fixture STALE (its row older than its file). The
// writers wrote the FILE, then queued the row, and the row landed at the next
// batch flush - 60-90 ms later for a one-page fixture compile (measured), up
// to a whole batch of LLM calls later in a real compile. A reconcile pass
// (files listed first, then rows) falling in that gap saw the new file
// beside the old row. writeWikiPage closes it:
//   - an UPDATE (the file exists) is STAGED: its new content goes to a hidden
//     sibling (".<name>.wp-staged-<pid>" - a dot-file, which the vault walk
//     and Quartz never read), the row is queued, and only after the row's
//     batch has LANDED is the staged file given an mtime at or before the
//     row's stamp and renamed into place. Since the reconcile lists files
//     before it reads rows, it can never see the new file with the old row
//     (a file seen new was renamed after its row landed, so the later row
//     read sees the new row). A batch that fails still puts the file in
//     place, with the current mtime - stale, as a failed row must read.
//   - a CREATE (no file yet) is written at once and asks for the next flush
//     immediately (maybeFlushWikiPages flushes when one is pending), so the
//     file-before-row gap of a new page is one upsert, not a batch. (A row
//     first would leave a row without a file for the reconcile's whole walk.)
//   - an unchanged page (exactly, or but for volatileKeys) is not written;
//     its row is queued as before.
// The callers' reads see staged content through readWikiPageFile /
// wikiPageExists (generate-wiki's collision check), so a staged page is not
// invisible to its own compile.
const _staged = new Map(); // absolute path -> hidden staged file
const _created = new Set(); // absolute paths this run CREATED (written before their row): removed if the row is withheld
let _createPending = false;
const stagedName = (absPath) => nodePath.join(nodePath.dirname(absPath), `.${nodePath.basename(absPath)}.wp-staged-${process.pid}`);
function stripVolatile(s, keys) {
  let out = s;
  for (const k of keys) {
    out = out
      .replace(new RegExp(`^${k}: .*$`, "m"), `${k}: <volatile>`)
      .replace(new RegExp(`"${k}": "[^"]*"`), `"${k}": "<volatile>"`);
  }
  return out;
}

/** The page's current content as this run sees it: its staged copy, else the file. Throws like readFileSync. */
export function readWikiPageFile(absPath) {
  const st = _staged.get(absPath);
  return fs.readFileSync(st || absPath, "utf8");
}
export function wikiPageExists(absPath) {
  return _staged.has(absPath) || fs.existsSync(absPath);
}

/**
 * Write a page (row first for an update, see above) and queue its row.
 * Returns true when the content changed. volatileKeys: frontmatter keys whose
 * value alone does not count as a change (writeIfChangedStable's rule);
 * omit for an exact comparison (writeIfChanged's).
 */
export function writeWikiPage(absPath, content, { volatileKeys = null } = {}) {
  let prev = null;
  try { prev = readWikiPageFile(absPath); } catch { /* none yet */ }
  const same = prev != null && (volatileKeys ? stripVolatile(prev, volatileKeys) === stripVolatile(content, volatileKeys) : prev === content);
  if (!same) {
    fs.mkdirSync(nodePath.dirname(absPath), { recursive: true });
    if (prev == null || !vaultRel(absPath)) {
      fs.writeFileSync(absPath, content, "utf8");
      if (vaultRel(absPath)) { _createPending = true; if (prev == null) _created.add(absPath); }
    } else {
      const tmp = _staged.get(absPath) || stagedName(absPath);
      fs.writeFileSync(tmp, content, "utf8");
      _staged.set(absPath, tmp);
    }
  }
  queueWikiPage(absPath, content);
  return !same;
}

// Put a staged page in place: mtime = at (a Date; at or before its row's stamp), else now.
function commitStaged(absPath, at) {
  const tmp = _staged.get(absPath);
  if (!tmp) return;
  _staged.delete(absPath);
  try {
    if (at) fs.utimesSync(tmp, at, at);
    fs.renameSync(tmp, absPath);
  } catch (e) {
    console.error(`[wiki-pages] staged page ${absPath} could not be put in place: ${e?.message || e}`);
  }
}
/** Put every staged page in place now (current mtime). finishWikiPages does this after its flush. */
export function commitAllStagedWikiPages() {
  for (const p of [..._staged.keys()]) commitStaged(p, null);
}
export function stagedWikiPageCount() {
  return _staged.size;
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
  const CHUNK = WRITE_CHUNK();
  let sent = 0;
  let failed = 0;
  let held = 0;
  let refusedRun = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    // at or before the rows' stamp (upsertWikiPages stamps them after this)
    const landedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    // rw-wiki-guarded-pages: a guard's refusal (42501) fails only the refused row; a failed request is retried once
    const rep = await upsertWikiPagesIsolated(part);
    if (rep.failed.length) {
      const again = await upsertWikiPagesIsolated(part.filter((r) => rep.failed.some((f) => f.slug === r.slug)));
      rep.failed = again.failed;
      for (const k of ["written", "withheld", "hidden", "refused"]) rep[k].push(...again[k]);
    }
    if (rep.failed.length) {
      const err = rep.failed[0].error;
      failed += rep.failed.length;
      for (const f of rep.failed) { _unsynced.set(f.slug, f.error); commitStaged(_pathOf.get(f.slug), null); _pathOf.delete(f.slug); }
      console.error(`[wiki-pages] row flush FAILED for ${rep.failed.length} page(s) after one retry: ${err}`);
    }
    {
      // a withheld row (a database guard withheld it, see upsertWikiPagesReport) or a REFUSED one (the guard raised
      // 42501, see upsertWikiPagesIsolated) is neither synced nor a failure: its file is left out, so it never becomes
      // reconcile drift, and it is not retried
      const gone = new Set(rep.failed.map((f) => f.slug));
      const out = new Set([...rep.withheld, ...rep.refused]);
      // a missing row no guard accounts for (rw-privacy-hardening): unsynced, its file kept, the run ends 3
      const hid = new Set(rep.hidden || []);
      // It may BE a guard's withheld row whose count did not arrive (no header, a mixed batch): so nothing of it is published. The
      // staged copy is thrown away, a file this run CREATED is removed, a file that was already there is left exactly as it is (not
      // overwritten, not deleted), and the run ends EXIT_COMPLETED_WITH_FAILURES.
      for (const r of part) if (hid.has(r.slug)) {
        failed += 1; _hiddenRun += 1;
        _unsynced.set(r.slug, "the row was not returned and no guard reported withholding it (row-level security? a guard whose count did not arrive?); nothing was written");
        const p = _pathOf.get(r.slug);
        const tmp = p && _staged.get(p);
        if (tmp) { _staged.delete(p); try { fs.unlinkSync(tmp); } catch { /* gone */ } }
        if (p && _created.has(p)) { _created.delete(p); try { fs.unlinkSync(p); } catch { /* gone */ } }
        _pathOf.delete(r.slug);
      }
      const landed = part.filter((r) => !out.has(r.slug) && !hid.has(r.slug) && !gone.has(r.slug));
      sent += landed.length;
      _synced += landed.length;
      for (const r of landed) { _unsynced.delete(r.slug); const p = _pathOf.get(r.slug); _created.delete(p); commitStaged(p, landedAt); _pathOf.delete(r.slug); }
      if (landed.length) forgetWithheldPages(landed.map((r) => r.slug));
      if (out.size) { held += out.size; _heldRun += out.size; recordHeld([...out]); await leaveOutWithheld([...out]); }
      refusedRun += rep.refused.length;
    }
  }
  if (sent) console.log(`[wiki-pages] synced ${sent} page row(s)`);
  if (held) console.log(`[wiki-pages] ${held} page(s) withheld by the database (a privacy guard${refusedRun ? `; ${refusedRun} refused out loud` : ""}): not written, their files left out`);
  return held ? { sent, failed, withheld: held } : { sent, failed };
}

// Per-batch flush: call after each page write. Flushes when the queue holds a
// batch (WIKI_PAGES_BATCH, default 25), so rows land during the run.
export async function maybeFlushWikiPages() {
  if (_createPending) { _createPending = false; return flushWikiPages(); }
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
  _createPending = false;
  commitAllStagedWikiPages(); // anything staged but never queued (none expected): in place now
  const u = unsyncedWikiPages();
  const synced = _synced;
  const heldRun = _heldRun;
  _synced = 0; // per run: the next run (or wiki-service cycle) counts its own
  _heldRun = 0;
  const hiddenRun = _hiddenRun;
  _hiddenRun = 0;
  if (!u.length) {
    console.log(`[wiki-pages] ${tag}: all ${synced} written page row(s) landed` + (heldRun ? ` (${heldRun} withheld by the database, files left out)` : ""));
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
  return hiddenRun ? EXIT_COMPLETED_WITH_FAILURES : 1;
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
  // rw-wiki-guarded-pages: small chunks (WRITE_CHUNK - 200 long pages ran into the request timeout on the guards' cost and
  // were recorded again as an outage, every cycle), a guard's refusal isolated to its row, and a row a guard withholds or
  // refuses is WITHHELD: out of the record (never retried), recorded as withheld (hash only), and its file - the refused
  // text, which this retry read it from - leaves the vault. Before this, a withheld row counted as landed and kept its file,
  // and one refused row failed its whole chunk, for ever.
  const landedSlugs = [];
  const failedAgain = new Map();
  const heldSlugs = [];
  const rep = await upsertWikiPagesIsolated(batch);
  landedSlugs.push(...rep.written);
  heldSlugs.push(...rep.withheld, ...rep.refused);
  for (const f of rep.failed) failedAgain.set(f.slug, f.error.slice(0, 300));
  for (const s of rep.hidden || []) failedAgain.set(s, "the row was not returned and no guard reported withholding it (row-level security?)");
  const wfile = withheldFileFor(vaultDir);
  if (landedSlugs.length) forgetWithheldPages(landedSlugs, { file: wfile });
  if (heldSlugs.length) {
    const cls = new Map(batch.map((r) => [r.slug, r.page_class]));
    recordWithheldPages(heldSlugs, { file: wfile, pageClassOf: (s) => cls.get(s) || null });
    // round 2 (review B2): only regenerable compile output leaves; an owner's or an AI note keeps its file, recorded only
    for (const slug of heldSlugs) {
      for (const r of [`${slug}.md`, `${slug}/index.md`]) {
        const abs = nodePath.resolve(root, r);
        if (!abs.startsWith(root + nodePath.sep) || !isRegenerable(r)) continue;
        try { fs.unlinkSync(abs); break; } catch { /* next */ }
      }
    }
  }
  // Apply the outcome to the record AS IT IS NOW: an entry is removed only if
  // it is still the one this retry read (a run that re-recorded the slug
  // meanwhile keeps its newer entry); entries recorded meanwhile stay.
  updateUnsynced(file, (rows) => {
    const same = (slug) => rows[slug] && seen[slug] && rows[slug].at === seen[slug].at;
    for (const slug of [...landedSlugs, ...gone, ...rejected, ...heldSlugs]) if (same(slug)) delete rows[slug];
    for (const [slug, error] of failedAgain) if (rows[slug]) rows[slug] = { ...rows[slug], error, at: new Date().toISOString() };
  });
  log(`[wiki-pages] retried ${slugs.length} row(s) left unsynced by a database outage: ${landedSlugs.length} landed, ` +
    `${failedAgain.size} failed again, ${gone.length} dropped (file gone), ${rejected.length} rejected (not a vault slug)` +
    (heldSlugs.length ? `, ${heldSlugs.length} withheld by a privacy guard (not retried, files left out)` : ""));
  const res = { retried: slugs.length, landed: landedSlugs.length, failed: failedAgain.size, dropped: gone.length, rejected: rejected.length };
  return heldSlugs.length ? { ...res, withheld: heldSlugs.length } : res;
}

// Test seam.
export function _resetWikiPagesForTests() {
  _queue.clear();
  _unsynced.clear();
  _withheld.clear();
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
      headers: { ...restAuth(), prefer: "return=representation" },
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
      headers: { ...restAuth(), prefer: "count=exact" },
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

// rw-rest-door-auth: the REST door (openbrain-rest -> PostgREST) refuses a request that does not carry this caller's own
// token - a JWT minted per caller whose role holds only what the caller uses. OPEN_BRAIN_REST_TOKEN, or
// OPEN_BRAIN_SERVICE_KEY (the name the wiki compile hands its child scripts). No token = no header = 401 at the door.
function restAuth() {
  const t = String(process.env.OPEN_BRAIN_REST_TOKEN || process.env.OPEN_BRAIN_SERVICE_KEY || "").trim();
  return t && t !== "local-trust" ? { authorization: `Bearer ${t}` } : {};
}
