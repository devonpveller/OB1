// OUTPUT VERIFICATION, fail closed (rw-p6a-resolve attempt 3). Attempt 2 checked the INPUT and
// trusted the outputs to follow; the tester found `javascript:` targets in DOCX relationships and
// PDF /URI actions, boxes in a 200 PDF and a credential in every format. So every rendered file is
// read back BEFORE it is served, by what it is:
//   MD    re-parsed by the same parser (markdown.ts markdownOffence): no unsafe target, no raw node,
//         no attribute block, no fenced div, no raw TeX command;
//   DOCX  unzipped: every relationship with a scheme (and every External one) is http(s)/mailto
//         and a hyperlink; every field code's HYPERLINK target is too, and no field fetches or links
//         content (INCLUDETEXT, INCLUDEPICTURE, DDE, LINK, IMPORT);
//   PDF   parsed (pdf_read.ts): every URI action is http(s)/mailto and there is no other action
//         (JavaScript, Launch, OpenAction, additional actions, forms, embedded files); no .notdef
//         glyph is drawn (a composite font's code 0: the box);
//   TXT   (and Copy page) the text itself.
// In EVERY format the text (the MD and TXT as written, the DOCX's text and XML, the PDF's text layer
// and dictionary strings) carries no unsafe-scheme string and not the configured OpenAlex key or
// Crossref mailto - credentials.ts secretIn: the RAW text, the text with only real tags removed, the
// normalised text, and their transformed forms (NFKC, percent-decoded, at/dot spelled out, letters
// and digits only, base64). attempt 4: attempt 3 searched only a normalised text whose normaliser
// deleted `< KEY >` as if it were a tag, so the MD, TXT, PDF and Copy page printed the key with 200.
// attempt 5: secretIn IS the credential invariant (credentials.ts canon: NFD, every combining mark and
// invisible removed BEFORE NFKC, casefold, the declared look-alikes, letters and digits; over every
// view the declared encodings reach) - the same function and list as the input and cached-row checks
// and the exporter's error bodies. Attempt 4 composed `Z` + U+0301 into `Ź` first and served the key.
// A failure is a RenderFailed: `output-verification` naming the format and the first offending
// target, or `credential` - 503, never a 200.
//
// rw-p6a-resolve2 (the reviewer's B1, B2):
//   - THE PART CLASSIFIER (partClass, below) is the one rule for how much of the invariant a part gets:
//     a MEDIA part (an embedded raster, a PDF image or font program) is judged raw and base64 only; a
//     TEXT part (everything else) gets the whole invariant. Attempt 6 ran the whole invariant on every
//     part up to 4 MB: a 1.5 MB screenshot took minutes and gigabytes, and a 2.7 MB one was refused
//     `credential` though it held none (the views cap).
//   - THE BUDGET (VERIFY_BUDGET): the credential judging of one export may take VERIFY_BUDGET.ms of its
//     own time, and one text it judges may be at most VERIFY_BUDGET.textChars long; running out of
//     either, or a text over the views cap, is 503 `verification-budget` - never `credential`.
//   - A body names the credential's KIND (credentials.ts credentialKind), never its prefix or length.
import { base64Forms, credentialKind, decodeEntities, INVISIBLE, type Verdict } from "./credentials.ts";
import { type Session, sharedPool, verificationSlot, VerifyBusy } from "./judge_pool.ts";
import { UNSAFE_SCHEME_TEXT } from "./markdown.ts";
import { type PdfDict, PdfDocument, PdfName, type PdfObject, PdfRef, type PdfValue } from "./pdf_read.ts";
import { zipEntries } from "./zip_read.ts";

export type RejectCode = "output-verification" | "credential" | "verification-budget" | "verification-busy";
export class OutputRejected extends Error {
  constructor(public code: RejectCode, public format: string, public offence: string) {
    super(code === "credential"
      ? `the ${format} export was not served: it would carry the configured service credential (${offence})`
      : code === "verification-budget"
      ? `the ${format} export was not served: it could not be checked for the configured service credential within the verification budget (${offence})`
      : code === "verification-busy"
      ? `the ${format} export was not served: it was not checked, because the credential check runs one export at a time (${offence}); try again`
      : `the ${format} export was not served: its output verification found ${offence}`);
  }
}

