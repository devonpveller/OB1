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
// rw-p6a-resolve attempt 2 (the tester's ADV-1c, ADV-4b, ADV-5, ADV-5a): the note's title is
// escaped to literal text; the references go in a CSL-JSON bibliography file; user text cannot
// become a citation; the CSL style is hashed when it is USED; every failure carries a code.
//
// rw-p6a-resolve attempt 3 (the tester's ADV-3, ADV-4, ADV-5 and near-misses 1, 2, 5, 6): the safety
// checks no longer read the raw markdown text.
//   - THE INPUT IS A PARSED DOCUMENT (markdown.ts): the note is parsed into a syntax tree, cleaned
//     node by node (link, image and reference targets, raw HTML, attribute blocks, unsafe-scheme
//     text, math pandoc would not read as math) and written back to markdown with every text
//     character that could start markup escaped. pandoc's own input extensions stay off as a belt:
//     raw HTML, raw attributes, raw TeX, every attribute syntax, fenced divs, bracketed spans, the
//     title and YAML blocks.
//   - THE OUTPUT IS VERIFIED before it is served (verify.ts): the MD re-parsed, the DOCX unzipped,
//     the PDF parsed (link actions, other actions, .notdef boxes), the text of every format searched
//     for unsafe-scheme strings and the configured key and mailto. A failure is 503
//     `output-verification` or `credential`, naming the format and the first offence (and the
//     credential's kind only); rw-p6a-resolve2: within one budget per export (verify.ts Budget) - an
//     output it cannot judge within it is 503 `verification-budget`, never `credential`.
//   - THE GLYPH CHECK reads the parsed text: every text node, code span, code block, math, image alt
//     and link title, the title and the reference strings - what Typst will draw (attempt 2 stripped
//     `$..$` from the raw text, code spans included). The PDF is then checked for .notdef glyphs.
//   - LIMITS before pandoc (markdown.ts): the note's size, bracket depth, tree depth and list depth -
//     422 `too-complex` naming the limit; pandoc itself runs with a wall-clock bound, one capability
//     and a heap cap (+RTS -N1 -M), a CPU-time limit set on its process (prlimit), and on timeout it
//     is killed with every process it started.
//   - only writers the verification knows are run (VERIFIED_WRITERS: pdf with Typst, docx,
//     markdown, plain); an operator row for another writer is refused 503 `format`;
//   - a style file must be a regular file inside the style directory (no symlink, real path checked).
import type { CslItem } from "./csl.ts";
import { describe, uncovered } from "./glyphs.ts";
import { DEFAULT_LIMITS, type Limits, TooComplex } from "./markdown.ts";
import { type Prepared, UnnumberedCitation } from "./prepare.ts";
import { Budget, OutputRejected, unverifiableWriter, verifyDrawnText, verifyOutput } from "./verify.ts";
// the pandoc input (prepare.ts), re-exported where the tests and the exporter have always found it
export { citeKey, frontmatterTitle, literalMarkdown, type Prepared, prepareDocument, UnnumberedCitation } from "./prepare.ts";

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

export type RenderCode = "citation" | "font" | "glyphs" | "pandoc" | "style-integrity" | "too-complex" | "output-verification" | "credential" | "verification-budget" | "format";

export class RenderFailed extends Error {
  constructor(message: string, public detail: string, public code: RenderCode = "pandoc", public extra: Record<string, unknown> = {}) {
    super(message);
  }
}


// pandoc's input: markdown without its YAML and title blocks (the frontmatter is not handed over)
// and with every raw and attribute syntax off - the cleaned markdown carries none (markdown.ts), and
// should one slip through, pandoc reads it as text.
export const INPUT_FORMAT = [
  "markdown", "yaml_metadata_block", "pandoc_title_block", "raw_html", "raw_attribute", "raw_tex", "link_attributes",
  "header_attributes", "inline_code_attributes", "fenced_code_attributes", "bracketed_spans", "fenced_divs",
].join("-");

