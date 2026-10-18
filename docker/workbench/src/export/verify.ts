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
import { base64Forms, decodeEntities, INVISIBLE, secretIn } from "./credentials.ts";
import { markdownOffence, UNSAFE_SCHEME_TEXT } from "./markdown.ts";
import { PdfDocument } from "./pdf_read.ts";
import { zipEntries } from "./zip_read.ts";

export class OutputRejected extends Error {
  constructor(public code: "output-verification" | "credential", public format: string, public offence: string) {
    super(code === "credential"
      ? `the ${format} export was not served: it would carry the configured service credential (${offence})`
      : `the ${format} export was not served: its output verification found ${offence}`);
  }
}

const mask = (s: string) => `${s.slice(0, 2)}...${s.length} characters`;

function checkText(format: string, text: string, secrets: string[]) {
  const n = text.replace(INVISIBLE, "");
  const scheme = UNSAFE_SCHEME_TEXT.exec(n);
  if (scheme) throw new OutputRejected("output-verification", format, `an unsafe-scheme string '${scheme[0]}' in its text`);
  const hit = secretIn(text, secrets);
  if (hit) throw new OutputRejected("credential", format, `the text holds ${mask(hit)}`);
}

// An absolute target an output may carry: http(s) or mailto only (no relative path in a PDF action
// or a DOCX external relationship).
export function safeAbsolute(target: string): boolean {
  const d = decodeEntities(target).replace(/[\u0000-\u0020\u007f-\u00a0\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "").toLowerCase();
  return /^(https?:\/\/[^\s]|mailto:[^\s])/.test(d) && !UNSAFE_SCHEME_TEXT.test(d);
}

// ── per format ─────────────────────────────────────────────────────────────────────────────────
export function verifyMarkdown(md: string, secrets: string[], format = "md") {
  const o = markdownOffence(md);
  if (o) throw new OutputRejected("output-verification", format, o);
  checkText(format, md, secrets);
}

export function verifyText(txt: string, secrets: string[], format = "txt") {
  checkText(format, txt, secrets);
}

const attr = (el: string, a: string) => {
  const m = new RegExp(`\\s${a}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(el);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
};
const xmlText = (x: string) => decodeEntities(x.replace(/<[^<>]*>/g, " "));

export async function verifyDocx(docx: Uint8Array, secrets: string[], format = "docx") {
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
    // file - /proc/self/environ, the vault's .git/config - is caught here even if its name hides it)
    const raw = secretInBytes(bytes, secrets);
    if (raw) throw new OutputRejected("credential", format, `${name} holds ${mask(raw)}`);
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
      // the raw XML too (attributes, properties): a secret in a target or a property is still a secret
      const hit = secretIn(xml, secrets) ?? secretIn(xmlText(xml), secrets);
      if (hit) throw new OutputRejected("credential", format, `${name} holds ${mask(hit)}`);
      const scheme = UNSAFE_SCHEME_TEXT.exec(xmlText(xml).replace(INVISIBLE, ""));
      if (scheme) throw new OutputRejected("output-verification", format, `an unsafe-scheme string '${scheme[0]}' in ${name}`);
    }
  }
  checkText(format, decodeEntities(words), secrets);
}

export async function verifyPdf(pdf: Uint8Array, secrets: string[], format = "pdf") {
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
  checkText(format, layer.text, secrets);
  for (const s of doc.dictStrings()) checkText(format, s, secrets);
  // every stream's decoded bytes too (images, embedded data): no configured secret anywhere
  for (const o of doc.objects.values()) {
    if (!o.stream) continue;
    const hit = secretInBytes(o.stream, secrets);
    if (hit) throw new OutputRejected("credential", format, `a stream holds ${mask(hit)}`);
  }
}

// A secret in binary bytes: as written (case-insensitive) and as base64 (depth 2), always; and, for a
// part up to 4 MB, the whole invariant (secretIn), decoded as Latin-1 and as UTF-8 (a fullwidth key
// is UTF-8). Over 4 MB: raw and base64 only (a declared residual, bounded cost).
const FULL_FORMS_MAX = 4 * 1024 * 1024;
function secretInBytes(b: Uint8Array, secrets: string[]): string | null {
  if (!secrets.length) return null;
  const s = new TextDecoder("latin1").decode(b);
  const low = s.toLowerCase();
  const raw = secrets.find((x) => x.length >= 4 && (low.includes(x.toLowerCase()) || base64Forms(x).some((f) => s.includes(f))));
  if (raw || b.byteLength > FULL_FORMS_MAX) return raw ?? null;
  return secretIn(s, secrets) ?? secretIn(new TextDecoder("utf-8", { fatal: false }).decode(b), secrets);
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

export async function verifyOutput(pandocTo: string, format: string, bytes: Uint8Array, secrets: string[]) {
  const w = writerOf(pandocTo);
  if (w === "pdf") return await verifyPdf(bytes, secrets, format);
  if (w === "docx") return await verifyDocx(bytes, secrets, format);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (w === "markdown") return verifyMarkdown(text, secrets, format);
  if (w === "plain") return verifyText(text, secrets, format);
  throw new OutputRejected("output-verification", format, `a writer ('${w}') the export cannot verify`);
}
