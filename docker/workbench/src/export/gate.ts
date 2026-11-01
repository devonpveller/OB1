// The export verification gate (research-workbench P6b, rw-p6b-gate): a rendered PDF is checked
// BEFORE it leaves the workbench, and a blocked one is never served (exporter.ts records it and
// answers 422 with the findings).
//
//   1. RASTERISE  pdftoppm (poppler-utils, GPL) - a SEPARATE, unmodified program run over files: the
//                 PDF in, one PNG per page out (D9 rule 4; never linked, never imported - there is no
//                 poppler binding anywhere in the workbench or the gate's Python). A PDF pdftoppm
//                 cannot render is blocked (`unrenderable`). The pages feed the vision pass.
//   2. STRUCTURE  gate/structure.py - pikepdf (MPL-2.0) and pdfplumber (MIT) in their own Python process:
//                 fonts embedded, no glyph outside the page box (`clipped`) or the format's text area
//                 (`overflow`: a clipped or over-wide table), no glyphs drawn over each other
//                 (`overlapping-text`); and the text of every page.
//   3. REFERENCES the file's reference list against the document's references (the list the export
//                 numbered - the same list the reference panel shows): one-to-one, in number order for a
//                 numeric style; a missing, extra or mismatched entry is `reference-mismatch`.
//   4. SECTIONS   the registry export_required_sections: a section the page's kind requires (the report
//                 credibility roll-up for a research report, D15/P3b) missing from the file is
//                 `required-section-missing`.
//   5. VISION     vision.ts, through LiteLLM only, under the export's own key; inert when unconfigured.
// Every stage's codes are a closed vocabulary; a stage that cannot run blocks (fail closed).
import { logRefusal } from "../identity/refusal_log.ts";
import { type Finding, type PageImage, type VisionConfig, visionPass, type Fetch } from "./vision.ts";

export type { Finding } from "./vision.ts";

export interface RequiredSection {
  key: string;
  when?: { frontmatter?: Record<string, string[]> };
  heading: string;
  must_include?: string[];
  formats?: string[];
}

export interface GateInput {
  pdf: Uint8Array;
  format: { key: string; metadata?: Record<string, unknown> };
  refs: { number: number; title: string; entry?: string }[]; // the references in the style's order; entry: citeproc's text for it
  numeric: boolean; // the style labels entries [n]
  frontmatter: string; // the page's YAML frontmatter text ("" when none)
  required: RequiredSection[]; // export_required_sections rows (live)
}

export interface GateResult {
  status: "passed" | "blocked";
  blocking_findings: Finding[];
  warnings: Finding[];
  checks: Record<string, unknown>;
}

export interface RunResult {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export interface GateDeps {
  vision: VisionConfig;
  run?: Runner;
  fetch?: Fetch;
  python?: string; // the gate's Python (EXPORT_GATE_PYTHON; default /opt/export-gate/bin/python)
  script?: string; // gate/structure.py
  pdftoppm?: string;
  dpi?: number; // the vision pass's raster resolution (EXPORT_GATE_DPI, default 72)
  timeoutMs?: number; // each program's wall clock (EXPORT_GATE_TIMEOUT_MS, default 120 s)
}

export const PDFTOPPM = "pdftoppm";

// A program run as a separate process: no shell, a clean environment, stdin closed, a wall clock.
export const runProgram: Runner = async (cmd, args, timeoutMs) => {
  const child = new Deno.Command(cmd, {
    args, clearEnv: true, env: { PATH: Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/tmp" },
    stdin: "null", stdout: "piped", stderr: "piped",
  }).spawn();
  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }, timeoutMs);
  try {
    const o = await child.output();
    return { code: o.code, stdout: o.stdout, stderr: o.stderr };
  } finally {
    clearTimeout(timer);
  }
};

