// The user document grammar (research-workbench P2b, D12). PURE: no DB, no vault, no env, no
// imports - the build test gate runs it, and the workspace (wiki-viewer/workspace/src/lib/
// grammar.ts) carries a BYTE-IDENTICAL copy, checked by the workspace runner, so the editor and
// the documents API read a document the same way.
//
// A user document is markdown with optional frontmatter and four link forms:
//   [[slug]] / [[slug|alias]]           a wiki page, live (kind page)
//   [[source:<id>|alias]]               a source or held source; the DOCUMENT defines its pin: the
//                                       documents API places one whole-source reference record per
//                                       (document, source) the first time the link is saved
//   [[claim:<id>]] [[report:<id>]] [[doc:<path>]]   a claim, a research report, another document
//   [@ref:<reference id>]               a citation chip: a P2a reference record, frozen to its pin
//   {{ref:<reference id>}}text{{/ref}}  a protected transclusion: the quoted text of a reference
//                                       record, held in the file so opening needs no fetch; the
//                                       editor makes the whole span atomic; a deliberate break
//                                       turns it into `text [@ref:<id>]`
// Links inside a transclusion's text are quoted source text, not the document's links.

export type LinkKind = "page" | "source" | "claim" | "report" | "document";

export interface DocLink {
  kind: LinkKind;
  id: string;
  alias: string | null;
  from: number;
  to: number;
}

export interface Chip {
  reference_id: string;
  from: number;
  to: number;
}

export interface Transclusion {
  reference_id: string;
  text: string;
  from: number;
  to: number;
  textFrom: number;
  textTo: number;
}

export interface Frontmatter {
  raw: string;
  fields: Record<string, string>;
  end: number;
}

export interface ParsedDocument {
  frontmatter: Frontmatter;
  title: string;
  idea: string;
  links: DocLink[];
  chips: Chip[];
  transclusions: Transclusion[];
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const UUID_RE = new RegExp(`^${UUID}$`);
export const WIKI_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
export const CHIP_RE = new RegExp(`\\[@ref:(${UUID})\\]`, "g");
export const TRANSCLUSION_RE = new RegExp(`\\{\\{ref:(${UUID})\\}\\}([\\s\\S]*?)\\{\\{\\/ref\\}\\}`, "g");
const TYPED: Record<string, LinkKind> = { source: "source", claim: "claim", report: "report", doc: "document" };

export function parseFrontmatter(md: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(md);
  if (!m) return { raw: "", fields: {}, end: 0 };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = unquote(kv[2].trim());
  }
  return { raw: m[0], fields, end: m[0].length };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    try {
      return v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

export function parseTransclusions(md: string): Transclusion[] {
  const out: Transclusion[] = [];
  const re = new RegExp(TRANSCLUSION_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const textFrom = m.index + `{{ref:${m[1]}}}`.length;
    out.push({
      reference_id: m[1].toLowerCase(), text: m[2], from: m.index, to: m.index + m[0].length,
      textFrom, textTo: textFrom + m[2].length,
    });
  }
  return out;
}

const inside = (pos: number, spans: { from: number; to: number }[]) => spans.some((s) => pos >= s.from && pos < s.to);

export function parseChips(md: string, skip: { from: number; to: number }[] = parseTransclusions(md)): Chip[] {
  const out: Chip[] = [];
  const re = new RegExp(CHIP_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (!inside(m.index, skip)) out.push({ reference_id: m[1].toLowerCase(), from: m.index, to: m.index + m[0].length });
  }
  return out;
}

export function classifyTarget(raw: string): { kind: LinkKind; id: string } {
  const t = raw.trim();
  const m = /^([a-z]+):(.+)$/.exec(t);
  if (m && TYPED[m[1]]) {
    const kind = TYPED[m[1]];
    const id = m[2].trim();
    return { kind, id: kind === "source" || kind === "claim" || kind === "report" ? id.toLowerCase() : id };
  }
  return { kind: "page", id: t.replace(/^\/+|\/+$/g, "") };
}

export function parseLinks(md: string, skip: { from: number; to: number }[] = parseTransclusions(md)): DocLink[] {
  const out: DocLink[] = [];
  const re = new RegExp(WIKI_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (inside(m.index, skip)) continue;
    const { kind, id } = classifyTarget(m[1]);
    if (!id) continue;
    out.push({ kind, id, alias: m[2]?.trim() ?? null, from: m.index, to: m.index + m[0].length });
  }
  return out;
}

export function titleOf(md: string, fm: Frontmatter, path: string): string {
  if (fm.fields.title) return fm.fields.title;
  const h = /^#\s+(.+)$/m.exec(md.slice(fm.end));
  if (h) return h[1].trim();
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

export function parseDocument(md: string, path = ""): ParsedDocument {
  const frontmatter = parseFrontmatter(md);
  const transclusions = parseTransclusions(md);
  const skip = [{ from: 0, to: frontmatter.end }, ...transclusions];
  return {
    frontmatter,
    title: titleOf(md, frontmatter, path),
    idea: (frontmatter.fields.idea ?? "").trim(),
    links: parseLinks(md, skip),
    chips: parseChips(md, skip),
    transclusions,
  };
}

// Every reference record the document holds explicitly (chips and transclusions), in order,
// de-duplicated.
export function referenceIdsOf(doc: ParsedDocument): string[] {
  const all = [...doc.transclusions, ...doc.chips].sort((a, b) => a.from - b.from).map((x) => x.reference_id);
  return [...new Set(all)];
}

// The deliberate break: the transclusion becomes plain text followed by its citation chip, the
// chip naming THE SAME reference record (so it stays frozen to the pinned revision).
export function breakTransclusion(md: string, t: Transclusion): string {
  return md.slice(0, t.from) + breakText(t) + md.slice(t.to);
}

export function breakText(t: { text: string; reference_id: string }): string {
  return `${t.text} [@ref:${t.reference_id}]`;
}

export function transclusionText(referenceId: string, text: string): string {
  return `{{ref:${referenceId}}}${text.replace(/\{\{\/ref\}\}/g, "{{ /ref}}")}{{/ref}}`;
}

export function chipText(referenceId: string): string {
  return `[@ref:${referenceId}]`;
}

// Replace (or add) one frontmatter field, keeping every other line verbatim.
export function setFrontmatterField(md: string, key: string, value: string | null): string {
  const fm = parseFrontmatter(md);
  const line = value === null ? null : `${key}: ${JSON.stringify(value)}`;
  if (!fm.end) return line === null ? md : `---\n${line}\n---\n\n${md}`;
  const inner = fm.raw.replace(/^---\r?\n/, "").replace(/\r?\n---[ \t]*(\r?\n|$)$/, "");
  const lines = inner.split(/\r?\n/).filter((l) => !new RegExp(`^${key}\\s*:`).test(l));
  if (line !== null) lines.push(line);
  return `---\n${lines.join("\n")}\n---\n` + md.slice(fm.end);
}
