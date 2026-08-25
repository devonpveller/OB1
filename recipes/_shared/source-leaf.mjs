/**
 * Canonical source-leaf renderer.
 *
 * A "source leaf" is the page `content/source/<uuid>.md` that the entity wiki
 * and notebook hubs link to via `[[content/source/<uuid>|Sn]]`. TWO emitters
 * write these files in a single compile:
 *   - entity-wiki/generate-wiki.mjs (emitLeafPages) — sources cited by an
 *     ENTITY page this run.
 *   - wiki-synthesis/scripts/synthesize-notebooks.mjs — sources cited by a
 *     notebook HUB (web_articles attached to a notebook but never extracted
 *     into an entity page would otherwise have NO leaf → the [Sn] link 404s).
 *
 * A source cited by BOTH paths must render byte-identically, or every compile
 * churns the file (whichever emitter runs last wins). Keeping the renderer here,
 * used by both, makes that impossible. The orphan sweep in
 * docker/wiki-service/wiki-service.mjs keeps any leaf referenced by a
 * `[[content/source/<uuid>]]` link, so hub-only leaves survive once emitted.
 */
import fs from "node:fs";
import path from "node:path";
import { rewriteResearchCitations } from "./citations.mjs";
import { writeIfChanged } from "./write-if-changed.mjs";
import { clip } from "./clip.mjs";

// YAML-safe scalar (quoted JSON string — handles colons, quotes, emoji).
export function frontmatterScalar(v) {
  return JSON.stringify(v == null ? "" : String(v));
}

// Untrusted-content hardening for snippet bodies. Byte-identical in effect to
// entity-wiki's scrubSnippetContent: drop control chars (keep tab 9 / LF 10 /
// CR 13, and everything above 31 except DEL 127), then neutralize tag-injection
// and flag common prompt-injection phrases in-place (visible, not silent).
export function scrubSnippetContent(raw) {
  if (raw == null) return "";
  let stripped = "";
  for (const ch of String(raw)) {
    const n = ch.codePointAt(0);
    if (n === 9 || n === 10 || n === 13 || (n > 31 && n !== 127)) stripped += ch;
  }
  return stripped
    // Scraped pages carry ad pixels, trackers, and scripts. A private wiki must
    // never auto-fire them or leak the reader's IP, so neutralize every external
    // resource load: drop <script>/<style> blocks and standalone resource tags,
    // and turn markdown images into non-loading links (click to view, never auto-GET).
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "[$1 removed]")
    .replace(/<\s*\/?\s*(img|iframe|script|style|link|source|video|audio|embed|object|track)\b[^>]*>/gi, "[$1 removed]")
    // Linked image — `[![alt](img)](href)` (README badges, newsletter tracking
    // pixels wrapped in a link). Drop the auto-loading image URL, keep ONLY the
    // outer link. MUST run before the standalone-image rule: otherwise that rule
    // rewrites the inner `![alt](img)` into `[image: alt](img)`, and the outer
    // `[` then forms a stray `[[image:` that Quartz mis-parses as a wikilink and
    // leaks as literal text into the page.
    .replace(/\[!\[([^\]]*)\]\([^)]*\)\]\(\s*(https?:[^)\s]+)[^)]*\)/gi, "[image: $1]($2)")
    .replace(/!\[([^\]]*)\]\(\s*(https?:[^)\s]+)[^)]*\)/gi, "[image: $1]($2)")
    .replace(/<\s*\/?\s*(thought|source)\b[^>]*>/gi, "[$1-tag-redacted]")
    .replace(/ignore\s+(all\s+)?previous\s+instructions?/gi, "[redacted injection attempt]")
    .replace(/disregard\s+(the\s+)?above/gi, "[redacted injection attempt]")
    .replace(/new\s+instructions\s*:/gi, "[redacted injection attempt]");
}

// Cap pathologically large source bodies before they reach Quartz. The OWUI
// knowledge-collection migration imported whole chat-history / document dumps as
// single "sources" (some 12-17MB, 300k+ lines); Quartz's regex markdown/wikilink
// parsers backtrack catastrophically on multi-megabyte content and HANG the
// whole build (one bad file pins a worker at 100% CPU forever). A leaf page is a
// readable preview, not a full archive — truncate with a visible notice. 128KB
// is far larger than any real article yet safely below the megabyte scale that
// bombs the parser.
const MAX_LEAF_CHARS = 131072;
export function capLeafContent(raw) {
  const s = String(raw == null ? "" : raw);
  if (s.length <= MAX_LEAF_CHARS) return s;
  const droppedMb = ((s.length - MAX_LEAF_CHARS) / 1048576).toFixed(1);
  return (
    // clip: surrogate-safe cut (never end mid-emoji — see _shared/clip.mjs).
    clip(s, MAX_LEAF_CHARS) +
    `\n\n*[… truncated ${droppedMb} MB — this source exceeds the wiki page display limit; ` +
    `open the original source for the full content …]*\n`
  );
}