const UNIT: Record<string, number> = { pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 };
// A Typst length from the format's metadata ("2.5cm") in points; null when it is not one.
export function lengthPt(v: unknown): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(pt|mm|cm|in)\s*$/.exec(String(v ?? ""));
  return m ? Number(m[1]) * UNIT[m[2]] : null;
}
// The horizontal margins the format sets (metadata.margin.x, or .left/.right); Typst's default 2.5 cm
// (the shorter side / 9.5 on A4 is ~ 62.6 pt; 2.5 cm is what the pdf row sets) when absent.
export function textArea(metadata: Record<string, unknown> | undefined): { left: number; right: number } {
  const m = (metadata?.margin ?? {}) as Record<string, unknown>;
  const x = lengthPt(m.x);
  const left = lengthPt(m.left) ?? x ?? lengthPt(m.rest) ?? 70.866;
  const right = lengthPt(m.right) ?? x ?? lengthPt(m.rest) ?? 70.866;
  return { left, right };
}

// Letters and digits only, lower case: a hyphenated line break, quotes, CSL punctuation and case
// changes do not count as a difference; anything else does.
// round 3 (tester t-p6b-gate2 D11): a PDF's text comes back in VISUAL order, so a right-to-left run (Hebrew,
// Arabic, and the spaces between their words) reads reversed, character by character and word by word. The
// comparisons fold each RTL run to its letters in a fixed (sorted) order, on both sides, so the logical title
// and the visual text compare equal; presentation forms are folded to base letters by NFKC first.
export const bidiFold = (s: string) =>
  s.normalize("NFKC").replace(/[\p{Script=Hebrew}\p{Script=Arabic}][\p{Script=Hebrew}\p{Script=Arabic}\p{M}\s]*/gu,
    (run) => ` ${[...run.replace(/[\s\p{M}]/gu, "")].sort().join("")} `);
export const norm = (s: string) => bidiFold(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// The reference list region of the file's text: after the LAST line that is exactly "References"
// (prepare.ts sets reference-section-title), page-number-only lines removed.
// round 5: a page's FOOTER (its page number) is the only digits-only line dropped - the page's last non-empty
// line; a digits-only line inside the list (the tail of a URL broken at a line end, "522") is entry text.
const dropFooter = (pageText: string) => {
  const ls = pageText.split(/\r?\n/);
  let k = ls.length - 1;
  while (k >= 0 && !ls[k].trim()) k--;
  if (k >= 0 && /^\s*\d+\s*$/.test(ls[k])) ls.splice(k, 1);
  return ls.join("\n");
};
export function referenceRegion(texts: string[]): string | null {
  const all = texts.map(dropFooter).join("\n");
  const lines = all.split(/\r?\n/);
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === "References") at = i;
  if (at < 0) return null;
  return lines.slice(at + 1).join("\n");
}
// the same for positioned lines: a digits-only line that is the last line of its page
function withoutFooters(ls: TextLine[]): TextLine[] {
  const last = new Map<number | undefined, number>();
  ls.forEach((l, i) => { if (l.text.trim()) last.set(l.page, i); });
  return ls.filter((l, i) => l.text.trim() && !(/^\s*\d+\s*$/.test(l.text) && last.get(l.page) === i));
}

