// rwr-source-reader-api: the two derivations the reader needs, as pure functions.
//
// The database stores neither a section name nor a claim-to-passage link nor a quote span (see the findings):
//   source_chunks (source_id, idx, content, embedding)       - no heading, no offset
//   claim_sources (claim, source, edge_type, weight)         - the claim is tied to the source, never to a chunk
// So both are DERIVED, deterministically and with no model call, from the text itself:
//   sectionsFor - the markdown headings of the source text, and the heading in force at each chunk's start;
//   placeClaim  - the chunk a claim's own words are found in: verbatim (with a span) or by word overlap (no span).
// A span, when given, is a character range of THAT CHUNK'S content as returned (start inclusive, end exclusive).

export interface ReaderChunk {
  idx: number;
  content: string;
}
export interface SectionInfo {
  name: string;
  level: number;
  first_chunk_idx: number | null;
}
export interface Placement {
  idx: number;
  span: { start: number; end: number } | null;
  overlap: number; // the share of the claim's words found in the chunk (1 for a verbatim match)
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const MAX_NAME = 200;

// whitespace runs -> one space; returns the collapsed text and, for each original index, its collapsed index
function collapse(s: string): { text: string; at: number[] } {
  const at = new Array<number>(s.length + 1);
  let out = "";
  let space = true; // leading whitespace is dropped
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    at[i] = out.length;
    if (/\s/.test(ch)) {
      if (!space) {
        out += " ";
        space = true;
      }
    } else {
      out += ch;
      space = false;
    }
  }
  at[s.length] = out.length;
  return { text: out.trimEnd(), at };
}

export function sectionsFor(content: string, chunks: ReaderChunk[]): { sections: SectionInfo[]; chunkSection: (string | null)[] } {
  const text = String(content ?? "").replace(/\r\n/g, "\n");
  const col = collapse(text);
  // headings with their collapsed position, outside code fences
  const heads: { name: string; level: number; pos: number }[] = [];
  let off = 0;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = HEADING.exec(line);
      if (m && m[2].trim()) heads.push({ name: m[2].trim().slice(0, MAX_NAME), level: m[1].length, pos: col.at[off] });
    }
    off += line.length + 1;
  }
  // where each chunk starts in the collapsed text (chunks are slices of the text; consecutive chunks overlap)
  const starts: (number | null)[] = [];
  const lens: number[] = [];
  let cursor = 0;
  let last: number | null = null;
  for (const ch of chunks) {
    const c = collapse(ch.content).text;
    let p = c ? col.text.indexOf(c, cursor) : -1;
    if (p < 0 && c) p = col.text.indexOf(c); // the cursor lost its place (a repeated phrase earlier)
    starts.push(p < 0 ? null : p);
    lens.push(c.length);
    if (p >= 0) {
      last = p;
      cursor = p + 1;
    }
  }
  void last;
  const chunkSection: (string | null)[] = [];
  let carried: string | null = null;
  for (const s of starts) {
    if (s !== null) {
      let cur: string | null = null;
      for (const h of heads) if (h.pos <= s) cur = h.name;
      carried = cur;
    }
    chunkSection.push(carried);
  }
  const sections: SectionInfo[] = heads.map((h) => {
    let first: number | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const s = starts[i];
      if (s !== null && s <= h.pos && h.pos < s + Math.max(1, lens[i])) {
        first = i;
        break;
      }
    }
    return { name: h.name, level: h.level, first_chunk_idx: first === null ? null : chunks[first].idx };
  });
  return { sections, chunkSection };
}

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const OVERLAP_FLOOR = 0.6;
const MIN_WORDS = 3;

export function placeClaim(claimText: string, chunks: ReaderChunk[]): Placement | null {
  const claim = String(claimText ?? "").trim();
  if (!claim || !chunks.length) return null;
  const re = new RegExp(claim.split(/\s+/).map(escapeRe).join("\\s+"), "iu");
  for (const ch of chunks) {
    const m = re.exec(ch.content);
    if (m) return { idx: ch.idx, span: { start: m.index, end: m.index + m[0].length }, overlap: 1 };
  }
  const want = [...new Set(words(claim))];
  if (want.length < MIN_WORDS) return null;
  let best: Placement | null = null;
  for (const ch of chunks) {
    const have = new Set(words(ch.content));
    const share = want.filter((w) => have.has(w)).length / want.length;
    if (share >= OVERLAP_FLOOR && (!best || share > best.overlap)) best = { idx: ch.idx, span: null, overlap: Math.round(share * 1000) / 1000 };
  }
  return best;
}
