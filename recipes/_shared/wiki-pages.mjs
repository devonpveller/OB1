/**
 * wiki-pages — publish what the compiler wrote into the `wiki_pages` table.
 *
 * WHY (wiki-dynamic-index plan, 2026-08-26): Quartz's ContentIndex emitter is
 * the ONLY non-incremental emitter left; it re-walks every page and
 * re-serialises a ~75MB blob on every rebuild, which pinned the rebuild at
 * ~2min and made a new note take minutes to appear. The page prose exists only
 * on disk (the brain has entities + raw thought/source text, not the
 * LLM-written bodies), so the compiler has to PUBLISH what it wrote for the
 * viewer's global indexes (search / nav / graph) to become queries instead of
 * whole-vault walks.
 *
 * Contract:
 *   - `parseWikiPage()` is PURE (frontmatter + links + class) and unit-tested.
 *   - The I/O helpers are BEST-EFFORT: they never throw and never block a
 *     compile. Losing a row costs a stale index entry until the next write or
 *     a backfill — never a failed compile.
 *   - Rows are DERIVED. The markdown on disk stays the source of truth;
 *     `backfill-wiki-pages.mjs` can rebuild the table at any time.
 */

// Vault-relative path (no leading slash, forward slashes) → slug + class.
// Slug matches Quartz's: path minus the .md extension, e.g.
// "content/person/person-ada-lovelace", "notes/my-note", "index".
export function classifySlug(relPath) {
  const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const slug = clean.replace(/\.md$/i, "");
  const parts = slug.split("/");
  if (parts[0] === "notes") return { slug, page_class: "note", entity_type: null };
  if (parts[0] !== "content") return { slug, page_class: "root", entity_type: null };
  const sub = parts[1];
  if (parts.length < 3) return { slug, page_class: "root", entity_type: null };
  // Leaf classes have their own kept-sets in the sweeps; everything else under
  // content/<type>/ is an entity page whose directory IS its entity_type.
  if (sub === "source") return { slug, page_class: "source", entity_type: null };
  if (sub === "thought") return { slug, page_class: "thought", entity_type: null };
  if (sub === "notebook") return { slug, page_class: "notebook", entity_type: null };
  // content/notebooks/<nb>/... = AI-authored notes inside a notebook, not entities.
  if (sub === "notebooks") return { slug, page_class: "note", entity_type: null };
  return { slug, page_class: "entity", entity_type: sub };
}

// Minimal frontmatter reader — only the keys this table stores. Avoids a YAML
// dependency (the recipes are Node-builtins-only by design).
function readFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md || "");
  if (!m) return { fm: {}, body: String(md || "") };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    fm[kv[1]] = v;
  }
  return { fm, body: String(md || "").slice(m[0].length) };
}