// The file's reference list against the expected one (acceptance 2: one-to-one).
export interface TextLine {
  text: string;
  x0: number;
  x1?: number;
  top?: number;
  bottom?: number;
  page?: number;
  size?: number; // the line's largest glyph size (pt): a heading is set larger than the body
}
// round 5 (operator 2026-10-31, "simpler check + advisory"; tester t-p6b-gate4 D15-D18): an entry is compared
// as a SKELETON - NFKC, case-folded, Unicode letters and digits only (every hyphen variant incl. U+00AD, every
// format character incl. ZWNJ/ZWSP/WJ, punctuation and whitespace dropped). With the entry citeproc renders for
// the reference (`entry`, biborder.ts bibliographyEntries - the same program and items as the export), the
// file's entry skeleton must EQUAL it; when the entry holds Hebrew/Arabic letters (visual order in the file),
// the two skeletons must be the same MULTISET of characters (equal counts both ways). Without `entry` (a
// caller that only knows the title) the title must be in the entry (holdsTitle). Order and count checks are
// unchanged. The result is ADVISORY: the gate reports it as a warning, it does not block (runGate).
export const skeleton = (s: string) => s.normalize("NFKC").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
const RTL_IN = /[\p{Script=Hebrew}\p{Script=Arabic}]/u;
export function sameEntry(file: string, expected: string): boolean {
  const a = skeleton(file), b = skeleton(expected);
  if (!b) return false;
  if (!RTL_IN.test(expected)) return a === b;
  if (a.length !== b.length) return false;
  return [...a].sort().join("") === [...b].sort().join("");
}
const entryMatches = (fileEntry: string, r: { title: string; entry?: string }, stripLabel: boolean) =>
  r.entry !== undefined ? sameEntry(stripLabel ? fileEntry.replace(/^\s*\[\d+\]/, "") : fileEntry, r.entry) : holdsTitle(fileEntry, r.title);

export function referenceParity(texts: string[], refs: { number: number; title: string; entry?: string }[], numeric: boolean, lines?: TextLine[]): Finding[] {
  const out: Finding[] = [];
  const region = referenceRegion(texts);
  if (!refs.length) {
    if (region !== null && norm(region).length > 0 && numeric && /^\s*\[\d+\]/m.test(region)) {
      out.push({ code: "reference-mismatch", detail: "the file lists references the document does not hold", stage: "references" });
    }
    return out;
  }
  if (region === null) {
    return [{ code: "reference-mismatch", detail: `the file has no reference list; the document holds ${refs.length} reference(s)`, stage: "references" }];
  }
  if (numeric) {
    const labels = [...region.matchAll(/^\s*\[(\d+)\]/gm)];
    const got = labels.map((m) => Number(m[1]));
    const want = refs.map((r) => r.number);
    if (got.join(",") !== want.join(",")) {
      out.push({ code: "reference-mismatch", detail: `the file lists entries [${got.join(", ")}]; the document's references are [${want.join(", ")}]`, stage: "references" });
      return out;
    }
    for (let i = 0; i < labels.length; i++) {
      const entry = region.slice(labels[i].index!, i + 1 < labels.length ? labels[i + 1].index! : undefined);
      const r = refs[i];
      if (!entryMatches(entry, r, true)) {
        out.push({ code: "reference-mismatch", detail: `entry [${r.number}] in the file is not "${r.title.slice(0, 120)}"`, sample: entry.trim().slice(0, 120), stage: "references" });
      }
    }
    return out;
  }
  // author-date: entries by the file's line layout - an entry starts at the list's left edge (the
  // hanging indent / the paragraph gap); without the layout, the region is one text. Round 3 (tester
  // t-p6b-gate2 D10): with the layout the comparison is POSITIONAL, as for a numbered style - `refs` come in
  // the style's own bibliography order (biborder.ts: citeproc's sort), there are exactly as many entries as
  // references, and entry i holds reference i's title as whole words. Without the layout: every title in
  // exactly one place.
  let entries: string[];
  if (lines) {
    let at = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].text.trim() === "References") at = i;
    entries = splitEntries(withoutFooters(lines.slice(at + 1)));
    if (entries.length !== refs.length) {
      out.push({ code: "reference-mismatch", detail: `the file lists ${entries.length} entr${entries.length === 1 ? "y" : "ies"}; the document holds ${refs.length} reference(s)`, stage: "references" });
    }
  } else {
    entries = [region];
  }
  if (lines && entries.length === refs.length) {
    refs.forEach((r, i) => {
      if (!entryMatches(entries[i], r, false)) {
        out.push({ code: "reference-mismatch", detail: `entry ${i + 1} of the file's reference list is not "${r.title.slice(0, 120)}" (the style's order)`, sample: entries[i].trim().slice(0, 120), stage: "references" });
      }
    });
    return out;
  }
  for (const r of refs) {
    const t = words(r.title);
    const n = t.trim() ? entries.reduce((k, e) => k + occurrences(e, t), 0) : 0;
    if (n !== 1) {
      out.push({ code: "reference-mismatch", detail: `reference ${r.number} ("${r.title.slice(0, 120)}") is ${n === 0 ? "not in" : "listed more than once in"} the file's reference list`, stage: "references" });
    }
  }
  return out;
}

