// Render a document with its numbered references through pandoc --citeproc (research-workbench P6a).
//
// D9 (pandoc is GPL-2.0-or-later, poppler GPL): pandoc runs as a SEPARATE PROCESS over files - the
// markdown, a JSON metadata file, the references as a CSL-JSON bibliography file, the verified copy
// of the unmodified CSL style - and writes the output file; Typst is pandoc's PDF engine, a separate
// process pandoc starts. No Lua filter, no JSON filter, no JSON-AST round trip, no in-process
// binding: the arguments are built here and nowhere else, and the tests check the argument list and
// the source tree.
//
// What the renderer knows about a format or a style comes from its registry entry (export_formats,
// citation_styles); there is no switch on a format or style key.
//
// rw-p6a-resolve attempt 2 (the tester's ADV-1c, ADV-4b, ADV-5, ADV-5a):
//   - the note's TITLE (the one frontmatter value handed to pandoc) is escaped to literal text: pandoc
//     reads metadata strings as markdown, so `@me` in a title was a citation and failed every export;
//   - the references go in a CSL-JSON bibliography file, not the metadata: citeproc reads CSL strings
//     with its own small markup (italics, small caps), never as markdown;
//   - user text cannot become a citation: a stray `@` is escaped (backslash parity, Unicode word
//     characters), and a citation citeproc still cannot match is escaped in place and the render run
//     once more - so "Citeproc: citation X not found" never reaches a user;
//   - raw HTML, raw TeX and raw-attribute blocks are not passed through (input `-raw_attribute
//     -raw_tex`; HTML elements are dropped by every writer, the MD one with `-raw_html
//     -raw_attribute`), and a link whose target is not http(s)/mailto (javascript:, data:, vbscript:)
//     keeps its text and loses its target;
//   - the CSL style is hashed when it is USED and pandoc is given that verified copy (a modified or
//     missing file, or a file name outside the style directory, refuses the render);
//   - a format that typesets glyphs (definition.glyph_check, the PDF) refuses text no installed face
//     covers, before Typst runs, naming the characters (glyphs.ts);
//   - every failure carries a code (citation, font, glyphs, pandoc, style-integrity); pandoc's own
//     report is `detail`, for the server log only.
import { EXPORT_LINK_RE, splitFrontmatter } from "../contracts/logic/citations.ts";
import type { CslItem } from "./csl.ts";
import { describe, uncovered, withoutMath } from "./glyphs.ts";

export interface FormatDef {
  key: string;
  pandoc_to: string;
  ext: string;
  mime: string;
  engine?: string; // pandoc --pdf-engine
  engine_opts?: string[]; // pandoc --pdf-engine-opt, one each
  metadata?: Record<string, unknown>; // merged into the metadata file (page geometry, fonts)
  binary?: boolean;
  glyph_check?: boolean; // the format typesets glyphs: refuse characters no installed face covers
  copy?: boolean; // the format "Copy page" may ask for (exporter.ts, mode=copy)
}

export interface StyleDef {
  key: string;
  file: string;
  sha256: string;
  citation_format: string;
}

export interface RefItem {
  key: string; // the citation key, src-<cited id>
  number: number; // the holder's citation number (P2a)
  csl: CslItem;
}

export type RenderCode = "citation" | "font" | "glyphs" | "pandoc" | "style-integrity";

