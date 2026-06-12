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
    const sids = Array.isArray(md.source_ids) ? md.source_ids : [];
    const linked = scrubSnippetContent(prose).replace(/\[Source\s+(\d+)\]/g, (m, n) => {
      const id = sids[parseInt(n, 10) - 1];
      return id ? `[[content/source/${id}|Source ${n}]]` : m;
    });
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
    const ev = scrubSnippetContent(r.content || "").trim();
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
      scrubSnippetContent(r.content || ""),
      "",
    ];
  }

  return [...head, ...body].join("\n") + "\n";
}

// Write `content/source/<id>.md` for each row under `<outDir>/source/`.
// Idempotent (same row → same bytes). Returns the count written.
export function writeSourceLeaves(rows, outDir) {
  if (!rows || !rows.length) return 0;
  const dir = path.join(outDir, "source");
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const r of rows) {
    if (!r || !r.id) continue;
    fs.writeFileSync(path.join(dir, `${r.id}.md`), renderSourceLeaf(r), "utf8");
    n++;
  }
  return n;
}
