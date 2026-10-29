// The documents panel renders a user document ITSELF, from its file (D12, operator 15:51): never the
// page route, the wiki render module or a contract page call. micromark (CommonMark + GFM) turns the
// markdown into HTML with raw HTML ESCAPED (micromark's default), and the document grammar - links,
// chips, transclusions - is put in through placeholders, so no text of the document reaches the DOM
// unescaped.
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { parseDocument, type ParsedDocument } from "./grammar";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface RenderOptions {
  stale?: Set<string>; // reference ids flagged out of date (the diff-id check on open)
}

export interface Rendered {
  html: string;
  doc: ParsedDocument;
  properties: [string, string][];
  chipNumbers: Map<string, number>;
}

export function renderDocument(md: string, path: string, opts: RenderOptions = {}): Rendered {
  const doc = parseDocument(md, path);
  const body = md.slice(doc.frontmatter.end);
  const offset = doc.frontmatter.end;
  const stale = opts.stale ?? new Set<string>();
  const chipNumbers = new Map<string, number>();
  const numberOf = (id: string) => {
    if (!chipNumbers.has(id)) chipNumbers.set(id, chipNumbers.size + 1);
    return chipNumbers.get(id)!;
  };
  const chip = (id: string) =>
    `<button type="button" class="ws-chip${stale.has(id) ? " ws-stale" : ""}" data-ref="${esc(id)}" title="${stale.has(id) ? "a newer revision exists" : "citation"}">[${numberOf(id)}]${stale.has(id) ? "<sup>updated</sup>" : ""}</button>`;
  // every construct, by position, replaced by a placeholder micromark leaves alone
  const spans: { from: number; to: number; html: string }[] = [];
  for (const t of doc.transclusions) {
    spans.push({
      from: t.from - offset, to: t.to - offset,
      html: `<span class="ws-transclusion${stale.has(t.reference_id) ? " ws-stale" : ""}" data-ref="${esc(t.reference_id)}">${esc(t.text)}${chip(t.reference_id)}</span>`,
    });
  }
  for (const c of doc.chips) spans.push({ from: c.from - offset, to: c.to - offset, html: chip(c.reference_id) });
  for (const l of doc.links) {
    const label = esc(l.alias ?? l.id);
    const html = l.kind === "page"
      ? `<a class="ws-wikilink" data-kind="page" href="/${esc(l.id)}">${label}</a>`
      : `<button type="button" class="ws-wikilink" data-kind="${l.kind}" data-id="${esc(l.id)}">${label}</button>`;
    spans.push({ from: l.from - offset, to: l.to - offset, html });
  }
  spans.sort((a, b) => a.from - b.from);
  let src = "";
  let at = 0;
  const slots: string[] = [];
  for (const s of spans) {
    if (s.from < at || s.from < 0) continue;
    src += body.slice(at, s.from) + `WSSLOT${slots.length}Z`;
    slots.push(s.html);
    at = s.to;
  }
  src += body.slice(at);
  let html = micromark(src, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  html = html.replace(/WSSLOT(\d+)Z/g, (_m, i) => slots[Number(i)] ?? "");
  let h = 0;
  html = html.replace(/<(h[1-6])>/g, (_m, tag) => `<${tag} data-heading="${h++}">`)
    .replace(/<\/(h[1-6])>/g, (_m, tag) => ` <button type="button" class="ws-copy-heading" title="copy this section">copy</button></${tag}>`);
  return { html, doc, properties: Object.entries(doc.frontmatter.fields), chipNumbers };
}

// The markdown of one heading's section (the heading line to the next heading of the same or a
// higher level) - the per-heading copy.
export function sectionOf(md: string, index: number): string {
  const lines = md.split("\n");
  const heads: { line: number; level: number }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    const m = /^(#{1,6})\s/.exec(l);
    if (m && !fence) heads.push({ line: i, level: m[1].length });
  });
  const hd = heads[index];
  if (!hd) return "";
  const next = heads.slice(index + 1).find((x) => x.level <= hd.level);
  return lines.slice(hd.line, next ? next.line : lines.length).join("\n").trim();
}