// The reference list's lines -> entries. An entry starts at the list's left edge; where the lines carry
// their vertical position, a new entry is a line after a paragraph gap (Typst sets each entry as its own
// paragraph: the gap between entries is larger than between an entry's lines), or - across a page break
// - a line after a short (paragraph-ending) line. Without positions: a hanging indent (a continuation
// line is indented).
export function splitEntries(rl: TextLine[]): string[] {
  if (!rl.length) return [];
  const edge = Math.min(...rl.map((l) => l.x0));
  const atEdge = (l: TextLine) => Math.abs(l.x0 - edge) <= 2;
  const positioned = rl.every((l) => typeof l.top === "number" && typeof l.bottom === "number" && typeof l.page === "number");
  const gaps: number[] = [];
  if (positioned) for (let i = 1; i < rl.length; i++) if (rl[i].page === rl[i - 1].page) gaps.push(rl[i].top! - rl[i - 1].bottom!);
  const minGap = gaps.length ? Math.min(...gaps) : 0;
  const byGap = positioned && gaps.some((g) => g > minGap * 1.6 + 1);
  const right = Math.max(...rl.map((l) => l.x1 ?? 0));
  const entries: string[] = [];
  for (let i = 0; i < rl.length; i++) {
    const l = rl[i], p = rl[i - 1];
    let starts: boolean;
    if (!p) starts = true;
    else if (!byGap) starts = atEdge(l);
    else if (l.page !== p.page) starts = atEdge(l) && (p.x1 ?? right) < right - 15;
    else starts = atEdge(l) && l.top! - p.bottom! > minGap * 1.6 + 1;
    if (starts) entries.push(l.text);
    else entries[entries.length - 1] += "\n" + l.text;
  }
  return entries;
}

// Whole-word forms: lower-case letter/digit words separated by one space, padded; a line-break hyphen
// is read both ways (joined, "re-<newline>view" = "review", and as a break, "claim-<newline>kind" = "claim kind").
// Does an entry of the file's reference list hold this title? (round 4, tester t-p6b-gate3 D13, D14)
//   - Typst hyphenates a long title at a line break with a SOFT hyphen (U+00AD) + newline, and breaks other
//     lines plainly: the title must be in the entry as whole words with the entry's line breaks read three
//     ways - a soft/hard hyphen + break joined, every break joined, every break a space (D13 - round 3 joined
//     only an ASCII hyphen, so "chal<U+00AD><newline>lenges" read as two words).
//   - A title with Hebrew or Arabic in it: the file's text is in VISUAL order, and a neutral (":", ",", "(",
//     " - ", quotes) or European digits between two RTL words join them into one reversed run, so no
//     per-run reordering recovers the logical order exactly (D14). Such a title is compared as an exact
//     MULTISET of its words: every word of the title (an RTL word by its letters in a fixed order, as the
//     visual text spells it backwards) must be in the entry as many times as in the title. Word ORDER inside an
//     RTL title is therefore not checked (recorded in the findings); a different, missing or extra-repeated
//     word still is.
const RTL_CHAR = /[\p{Script=Hebrew}\p{Script=Arabic}]/u;
function titleTokens(s: string): string[] {
  return s.normalize("NFKC").replace(/\u00AD\s*\n\s*/g, "").replace(/[\u00AD\p{M}]/gu, "").toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((t) => (RTL_CHAR.test(t) ? [...t].sort().join("") : t));
}
export function holdsTitle(entry: string, title: string): boolean {
  if (!RTL_CHAR.test(title)) {
    // whole words first, with the file's line breaks read three ways (a soft or hard hyphen + break joined;
    // every break joined; every break a space)
    const w = words(title);
    if (!w.trim()) return false;
    const e = entry.normalize("NFKC");
    const variants = [e.replace(/[\u00AD-]\s*\n\s*/g, ""), e.replace(/\u00AD?\s*\n\s*/g, ""), e.replace(/\u00AD/g, "")];
    // (no letters-only fallback: "number 1" would be found inside "number 10" - fail closed instead)
    return variants.some((v) => words(v).includes(w));
  }
  const have = new Map<string, number>();
  for (const t of titleTokens(entry)) have.set(t, (have.get(t) ?? 0) + 1);
  const want = new Map<string, number>();
  for (const t of titleTokens(title)) want.set(t, (want.get(t) ?? 0) + 1);
  return want.size > 0 && [...want].every(([t, n]) => (have.get(t) ?? 0) >= n);
}

