// The note's markdown as a PARSED DOCUMENT (rw-p6a-resolve attempt 3). PURE: no file, no process.
//
// Attempt 2's defences were regular expressions over the raw markdown text, and pandoc's grammar is
// wider than every one of them: a link whose text ran over two lines, held a code span or a nested
// parenthesis, a reference definition or a destination on the next line all reached the DOCX and
// the PDF as `javascript:` targets; a `{onclick=..}` after a link survived into the MD; `$..$`
// stripped from the raw text hid a character inside a code span from the glyph check. Here the note
// is parsed into a syntax tree (mdast, by micromark - CommonMark + the GFM table, footnote,
// strikethrough and task-list extensions + `$` math; MIT, pinned in deno.json/deno.lock, noticed in
// THIRD-PARTY-NOTICES.md), the tree is cleaned NODE BY NODE, and the tree is written back to
// markdown for pandoc by mdast-util-to-markdown, which escapes every character of a text node that
// could start markup. pandoc stays a separate process that reads markdown and writes a file
// (acceptance 5): no filter, no JSON AST.
//
// What the cleaning guarantees about the markdown pandoc reads:
//   - every link, autolink and reference target is http(s) or mailto (attempt 4: a fragment or a
//     relative path link is rendered as its text), an image's a relative path inside the vault or
//     an inline raster `data:image/...`; any other target is dropped and the link keeps its text
//     (an image its alt text, an autolink "(link removed)"); reference
//     definitions are resolved here and removed, so pandoc sees no definition at all;
//   - no raw HTML node (dropped, its text kept where it was text), no attribute block: a `{...}` right
//     after a link, an image or a code span, a heading's trailing `{...}` and a fenced code block's
//     info string other than a plain language name are removed;
//   - text is TEXT: `[`, `<`, `*`, `_`, `` ` ``, `$`, `@` and `{` are escaped, so pandoc cannot build
//     a link, a raw node, a citation or an attribute from it; `$...$` stays math only where pandoc
//     itself reads math (no space inside the dollars, no digit after, no `$` inside), otherwise it is
//     text; display math holds no blank line;
//   - an unsafe-scheme string written as text (`javascript:`, `vbscript:`, `data:<type>/`, `file://`)
//     is defanged to `javascript[:]` so no reader can make it a link;
//   - the source wikilinks become citations of their reference keys (the only `[@key]` pandoc sees),
//     other wikilinks their text; inside code a wikilink stays as written.
// Limits (attempt 3, the tester's near-miss 1: 20 000 nested brackets held pandoc for 180 s): the
// note's size, its bracket nesting, and the tree's depth and list depth are checked BEFORE pandoc
// runs; past a limit the export is refused 422 `too-complex`, naming the limit.
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown, gfmTableToMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown, gfmTaskListItemToMarkdown } from "mdast-util-gfm-task-list-item";
import { math } from "micromark-extension-math";
import { mathFromMarkdown, mathToMarkdown } from "mdast-util-math";
import { defang, noColonRuns, UNSAFE_SCHEME_TEXT } from "./schemes.ts";
import { decodeEntities } from "./credentials.ts";

// deno-lint-ignore no-explicit-any
export type MdNode = { type: string; children?: MdNode[]; value?: string; url?: string; title?: string | null; alt?: string | null; [k: string]: any };

export function parseMarkdown(md: string): MdNode {
  return fromMarkdown(md, {
    extensions: [gfmFootnote(), gfmStrikethrough({ singleTilde: false }), gfmTable(), gfmTaskListItem(), math()],
    mdastExtensions: [gfmFootnoteFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown(), mathFromMarkdown()],
  }) as unknown as MdNode;
}