export class RenderFailed extends Error {
  constructor(message: string, public detail: string, public code: RenderCode = "pandoc", public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

// A body link the numbering does not know (an id that is not a uuid, on a page that is not a
// holder): never rendered as text, the export refuses it.
export class UnnumberedCitation extends Error {}

export const citeKey = (citedRef: string) => `src-${citedRef.toLowerCase()}`;

// pandoc's input: markdown without its YAML block reader (the frontmatter is not handed over),
// without raw-attribute blocks ({=html} {=typst} {=openxml} {=markdown} become code, inert) and
// without raw TeX (a backslash command prints as text).
export const INPUT_FORMAT = "markdown-yaml_metadata_block-raw_attribute-raw_tex";

// Code spans, autolinks/e-mail autolinks and link destinations: never rewritten.
const PROTECTED = /(`+)[\s\S]*?\1|<[^>\s]*[:@][^>\s]*>|\]\([^)\s]*\)/g;

// Escape every `@` pandoc could read as a citation in a run of text: one not already escaped (an odd
// run of backslashes before it) and not inside a word (a letter or digit before it; `_` is not one).
function escapeAts(text: string, before: string): string {
  let out = "";
  let run = 0;
  let prev = before;
  for (const ch of text) {
    out += ch === "@" && run % 2 === 0 && !/[\p{L}\p{N}]/u.test(prev) ? "\\@" : ch;
    run = ch === "\\" ? run + 1 : 0;
    prev = ch;
  }
  return out;
}

// Apply `fn` to the parts of each line outside fenced code, indented code, and protected spans.
function mapText(md: string, fn: (text: string, before: string) => string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      out.push(line);
      continue;
    }
    if (/^( {4}|\t)/.test(line)) { // an indented code line: backslashes are literal there
      out.push(line);
      continue;
    }
    let res = "";
    let last = 0;
    for (const m of line.matchAll(PROTECTED)) {
      res += fn(line.slice(last, m.index), res.slice(-1));
      res += m[0];
      last = m.index! + m[0].length;
    }
    out.push(res + fn(line.slice(last), res.slice(-1)));
  }
  return out.join("\n");
}

// Markdown escape for an `@` pandoc would read as a citation (`@name`, `[@name]`, `-@name`), outside
// code fences, indented code, code spans, autolinks and link destinations.
export const escapeStrayCitations = (md: string) => mapText(md, escapeAts);

// A `{=format}` right after a code span is pandoc's raw-attribute syntax: the input reader has it
// off, but the MD writer prints the text back verbatim after the code span (an escape does not
// survive the writer), and the next pandoc reader would honour it. One space between the code span
// and the brace keeps the text and breaks the syntax.
export const escapeRawAttributes = (md: string) => mapText(md, (t, before) => (before === "`" && t.startsWith("{=") ? " " : "") + t);

// The second pass: citations citeproc reported as not found (user text the first pass let through,
// e.g. in a list item's indented continuation) escaped wherever they stand, indented lines included.
export function escapeCitationKeys(md: string, keys: string[]): string {
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return keys.reduce((s, k) =>
    s.replace(new RegExp(`(^|[^\\p{L}\\p{N}\\\\])@(\\{?)(?=${esc(k)}(?![\\p{L}\\p{N}_]))`, "gmu"), "$1\\@$2"), md);
}

// A link target the export keeps: http(s), mailto, a relative path or fragment, and (images only)
// an inline raster image. Entities, markdown backslash escapes and the whitespace/control characters
// browsers ignore are undone first, so `jav&#x61;script:` and ` JaVa\tScript:` are seen for what they are.
export function safeTarget(dest: string, image = false): boolean {
  const d = dest.trim().replace(/^<|>$/g, "")
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16) || 0x20))
    .replace(/&#([0-9]+);?/g, (_m, n) => String.fromCodePoint(Number(n) || 0x20))
    .replace(/&(colon|tab|newline|nbsp|amp);?/gi, (_m, n) => ({ colon: ":", tab: "\t", newline: "\n", nbsp: " ", amp: "&" })[(n as string).toLowerCase()]!)
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/[\u0000-\u0020\u007f-\u00a0\u200b-\u200f\u2028\u2029\ufeff]/g, "")
    .toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(d)?.[1];
  if (!scheme) return true;
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return true;
  return image && /^data:image\/(png|jpe?g|gif|webp);/.test(d);
}

const INLINE_LINK = /(!?)\[((?:[^[\]\\]|\\.)*)\]\(\s*(<[^>\n]*>|(?:[^()\s\\]|\\.|\((?:[^()\s\\]|\\.)*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REF_DEF = /^ {0,3}\[(?:[^[\]\\]|\\.)+\]:\s*(<[^>\n]*>|\S+)/;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g;

// A link whose target is not safe keeps its text (an image its alt text); a reference definition
// with one is dropped (its uses then print as the bracketed text); an autolink with one is removed.
export function neutralizeUnsafeLinks(md: string): string {
  const inline = (text: string) =>
    text.replace(INLINE_LINK, (m, bang, label, dest) => safeTarget(dest, bang === "!") ? m : label)
      .replace(AUTOLINK, (m, target) => safeTarget(target) ? m : "(link removed)");
  let fence: string | null = null;
  return md.split("\n").map((line) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return line;
    }
    if (f) {
      fence = f[1];
      return line;
    }
    if (/^( {4}|\t)/.test(line) && !REF_DEF.test(line)) return line;
    const def = REF_DEF.exec(line);
    if (def && !safeTarget(def[1])) return "";
    // code spans are kept as they are; everything else is checked (autolinks included)
    let res = "";
    let last = 0;
    for (const m of line.matchAll(/(`+)[\s\S]*?\1/g)) {
      res += inline(line.slice(last, m.index)) + m[0];
      last = m.index! + m[0].length;
    }
    return res + inline(line.slice(last));
  }).join("\n");
}

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
}

// The pandoc input: source wikilinks become citations of their references' keys, other wikilinks
// degrade to their text, stray `@` are escaped, unsafe link targets dropped; the numbered references
// not cited in the body are `nocite`d in number order, so citeproc's order (first citation, then
// nocite) is the holder order.
export function prepareDocument(md: string, refs: RefItem[], format: FormatDef): Prepared {
  const { fm, body } = splitFrontmatter(md);
  const byId = new Map(refs.map((r) => [r.key, r]));
  const cited: string[] = [];
  let out = escapeRawAttributes(escapeStrayCitations(neutralizeUnsafeLinks(body))).replace(new RegExp(EXPORT_LINK_RE.source, "g"), (_full, _target, uuid, alias) => {
    const key = citeKey(uuid);
    if (!byId.has(key)) throw new UnnumberedCitation(`export refused: the document links source/${uuid}, which is not a citable source id`);
    if (!cited.includes(key)) cited.push(key);
    const label = (alias || "").trim();
    return label ? `${label} [@${key}]` : `[@${key}]`;
  });
  out = out
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, t) => String(t).split("/").pop() || String(t));
  const nocite = refs.filter((r) => !cited.includes(r.key)).sort((a, b) => a.number - b.number).map((r) => r.key);
  const title = frontmatterTitle(fm);
  const metadata: Record<string, unknown> = {
    ...(format.metadata ?? {}),
    ...(title ? { title: literalMarkdown(title) } : {}),
    lang: "en",
    "reference-section-title": "References",
    "link-citations": false,
    ...(nocite.length ? { nocite: nocite.map((k) => `@${k}`).join(" ") } : {}),
  };
  const references = [...refs].sort((a, b) => a.number - b.number).map((r) => ({ ...r.csl, id: r.key }));
  return { markdown: out, metadata, references, title, cited, nocite };
}

export interface RenderInput {
  md: string;
  refs: RefItem[];
  format: FormatDef;
  style: StyleDef;
  cslDir: string;
  wrapNone?: boolean;
  resourcePath?: string;
  engineOpts?: string[]; // extra engine options (the glyph test renders a no-system-fonts control)
}

export interface RenderOutput {
  bytes: Uint8Array;
  args: string[]; // the pandoc argument list, for the process-separation check
  stderr: string;
}

export const PANDOC = "pandoc";

export function pandocArgs(dir: string, i: RenderInput): string[] {
  return [
    "--from", INPUT_FORMAT,
    "--to", i.format.pandoc_to,
    "--citeproc",
    "--csl", `${dir}/${i.style.file}`,
    "--bibliography", `${dir}/references.json`,
    "--metadata-file", `${dir}/meta.json`,
    ...(i.resourcePath ? ["--resource-path", i.resourcePath] : []),
    ...(i.wrapNone ? ["--wrap=none"] : []),
    ...(i.format.engine ? ["--pdf-engine", i.format.engine] : []),
    ...[...(i.format.engine_opts ?? []), ...(i.engineOpts ?? [])].map((o) => `--pdf-engine-opt=${o}`),
    "--output", `${dir}/out.${i.format.ext}`,
    `${dir}/in.md`,
  ];
}

const sha256Hex = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

// ADV-4b: the style as USED is the style registered. The row's file must be a plain .csl name in the
// style directory, its sha256 a hash, and the file's bytes must hash to it; the verified BYTES are
// what pandoc reads (copied into the scratch directory), so the file cannot change in between.
export async function verifiedStyle(cslDir: string, style: StyleDef): Promise<Uint8Array> {
  const fail = (why: string) => new RenderFailed(`citation style '${style.key}' failed its integrity check: ${why}`, why, "style-integrity", { style: style.key });
  if (typeof style.file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.csl$/.test(style.file) || style.file.includes("..")) {
    throw fail("the registry row's file is not a style file name in the style directory");
  }
  if (typeof style.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(style.sha256)) throw fail("the registry row carries no sha256");
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(`${cslDir}/${style.file}`);
  } catch {
    throw fail("the style file the registry row names is missing");
  }
  if (await sha256Hex(bytes) !== style.sha256) throw fail("the file's sha256 differs from the registry (modified)");
  return bytes;
}

const CITATION_NOT_FOUND = /Citeproc: citation (\S+) not found/g;
const UNKNOWN_FONT = /unknown font family: ([^\n]+)/g;

// pandoc's report: an unresolved citation (would print the key as text) or a font Typst cannot find
// (would print with whatever it falls back to) - both fatal.
export const fatalWarnings = (stderr: string) =>
  [CITATION_NOT_FOUND, UNKNOWN_FONT].flatMap((re) => [...stderr.matchAll(re)].map((m) => m[0]));

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
};

export async function render(i: RenderInput): Promise<RenderOutput> {
  const p = prepareDocument(i.md, i.refs, i.format);
  const style = await verifiedStyle(i.cslDir, i.style);
  if (i.format.glyph_check) {
    const lost = await uncovered([withoutMath(p.markdown), p.title ?? "", ...strings(p.references)].join("\n"));
    if (lost.length) {
      throw new RenderFailed(`the PDF cannot be typeset: no installed font covers ${describe(lost)}`, "", "glyphs",
        { characters: lost.slice(0, 20).map((c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`) });
    }
  }
  // Scratch OUTSIDE the vault: pandoc and its engines write transient files in the cwd, and the
  // wiki viewer watching the vault crashes on a file that vanishes (ENOENT unlink).
  const dir = await Deno.makeTempDir({ prefix: "ob-export-" });
  try {
    await Deno.writeFile(`${dir}/${i.style.file}`, style);
    await Deno.writeTextFile(`${dir}/references.json`, JSON.stringify(p.references));
    await Deno.writeTextFile(`${dir}/meta.json`, JSON.stringify(p.metadata));
    const args = pandocArgs(dir, i);
    let markdown = p.markdown;
    for (let pass = 0; ; pass++) {
      await Deno.writeTextFile(`${dir}/in.md`, markdown);
      const { code, stderr } = await new Deno.Command(PANDOC, {
        args, cwd: dir, stdin: "null", stdout: "piped", stderr: "piped",
        signal: AbortSignal.timeout(180_000),
      }).output();
      const err = new TextDecoder().decode(stderr);
      if (code !== 0) throw new RenderFailed("the document could not be converted (pandoc failed; the workbench log has its report)", err.slice(0, 2000), "pandoc");
      const fonts = [...err.matchAll(UNKNOWN_FONT)].map((m) => m[1].trim());
      if (fonts.length) {
        throw new RenderFailed(`the PDF cannot be typeset: a font the format names is not installed (${[...new Set(fonts)].join(", ")})`, err.slice(0, 2000), "font", { fonts });
      }
      const missing = [...new Set([...err.matchAll(CITATION_NOT_FOUND)].map((m) => m[1]))];
      if (missing.length) {
        if (pass === 0) { // user text that still read as a citation: escape it where it stands, once
          markdown = escapeCitationKeys(markdown, missing);
          continue;
        }
        throw new RenderFailed("the export would print a citation it holds no reference for", err.slice(0, 2000), "citation");
      }
      return { bytes: await Deno.readFile(`${dir}/out.${i.format.ext}`), args, stderr: err };
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
