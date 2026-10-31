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
  refs: { number: number; title: string }[]; // the references the export numbered, in number order
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
export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// The reference list region of the file's text: after the LAST line that is exactly "References"
// (prepare.ts sets reference-section-title), page-number-only lines removed.
export function referenceRegion(texts: string[]): string | null {
  const all = texts.join("\n");
  const lines = all.split(/\r?\n/);
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === "References") at = i;
  if (at < 0) return null;
  return lines.slice(at + 1).filter((l) => !/^\s*\d+\s*$/.test(l)).join("\n");
}

// The file's reference list against the expected one (acceptance 2: one-to-one).
export interface TextLine {
  text: string;
  x0: number;
  x1?: number;
  top?: number;
  bottom?: number;
  page?: number;
}
export function referenceParity(texts: string[], refs: { number: number; title: string }[], numeric: boolean, lines?: TextLine[]): Finding[] {
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
      if (!norm(entry).includes(norm(r.title))) {
        out.push({ code: "reference-mismatch", detail: `entry [${r.number}] in the file is not "${r.title.slice(0, 120)}"`, sample: entry.trim().slice(0, 120), stage: "references" });
      }
    }
    return out;
  }
  // author-date: entries by the file's line layout - an entry starts at the list's left edge (the
  // hanging indent); without the layout, the region is one text. Every reference's title must be in
  // exactly one entry, as whole words ("number 1" is not in "number 10"), and with the layout there are
  // exactly as many entries as references.
  let entries: string[];
  if (lines) {
    let at = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].text.trim() === "References") at = i;
    entries = splitEntries(lines.slice(at + 1).filter((l) => !/^\s*\d+\s*$/.test(l.text) && l.text.trim()));
    if (entries.length !== refs.length) {
      out.push({ code: "reference-mismatch", detail: `the file lists ${entries.length} entr${entries.length === 1 ? "y" : "ies"}; the document holds ${refs.length} reference(s)`, stage: "references" });
    }
  } else {
    entries = [region];
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
const words = (s: string) => ` ${s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
function occurrences(entry: string, t: string): number {
  const count = (hay: string) => hay.split(t).length - 1;
  return Math.max(count(words(entry.replace(/-\s*\n\s*/g, ""))), count(words(entry)));
}

// The page's YAML frontmatter block ("" when it has none).
export function frontmatterOf(md: string): string {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  return m ? m[1] : "";
}

// The frontmatter's `key: value` (scalar, or a [list] / block list) - enough for a registry `when`.
export function frontmatterValues(fm: string, key: string): string[] {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc}:[ \\t]*(.*)$`, "m").exec(fm);
  if (!m) return [];
  const v = m[1].trim();
  const unq = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if (v.startsWith("[")) return v.replace(/^\[|\]$/g, "").split(",").map(unq).filter(Boolean);
  if (v) return [unq(v)];
  const block: string[] = [];
  for (const l of fm.slice(m.index + m[0].length).split("\n").slice(1)) {
    const b = /^\s+-\s+(.*)$/.exec(l);
    if (!b) break;
    block.push(unq(b[1]));
  }
  return block;
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
export function requiredSections(texts: string[], sections: RequiredSection[], fm: string, format: string): Finding[] {
  const out: Finding[] = [];
  const lines = texts.join("\n").split(/\r?\n/);
  for (const s of sections) {
    if (!sectionApplies(s, fm, format)) continue;
    const at = lines.findIndex((l) => norm(l) === norm(s.heading));
    if (at < 0) {
      out.push({ code: "required-section-missing", detail: `the export has no "${s.heading}" section (${s.key}), which this kind of page must carry`, stage: "sections" });
      continue;
    }
    const after = norm(lines.slice(at + 1).join("\n"));
    const missing = (s.must_include ?? []).filter((t) => !after.includes(norm(t)));
    if (missing.length) {
      out.push({ code: "required-section-missing", detail: `the "${s.heading}" section (${s.key}) lacks: ${missing.join(", ")}`, stage: "sections" });
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
      ["-I", deps.script ?? new URL("../../gate/structure.py", import.meta.url).pathname, pdfPath, JSON.stringify({ text_area: ta, tolerance: 2, min_overlaps: 3, max_pages: 500 })],
      timeout);
    let texts: string[] = [];
    let lines: TextLine[] = [];
    let structure: { pages?: number; blocking?: Finding[]; warnings?: Finding[]; texts?: string[]; lines?: TextLine[][]; tools?: Record<string, string>; error?: string } | null = null;
    try { structure = JSON.parse(dec(s.stdout)); } catch { structure = null; }
    if (!structure || s.code !== 0 || !Array.isArray(structure.texts)) {
      blocking.push({ code: "structure-unreadable", detail: `the structure check could not read the PDF${structure?.error ? ` (${String(structure.error).slice(0, 200)})` : ""}`, stage: "structure" });
    } else {
      for (const f of structure.blocking ?? []) blocking.push({ ...f, stage: "structure" });
      for (const f of structure.warnings ?? []) warnings.push({ ...f, stage: "structure" });
      texts = structure.texts;
      lines = (structure.lines ?? []).flat();
      texts.forEach((t, i) => { if (!t.trim()) warnings.push({ code: "empty-page", page: i + 1, detail: `page ${i + 1} carries no text`, stage: "structure" }); });
    }
    checks.structure = { pages: structure?.pages ?? null, tools: structure?.tools ?? null, text_area_pt: ta };

    // 3 + 4. references and required sections (only on a text the structure check read)
    if (structure && s.code === 0) {
      blocking.push(...referenceParity(texts, input.refs, input.numeric, lines.length ? lines : undefined));
      blocking.push(...requiredSections(texts, input.required, input.frontmatter, input.format.key));
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