// Raw article text must never form INTERNAL markdown links. Fragments shaped
// like "[% ... %] (x)" parse as [text](target); a target with a bare "%"
// throws "URI malformed" inside the viewer's link transformer (2026-08-25: ONE
// Template-Toolkit man-page leaf crash-looped the whole builder and froze
// snapshot publishing). Break the "](": adjacency unless the target is an
// absolute http(s) URL — scrubSnippetContent deliberately emits
// "[image: …](https://…)" links, which stay clickable.
export function breakAccidentalLinks(s) {
  return String(s ?? "").replace(/\]\((?!https?:\/\/)/g, "] (");
}

// Render one source row → the full `content/source/<id>.md` file body.
// Expects: { id, title?, url?, content?, content_type?, notebook?, created_at? }.
export function renderSourceLeaf(r) {
  const date = String(r.created_at || "").slice(0, 10);
  const title = r.title || r.url || `Source ${r.id}`;
  const md = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
  const prose = r.content_type === "research_synthesis" ? String(md.prose_synthesis || "").trim() : "";

  const head = [
    "---",
    `title: ${frontmatterScalar(title)}`,
    "type: source", // P0.6/G12 leaf id contract = type + id
    `id: ${frontmatterScalar(r.id)}`,
    ...(date ? [`date: ${date}`] : []),
    ...(r.url ? [`url: ${frontmatterScalar(r.url)}`] : []),
    ...(r.content_type ? [`content_type: ${frontmatterScalar(r.content_type)}`] : []),
    ...(md.report_type ? [`report_type: ${frontmatterScalar(md.report_type)}`] : []),
    ...(r.notebook ? [`notebook: ${frontmatterScalar(r.notebook)}`] : []),
    "tags: [leaf, source]",
    "---",
    "",
    `# ${scrubSnippetContent(title)}`,
    "",
  ];

  let body;
  if (prose) {
    // Research synthesis: the READABLE prose is the page. Rewrite its [Source N]
    // citations into clickable source-leaf wikilinks (N → source_ids[N-1], the
    // curator's persisted citation order). The grounded one-claim-per-line
    // evidence is kept verbatim in a collapsible callout below (audit trail);
    // the research questions are surfaced as breadcrumbs.
    // Shared tolerant rewrite: also handles the grouped forms the renderer
    // deliberately emits ([Source 1, 3]) and model variants ([Sources 1 and 2]),
    // which the old single-number regex left raw and unlinked.
    const sids = Array.isArray(md.source_ids) ? md.source_ids : [];
    const linked = rewriteResearchCitations(scrubSnippetContent(prose), sids);
    const origQ = String(r.research_query || "").trim();
    const needs = Array.isArray(md.needs) ? md.needs.filter(Boolean) : [];
    const follow = Array.isArray(md.followup_queries) ? md.followup_queries.filter(Boolean) : [];
    const qs = [];
    if (origQ || needs.length || follow.length) {
      qs.push("## Research questions", "");
      if (origQ) qs.push(`**Original question:** ${scrubSnippetContent(origQ)}`, "");
      if (needs.length) qs.push("**Sub-questions explored:**", ...needs.map((x) => `- ${scrubSnippetContent(String(x))}`), "");
      if (follow.length) qs.push("**Follow-up queries:**", ...follow.map((x) => `- ${scrubSnippetContent(String(x))}`), "");
    }
    const ev = breakAccidentalLinks(scrubSnippetContent(capLeafContent(r.content))).trim();
    const evidence = ev
      ? [
          "> [!note]- Evidence — the grounded claims &amp; gaps this synthesis is built from",
          ...ev.split("\n").map((l) => `> ${l}`),
          "",
        ]
      : [];
    body = [linked, "", ...qs, ...evidence];
  } else {
    body = [
      ...(r.url ? [`Source: ${scrubSnippetContent(r.url)}`, ""] : []),
      breakAccidentalLinks(scrubSnippetContent(capLeafContent(r.content))),
      "",
    ];
  }

  return [...head, ...body].join("\n") + "\n";
}

// Write `content/source/<id>.md` for each row under `<outDir>/source/`.
// Idempotent (same row → same bytes), and an unchanged leaf is not rewritten
// (no mtime bump → the viewer's watcher stays quiet). Returns the count of
// files actually written.
export function writeSourceLeaves(rows, outDir) {
  if (!rows || !rows.length) return 0;
  const dir = path.join(outDir, "source");
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (writeIfChanged(path.join(dir, `${r.id}.md`), renderSourceLeaf(r))) n++;
  }
  return n;
}