// Text is escaped where it could start markup for CommonMark (the library's own list) and for
// pandoc (`@` a citation, `{` an attribute block); link destinations and autolinks are not text.
const NOT_TEXT = ["autolink", "destinationLiteral", "destinationRaw", "reference", "titleQuote", "titleApostrophe"] as const;
export function serialiseMarkdown(tree: MdNode): string {
  return toMarkdown(tree as never, {
    bullet: "-",
    fences: true,
    listItemIndent: "one",
    rule: "-",
    extensions: [gfmFootnoteToMarkdown(), gfmStrikethroughToMarkdown(), gfmTableToMarkdown(), gfmTaskListItemToMarkdown(), mathToMarkdown()],
    unsafe: [
      { character: "@", inConstruct: "phrasing", notInConstruct: [...NOT_TEXT] },
      { character: "{", inConstruct: "phrasing", notInConstruct: [...NOT_TEXT] },
      { character: "}", inConstruct: "phrasing", notInConstruct: [...NOT_TEXT] },
      { atBreak: true, character: ":" }, // a line of colons would open a fenced div for a reader with fenced_divs on
    ],
  });
}

// ── link targets ─────────────────────────────────────────────────────────────────────────────
// The target as a browser would read it: entities, backslash escapes and the whitespace/control
// characters browsers ignore are undone, lower-cased.
function normaliseTarget(dest: string): string {
  return dest.trim().replace(/^<|>$/g, "")
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16) || 0x20, 0x10ffff)))
    .replace(/&#([0-9]+);?/g, (_m, n) => String.fromCodePoint(Math.min(Number(n) || 0x20, 0x10ffff)))
    .replace(/&(colon|tab|newline|nbsp|amp);?/gi, (_m, n) => ({ colon: ":", tab: "\t", newline: "\n", nbsp: " ", amp: "&" })[(n as string).toLowerCase()]!)
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/[\u0000-\u0020\u007f-\u00a0\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "")
    .toLowerCase();
}

