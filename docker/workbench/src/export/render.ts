// Render a document with its numbered references through pandoc --citeproc (research-workbench P6a).
//
// D9 (pandoc is GPL-2.0-or-later, poppler GPL): pandoc runs as a SEPARATE PROCESS over files - the
// markdown, a JSON metadata file carrying the CSL-JSON references, the unmodified CSL style - and
// writes the output file; Typst is pandoc's PDF engine, a separate process pandoc starts. No Lua
// filter, no JSON filter, no JSON-AST round trip, no in-process binding: the arguments are built
// here and nowhere else, and export_process_test.ts checks the argument list and the source tree.
//
// What the renderer knows about a format or a style comes from its registry entry (export_formats,
// citation_styles); there is no switch on a format or style key.
import { EXPORT_LINK_RE, splitFrontmatter } from "../contracts/logic/citations.ts";
import type { CslItem } from "./csl.ts";

export interface FormatDef {
  key: string;
  pandoc_to: string;
  ext: string;
  mime: string;
  engine?: string; // pandoc --pdf-engine
  engine_opts?: string[]; // pandoc --pdf-engine-opt, one each
  metadata?: Record<string, unknown>; // merged into the metadata file (page geometry, fonts)
  binary?: boolean;
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

export class RenderFailed extends Error {
  constructor(message: string, public detail: string) {
    super(message);
  }
}

// A body link the numbering does not know (an id that is not a uuid, on a page that is not a
// holder): never rendered as text, the export refuses it.
export class UnnumberedCitation extends Error {}

export const citeKey = (citedRef: string) => `src-${citedRef.toLowerCase()}`;

// Markdown escape for an `@` pandoc would read as a citation (`@name`, `[@name]`, `-@name`): any
// `@` not preceded by a word character, outside code fences, code spans, autolinks and link
// destinations. An `@` inside a word (an e-mail address) is not a citation and is left alone.
export function escapeStrayCitations(md: string): string {
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
    // protected spans: code spans, <autolinks>, ](link destinations)
    out.push(line.replace(/(`+)[\s\S]*?\1|<[^>\s]*[:@][^>\s]*>|\]\([^)\s]*\)|(^|[^\w\\])@/g, (m, ticks, pre) =>
      ticks !== undefined || pre === undefined ? m : `${pre}\\@`));
  }
  return out.join("\n");
}

// The scalar title of the note's frontmatter (`title: x` / `title: "x"`). The frontmatter is NOT
// handed to pandoc: its keys could name files pandoc would read (bibliography, csl,
// citation-abbreviations) or carry references of their own.
export function frontmatterTitle(fm: string): string | null {
  const m = /^title:[ \t]*(.+?)[ \t]*$/m.exec(fm);
  if (!m) return null;
  const v = m[1].replace(/^(["'])(.*)\1$/, "$2").trim();
  return v || null;
}

export interface Prepared {
  markdown: string;
  metadata: Record<string, unknown>;
  cited: string[]; // keys cited in the body, first appearance
  nocite: string[]; // numbered keys the body does not cite (the added references), by number
}

// The pandoc input: source wikilinks become citations of their references' keys, other wikilinks
// degrade to their text, stray `@` are escaped; the numbered references not cited in the body are
// `nocite`d in number order, so citeproc's order (first citation, then nocite) is the holder order.
export function prepareDocument(md: string, refs: RefItem[], format: FormatDef): Prepared {
  const { fm, body } = splitFrontmatter(md);
  const byId = new Map(refs.map((r) => [r.key, r]));
  const cited: string[] = [];
  let out = escapeStrayCitations(body).replace(new RegExp(EXPORT_LINK_RE.source, "g"), (_full, _target, uuid, alias) => {
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
    ...(title ? { title } : {}),
    lang: "en",
    "reference-section-title": "References",
    "link-citations": false,
    references: [...refs].sort((a, b) => a.number - b.number).map((r) => ({ ...r.csl, id: r.key })),
    ...(nocite.length ? { nocite: nocite.map((k) => `@${k}`).join(" ") } : {}),
  };
  return { markdown: out, metadata, cited, nocite };
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
    "--from", "markdown-yaml_metadata_block",
    "--to", i.format.pandoc_to,
    "--citeproc",
    "--csl", `${i.cslDir}/${i.style.file}`,
    "--metadata-file", `${dir}/meta.json`,
    ...(i.resourcePath ? ["--resource-path", i.resourcePath] : []),
    ...(i.wrapNone ? ["--wrap=none"] : []),
    ...(i.format.engine ? ["--pdf-engine", i.format.engine] : []),
    ...[...(i.format.engine_opts ?? []), ...(i.engineOpts ?? [])].map((o) => `--pdf-engine-opt=${o}`),
    "--output", `${dir}/out.${i.format.ext}`,
    `${dir}/in.md`,
  ];
}

// Citeproc reports a citation it has no item for as a warning and renders the key as text; that is
// an unresolved reference rendered as text, so it fails here. A font family Typst cannot find
// would render with whatever it falls back to (tofu for CJK), so it fails too.
const FATAL_WARNINGS = [/Citeproc: citation (\S+) not found/g, /unknown font family: ([^\n]+)/g];

export const fatalWarnings = (stderr: string) => FATAL_WARNINGS.flatMap((re) => [...stderr.matchAll(re)].map((m) => m[0]));

export async function render(i: RenderInput): Promise<RenderOutput> {
  const p = prepareDocument(i.md, i.refs, i.format);
  // Scratch OUTSIDE the vault: pandoc and its engines write transient files in the cwd, and the
  // wiki viewer watching the vault crashes on a file that vanishes (ENOENT unlink).
  const dir = await Deno.makeTempDir({ prefix: "ob-export-" });
  try {
    await Deno.writeTextFile(`${dir}/in.md`, p.markdown);
    await Deno.writeTextFile(`${dir}/meta.json`, JSON.stringify(p.metadata));
    const args = pandocArgs(dir, i);
    const { code, stderr } = await new Deno.Command(PANDOC, {
      args, cwd: dir, stdin: "null", stdout: "piped", stderr: "piped",
      signal: AbortSignal.timeout(180_000),
    }).output();
    const err = new TextDecoder().decode(stderr);
    if (code !== 0) throw new RenderFailed("pandoc conversion failed", err.slice(0, 2000));
    const fatal = fatalWarnings(err);
    if (fatal.length) throw new RenderFailed("the export would render an unresolved reference or a missing font", fatal.join("\n"));
    return { bytes: await Deno.readFile(`${dir}/out.${i.format.ext}`), args, stderr: err };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