// The second pass: citations citeproc reported as not found (none can come from user text, every
// `@` of it is escaped; kept as the fail-safe it was) escaped wherever they stand.
export function escapeCitationKeys(md: string, keys: string[]): string {
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return keys.reduce((s, k) =>
    s.replace(new RegExp(`(^|[^\\p{L}\\p{N}\\\\])@(\\{?)(?=${esc(k)}(?![\\p{L}\\p{N}_]))`, "gmu"), "$1\\@$2"), md);
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
  secrets?: string[]; // the configured key and mailto: no output may carry them (verify.ts)
  limits?: Limits;
  timeoutMs?: number; // pandoc's wall-clock bound (default EXPORT_PANDOC_TIMEOUT_MS or 60 s)
  parseTimeoutMs?: number; // the parser's (prepare_worker.ts; default EXPORT_PARSE_TIMEOUT_MS or 15 s)
  verify?: boolean; // default true; false only for a test's control render (the tofu control, the parity
  // fixture's retired WeasyPrint engine) - the exporter never sets it
  verifyBudget?: { ms: number; textChars: number }; // default verify.ts VERIFY_BUDGET; a test's smaller one
}

export interface RenderOutput {
  bytes: Uint8Array;
  args: string[]; // the pandoc argument list, for the process-separation check
  stderr: string;
}

export const PANDOC = "pandoc";

// pandoc's resource bounds: one capability (one core of CPU at most, no parallel GC) and a heap cap.
export const PANDOC_RTS = ["+RTS", "-N1", "-M2g", "-RTS"];