// A target the export keeps: http(s) or mailto; a fragment; a relative path that cannot be read as
// a scheme or an entity (no `:` before the first `/`, `?` or `#`, no `&`, no backslash); and, for an
// image only, an inline raster image.
export function safeTarget(dest: string, image = false): boolean {
  if (typeof dest !== "string") return false;
  const d = normaliseTarget(dest);
  if (UNSAFE_SCHEME_TEXT.test(d)) return false; // also inside an http(s) URL: the text checks would refuse it
  if (/^(https?:\/\/|mailto:)/.test(d)) return /^(https?:\/\/[^\s]|mailto:[^\s])/.test(d) || d === "";
  if (image && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]*$/i.test(d)) return true;
  if (/[&\\]/.test(d)) return false;
  const head = d.split(/[/?#]/)[0];
  return !head.includes(":");
}

// What an image may load (rw-p6a-resolve attempt 3, found while verifying the DOCX): pandoc READS a
// local image path and embeds the bytes, and FETCHES an http(s) one, from the workbench itself - so
// `![x](/proc/self/environ)` or `![x](../../../etc/passwd)` put the workbench's environment (the API
// key) or any file into a DOCX, and `![x](http://internal-host/)` made a request from inside. An image
// may be: an inline raster `data:image/...` ("data"); a RELATIVE path inside the resource path - no
// leading `/`, no `..` or hidden (`.x`) segment, no `%`, `:`, `?`, `#`, `&` or backslash, ending in a
// raster image extension ("local"). An http(s) image becomes a link ("remote"); anything else, its alt.
export function imageSource(dest: string): "data" | "local" | "remote" | null {
  if (typeof dest !== "string") return null;
  const d = normaliseTarget(dest);
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]*$/i.test(d)) return "data";
  if (!safeTarget(dest)) return null;
  if (/^https?:\/\//.test(d)) return "remote";
  if (d.startsWith("/") || /[%:?#&\\]/.test(d)) return null;
  const parts = d.split("/");
  if (parts.some((p) => p === "" || p.startsWith("."))) return null;
  return /\.(png|jpe?g|gif|webp)$/.test(d) ? "local" : null;
}

// A link target that stays a link in the export: http(s) or mailto (safeTarget also passes it).
export const absoluteLink = (dest: string) => /^(https?:\/\/|mailto:)/.test(normaliseTarget(dest));

export { defang, UNSAFE_SCHEME_TEXT };

// Text (not code): defanged, and never three colons in a row (schemes.ts noColonRuns).
export const textSafe = (s: string) => noColonRuns(defang(s));

// ── attribute blocks ───────────────────────────────────────────────────────────────────────────
// `{...}` from the brace to its matching close (quotes respected); the index after it, or -1.
function attrEnd(s: string, at: number): number {
  let q: string | null = null;
  for (let i = at + 1; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "}") return i + 1;
  }
  return -1;
}
// The brace a text node starts with right after a link, an image or a code span: removed to its
// matching close, or alone when it has none (no attribute can open without it).
function stripLeadingAttr(s: string): string {
  if (!s.startsWith("{")) return s;
  const e = attrEnd(s, 0);
  return e < 0 ? s.slice(1) : s.slice(e);
}

// ── limits ─────────────────────────────────────────────────────────────────────────────────────
export interface Limits {
  maxBytes: number; // the note's size
  maxBracketDepth: number; // `[` nested inside `[` (outside code)
  maxDepth: number; // the tree's depth
  maxListDepth: number; // lists nested in lists
  maxDelimiters: number; // `*`, `_`, `~` in one paragraph
  maxBrackets: number; // `[`, `]` in one paragraph
}
export const DEFAULT_LIMITS: Limits = { maxBytes: 1_000_000, maxBracketDepth: 32, maxDepth: 64, maxListDepth: 16, maxDelimiters: 1000, maxBrackets: 1000 };

export function limitsFromEnv(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): Limits {
  const n = (k: string, d: number) => {
    const v = parseInt(env(k) ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    maxBytes: n("EXPORT_MAX_NOTE_BYTES", DEFAULT_LIMITS.maxBytes),
    maxBracketDepth: n("EXPORT_MAX_BRACKET_DEPTH", DEFAULT_LIMITS.maxBracketDepth),
    maxDepth: n("EXPORT_MAX_DEPTH", DEFAULT_LIMITS.maxDepth),
    maxListDepth: n("EXPORT_MAX_LIST_DEPTH", DEFAULT_LIMITS.maxListDepth),
    maxDelimiters: n("EXPORT_MAX_PARAGRAPH_DELIMITERS", DEFAULT_LIMITS.maxDelimiters),
    maxBrackets: n("EXPORT_MAX_PARAGRAPH_BRACKETS", DEFAULT_LIMITS.maxBrackets),
  };
}

export class TooComplex extends Error {
  constructor(public limit: string, public value: number, public max: number) {
    super(`the document is too complex to export: ${limit} is ${value}, the limit is ${max}`);
  }
}

// Before the parser: the size and the bracket nesting (a backslash-escaped bracket is text; a
// blank line ends a paragraph, and with it any open bracket).
export function checkSourceLimits(md: string, lim: Limits) {
  const bytes = new TextEncoder().encode(md).byteLength;
  if (bytes > lim.maxBytes) throw new TooComplex("the note's size in bytes", bytes, lim.maxBytes);
  let depth = 0, max = 0, esc = false, nl = 0;
  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    if (c === "\n") {
      nl++;
      if (nl >= 2) depth = 0;
      esc = false;
      continue;
    }
    if (c !== " " && c !== "\t" && c !== "\r") nl = 0;
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") esc = true;
    else if (c === "[") {
      depth++;
      if (depth > max) max = depth;
      if (max > lim.maxBracketDepth) throw new TooComplex("the bracket nesting depth", max, lim.maxBracketDepth);
    } else if (c === "]" && depth > 0) depth--;
  }
  // the containers a line opens before its text (the parser's cost grows with them): list markers
  // and quote markers in the line's prefix, and the indentation in front of a list marker
  for (const line of md.split("\n")) {
    const prefix = /^(?:[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)|[ \t]*>[ \t]?)*/.exec(line)![0];
    if (!prefix) continue;
    const lists = (prefix.match(/(?:^|[ \t>])(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/g) ?? []).length;
    const quotes = (prefix.match(/>/g) ?? []).length;
    const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;
    if (lists > lim.maxListDepth) throw new TooComplex("the list nesting depth", lists, lim.maxListDepth);
    if (quotes + lists > lim.maxDepth) throw new TooComplex("the document's nesting depth", quotes + lists, lim.maxDepth);
    if (lists && indent > 4 * (lim.maxListDepth + 1)) throw new TooComplex("the list indentation in columns", indent, 4 * (lim.maxListDepth + 1));
  }
  // per paragraph (a run of lines up to a blank line or a line that opens a new block), the emphasis
  // and strikethrough delimiters and the brackets: the parser pairs them in time that grows with the
  // square of their number (25 KB of `*a` took it 9 s), so a paragraph holds at most so many; fenced
  // code is skipped (its characters are not delimiters)
  let delims = 0, brackets = 0, fence: string | null = null;
  for (const line of md.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      delims = brackets = 0;
      continue;
    }
    if (/^\s*$/.test(line) || /^ {0,3}(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}\s|>|\|)/.test(line)) delims = brackets = 0;
    for (const ch of line.replace(/\[\[[^\[\]]*\]\]/g, "")) { // a wikilink becomes a word before the parser
      if (ch === "*" || ch === "_" || ch === "~") delims++;
      else if (ch === "[" || ch === "]") brackets++;
    }
    if (delims > lim.maxDelimiters) throw new TooComplex("the emphasis delimiters in one paragraph", delims, lim.maxDelimiters);
    if (brackets > lim.maxBrackets) throw new TooComplex("the brackets in one paragraph", brackets, lim.maxBrackets);
  }
}

