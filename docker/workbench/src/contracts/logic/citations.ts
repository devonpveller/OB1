// Legacy note citations and the reference anchors derived from them (research-workbench P2a).
// PURE: no DB, no vault, no env - runs in the image build test gate.
//
// Before P2a a legacy note's references lived in two readers that disagreed at the edges:
//   - note-refs (GET /workbench/note-refs) listed `added` (frontmatter `sources: [...]`) and
//     `cited` (body links matched by NOTE_REFS_BODY_RE, added ones excluded);
//   - export (GET /workbench/export) numbered citations by first appearance of EXPORT_LINK_RE
//     over the whole file, then the frontmatter sources, and printed a numbered References list.
// Both grammars are kept here VERBATIM (moved from routes/note-refs.ts and routes/export.ts at
// a28e9db), because P2a's acceptance is that a migrated note lists the same references and
// exports the same numbered References section as before. The migration materialises both
// readings into reference_holders (seq = the note-refs order, number = the export number); the
// routes then read the table, and these grammars only reconcile it with the file. The export's
// rendering moved to src/export/ (P6a): citeproc over the holder numbers, a CSL style chosen.

// Unanchored, as both legacy readers used it.
export const UUID_LOOSE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
// A storable id (reference_holders.cited_ref CHECK).
export const UUID_STRICT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// note-refs: source leaves cited in the body: [[content/source/<uuid>|x]] or [[source/<uuid>]]
const NOTE_REFS_BODY_RE = /\[\[[^\]]*source\/([0-9a-fA-F-]{36})/g;
// export: [[...source/<uuid>]] or [[...source/<uuid>|alias]]
export const EXPORT_LINK_RE = /\[\[([^\]|]*?source\/([0-9a-fA-F-]{36}))(?:\|([^\]]+))?\]\]/g;

export function splitFrontmatter(content: string): { fm: string; body: string } {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      const nl = content.indexOf("\n", end + 4);
      const fmEnd = nl === -1 ? content.length : nl + 1;
      return { fm: content.slice(0, fmEnd), body: content.slice(fmEnd) };
    }
  }
  return { fm: "", body: content };
}

// The frontmatter `sources: [...]` list, as note-refs read it (export read the same line with
// the same filter, see the conformance test). Duplicates are kept: the legacy readers kept them.
export function frontmatterSources(content: string): string[] {
  const m = splitFrontmatter(content).fm.match(/^sources:\s*\[([^\]]*)\]\s*$/m);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => UUID_LOOSE.test(s));
}

// note-refs `cited`: body links in first-appearance order, de-duplicated, minus `added`.
export function noteRefsCited(content: string, added: string[]): string[] {
  const { body } = splitFrontmatter(content);
  const addedSet = new Set(added);
  const cited: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(NOTE_REFS_BODY_RE.source, "g");
  while ((m = re.exec(body))) {
    const u = m[1];
    if (!addedSet.has(u) && !cited.includes(u)) cited.push(u);
  }
  return cited;
}

// export numbering: cited links (whole file) by first appearance, then the added list.
export function exportOrder(content: string, added: string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const enrol = (u: string) => {
    if (UUID_LOOSE.test(u) && !seen.has(u)) {
      seen.add(u);
      order.push(u);
    }
  };
  let m: RegExpExecArray | null;
  const re = new RegExp(EXPORT_LINK_RE.source, "g");
  while ((m = re.exec(content))) enrol(m[2]);
  added.forEach(enrol);
  return order;
}

// What a legacy note holds, in the shape reference_holders stores: one entry per id, `seq` the
// note-refs listing order (added, then cited), `number` the export citation number or null.
export interface PlannedHolder {
  cited_ref: string;
  origin: "added" | "cited"; // keys of the reference_origins registry
  seq: number;
  number: number | null;
}

export interface HolderPlan {
  holders: PlannedHolder[];
  // ids the legacy readers saw that cannot be stored as an id (not uuid-shaped): the legacy
  // resolver failed on them (a SQL cast error emptied its whole list), so a note carrying one
  // cannot be migrated faithfully - the migration refuses it and says why.
  unstorable: string[];
}