// ── the budget ─────────────────────────────────────────────────────────────────────────────────
// Per export: the time the credential judging may take (counted only while a check runs: the pandoc /
// Typst run between the drawn-text check and the output check is not), and the length of one text it
// judges with the whole invariant. The values and their measurements: findings rw-p6a-resolve2.
export const VERIFY_BUDGET = { ms: 15_000, textChars: 4 * 1024 * 1024 };
// rw-p6a-resolve2 attempt 2: the texts of a PDF, a DOCX or the drawn text are judged in workers
// (judge_pool.ts) while the check goes on; the verdicts are read in the check's order (settle, below).
// rw-p6a-followups (R2-4): EVERY text is - the MD and the TXT (one text each) and the short ones too; none
// is judged on the export's thread, so a large MD or TXT export no longer holds it for up to the budget.
// And (R3-2) one verification at a time in the process (judge_pool.ts verificationSlot), its budget
// running only once it holds the slot.
type Pending = { format: string; where: string; p: Promise<Verdict | null> };
export class Budget {
  private used = 0;
  private since = 0;
  pool: Session | null = null;
  pending: Pending[] = [];
  constructor(public ms = VERIFY_BUDGET.ms, public textChars = VERIFY_BUDGET.textChars) {}
  // a whole check: the slot first (waiting for it is not the check's time), then the counted, settled
  // check; with no secret configured there is nothing to judge and no slot is taken
  // `pre` (round 2: the MD re-parse) runs in the pool after the slot is taken and before the clock starts
  async check(format: string, secrets: string[], check: () => void | Promise<void>, pre?: (s: Session) => Promise<void>): Promise<void> {
    const before = async () => {
      if (!pre) return;
      if (this.pool) return await pre(this.pool);
      const s = sharedPool.open();
      try {
        await pre(s);
      } finally {
        s.close();
      }
    };
    if (!secrets.length || this.pool) {
      await before();
      return await this.run(() => this.settle(check));
    }
    let release: () => void;
    try {
      release = await verificationSlot.acquire();
    } catch (e) {
      if (e instanceof VerifyBusy) throw new OutputRejected("verification-busy", format, e.message);
      throw e;
    }
    try {
      await before();
      await this.run(() => this.settle(check));
    } finally {
      release();
    }
  }
  // run a check whose texts are judged in parallel, answering as if they were judged in order:
  // every text judged before the check stopped (or all of them) is read in order, and the first offence
  // among them is the answer; then what stopped the check, if anything. Its jobs end with it.
  async settle(check: () => void | Promise<void>): Promise<void> {
    if (this.pool) return await check(); // nested: the outer one settles
    this.pool = sharedPool.open();
    this.pending = [];
    let stopped: { e: unknown } | null = null;
    try {
      await check();
    } catch (e) {
      stopped = { e };
    }
    try {
      for (const j of this.pending) verdictThrows(j.format, j.where, await j.p, this);
    } finally {
      this.pool.close();
      this.pool = null;
      this.pending = [];
    }
    if (stopped) throw stopped.e;
  }
  // the deadline of the check running now (performance.now() ms)
  get deadline(): number {
    return (this.since || performance.now()) + this.ms - this.used;
  }
  // run a check, counting its time (synchronous or not); a nested run is counted by the outer one
  run<T>(f: () => T): T {
    if (this.since) return f();
    this.since = performance.now();
    const stop = () => {
      this.used += performance.now() - this.since;
      this.since = 0;
    };
    let r: T;
    try {
      r = f();
    } catch (e) {
      stop();
      throw e;
    }
    if (r instanceof Promise) return r.finally(stop) as T;
    stop();
    return r;
  }
}

// The verdict on one text, as an OutputRejected: `credential` naming the KIND, or `verification-budget`.
function judge(format: string, where: string, text: string, secrets: string[], budget: Budget) {
  if (!secrets.length || !text) return;
  if (text.length > budget.textChars) {
    throw new OutputRejected("verification-budget", format, `${where} is ${text.length} characters long; one text may be ${budget.textChars}`);
  }
  // rw-p6a-followups: never on the export's thread (every check runs inside Budget.check / settle)
  if (!budget.pool) throw new Error("a credential judging outside a verification (verify.ts Budget.check)");
  budget.pending.push({ format, where, p: budget.pool.judge(text, secrets, budget.deadline) });
}
function verdictThrows(format: string, where: string, v: Verdict | null, budget: Budget) {
  if (v && "secret" in v) throw new OutputRejected("credential", format, `${where} holds ${credentialKind(v.secret)}`);
  if (v) throw new OutputRejected("verification-budget", format, `${where}: ${v.unjudged}; the budget is ${budget.ms / 1000} s per export`);
}

