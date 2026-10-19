// The WeasyPrint parity fixture (research-workbench P6a acceptance 6, 03-PLAN P6a (5)): the same
// document, without math, through the Typst path and through the retired WeasyPrint path; the
// checked properties must match before WeasyPrint is removed. Used by parity_fixture.ts in the image's
// parity stage only (WeasyPrint is installed there and nowhere else).
import { pdfPages, pdfText } from "./pdf_tools.ts";
import type { FormatDef } from "./render.ts";

// The retired path given the SAME page as the Typst one: the PDF format entry's paper, margins,
// font and size, as CSS for pandoc's HTML template (pandoc's `css` metadata key). Typst's template
// justifies and numbers pages; so does this.
export function weasyprintFallbackCss(f: FormatDef): string {
  const md = (f.metadata ?? {}) as { papersize?: string; margin?: { x?: string; y?: string }; fontsize?: string; mainfont?: string };
  const font = md.mainfont ? `"${md.mainfont}"` : "serif";
  const size = md.fontsize ?? "11pt";
  return [
    `@page { size: ${(md.papersize ?? "a4").toUpperCase()}; margin: ${md.margin?.y ?? "2.5cm"} ${md.margin?.x ?? "2.5cm"};`,
    `  @bottom-center { content: counter(page); font-family: ${font}; font-size: ${size}; } }`,
    `html { font-size: ${size}; }`,
    `body { max-width: none; margin: 0; padding: 0; font-family: ${font}; font-size: ${size}; line-height: 1.35;`,
    `  text-align: justify; hyphens: auto; color: #000; background: #fff; }`,
    `h1 { font-size: 1.4em; margin: 0 0 0.8em; } h2 { font-size: 1.2em; margin: 1.2em 0 0.6em; }`,
    `p { margin: 0 0 0.9em; }`,
  ].join("\n");
}

export function weasyprintFormat(f: FormatDef, cssPath: string): FormatDef {
  return { ...f, key: `${f.key}-weasyprint`, engine: "weasyprint", engine_opts: [], metadata: { ...(f.metadata ?? {}), css: [cssPath] } };
}

export interface ParityProperties {
  pages: number;
  text: string; // every non-space character in reading order, page numbers and line-end hyphens removed
  numbering: string[]; // every [N] in order: the inline markers, then the reference list's labels
  headings: string[]; // the fixture's headings in the order they appear
}

export async function parityProperties(pdf: Uint8Array, headings: string[]): Promise<ParityProperties> {
  const layout = await pdfText(pdf, true);
  const lines = layout.split(/\n|\f/).filter((l) => !/^\s*\d+\s*$/.test(l)); // page-number lines
  // hyphenated line breaks: an ASCII hyphen, a soft hyphen or U+2010 (WeasyPrint's hyphenation glyph)
  const joined = lines.join("\n").replace(/(\p{L})[-­‐][ \t]*\n\s*(\p{L})/gu, "$1$2");
  const trimmed = lines.map((l) => l.trim());
  return {
    pages: await pdfPages(pdf),
    text: joined.replace(/\s+/g, ""),
    numbering: [...joined.matchAll(/\[(\d+)\]/g)].map((m) => m[1]),
    headings: headings.filter((h) => trimmed.includes(h)).sort((a, b) => trimmed.indexOf(a) - trimmed.indexOf(b)),
  };
}

export function compareParity(typst: ParityProperties, weasy: ParityProperties, headings: string[]) {
  const diffs: string[] = [];
  if (typst.pages !== weasy.pages) diffs.push(`page count: Typst ${typst.pages}, WeasyPrint ${weasy.pages}`);
  if (typst.text !== weasy.text) {
    let i = 0;
    while (i < typst.text.length && typst.text[i] === weasy.text[i]) i++;
    diffs.push(`text differs at character ${i}: Typst '${typst.text.slice(i, i + 40)}' vs WeasyPrint '${weasy.text.slice(i, i + 40)}'`);
  }
  if (typst.numbering.join(",") !== weasy.numbering.join(",")) {
    diffs.push(`reference numbering: Typst ${typst.numbering.join(",")} vs WeasyPrint ${weasy.numbering.join(",")}`);
  }
  if (typst.headings.join("|") !== headings.join("|") || weasy.headings.join("|") !== headings.join("|")) {
    diffs.push(`heading order: expected ${headings.join(" | ")}; Typst ${typst.headings.join(" | ")}; WeasyPrint ${weasy.headings.join(" | ")}`);
  }
  return { ok: diffs.length === 0, diffs };
}
