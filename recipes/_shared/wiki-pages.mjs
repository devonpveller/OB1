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
 *   - The markdown on disk is the durable copy the same compile writes (git
 *     vault, backups); `reconcile-wiki-pages.mjs` measures files vs rows and
 *     repairs drift on (re)connect.
 */
import { extractLinks } from "./links.mjs";
import { classify } from "./page-classes.mjs";
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
// generated from rows, so the row must carry them.
const TAG_RE = /(?<=^| )#((?:[-_\p{L}\p{Emoji}\p{M}\d])+(?:\/[-_\p{L}\p{Emoji}\p{M}\d]+)*)/gu;
const slugTagSeg = (s) => s.replace(/\s/g, "-").replace(/&/g, "-and-").replace(/%/g, "-percent").replace(/\?/g, "").replace(/#/g, "");
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

// ── the run's write queue and its unsynced ledger ──────────────────────────
const _queue = new Map();     // slug -> row (last write wins)
const _unsynced = new Map();  // slug -> error (the page's file exists; its row did not land)
let _synced = 0;

// Vault-relative path from an absolute one; null OUTSIDE the vault root (a
// scratch --out-dir must never write junk slugs, observed 2026-08-26).
export function vaultRel(absPath, vaultDir = process.env.WIKI_GIT_DIR || "/wiki") {
  const abs = String(absPath || "").replace(/\\/g, "/");
  const root = String(vaultDir).replace(/\\/g, "/").replace(/\/+$/, "");
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
export async function finishWikiPages(tag = "compile") {
  await flushWikiPages();
  const u = unsyncedWikiPages();
  if (!u.length) {
    console.log(`[wiki-pages] ${tag}: all ${_synced} written page row(s) landed`);
    return 0;
  }
  const first = u.slice(0, 10).map((x) => x.slug).join(", ");
  console.error(`[wiki-pages] ${tag} FAILED: ${u.length} page(s) UNSYNCED (file written, row did not land); first: ${first}; error: ${u[0].error}`);
  return 1;
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