function checkText(format: string, text: string, secrets: string[], budget: Budget, where = "the text") {
  const n = text.replace(INVISIBLE, "");
  const scheme = UNSAFE_SCHEME_TEXT.exec(n);
  if (scheme) throw new OutputRejected("output-verification", format, `an unsafe-scheme string '${scheme[0]}' in its text`);
  judge(format, where, text, secrets, budget);
}

// An absolute target an output may carry: http(s) or mailto only (no relative path in a PDF action
// or a DOCX external relationship).
export function safeAbsolute(target: string): boolean {
  const d = decodeEntities(target).replace(/[\u0000-\u0020\u007f-\u00a0\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "").toLowerCase();
  return /^(https?:\/\/[^\s]|mailto:[^\s])/.test(d) && !UNSAFE_SCHEME_TEXT.test(d);
}

// attempt 6: the PDF's text in LOGICAL order, before it is typeset. A PDF text layer is in the order
// the glyphs are drawn: a bidi control (U+2067 RLI) reorders the entities after it (`&#72;` read back
// as `& #72 &;`), so the layer no longer spells the encoding the document holds (property text seed
// 2026101806 #0). Each string the document draws (prepare.ts `text`: the parsed text, the title, every
// reference field) is checked under the same invariant before Typst runs.
export async function verifyDrawnText(texts: string[], secrets: string[], format: string, budget = new Budget()) {
  if (!secrets.length) return;
  await budget.check(format, secrets, () => {
    for (const t of texts) judge(format, "the text it would draw", t, secrets, budget);
  });
}

// ── per format ─────────────────────────────────────────────────────────────────────────────────
// round 2 (tester t-p6a-fu, Case 5): the re-parse runs in a worker too - 4 concurrent 1 MB MD exports stacked
// ~300 ms each on the export's thread (/health 1.75 s)
export async function verifyMarkdown(md: string, secrets: string[], format = "md", budget = new Budget()) {
  await budget.check(format, secrets, () => checkText(format, md, secrets, budget), async (s) => {
    const o = await s.offence(md);
    if (o) throw new OutputRejected("output-verification", format, o);
  });
}

export async function verifyText(txt: string, secrets: string[], format = "txt", budget = new Budget()) {
  await budget.check(format, secrets, () => checkText(format, txt, secrets, budget));
}

const attr = (el: string, a: string) => {
  const m = new RegExp(`\\s${a}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(el);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
};
const xmlText = (x: string) => decodeEntities(x.replace(/<[^<>]*>/g, " "));

export async function verifyDocx(docx: Uint8Array, secrets: string[], format = "docx", budget = new Budget()) {
  await budget.check(format, secrets, () => docxChecked(docx, secrets, format, budget));
}
async function docxChecked(docx: Uint8Array, secrets: string[], format: string, budget: Budget) {
  let parts: Map<string, Uint8Array>;
  try {
    parts = await zipEntries(docx);
  } catch (e) {
    throw new OutputRejected("output-verification", format, `a file that cannot be read back (${(e as Error).message})`);
  }
  const dec = new TextDecoder();
  let words = "";
  for (const [name, bytes] of parts) {
    // every part, whatever it is: no configured secret in its bytes (an embedded "image" that was a
    // file - /proc/self/environ, the vault's .git/config - is not a raster: a TEXT part, judged whole,
    // even if its name hides it); how much of the invariant, by partClass
    partJudged(format, name, bytes, partClass({ in: "docx", name, bytes }), secrets, budget);
    // embedded media must BE images (by their first bytes): a note cannot make pandoc embed a file
    if (/^word\/media\//.test(name) && !isRasterImage(bytes)) {
      throw new OutputRejected("output-verification", format, `an embedded part that is not an image (${name})`);
    }
    if (!/\.(xml|rels)$/i.test(name)) continue;
    const xml = dec.decode(bytes);
    if (/\.rels$/i.test(name)) {
      for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
        const target = attr(m[0], "Target") ?? "";
        const external = /^external$/i.test(attr(m[0], "TargetMode") ?? "");
        const hasScheme = /^\s*[a-z][a-z0-9+.-]*:/i.test(target);
        if (external || hasScheme) {
          if (!/\/hyperlink$/.test(attr(m[0], "Type") ?? "")) throw new OutputRejected("output-verification", format, `an external relationship that is not a hyperlink ('${(attr(m[0], "Type") ?? "").split("/").pop()}' to '${target.slice(0, 80)}')`);
          if (!safeAbsolute(target)) throw new OutputRejected("output-verification", format, `a hyperlink to '${target.slice(0, 80)}'`);
        }
      }
    }
    // field codes: <w:instrText> runs (joined per part) and <w:fldSimple w:instr="...">
    const instr = [...xml.matchAll(/<w:instrText\b[^>]*>([^<]*)<\/w:instrText>/g)].map((m) => decodeEntities(m[1])).join("") +
      " " + [...xml.matchAll(/<w:fldSimple\b[^>]*>/g)].map((m) => attr(m[0], "w:instr") ?? "").join(" ");
    if (/\b(INCLUDETEXT|INCLUDEPICTURE|DDEAUTO|DDE|LINK|IMPORT)\b/.test(instr)) throw new OutputRejected("output-verification", format, `a field that fetches content ('${/\b(INCLUDETEXT|INCLUDEPICTURE|DDEAUTO|DDE|LINK|IMPORT)\b/.exec(instr)![0]}')`);
    for (const m of instr.matchAll(/HYPERLINK\s+(?:"([^"]*)"|(\S+))/g)) {
      const t = m[1] ?? m[2] ?? "";
      if (!t.startsWith("\\") && !safeAbsolute(t)) throw new OutputRejected("output-verification", format, `a HYPERLINK field to '${t.slice(0, 80)}'`);
    }
    if (/^(word|docProps)\//.test(name)) {
      words += " " + [...xml.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
      // the raw XML (attributes, properties: a secret in a target or a property is still a secret) is
      // the part's own UTF-8 text, judged above by partJudged; and its text with the tags as spaces
      judge(format, name, xmlText(xml), secrets, budget);
      const scheme = UNSAFE_SCHEME_TEXT.exec(xmlText(xml).replace(INVISIBLE, ""));
      if (scheme) throw new OutputRejected("output-verification", format, `an unsafe-scheme string '${scheme[0]}' in ${name}`);
    }
  }
  checkText(format, decodeEntities(words), secrets, budget);
}

export async function verifyPdf(pdf: Uint8Array, secrets: string[], format = "pdf", budget = new Budget()) {
  await budget.check(format, secrets, () => pdfChecked(pdf, secrets, format, budget));
}
async function pdfChecked(pdf: Uint8Array, secrets: string[], format: string, budget: Budget) {
  let doc: PdfDocument;
  let layer: Awaited<ReturnType<PdfDocument["glyphs"]>>;
  try {
    doc = await PdfDocument.read(pdf);
    layer = await doc.glyphs();
  } catch (e) {
    throw new OutputRejected("output-verification", format, `a file that cannot be read back (${(e as Error).message})`);
  }
  for (const a of doc.actions()) {
    if (a.kind === "URI") {
      if (!safeAbsolute(a.target ?? "")) throw new OutputRejected("output-verification", format, `a URI action to '${(a.target ?? "").slice(0, 80)}'`);
    } else if (a.kind !== "GoTo") throw new OutputRejected("output-verification", format, `a '${a.kind}' action`);
  }
  if (layer.notdef.length) {
    const f = layer.notdef[0];
    throw new OutputRejected("output-verification", format, `${f.count} .notdef glyph(s) (an empty box) drawn in ${f.font.replace(/^[A-Z]{6}\+/, "")}: a character no face draws`);
  }
  checkText(format, layer.text, secrets, budget, "the text layer");
  if (layer.body !== layer.text) checkText(format, layer.body, secrets, budget, "the text layer"); // attempt 6: without the page numbers
  for (const s of doc.dictStrings()) checkText(format, s, secrets, budget, "a dictionary string");
  // every stream's decoded bytes too (images, fonts, content, embedded data): how much, by partClass
  const fonts = fontPrograms(doc);
  for (const [num, o] of doc.objects) {
    if (!o.stream) continue;
    partJudged(format, `stream ${num}`, o.stream, partClass({ in: "pdf", dict: streamDict(o), fontProgram: fonts.has(num) }), secrets, budget);
  }
}

// ── THE PART CLASSIFIER (rw-p6a-resolve2): the one rule ─────────────────────────────────────────
//   media  a DOCX `word/media/` part whose first bytes ARE a raster (isRasterImage: PNG, JPEG, GIF,
//          WebP - the only files the note's image rule lets pandoc embed, markdown.ts imageSource);
//          a PDF image XObject (/Subtype /Image: the pixels Typst drew from such a raster, inflated,
//          or the JPEG itself, DCT); a PDF font program (a font descriptor's /FontFile, /FontFile2 or
//          /FontFile3, or a stream with /Length1-3 or /Subtype Type1C, CIDFontType0C, OpenType: the
//          installed faces, subset)
//          -> the secret as written (case-insensitive) and its base64 (depth 1-2, every alignment).
//   text   every other part: DOCX XML and relationships, any part that is NOT a raster (a disguised
//          file: refused `credential` or `output-verification`), PDF content streams, object streams,
//          CMaps, metadata, anything else
//          -> the whole invariant (credentials.ts judgeSecret) over its UTF-8 text, and over its
//          Latin-1 text where that differs, within the budget.
// DECLARED RESIDUAL: a media part whose bytes encode the secret in a form other than raw or base64 (an
// image's metadata chunk holding the key entity-, percent- or hex-encoded, a font's name table) is not
// judged by the decoders: the note's own image file, in the vault, can carry it.
export type PartClass = "media" | "text";
export type Part = { in: "docx"; name: string; bytes: Uint8Array } | { in: "pdf"; dict: PdfDict; fontProgram: boolean };
const nameOf = (v: PdfValue | undefined) => (v instanceof PdfName ? v.name : undefined);
export function partClass(p: Part): PartClass {
  if (p.in === "docx") return /^word\/media\//.test(p.name) && isRasterImage(p.bytes) ? "media" : "text";
  if (p.fontProgram) return "media";
  const sub = nameOf(p.dict.get("Subtype"));
  if (sub === "Image" || sub === "Type1C" || sub === "CIDFontType0C" || sub === "OpenType") return "media";
  if (p.dict.has("Length1") || p.dict.has("Length2") || p.dict.has("Length3")) return "media";
  return "text";
}
const streamDict = (o: PdfObject): PdfDict => (o.value instanceof Map ? o.value : new Map());
// the object numbers a font descriptor names as its font program
function fontPrograms(doc: PdfDocument): Set<number> {
  const out = new Set<number>();
  for (const o of doc.objects.values()) {
    if (!(o.value instanceof Map) || nameOf(o.value.get("Type")) !== "FontDescriptor") continue;
    for (const k of ["FontFile", "FontFile2", "FontFile3"]) {
      const r = o.value.get(k);
      if (r instanceof PdfRef) out.add(r.num);
    }
  }
  return out;
}

// One part, judged by its class: as written and base64, always (linear in its size); a text part also
// the whole invariant.
function partJudged(format: string, where: string, b: Uint8Array, cls: PartClass, secrets: string[], budget: Budget) {
  if (!secrets.length) return;
  const latin1 = new TextDecoder("latin1").decode(b);
  const low = latin1.toLowerCase();
  const raw = secrets.find((x) => x.length >= 4 && (low.includes(x.toLowerCase()) || base64Forms(x).some((f) => latin1.includes(f))));
  if (raw) throw new OutputRejected("credential", format, `${where} holds ${credentialKind(raw)}`);
  if (cls === "media") return;
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(b);
  judge(format, where, utf8, secrets, budget);
  if (latin1 !== utf8) judge(format, where, latin1, secrets, budget);
}

// PNG, JPEG, GIF, WebP, by their signatures (pandoc embeds a note's images as they are).
export function isRasterImage(b: Uint8Array): boolean {
  const at = (sig: number[], off = 0) => sig.every((x, k) => b[off + k] === x);
  return at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || at([0xff, 0xd8, 0xff]) ||
    at([0x47, 0x49, 0x46, 0x38]) || (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8));
}

// The writers the export can verify; any other registry row is refused before pandoc runs (a PDF
// only through Typst, the engine whose output pdf_read.ts reads). attempt 3, the tester's near-miss
// 6: an operator row for html5 would have passed raw HTML through.
export const VERIFIED_WRITERS = new Set(["pdf", "docx", "markdown", "plain"]);
export const writerOf = (pandocTo: string) => (pandocTo ?? "").split(/[+-]/)[0];
export function unverifiableWriter(pandocTo: string, engine: string | undefined): string | null {
  const w = writerOf(pandocTo);
  if (!VERIFIED_WRITERS.has(w)) return `'${w}'`;
  if (w === "pdf" && engine !== "typst") return `'${w}' with ${engine ?? "no engine"}`;
  return null;
}

export async function verifyOutput(pandocTo: string, format: string, bytes: Uint8Array, secrets: string[], budget = new Budget()) {
  const w = writerOf(pandocTo);
  if (w === "pdf") return await verifyPdf(bytes, secrets, format, budget);
  if (w === "docx") return await verifyDocx(bytes, secrets, format, budget);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (w === "markdown") return await verifyMarkdown(text, secrets, format, budget);
  if (w === "plain") return await verifyText(text, secrets, format, budget);
  throw new OutputRejected("output-verification", format, `a writer ('${w}') the export cannot verify`);
}