function parseTags(raw) {
  if (!raw) return [];
  // Inline list form only — that is what every compiler-written page emits
  // ("tags: [leaf, source]"). Block lists are treated as absent rather than
  // guessed at.
  const m = /^\[(.*)\]$/.exec(String(raw).trim());
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// extractLinks moved to links.mjs (2026-08-28) so the Deno workbench can
// import it without this module's process.env load-time reads. Re-exported
// here so existing consumers keep working. NB: this must be an import + a
// separate export — the `export { x } from "./y.mjs"` form creates NO local
// binding, so parseWikiPage's call threw ReferenceError on every page and the
// mirror silently took zero compiler writes from 08-28 to 09-02.
import { extractLinks } from "./links.mjs";
export { extractLinks };

// PURE: markdown + vault-relative path → the row this page should have.
export function parseWikiPage(relPath, markdown) {
  const { slug, page_class, entity_type } = classifySlug(relPath);
  const { fm, body } = readFrontmatter(markdown);
  return {
    slug,
    page_class,
    entity_type: fm.entity_type || entity_type,
    title: fm.title || slug.split("/").pop() || slug,
    body,
    tags: parseTags(fm.tags),
    links: extractLinks(body),
  };
}

// ── I/O (best-effort; never throws) ────────────────────────────────────────
// Speaks PostgREST like the rest of the recipe layer. Caddy strips auth and
// PostgREST's anon role is service_role, so the apikey is nominal.
const OB_URL = (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const ENABLED = process.env.WIKI_PAGES_SYNC !== "0";
const TIMEOUT_MS = Math.max(1000, Number(process.env.WIKI_PAGES_SYNC_TIMEOUT_MS || "10000"));

let warned = false;
function warnOnce(what, e) {
  if (warned) return;
  warned = true;
  console.error(`[wiki-pages] sync degraded (${what}): ${e?.message || e} — ` +
    `indexes may lag until the next write or backfill (non-fatal)`);
}

async function obFetch(method, pathq, body, headers = {}) {
  const r = await fetch(`${OB_URL}/rest/v1/${pathq}`, {
    method,
    headers: { "content-type": "application/json", apikey: "local-trust", prefer: "return=minimal", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${method} ${pathq}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return true;
}

// Upsert one or many rows. `on_conflict=slug` + merge-duplicates makes this an
// UPSERT; updated_at is refreshed explicitly (the column default only applies
// on INSERT).
export async function upsertWikiPages(rows) {
  if (!ENABLED) return false;
  const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r && r.slug);
  if (!list.length) return true;
  const now = new Date().toISOString();
  try {
    await obFetch(
      "POST",
      "wiki_pages?on_conflict=slug",
      list.map((r) => ({
        slug: r.slug,
        page_class: r.page_class || "root",
        entity_type: r.entity_type ?? null,
        title: r.title || "",
        body: r.body || "",
        tags: r.tags || [],
        links: r.links || [],
        updated_at: now,
      })),
      { prefer: "resolution=merge-duplicates,return=minimal" },
    );
    return true;
  } catch (e) {
    warnOnce("upsert", e);
    return false;
  }
}

// ── Write queue ────────────────────────────────────────────────────────────
// The page writers (generate-wiki, source-leaf, synthesize-notebooks) are
// SHORT-LIVED CLI processes: a fire-and-forget POST would be cut off when the
// process exits. They queue rows synchronously as they write, and flush once
// before returning — which is also one batched request instead of ~50.
const _queue = new Map(); // slug -> row (last write wins)

// Vault-relative path from an absolute one ("/wiki/content/x/y.md" -> "content/x/y.md").
// Returns null for anything OUTSIDE the vault root. That matters: recipes are
// routinely run against a scratch --out-dir (RED/GREEN probes, dry runs), and
// indexing those would write junk slugs like "tmp/greenout/place/x" into the
// table and surface them in search (observed 2026-08-26 while proving P1).
export function vaultRel(absPath, vaultDir = process.env.WIKI_GIT_DIR || "/wiki") {
  const abs = String(absPath || "").replace(/\\/g, "/");
  const root = String(vaultDir).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || !abs.startsWith(root + "/")) return null;
  return abs.slice(root.length + 1);
}

// Sync, no I/O — safe to call from non-async write paths.
export function queueWikiPage(absPath, markdown) {
  try {
    const rel = vaultRel(absPath);
    if (!rel) return; // outside the vault (scratch out-dir) - not a real page
    const row = parseWikiPage(rel, markdown);
    _queue.set(row.slug, row);
  } catch (e) {
    // Never let bookkeeping break a compile — but never swallow it silently
    // either: a parse-path bug here starved the mirror for days with clean
    // "compile ok" logs (the 08-28 extractLinks regression).
    warnOnce("queue", e);
  }
}

export function queuedWikiPageCount() {
  return _queue.size;
}

// Flush the queue. Best-effort; returns the number of rows sent.
export async function flushWikiPages() {
  if (!_queue.size) return 0;
  const rows = [..._queue.values()];
  _queue.clear();
  const CHUNK = 200; // keep request bodies sane on big cold runs
  let sent = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    if (await upsertWikiPages(part)) sent += part.length;
  }
  if (sent) console.log(`[wiki-pages] synced ${sent} page row(s)`);
  return sent;
}

// Convenience for writers that already have the file path + markdown.
export async function syncWikiPage(relPath, markdown) {
  return upsertWikiPages(parseWikiPage(relPath, markdown));
}

// Delete rows for swept/removed pages. Chunked so a big sweep cannot build a
// URL past PostgREST's limits.
export async function deleteWikiPages(slugs) {
  if (!ENABLED) return false;
  const list = [...new Set((slugs || []).filter(Boolean))];
  if (!list.length) return true;
  const CHUNK = 100;
  try {
    for (let i = 0; i < list.length; i += CHUNK) {
      const inList = list
        .slice(i, i + CHUNK)
        .map((s) => `"${String(s).replace(/"/g, '""')}"`)
        .join(",");
      await obFetch("DELETE", `wiki_pages?slug=in.(${encodeURIComponent(inList)})`);
    }
    return true;
  } catch (e) {
    warnOnce("delete", e);
    return false;
  }
}

// Row count, for the per-compile reconciliation log (rows vs files on disk).
// Returns null when unavailable — the caller must not treat that as "0".
// `pageClass` MUST be passed when comparing against a class-specific file
// listing: comparing ALL rows to entity-only files reported a permanent
// false DRIFT (29,658 rows vs 20,101 entity pages) on the first live run.
export async function countWikiPages(pageClass) {
  const filter = pageClass ? `&page_class=eq.${encodeURIComponent(pageClass)}` : "";
  try {
    const r = await fetch(`${OB_URL}/rest/v1/wiki_pages?select=slug&limit=1${filter}`, {
      method: "HEAD",
      headers: { apikey: "local-trust", prefer: "count=exact" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const cr = r.headers.get("content-range");
    const total = cr && cr.includes("/") ? Number(cr.split("/")[1]) : NaN;
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}