// After the parser, without recursion: the tree's depth and its list depth.
export function checkTreeLimits(tree: MdNode, lim: Limits) {
  const stack: [MdNode, number, number][] = [[tree, 1, 0]];
  while (stack.length) {
    const [n, d, l] = stack.pop()!;
    if (d > lim.maxDepth) throw new TooComplex("the document's nesting depth", d, lim.maxDepth);
    const ld = n.type === "list" ? l + 1 : l;
    if (ld > lim.maxListDepth) throw new TooComplex("the list nesting depth", ld, lim.maxListDepth);
    for (const k of n.children ?? []) stack.push([k, d + 1, ld]);
  }
}

// ── wikilinks ──────────────────────────────────────────────────────────────────────────────────
export interface Wikilink {
  original: string; // as written
  cite?: string; // the citation key (a source wikilink)
  text: string; // the alias, or the text a plain wikilink degrades to
}

// ── the cleaning ───────────────────────────────────────────────────────────────────────────────
const KNOWN = new Set([
  "root", "paragraph", "heading", "thematicBreak", "blockquote", "list", "listItem", "code", "html", "definition",
  "text", "emphasis", "strong", "delete", "inlineCode", "break", "link", "image", "linkReference", "imageReference",
  "footnoteDefinition", "footnoteReference", "table", "tableRow", "tableCell", "math", "inlineMath",
]);
const PHRASING_CONTAINERS = new Set(["paragraph", "heading", "emphasis", "strong", "delete", "link", "tableCell"]);
const LANG = /^[A-Za-z0-9_+#.-]{1,40}$/;

export interface Cleaned {
  tree: MdNode;
  cited: string[]; // citation keys in document order (first appearance)
  markers: Map<string, string>; // marker text in the serialised markdown -> `[@key]`
  text: string[]; // every string the document will draw: text, code, math, alt, link titles
  dropped: { links: number; images: number; html: number; attributes: number };
}

// The text of an HTML block: comments and the elements whose content is not text (script, style,
// iframe, object, embed, noscript, textarea, title, template, svg, math) dropped with their content,
// every other tag stripped, entities decoded, whitespace collapsed.
export function htmlText(html: string): string {
  return decodeEntities(
    html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/<(script|style|iframe|object|embed|noscript|textarea|title|template|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
      .replace(/<\/?[A-Za-z][^>]*>?/g, " ")
      .replace(/<[!?][^>]*>?/g, " "),
  ).replace(/\s+/g, " ").trim();
}

const toText = (n: MdNode): string =>
  n.type === "text" || n.type === "inlineCode" || n.type === "inlineMath" ? n.value ?? "" : n.type === "image" ? n.alt ?? "" : (n.children ?? []).map(toText).join("");

// Clean the parsed note. `src` is the exact string that was parsed (positions index it), `links`
// the wikilinks its tokens stand for, `token` the token pattern.
export function cleanTree(tree: MdNode, src: string, links: Wikilink[], token: RegExp, markerOf: (i: number) => string): Cleaned {
  const dropped = { links: 0, images: 0, html: 0, attributes: 0 };
  const cited: string[] = [];
  const markers = new Map<string, string>();
  const text: string[] = [];
  const restore = (s: string) => s.replace(token, (_m, i) => links[Number(i)]?.original ?? "");

  // the reference definitions, resolved here (first definition of a label wins, as CommonMark)
  const defs = new Map<string, { url: string; title: string | null }>();
  const collect = (n: MdNode) => {
    if (n.type === "definition" && !defs.has(n.identifier)) defs.set(n.identifier, { url: restore(n.url ?? ""), title: n.title ? restore(n.title) : null });
    for (const k of n.children ?? []) collect(k);
  };
  collect(tree);

  // text with tokens -> text nodes (and citation markers)
  const textNodes = (value: string): MdNode[] => {
    const out: MdNode[] = [];
    let last = 0;
    for (const m of value.matchAll(new RegExp(token.source, "g"))) {
      if (m.index! > last) out.push({ type: "text", value: textSafe(value.slice(last, m.index)) });
      const w = links[Number(m[1])];
      if (w?.cite) {
        if (!cited.includes(w.cite)) cited.push(w.cite);
        const marker = markerOf(Number(m[1]));
        markers.set(marker, `[@${w.cite}]`);
        out.push({ type: "text", value: (w.text ? textSafe(w.text) + " " : "") + marker });
      } else if (w) out.push({ type: "text", value: textSafe(w.text) });
      last = m.index! + m[0].length;
    }
    if (last < value.length) out.push({ type: "text", value: textSafe(value.slice(last)) });
    return out;
  };

  const inlineMathOk = (n: MdNode): boolean => {
    const v = n.value ?? "";
    const s = n.position?.start?.offset, e = n.position?.end?.offset;
    if (typeof s !== "number" || typeof e !== "number") return false;
    const raw = src.slice(s, e);
    return v.length > 0 && v.trim() === v && !v.includes("$") && !v.endsWith("\\") && !/\n\s*\n/.test(v) &&
      (raw === `$${v}$` || raw === `$$${v}$$`) && !/[0-9]/.test(src[e] ?? "");
  };

  const clean = (n: MdNode, parent: MdNode | null): MdNode[] => {
    if (!KNOWN.has(n.type)) { // never expected: keep its text, never its syntax
      const t = toText(n);
      return t ? [{ type: "text", value: textSafe(restore(t)) }] : [];
    }
    switch (n.type) {
      case "html": {
        // raw HTML never passes; a block keeps its TEXT (tags stripped, script-like elements and
        // comments dropped with their content) as a plain paragraph, an inline tag is dropped (the
        // text around it is its own node)
        dropped.html++;
        if (parent && PHRASING_CONTAINERS.has(parent.type)) return [];
        const t = htmlText(restore(n.value ?? ""));
        return t ? [{ type: "paragraph", children: textNodes(t) }] : [];
      }
      case "definition":
        return [];
      case "text":
        return textNodes(n.value ?? "");
      case "inlineCode":
        return [{ type: "inlineCode", value: defang(restore(n.value ?? "")) }];
      case "code":
        if (n.meta || (n.lang && !LANG.test(n.lang))) dropped.attributes++;
        return [{ type: "code", lang: n.lang && LANG.test(n.lang) ? n.lang : null, meta: null, value: defang(restore(n.value ?? "")) }];
      case "inlineMath":
        if (inlineMathOk(n)) return [{ type: "inlineMath", value: defang(restore(n.value ?? "")) }];
        return textNodes(src.slice(n.position.start.offset, n.position.end.offset));
      case "math": {
        const v = defang(restore(n.value ?? ""));
        if (v.includes("$$") || /\n\s*\n/.test(v) || !v.trim()) return [{ type: "code", lang: null, meta: null, value: v }];
        return [{ type: "math", meta: null, value: v }];
      }
      case "image":
      case "imageReference": {
        const def = n.type === "imageReference" ? defs.get(n.identifier) : { url: restore(n.url ?? ""), title: n.title ? restore(n.title) : null };
        const alt = defang(restore(n.alt ?? ""));
        const kind = def ? imageSource(def.url) : null;
        if (kind === "remote") { // pandoc would FETCH it from the workbench: a link instead, never a request
          dropped.images++;
          return [{ type: "link", url: def!.url, title: def!.title ? defang(def!.title) : null, children: [{ type: "text", value: textSafe(alt || def!.url) }] }];
        }
        if (!def || !kind) {
          dropped.images++;
          return alt ? [{ type: "text", value: textSafe(alt) }] : [];
        }
        return [{ type: "image", url: def.url, title: def.title ? defang(def.title) : null, alt }];
      }
      case "link":
      case "linkReference": {
        const def = n.type === "linkReference" ? defs.get(n.identifier) : { url: restore(n.url ?? ""), title: n.title ? restore(n.title) : null };
        const kids = cleanChildren(n);
        // attempt 4 (tester N4): a relative path (`notes/other.md`) or an in-note anchor (`#part`)
        // has no target in an exported file - the DOCX would carry it as an external relationship
        // the verification refuses (503) and Typst refuses a label it cannot find (422) - so such a
        // link is rendered as its TEXT in every format, never refused; only an http(s) or mailto
        // target stays a link (and a mailto carrying the configured mailto is refused 503
        // `credential` by the output verification, as any text carrying it).
        if (!def || !safeTarget(def.url) || !absoluteLink(def.url)) {
          if (def) dropped.links++;
          const shown = toText(n);
          const autolink = def && (shown === def.url || `mailto:${shown}` === def.url);
          return autolink ? [{ type: "text", value: "(link removed)" }] : kids;
        }
        return [{ type: "link", url: def.url, title: def.title ? defang(def.title) : null, children: kids }];
      }
      default: {
        const out: MdNode = { ...n, children: n.children ? cleanChildren(n) : undefined };
        delete out.position;
        if (out.children === undefined) delete out.children;
        return [out];
      }
    }
  };

  const cleanChildren = (n: MdNode): MdNode[] => {
    const kids = n.children ?? [];
    const out: MdNode[] = [];
    for (let i = 0; i < kids.length; i++) {
      let k = kids[i];
      // an attribute block right after a link, an image or a code span (pandoc's link_attributes,
      // inline_code_attributes): removed
      const prev = kids[i - 1];
      if (k.type === "text" && prev && ["link", "linkReference", "image", "imageReference", "inlineCode"].includes(prev.type) && (k.value ?? "").startsWith("{")) {
        k = { ...k, value: stripLeadingAttr(k.value ?? "") };
        dropped.attributes++;
      }
      out.push(...clean(k, n));
    }
    // a heading's trailing attribute block (pandoc's header_attributes)
    if (n.type === "heading") {
      const lastText = [...out].reverse().find((x) => x.type === "text");
      if (lastText && out[out.length - 1] === lastText && /\}\s*$/.test(lastText.value ?? "")) {
        const v = lastText.value!;
        const open = v.lastIndexOf("{");
        lastText.value = open >= 0 ? v.slice(0, open).replace(/\s+$/, "") : v.replace(/\}\s*$/, "");
        dropped.attributes++;
      }
    }
    // the same after the cleaning (a dropped link's text can now precede a brace)
    for (let i = 1; i < out.length; i++) {
      if (out[i].type === "text" && ["link", "image", "inlineCode"].includes(out[i - 1].type) && (out[i].value ?? "").startsWith("{")) {
        out[i] = { ...out[i], value: stripLeadingAttr(out[i].value ?? "") };
      }
    }
    return out.filter((x) => !(x.type === "text" && x.value === "" && PHRASING_CONTAINERS.has(n.type)));
  };

  const root: MdNode = { type: "root", children: cleanChildren(tree) };
  // every string the PDF will draw
  const gather = (n: MdNode) => {
    for (const v of [n.value, n.alt, n.title]) if (typeof v === "string" && v) text.push(v);
    for (const k of n.children ?? []) gather(k);
  };
  gather(root);
  return { tree: root, cited, markers, text: text.map((t) => [...markers.keys()].reduce((s, m) => s.replaceAll(m, ""), t)), dropped };
}

