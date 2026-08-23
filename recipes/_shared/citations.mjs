/**
 * Canonical citation rewriting — the SINGLE grammar for turning LLM-emitted
 * citation markers into Quartz wikilinks. Shared by:
 *   - entity-wiki/generate-wiki.mjs   (entity pages: [S1] / [#11173])
 *   - wiki-synthesis/synthesize-notebooks.mjs (notebook hubs: [S1], legacy [S:<uuid>])
 *   - _shared/source-leaf.mjs         (research reports: [Source N])
 *
 * Design contract (quartz-4-expansion-plan.md Phase 1): the model NEVER sees
 * or emits UUIDs — it cites short per-page tokens (S1, S2, …) resolved through
 * a deterministic token→UUID map at rewrite time. A marker that cannot be
 * resolved is LEFT AS PLAIN TEXT (mirroring broken-[[wikilink]] handling) —
 * never linked speculatively, never dropped.
 *
 * 2026-08-23: extracted from generate-wiki.mjs and extended with the
 * multi-marker bracket groups the models actually emit — `[S1, S3]`,
 * `[Source 1, 2]`, `[Sources 1 and 2]` — which the old single-marker regexes
 * silently skipped, leaving raw unlinked citations in rendered pages (the
 * reported production symptom). Legacy `[S:<uuid>]` markers (pre-2026-06-05
 * pages, and a hedge against model habit) resolve through the same map.
 */

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

// Split out fenced/inline code so markers inside code are never rewritten.
const PROTECTED_RE = /(```[\s\S]*?```|`[^`]*`)/g;

function mapSegments(markdown, fn) {
  const parts = String(markdown).split(PROTECTED_RE);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // protected code span — leave as-is
    parts[i] = fn(parts[i]);
  }
  return parts.join("");
}

// Make a string safe as a wikilink alias / label ([, ], | break the link).
export function linkSafeLabel(v) {
  return String(v == null ? "" : v)
    .replace(/[\[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// P1.3/1.4 — turn inline citations into real internal wikilinks so native
// Quartz popover + SPA + backlinks + search apply with no custom interaction
// code:
//   [#<digits>]  → #[[content/thought/<digits>|<digits>]]
//   [S<n>]       → [[content/source/<uuid>|S<n>]]     (token→UUID map)
//   [S1, S3]     → [[…|S1]], [[…|S3]]                 (group form)
//   [S:<uuid>]   → [[content/source/<uuid>|S<n>]]     (legacy; only KNOWN uuids)
// The ids actually turned into links are accumulated into `run` so the caller
// emits exactly the cited leaves and the sweep removes the rest (P1.1/1.5).
// Idempotent and conservative: fenced/inline code is protected; the "#" stays
// OUTSIDE the thought wikilink (a "#"-leading alias breaks Quartz's parser).
export function rewriteCitations(markdown, validThoughtIds, sourceTokenMap, run) {
  const uuidToToken = new Map();
  for (const [token, uuid] of sourceTokenMap) {
    uuidToToken.set(String(uuid).toLowerCase(), token);
  }
  const linkToken = (token) => {
    const uuid = sourceTokenMap.get(token);
    if (!uuid) return token; // mis-cite — plain text
    run.citedSourceIds.add(uuid);
    return `[[content/source/${uuid}|${token}]]`;
  };
  return mapSegments(markdown, (seg) => {
    // Legacy / habit: [S:<uuid>] and grouped [S:<uuid>, S:<uuid>]. Only KNOWN
    // uuids link (aliased to their stable Sn token); unknown uuids stay plain
    // text — NEVER speculatively linked (a broken leaf link is worse than an
    // unlinked marker).
    seg = seg.replace(/\[\s*S:[^[\]]*\]/g, (m) => {
      const uuids = m.match(UUID_RE) || [];
      if (!uuids.length || !uuids.some((u) => uuidToToken.has(u.toLowerCase()))) return m;
      const rendered = uuids.map((u) => {
        const token = uuidToToken.get(u.toLowerCase());
        if (!token) return `S:${u}`;
        run.citedSourceIds.add(sourceTokenMap.get(token));
        return `[[content/source/${sourceTokenMap.get(token)}|${token}]]`;
      });
      return `[${rendered.join(", ")}]`;
    });
    // Grouped tokens: [S1, S3] / [S1,S3] / [S1 and S3] / [S1 & S3].
    seg = seg.replace(/\[(S\d+(?:\s*(?:,|and|&)\s*S\d+)+)\]/g, (_m, inner) => {
      const tokens = inner.match(/S\d+/g) || [];
      return `[${tokens.map(linkToken).join(", ")}]`;
    });
    // Sources: [S1], [S2], … — resolve token→UUID; unknown token → plain text.
    seg = seg.replace(/\[S(\d+)\]/g, (m, n) => {
      const uuid = sourceTokenMap.get(`S${n}`);
      if (!uuid) return m; // mis-cite — leave as plain text
      run.citedSourceIds.add(uuid);
      return `[[content/source/${uuid}|S${n}]]`;
    });
    // Thoughts: [#11173] — literal id; not-on-this-page id → plain text.
    seg = seg.replace(/\[#(\d+)\]/g, (m, d) => {
      if (!validThoughtIds.has(Number(d))) return m;
      run.citedThoughtIds.add(Number(d));
      return `#[[content/thought/${d}|${d}]]`;
    });
    return seg;
  });
}

// Research-report citations on source-leaf pages: `[Source N]` where
// N → sourceIds[N-1] (the curator's persisted citation order). Handles the
// grouped forms the report renderer deliberately emits (`[Source 1, 3]`) and
// the model variants lib.ts documents (`[Sources 1 and 2]`). A number with no
// backing id stays plain text inside the bracket.
export function rewriteResearchCitations(text, sourceIds) {
  const sids = Array.isArray(sourceIds) ? sourceIds : [];
  return mapSegments(text, (seg) =>
    seg.replace(/\[Sources?\s+\d+(?:\s*(?:,|and|&)\s*\d+)*\]/gi, (m) => {
      const nums = m.match(/\d+/g) || [];
      const rendered = nums.map((n) => {
        const id = sids[parseInt(n, 10) - 1];
        return id ? `[[content/source/${id}|Source ${n}]]` : `Source ${n}`;
      });
      return `[${rendered.join(", ")}]`;
    }),
  );
}