const words = (s: string) => ` ${bidiFold(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
function occurrences(entry: string, t: string): number {
  const count = (hay: string) => hay.split(t).length - 1;
  return Math.max(count(words(entry.replace(/-\s*\n\s*/g, ""))), count(words(entry)));
}

// The page's YAML frontmatter block ("" when it has none).
export function frontmatterOf(md: string): string {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  return m ? m[1] : "";
}

// The frontmatter's top-level keys, read as YAML reads them (rw-p6b-gate round 2, tester D5: a trailing
// `# comment`, a quoted KEY and a quoted value are all valid YAML for the same value, and round 1 missed
// the first two). Handled: plain, single- and double-quoted keys and scalars; a comment after
// whitespace outside quotes; a `!!str` / `!tag` prefix; flow lists `[a, "b"]`; block lists (`- x`);
// block scalars (`|` / `>`). Keys compare exactly (YAML keys are case-sensitive). Anything nested deeper
// than the top level is not a `when` key and is skipped.
function stripComment(v: string): string {
  let q: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (q) {
      if (q === '"' && ch === "\\") { i++; continue; }
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s,\[]/.test(v[i - 1])) q = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(v[i - 1]))) {
      return v.slice(0, i);
    }
  }
  return v;
}
function scalar(raw: string): string {
  let v = raw.trim().replace(/^!!?[A-Za-z]*\s+/, "").trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/\\(["\\\/])/g, "$1").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  } else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    v = v.slice(1, -1).replace(/''/g, "'");
  }
  return v.trim();
}
function flowList(v: string): string[] {
  const inner = v.trim().replace(/^\[/, "").replace(/\]$/, "");
  const out: string[] = [];
  let cur = "", q: string | null = null;
  for (const ch of inner) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ",") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(scalar).filter(Boolean);
}
export function parseFrontmatter(fm: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = fm.replace(/\r\n?/g, "\n").split("\n");
  const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#"'\-?:][^:]*?|-[^\s:][^:]*?))[ \t]*:(?:[ \t]+(.*))?$/;
  for (let i = 0; i < lines.length; i++) {
    const m = KEY.exec(lines[i]);
    if (!m) continue;
    const key = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3].trim();
    const v = stripComment(m[4] ?? "").trim();
    if (v.startsWith("[")) out.set(key, flowList(v));
    else if (/^[|>][+-]?\d*$/.test(v)) {
      const body: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) body.push(lines[++i].trim());
      out.set(key, [body.filter(Boolean).join(v.startsWith(">") ? " " : "\n")]);
    } else if (v) out.set(key, [scalar(v)]);
    else {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) block.push(scalar(stripComment(lines[++i].replace(/^\s*-\s+/, ""))));
      out.set(key, block);
    }
  }
  return out;
}
export function frontmatterValues(fm: string, key: string): string[] {
  return parseFrontmatter(fm).get(key) ?? [];
}