export function planLegacyHolders(content: string, added: string[]): HolderPlan {
  const cited = noteRefsCited(content, added);
  const numbered = exportOrder(content, added);
  const numberOf = new Map(numbered.map((u, i) => [u, i + 1]));
  const out: PlannedHolder[] = [];
  const seen = new Set<string>();
  const unstorable: string[] = [];
  const push = (u: string, origin: "added" | "cited") => {
    if (seen.has(u)) return;
    seen.add(u);
    if (!UUID_STRICT.test(u)) {
      unstorable.push(u);
      return;
    }
    out.push({ cited_ref: u, origin, seq: out.length, number: numberOf.get(u) ?? null });
  };
  for (const u of added) push(u, "added");
  for (const u of cited) push(u, "cited");
  for (const u of numbered) push(u, "cited");
  return { holders: out, unstorable };
}

// ── whole-source anchors ─────────────────────────────────────────────────────────────────
// A legacy note cites a source as a whole. Its reference still needs a quote (P2a acceptance 2),
// so the quote is the OPENING of the pinned revision's text: up to QUOTE_MAX characters from the
// first non-blank one, cut back to a word boundary, with the 32 characters around it as prefix
// and suffix, and its offsets as the position selector. For a content type the selector
// registry marks as needing page+quad (pdf), the anchor is page 1, the whole page.
export const QUOTE_MAX = 160;
const CONTEXT = 32;

export interface AnchorText {
  text: string;
  field: "content" | "title"; // which text the offsets index (title only when the content is empty)
}

export function anchorText(content: string | null, title: string | null): AnchorText | null {
  if (content && content.trim()) return { text: content, field: "content" };
  if (title && title.trim()) return { text: title, field: "title" };
  return null;
}

export function wholeSourceQuote(a: AnchorText) {
  const t = a.text;
  const start = t.search(/\S/);
  let end = Math.min(t.length, start + QUOTE_MAX);
  if (end < t.length) {
    const ws = t.lastIndexOf(" ", end);
    if (ws > start + QUOTE_MAX / 2) end = ws;
  }
  while (end > start && /\s/.test(t[end - 1])) end--;
  return {
    quote: { exact: t.slice(start, end), prefix: t.slice(Math.max(0, start - CONTEXT), start), suffix: t.slice(end, end + CONTEXT) },
    position: { start, end, ...(a.field === "title" ? { field: "title" } : {}) },
  };
}

export const WHOLE_PAGE_QUAD = [0, 0, 1, 0, 1, 1, 0, 1];

// The deriver per selector kind. A selector kind registered later that is REQUIRED for a content
// type needs its deriver here (registration = the entry plus its rule, D18); without one the
// derivation fails loudly rather than storing a reference the trigger would refuse.
export function deriveWholeSourceSelectors(a: AnchorText, requiredKinds: string[]): Record<string, unknown> {
  const { quote, position } = wholeSourceQuote(a);
  const out: Record<string, unknown> = { quote, position };
  for (const k of requiredKinds) {
    if (k === "quote" || k === "position") continue;
    if (k === "pdf") out.pdf = { page: 1, quads: [WHOLE_PAGE_QUAD] };
    else throw new Error(`no whole-source deriver for the required selector kind '${k}'`);
  }
  return out;
}

// Which selector kinds the registry requires for a content type (mirrors the trigger's rule).
export function requiredSelectorKinds(
  entries: { key: string; definition: Record<string, unknown>; retired_at?: string | null }[],
  contentType: string | null,
): string[] {
  return entries.filter((e) => !e.retired_at).filter((e) => {
    const d = e.definition ?? {};
    if (d.required === "always") return true;
    const types = Array.isArray(d.required_for_content_types) ? d.required_for_content_types as string[] : [];
    return contentType !== null && types.includes(contentType);
  }).map((e) => e.key).sort();
}

// The first chunk whose text contains the quote (the span reanchor rule, used when a reference
// is placed without a chunk_idx). Chunks in idx order.
export function chunkContaining(chunks: { idx: number; content: string }[], exact: string): number | null {
  for (const c of chunks) if (c.content.includes(exact)) return c.idx;
  return null;
}