export function pandocArgs(dir: string, i: RenderInput): string[] {
  return [
    ...PANDOC_RTS,
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
// style directory, a REGULAR file there (not a symlink; its real path inside the directory's), its
// sha256 a hash, and the file's bytes must hash to it; the verified BYTES are what pandoc reads
// (copied into the scratch directory), so the file cannot change in between.
export async function verifiedStyle(cslDir: string, style: StyleDef): Promise<Uint8Array> {
  const fail = (why: string) => new RenderFailed(`citation style '${style.key}' failed its integrity check: ${why}`, why, "style-integrity", { style: style.key });
  if (typeof style.file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.csl$/.test(style.file) || style.file.includes("..")) {
    throw fail("the registry row's file is not a style file name in the style directory");
  }
  if (typeof style.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(style.sha256)) throw fail("the registry row carries no sha256");
  const path = `${cslDir}/${style.file}`;
  let bytes: Uint8Array;
  try {
    const st = await Deno.lstat(path);
    if (st.isSymlink || !st.isFile) throw fail("the style file is not a regular file (a symlink or another kind)");
    const [real, realDir] = [await Deno.realPath(path), await Deno.realPath(cslDir)];
    if (!real.startsWith(realDir.replace(/\/?$/, "/"))) throw fail("the style file's real path is outside the style directory");
    bytes = await Deno.readFile(path);
  } catch (e) {
    if (e instanceof RenderFailed) throw e;
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

// The format's writer must be one the output verification reads (verify.ts unverifiableWriter).
export function checkWriter(format: FormatDef) {
  const bad = unverifiableWriter(format.pandoc_to, format.engine);
  if (bad) throw new RenderFailed(`the export format '${format.key}' uses a writer the export cannot verify (${bad})`, "", "format", { format: format.key });
}

// Every process `pid` started, children first (from /proc; Linux).
function descendants(pid: number): number[] {
  const kids = new Map<number, number[]>();
  try {
    for (const e of Deno.readDirSync("/proc")) {
      if (!/^\d+$/.test(e.name)) continue;
      try {
        const stat = Deno.readTextFileSync(`/proc/${e.name}/stat`);
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        kids.set(ppid, [...(kids.get(ppid) ?? []), Number(e.name)]);
      } catch { /* gone */ }
    }
  } catch {
    return [];
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      walk(k);
      out.push(k);
    }
  };
  walk(pid);
  return out;
}

export const pandocTimeoutMs = () => {
  const v = parseInt(Deno.env.get("EXPORT_PANDOC_TIMEOUT_MS") ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
};

// One pandoc run, bounded: wall clock, a CPU-time limit on its process (prlimit, inherited by
// Typst), and on timeout pandoc and every process it started are killed.
async function runPandoc(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  // a CLEAN environment: pandoc and Typst get the path, a home in the scratch directory and a locale -
  // never the workbench's own variables (the OpenAlex key, the Crossref mailto, the database password)
  const env: Record<string, string> = { PATH: Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8" };
  const fonts = Deno.env.get("TYPST_FONT_PATHS");
  if (fonts) env.TYPST_FONT_PATHS = fonts;
  const child = new Deno.Command(PANDOC, { args, cwd, clearEnv: true, env, stdin: "null", stdout: "piped", stderr: "piped" }).spawn();
  const cpu = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  try {
    await new Deno.Command("prlimit", { args: ["--pid", String(child.pid), `--cpu=${cpu}:${cpu}`], stdin: "null", stdout: "null", stderr: "null" }).output();
  } catch { /* no prlimit outside the image: the wall clock still bounds the run */ }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const p of descendants(child.pid)) {
      try {
        Deno.kill(p, "SIGKILL");
      } catch { /* gone */ }
    }
    try {
      child.kill("SIGKILL");
    } catch { /* gone */ }
  }, timeoutMs);
  try {
    const { code, stderr } = await child.output();
    return { code, stderr: new TextDecoder().decode(stderr), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export const parseTimeoutMs = () => {
  const v = parseInt(Deno.env.get("EXPORT_PARSE_TIMEOUT_MS") ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 15_000;
};

// prepareDocument in a worker (prepare_worker.ts), bounded by `ms`: the parser cannot stall the
// workbench's thread, and past its time its worker is terminated - 422 too-complex. The workers are a
// small pool kept for the process's life (a worker's start costs seconds: it loads the parser), at
// most EXPORT_PARSE_WORKERS (default 2) at once; a job waits for a free one, and its time counts from
// when it starts.
interface ParseJob { args: unknown[]; ms: number; resolve: (p: Prepared) => void; reject: (e: unknown) => void }
interface Slot { w: Worker; busy: boolean }
const pool: Slot[] = [];
const waiting: ParseJob[] = [];
const poolMax = () => {
  const v = parseInt(Deno.env.get("EXPORT_PARSE_WORKERS") ?? "", 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 8) : 2;
};
const drop = (slot: Slot) => {
  const k = pool.indexOf(slot);
  if (k >= 0) pool.splice(k, 1);
  try {
    slot.w.terminate();
  } catch { /* gone */ }
};
function dispatch() {
  while (waiting.length) {
    let slot = pool.find((s) => !s.busy);
    if (!slot && pool.length < poolMax()) {
      slot = { w: new Worker(new URL("./prepare_worker.ts", import.meta.url).href, { type: "module" }), busy: false };
      pool.push(slot);
    }
    if (!slot) return;
    runJob(slot, waiting.shift()!);
  }
}
function runJob(slot: Slot, job: ParseJob) {
  slot.busy = true;
  const finish = () => {
    clearTimeout(timer);
    slot.w.onmessage = () => {};
    slot.w.onerror = (e: ErrorEvent) => e.preventDefault();
    slot.busy = false;
    queueMicrotask(dispatch);
  };
  const timer = setTimeout(() => {
    drop(slot);
    job.reject(new TooComplex("the parser's time in milliseconds", job.ms, job.ms));
    queueMicrotask(dispatch);
  }, job.ms);
  slot.w.onmessage = (e: MessageEvent) => {
    finish();
    const d = e.data;
    if (d.ok) return job.resolve(d.prepared as Prepared);
    if (d.name === "TooComplex") return job.reject(new TooComplex(d.limit, d.value, d.max));
    if (d.name === "UnnumberedCitation") return job.reject(new UnnumberedCitation(d.message));
    job.reject(new Error(d.message));
  };
  slot.w.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    clearTimeout(timer);
    drop(slot);
    job.reject(new Error(`the document could not be prepared: ${e.message}`));
    queueMicrotask(dispatch);
  };
  slot.w.postMessage(job.args);
}
export function prepareBounded(md: string, refs: RefItem[], format: FormatDef, limits: Limits, ms: number): Promise<Prepared> {
  return new Promise<Prepared>((resolve, reject) => {
    waiting.push({ args: [md, refs, format, limits], ms, resolve, reject });
    dispatch();
  });
}
// The pool's workers ended (a test's last step; the workbench keeps them).
export function closeParserPool() {
  for (const s of [...pool]) drop(s);
}

export async function render(i: RenderInput): Promise<RenderOutput> {
  if (i.verify !== false) checkWriter(i.format); // (verify: false - a test's control render only)
  let p: Prepared;
  try {
    p = await prepareBounded(i.md, i.refs, i.format, i.limits ?? DEFAULT_LIMITS, i.parseTimeoutMs ?? parseTimeoutMs());
  } catch (e) {
    if (e instanceof TooComplex) throw new RenderFailed(e.message, "", "too-complex", { limit: e.limit, value: e.value, max: e.max });
    throw e;
  }
  const style = await verifiedStyle(i.cslDir, i.style);
  if (i.format.glyph_check) {
    const lost = await uncovered(p.text.join("\n"));
    if (lost.length) {
      throw new RenderFailed(`the PDF cannot be typeset: no installed font covers ${describe(lost)}`, "", "glyphs",
        { characters: lost.slice(0, 20).map((c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`) });
    }
  }
  // attempt 6: a typeset format's (the glyph check's) text layer is in drawn (visual) order; the
  // logical text it will draw is checked first. rw-p6a-resolve2: one verification budget per export.
  // rw-p6a-resolve2 attempt 2 (placement, not meaning): that check RUNS while pandoc and Typst run, and its
  // verdict is READ first - before the output check, and before any error of the conversion - so the
  // answer is the sequential one (a refused drawn text is refused with its own code whatever pandoc did);
  // nothing is served before it is read, and the output check starts after it ends (one budget, never
  // two checks counted at once).
  const budget = new Budget(i.verifyBudget?.ms, i.verifyBudget?.textChars);
  const asRendered = (e: unknown) =>
    e instanceof OutputRejected ? new RenderFailed(e.message, e.offence, e.code, { format: e.format, offence: e.offence }) : e;
  const drawn: Promise<unknown> = i.verify !== false && i.format.glyph_check
    ? verifyDrawnText(p.text, i.secrets ?? [], i.format.key, budget).then(() => null, (e) => asRendered(e) ?? new Error("drawn text check"))
    : Promise.resolve(null);
  const drawnFirst = async () => {
    const e = await drawn;
    if (e) throw e;
  };
  // Scratch OUTSIDE the vault: pandoc and its engines write transient files in the cwd, and the
  // wiki viewer watching the vault crashes on a file that vanishes (ENOENT unlink).
  let dir = "";
  try {
    dir = await Deno.makeTempDir({ prefix: "ob-export-" });
    await Deno.writeFile(`${dir}/${i.style.file}`, style);
    await Deno.writeTextFile(`${dir}/references.json`, JSON.stringify(p.references));
    await Deno.writeTextFile(`${dir}/meta.json`, JSON.stringify(p.metadata));
    const args = pandocArgs(dir, i);
    let markdown = p.markdown;
    const timeoutMs = i.timeoutMs ?? pandocTimeoutMs();
    for (let pass = 0; ; pass++) {
      await Deno.writeTextFile(`${dir}/in.md`, markdown);
      const { code, stderr: err, timedOut } = await runPandoc(args, dir, timeoutMs);
      if (timedOut) {
        throw new RenderFailed(`the document could not be converted within ${Math.round(timeoutMs / 1000)} s (pandoc was stopped)`, err.slice(0, 2000), "too-complex", { limit: "pandoc's time", max: timeoutMs });
      }
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
      const bytes = await Deno.readFile(`${dir}/out.${i.format.ext}`);
      await drawnFirst();
      if (i.verify !== false) {
        try {
          await verifyOutput(i.format.pandoc_to, i.format.key, bytes, i.secrets ?? [], budget);
        } catch (e) {
          if (e instanceof OutputRejected) throw new RenderFailed(e.message, e.offence, e.code, { format: e.format, offence: e.offence });
          throw e;
        }
      }
      return { bytes, args, stderr: err };
    }
  } catch (e) {
    await drawnFirst(); // the drawn text's verdict comes before any later error, as when it ran first
    throw e;
  } finally {
    if (dir) await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