export function sectionApplies(s: RequiredSection, fm: string, format: string): boolean {
  if (s.formats && !s.formats.includes(format)) return false;
  for (const [k, vals] of Object.entries(s.when?.frontmatter ?? {})) {
    const have = frontmatterValues(fm, k);
    if (!have.some((h) => vals.includes(h))) return false;
  }
  return true;
}

// Acceptance 5: a required section (the roll-up) is in the file: its heading as a line, then each
// must_include text after it.
// Acceptance 5 (round 2, tester D5): a required section (the roll-up) is in the file - its heading as a
// line, and each must_include text INSIDE that section: from the heading to the next heading. With the
// file's line layout a heading is a line set larger than the body text (the size most lines are set in); without
// it (the unit cases), a line equal to another known heading of the page ends nothing, so the section
// runs to the end - the caller always passes the layout for a real PDF.
export function requiredSections(texts: string[], sections: RequiredSection[], fm: string, format: string, layout?: TextLine[]): Finding[] {
  const out: Finding[] = [];
  const lines: { text: string; size?: number }[] = layout?.length ? layout : texts.join("\n").split(/\r?\n/).map((text) => ({ text }));
  // the body size: the size most lines are set in (ties: the smaller)
  const counts = new Map<number, number>();
  for (const l of lines) if (typeof l.size === "number" && l.size > 0) counts.set(Math.round(l.size * 2) / 2, (counts.get(Math.round(l.size * 2) / 2) ?? 0) + 1);
  const body = [...counts].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0]?.[0] ?? 0;
  const isHeading = (l: { size?: number }) => body > 0 && typeof l.size === "number" && l.size > body + 0.5;
  for (const s of sections) {
    if (!sectionApplies(s, fm, format)) continue;
    const at = lines.findIndex((l) => norm(l.text) === norm(s.heading));
    if (at < 0) {
      out.push({ code: "required-section-missing", detail: `the export has no "${s.heading}" section (${s.key}), which this kind of page must carry`, stage: "sections" });
      continue;
    }
    let end = at + 1;
    while (end < lines.length && !isHeading(lines[end])) end++;
    const inside = norm(lines.slice(at + 1, end).map((l) => l.text).join("\n"));
    const missing = (s.must_include ?? []).filter((t) => !inside.includes(norm(t)));
    if (missing.length) {
      out.push({ code: "required-section-missing", detail: `the "${s.heading}" section (${s.key}) lacks, before the next heading: ${missing.join(", ")}`, stage: "sections" });
    }
  }
  return out;
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export async function runGate(deps: GateDeps, input: GateInput): Promise<GateResult> {
  const run = deps.run ?? runProgram;
  const timeout = deps.timeoutMs ?? 120_000;
  const blocking: Finding[] = [];
  const warnings: Finding[] = [];
  const checks: Record<string, unknown> = { format: input.format.key };
  const dir = await Deno.makeTempDir({ prefix: "ob-export-gate-" });
  try {
    const pdfPath = `${dir}/export.pdf`;
    await Deno.writeFile(pdfPath, input.pdf);

    // 1. rasterise
    const images: PageImage[] = [];
    const r = await run(deps.pdftoppm ?? PDFTOPPM, ["-png", "-r", String(deps.dpi ?? 72), pdfPath, `${dir}/page`], timeout);
    if (r.code !== 0) {
      blocking.push({ code: "unrenderable", detail: "pdftoppm could not render the PDF", stage: "rasterise" });
    } else {
      const names = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => /^page-\d+\.png$/.test(n))
        .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
      for (const n of names) images.push({ page: Number(/\d+/.exec(n)![0]), png: await Deno.readFile(`${dir}/${n}`) });
      if (!images.length) blocking.push({ code: "unrenderable", detail: "pdftoppm rendered no page", stage: "rasterise" });
    }
    checks.rasterise = { program: "pdftoppm", pages: images.length, dpi: deps.dpi ?? 72 };

    // 2. structure
    const ta = textArea(input.format.metadata);
    const s = await run(deps.python ?? "/opt/export-gate/bin/python",
      ["-I", deps.script ?? new URL("../../gate/structure.py", import.meta.url).pathname, pdfPath, JSON.stringify({ text_area: ta, tolerance: 2, min_overlaps: 1, max_pages: 500 })],
      timeout);
    let texts: string[] = [];
    let lines: TextLine[] = [];
    let structure: { pages?: number; blocking?: Finding[]; warnings?: Finding[]; texts?: string[]; lines?: TextLine[][]; tools?: Record<string, string>; error?: string } | null = null;
    try { structure = JSON.parse(dec(s.stdout)); } catch { structure = null; }
    if (!structure || s.code !== 0 || !Array.isArray(structure.texts)) {
      // rw-identity-harden round 4 (D6): the program's own error text names the server's temp path; it goes to the log only
      if (structure?.error) logRefusal("export-gate: structure-unreadable", `[export-gate] structure check error: ${String(structure.error).slice(0, 300)}`);
      blocking.push({ code: "structure-unreadable", detail: "the structure check could not read the PDF", stage: "structure" });
    } else {
      for (const f of structure.blocking ?? []) blocking.push({ ...f, stage: "structure" });
      for (const f of structure.warnings ?? []) {
        // qpdf's syntax warnings carry the temp file's path: one fixed text on the run, the original in the log
        if (f.code === "qpdf") {
          logRefusal("export-gate: qpdf", `[export-gate] qpdf: ${String(f.detail).slice(0, 300)}`);
          warnings.push({ code: "qpdf", detail: "qpdf reported a syntax warning in the PDF", stage: "structure" });
        } else warnings.push({ ...f, stage: "structure" });
      }
      texts = structure.texts;
      lines = (structure.lines ?? []).flat();
      texts.forEach((t, i) => { if (!t.trim()) warnings.push({ code: "empty-page", page: i + 1, detail: `page ${i + 1} carries no text`, stage: "structure" }); });
    }
    checks.structure = { pages: structure?.pages ?? null, tools: structure?.tools ?? null, text_area_pt: ta };

    // 3 + 4. references and required sections (only on a text the structure check read)
    if (structure && s.code === 0) {
      // round 5 (operator 2026-10-31): the reference list's parity is ADVISORY - a mismatch is a warning on
      // the run (the export panel shows "reference list may differ from the panel"), never a block
      warnings.push(...referenceParity(texts, input.refs, input.numeric, lines.length ? lines : undefined));
      blocking.push(...requiredSections(texts, input.required, input.frontmatter, input.format.key, lines.length ? lines : undefined));
    }
    checks.references = { expected: input.refs.length, numeric: input.numeric };
    checks.sections = input.required.filter((x) => sectionApplies(x, input.frontmatter, input.format.key)).map((x) => x.key);

    // 5. vision (on what rendered; a blocked raster leaves nothing to look at - already blocked)
    const v = images.length ? await visionPass(deps.vision, images, deps.fetch) : { blocking: [], warnings: [], calls: 0, ran: false };
    blocking.push(...v.blocking);
    warnings.push(...v.warnings);
    checks.vision = { state: deps.vision.state, model: deps.vision.state === "on" ? deps.vision.model : null, calls: v.calls };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
  return { status: blocking.length ? "blocked" : "passed", blocking_findings: blocking, warnings, checks };
}

export function gateDepsFromEnv(vision: VisionConfig, env = (k: string) => Deno.env.get(k)): GateDeps {
  const n = (k: string, d: number) => {
    const v = Number(env(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    vision,
    python: env("EXPORT_GATE_PYTHON") || "/opt/export-gate/bin/python",
    dpi: n("EXPORT_GATE_DPI", 72),
    timeoutMs: n("EXPORT_GATE_TIMEOUT_MS", 120_000),
  };
}
