// The pandoc INPUT, prepared from the note (research-workbench P6a; rw-p6a-resolve attempt 3 moved it
// here from render.ts so the parser's worker - prepare_worker.ts - loads only what it needs). PURE: no
// file, no process. What it guarantees is described in markdown.ts; render.ts runs it in the worker.
import { EXPORT_LINK_RE, splitFrontmatter } from "../contracts/logic/citations.ts";
import { renderSafeCsl } from "./csl.ts";
import { checkSourceLimits, checkTreeLimits, cleanTree, DEFAULT_LIMITS, type Limits, parseMarkdown, serialiseMarkdown, type Wikilink } from "./markdown.ts";
import { defang } from "./schemes.ts";
import type { FormatDef, RefItem } from "./render.ts";

// A body link the numbering does not know (an id that is not a uuid, on a page that is not a
// holder): never rendered as text, the export refuses it.
export class UnnumberedCitation extends Error {}

export const citeKey = (citedRef: string) => `src-${citedRef.toLowerCase()}`;

// A frontmatter value handed to pandoc as metadata, made LITERAL: pandoc reads metadata strings as
// markdown, so every ASCII punctuation character is backslash-escaped (all_symbols_escapable) and
// whitespace collapsed. `@me`, `[@you]`, `#set`, `$x$`, `\`, `*`, `_`, `<b>` print as written; the
// Typst writer then escapes the text for Typst as it does any text.
export const literalMarkdown = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[!-/:-@[-`{-~]/g, "\\$&");

// The scalar title of the note's frontmatter (`title: x` / `title: "x"`). The frontmatter is NOT
// handed to pandoc: its keys could name files pandoc would read (bibliography, csl,
// citation-abbreviations) or carry references of their own. Only the title is, made literal.
export function frontmatterTitle(fm: string): string | null {
  const m = /^title:[ \t]*(.+?)[ \t]*$/m.exec(fm);
  if (!m) return null;
  const v = m[1].replace(/^(["'])(.*)\1$/, "$2").trim();
  return v || null;
}

export interface Prepared {
  markdown: string;
  metadata: Record<string, unknown>;
  references: Record<string, unknown>[]; // the CSL-JSON bibliography, in number order
  title: string | null; // as written (the metadata carries it escaped)
  cited: string[]; // keys cited in the body, first appearance
  nocite: string[]; // numbered keys the body does not cite (the added references), by number
  text: string[]; // what the document draws (the glyph check): the parsed text, the title, the references
  dropped: { links: number; images: number; html: number; attributes: number };
}

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
};

// A nonce of letters only: the wikilink tokens are words the parser and the writer leave alone.
const nonce = () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => String.fromCharCode(97 + (b % 16))).join("");

// The pandoc input: the note's body parsed and cleaned (markdown.ts); source wikilinks become
// citations of their references' keys, other wikilinks their text; the numbered references not
// cited in the body are `nocite`d in number order, so citeproc's order (first citation, then nocite)
// is the holder order. Throws TooComplex past a limit, UnnumberedCitation for a source link the
// numbering does not know.
export function prepareDocument(md: string, refs: RefItem[], format: FormatDef, limits: Limits = DEFAULT_LIMITS): Prepared {
  const { fm, body } = splitFrontmatter(md);
  checkSourceLimits(body, limits);
  const byId = new Map(refs.map((r) => [r.key, r]));
  const n = nonce();
  const links: Wikilink[] = [];
  const tok = (w: Wikilink) => `zwl${n}q${links.push(w) - 1}z`;
  const src = body
    .replace(new RegExp(EXPORT_LINK_RE.source, "g"), (full, _target, uuid, alias) => {
      const key = citeKey(uuid);
      if (!byId.has(key)) throw new UnnumberedCitation(`export refused: the document links source/${uuid}, which is not a citable source id`);
      return tok({ original: full, cite: key, text: (alias || "").trim() });
    })
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (full, _a, b) => tok({ original: full, text: String(b) }))
    .replace(/\[\[([^\]]+)\]\]/g, (full, t) => tok({ original: full, text: String(t).split("/").pop() || String(t) }));
  const tree = parseMarkdown(src);
  checkTreeLimits(tree, limits);
  const c = cleanTree(tree, src, links, new RegExp(`zwl${n}q(\\d+)z`, "g"), (i) => `zwc${n}q${i}z`);
  let out = serialiseMarkdown(c.tree);
  for (const [marker, cite] of c.markers) out = out.replaceAll(marker, cite);
  const cited = c.cited;
  const nocite = refs.filter((r) => !cited.includes(r.key)).sort((a, b) => a.number - b.number).map((r) => r.key);
  const title = frontmatterTitle(fm);
  const shownTitle = title ? defang(title) : null;
  const metadata: Record<string, unknown> = {
    ...(format.metadata ?? {}),
    ...(shownTitle ? { title: literalMarkdown(shownTitle) } : {}),
    lang: "en",
    "reference-section-title": "References",
    "link-citations": false,
    ...(nocite.length ? { nocite: nocite.map((k) => `@${k}`).join(" ") } : {}),
  };
  const references = [...refs].sort((a, b) => a.number - b.number).map((r) => ({ ...renderSafeCsl(r.csl), id: r.key }));
  return {
    markdown: out, metadata, references, title, cited, nocite, dropped: c.dropped,
    text: [...c.text, shownTitle ?? "", "References", ...references.flatMap((r) => strings(r))],
  };
}