// ── the output check (the MD export, read back by the same parser) ───────────────────────────────
// What a markdown reader could still build from the produced MD: a link, image or definition with
// an unsafe target, a raw HTML node, an attribute block (after a link, an image or a code span; a
// heading's trailing one; a fenced code info string with a brace; a bracketed span), a fenced-div
// line, or a raw-TeX command outside code and math. The first offence is returned, or null.
export function markdownOffence(md: string): string | null {
  const tree = parseMarkdown(md);
  const codeLines = new Set<number>();
  let found: string | null = null;
  const visit = (n: MdNode, parent: MdNode | null, i: number) => {
    if (found) return;
    const s = n.position?.start, e = n.position?.end;
    if (["code", "math", "inlineCode", "inlineMath"].includes(n.type) && s && e) for (let l = s.line; l <= e.line; l++) codeLines.add(l);
    if ((n.type === "link" || n.type === "definition") && !safeTarget(n.url ?? "")) found = `a link to '${n.url}'`;
    else if (n.type === "image" && !safeTarget(n.url ?? "", true)) found = `an image from '${n.url}'`;
    else if (n.type === "html") found = `raw HTML '${(n.value ?? "").slice(0, 60)}'`;
    else if (n.type === "code" && /[{}]/.test(`${n.lang ?? ""} ${n.meta ?? ""}`)) found = `a code block attribute '${n.lang ?? ""} ${n.meta ?? ""}'`;
    else if (n.type === "text" && parent && i > 0 && ["link", "image", "inlineCode", "linkReference", "imageReference"].includes(parent.children![i - 1].type) && (n.value ?? "").startsWith("{")) {
      found = `an attribute block '${(n.value ?? "").slice(0, 60)}'`;
    } else if (n.type === "heading" && /\}\s*$/.test(toText(n))) found = `a heading attribute block '${toText(n).slice(-60)}'`;
    else if (n.type === "text" && s && e) {
      const raw = md.slice(s.offset, e.offset);
      if (/(?<!\\)\]\{/.test(raw)) found = `a bracketed span '${raw.slice(0, 60)}'`;
      else if (/(?<!\\)\\[A-Za-z]{2,}/.test(raw)) found = `a raw TeX command '${/(?<!\\)\\[A-Za-z]+/.exec(raw)![0]}'`;
    }
    (n.children ?? []).forEach((k, j) => visit(k, n, j));
  };
  visit(tree, null, 0);
  if (found) return found;
  // A fenced div is pandoc's own reference list (citeproc's `#refs` and `.csl-entry` divs, the MD
  // writer keeps fenced_divs on so that a note's `:::` text is escaped): an opening fence may carry
  // only ids, classes and the CSL spacing keys; anything else is an attribute a reader would apply.
  const lines = md.split("\n");
  for (let l = 0; l < lines.length; l++) {
    if (codeLines.has(l + 1)) continue;
    const m = /^\s{0,3}:{3,}(.*)$/.exec(lines[l]);
    if (m && !inertDivAttributes(m[1])) return `a fenced div '${lines[l].slice(0, 60)}'`;
  }
  return null;
}

function inertDivAttributes(rest: string): boolean {
  const r = rest.trim().replace(/:+$/, "").trim();
  if (r === "" || /^[A-Za-z][\w-]*$/.test(r)) return true; // a closing fence, or one class
  const m = /^\{([^{}]*)\}$/.exec(r);
  if (!m) return false;
  return m[1].trim().split(/\s+/).every((t) => /^[#.][A-Za-z][\w:.-]*$/.test(t) || /^(entry-spacing|line-spacing)="[0-9]+"$/.test(t));
}
