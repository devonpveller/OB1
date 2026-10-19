// Credential-shaped text, judged on what a READER sees (rw-p6a-resolve attempts 3, 4 and 5). PURE.
//
// Attempt 2 compared the stored strings with the key; attempt 3 searched one normalised text whose
// normaliser deleted `< KEY >` as a tag; attempt 4 searched several forms, but its "letters and
// digits only" form ran NFKC BEFORE removing combining marks, so `Z` + U+0301 composed into the
// letter `Ź`, survived, and the key was stored and served in every format (tester t-rw-p6a-4).
//
// attempt 5 (structural): ONE invariant, ONE function, ONE list, used by every door - the input
// check (resolver.ts unsafe / carries: the CSL item AND the raw upstream strings), the cached-row
// check (exporter.ts, through resolver.unsafe), the output verifier (verify.ts judge /
// partJudged; rw-p6a-resolve2: judgeSecret) and the exporter's error bodies (exporter.ts guardBody):
//
//   canon(text) = NFD -> remove every combining mark (Mn, Mc, Me), every default-ignorable code point
//                 and every format character (zero-width, joiners, bidi controls, soft hyphen,
//                 variation selectors, tags) -> NFKC -> casefold -> the DECLARED look-alike map
//                 (LOOKALIKE below) -> repeated until stable -> keep only letters and digits.
//
//   secretIn(text) is non-null when, in ANY VIEW of the text (below), the secret appears as written
//   (case-insensitive, with or without whitespace), or canon(secret) is a substring of canon(view) or
//   of canon(view with the mailto's spelled-out `(at)` / `[at]` / `{at}` / `<at>` / ` at ` and
//   `(dot)` / ` dot ` removed), or the secret's base64 (standard and URL alphabets, every byte
//   alignment, depth 1 and 2) is in the view.
//
//   VIEWS: the raw text and every text reachable from it by these DECODERS (ENCODINGS), each at most
//   to its declared depth, in any order, every intermediate kept:
//     squeeze  whitespace, invisibles and backslashes removed (a PDF line break, or Typst's
//              hyphenation `&#xf<U+00AD> eff;`, inside an entity or a %xx splits nothing)           1
//     compat   NFKC (a PDF ligature `ﬀ` inside `&#xfeff;`, a fullwidth `％４０`, are still the encoding)  1
//     untag    real tags (the REAL_TAG grammar), HTML comments, CDATA wrappers removed           3
//     loose    every `<...>` span removed (attempt 3's form; one more view, never the only one)  1
//     unescape markdown backslash escapes undone (`\<i\>`, `&\#64;`: how the MD output spells text) 2
//     entity   HTML entities: named, decimal, hex; a named letter entity (`&Zacute;`, `&Zopf;`)
//              read as its base letter                                                            4
//     percent  `%xx` runs decoded as UTF-8                                                        4
//     base64   every run of the base64/base64url alphabet (12+ characters; whitespace and
//              invisible characters inside it ignored) decoded at each of the 4 offsets           2
//     hex      every run of 16+ hex digits (upper or lower) decoded at both offsets               2
//   A text whose views exceed MAX_VIEWS is refused (fail closed).
//
// attempt 6 (bounded): entity and percent 3 -> 4. A depth counts EVERY application of a decoder, the
// token-level ones included: two whole-text entity layers over a text whose characters are already
// `&#NN;` tokens, with a literal `&shy;` inside a hex run, is entity depth 4; three percent layers over a
// mailto whose `@` is `%40` is percent depth 4 (tester t-rw-p6a-5b, seed 2718281828 #687, #1362, #843 -
// attempt 5 followed 3 and missed them). The property test's generator counts the same way and asserts it
// never emits deeper than this table (attempt5_test.ts `deeper`).
//
// rw-p6a-resolve2 (the reviewer's B1/B2): a text whose views exceed MAX_VIEWS, or whose judging passes
// a caller's deadline, is NOT JUDGED - judgeSecret answers { unjudged } and never names a secret
// (attempt 6 returned the first configured secret, and the verifier reported a key the text did not
// hold). secretIn, for the input doors, still fails closed on it (non-null: UNJUDGED, not a secret).
// How much of the invariant a binary output part gets is verify.ts partClass (the one rule).
//
// DECLARED RESIDUALS (not encodings; named, not claimed): scrambles - reversal under bidi overrides,
// ROT13-style substitutions, interleaving with a literal entity or other text; cross-script
// look-alikes beyond LOOKALIKE (Cyrillic `а` for Latin `a`); a secret whose canon is shorter than 8
// characters is matched as written and through the decoders only; a MEDIA part (verify.ts partClass:
// an embedded raster, a PDF image or font program) is judged raw and base64 only.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: ".", hyphen: "-", dash: "-",
  colon: ":", lowbar: "_", sol: "/", equals: "=", quest: "?", num: "#", shy: "", zwj: "", zwnj: "",
};
// Unchanged since attempt 3 (markdown.ts reads link targets with it).
export const decodeEntities = (s: string) =>
  s.replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16) || 0x20, 0x10ffff)))
    .replace(/&#([0-9]+);?/g, (_m, n) => String.fromCodePoint(Math.min(Number(n) || 0x20, 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[(n as string).toLowerCase()] ?? m);

// The credential check's entity decoder: the above, more punctuation names, and a named LETTER entity
// (a letter + a diacritic or a math alphabet: `&Zacute;`, `&ocirc;`, `&Zopf;`, `&zscr;`) read as its
// base letter - the reader sees that letter.
const MORE_NAMED: Record<string, string> = {
  percnt: "%", plus: "+", excl: "!", dollar: "$", lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lcub: "{", rcub: "}",
  ast: "*", comma: ",", semi: ";", bsol: "\\", verbar: "|", grave: "`", tilde: "~", zwsp: "", lrm: "", rlm: "",
  ensp: " ", emsp: " ", thinsp: " ", wj: "", nobreak: "", szlig: "ss", aelig: "ae", oelig: "oe", oslash: "o",
  eth: "d", dstrok: "d", lstrok: "l", hstrok: "h", tstrok: "t", inodot: "i", imath: "i", jmath: "j",
};
const LETTER_ENTITY = /^([a-z])(acute|grave|circ|tilde|uml|ring|cedil|caron|macr|breve|ogon|dot|dblac|stroke|opf|scr|fr)$/i;
function decodeEntitiesDeep(s: string): string {
  return decodeEntities(s).replace(/&([a-z]+);/gi, (m, n: string) => {
    const k = MORE_NAMED[n.toLowerCase()];
    if (k !== undefined) return k;
    const l = LETTER_ENTITY.exec(n);
    return l ? l[1] : m;
  });
}

export const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]|[\u{e0000}-\u{e0fff}]/gu;

// A REAL tag: `<name attr="v" ...>` or `</name>`; a quoted value holds no `<` or `>` (so a scan
// stops at the next bracket: linear time). Anything else between `<` and `>` is text.
const ATTR = String.raw`(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'=<>\x60]+))?)`;
export const REAL_TAG = new RegExp(String.raw`<(?:[A-Za-z][A-Za-z0-9-]*${ATTR}*\s*\/?|\/[A-Za-z][A-Za-z0-9-]*\s*)>`, "g");
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
export const stripRealTags = (s: string) => s.replace(COMMENT, "").replace(REAL_TAG, "");

// ── canon ────────────────────────────────────────────────────────────────────────────────────────
// Combining marks, default-ignorables and format characters: removed after NFD, before NFKC.
export const STRIP = /[\p{M}\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
// The DECLARED look-alike map, applied after NFKC and casefold. NFKC already reads fullwidth forms,
// mathematical alphanumerics, circled, parenthesised and squared letters and digits, superscript and
// subscript digits, ligatures, the long s and Roman numerals as their letters; this adds:
//   - Latin letters with a stroke, bar or hook that have NO decomposition (ø ł đ ħ ŧ ƶ ...), æ œ ð;
//   - Latin small capitals (ᴀ ʙ ᴄ ...), the dotless i and j;
//   - negative circled, dingbat circled and double circled digits (❶ ➀ ➊ ⓫ ⓵ ⓿);
//   - negative circled / negative squared Latin capitals (🅐 🅰) and regional indicators (🇦).
const LATIN_LOOKALIKE: Record<string, string> = {
  "ø": "o", "ł": "l", "đ": "d", "ħ": "h", "ŧ": "t", "ƀ": "b", "ɨ": "i", "ƶ": "z", "ǥ": "g", "ɍ": "r", "ʉ": "u",
  "ɏ": "y", "ȼ": "c", "ɇ": "e", "ɉ": "j", "ꝁ": "k", "ƚ": "l", "ȥ": "z", "ɗ": "d", "ƈ": "c", "ɓ": "b", "ƒ": "f",
  "ɠ": "g", "ɦ": "h", "ƙ": "k", "ɱ": "m", "ɲ": "n", "ƥ": "p", "ʠ": "q", "ɽ": "r", "ʂ": "s", "ƭ": "t", "ʋ": "v",
  "ⱳ": "w", "ƴ": "y", "ı": "i", "ȷ": "j", "æ": "ae", "œ": "oe", "ð": "d", "ɫ": "l", "ɬ": "l",
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k",
  "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ʀ": "r", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w",
  "ʏ": "y", "ᴢ": "z",
};
const RANGES: [number, number, (o: number) => string][] = [
  [0x2776, 0x277f, (o) => String(o + 1)], [0x2780, 0x2789, (o) => String(o + 1)], [0x278a, 0x2793, (o) => String(o + 1)],
  [0x24eb, 0x24f4, (o) => String(o + 11)], [0x24f5, 0x24fe, (o) => String(o + 1)], [0x24ff, 0x24ff, () => "0"],
  [0x1f150, 0x1f169, (o) => String.fromCharCode(97 + o)], [0x1f170, 0x1f189, (o) => String.fromCharCode(97 + o)],
  [0x1f1e6, 0x1f1ff, (o) => String.fromCharCode(97 + o)],
];
export const LOOKALIKE = /[æðøĀ-˿ᴀ-ᴫ꜀-ꟿⱠ-Ɀ❶-➓⓫-⓿]|[\u{1f150}-\u{1f189}\u{1f1e6}-\u{1f1ff}]/gu;
function lookalike(c: string): string {
  const l = LATIN_LOOKALIKE[c];
  if (l) return l;
  const cp = c.codePointAt(0)!;
  for (const [a, b, f] of RANGES) if (cp >= a && cp <= b) return f(cp - a);
  return c;
}
const casefold = (s: string) => s.toUpperCase().toLowerCase();

// canon before its letters-and-digits step (punctuation kept, for the mailto's at/dot spellings).
// rw-p6a-resolve2 (cost, not meaning): on pure ASCII every step but the case fold is the identity (no
// mark, no default-ignorable or format character, NFD and NFKC change nothing, no look-alike is ASCII),
// so canonText(ascii) === ascii.toLowerCase(); resolve2_test.ts "A7-2 (cost, not meaning)" asserts the two agree.
const ASCII_ONLY = /^[\x00-\x7f]*$/;
export function canonText(t: string): string {
  if (ASCII_ONLY.test(t)) return t.toLowerCase();
  return canonTextFull(t);
}
export function canonTextFull(t: string): string {
  let x = t;
  for (let k = 0; k < 4; k++) {
    const y = casefold(x.normalize("NFD").replace(STRIP, "").normalize("NFKC")).replace(LOOKALIKE, lookalike)
      .normalize("NFD").replace(STRIP, "");
    if (y === x) break;
    x = y;
  }
  return x;
}
const lettersDigits = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "");
export const canon = (t: string) => lettersDigits(canonText(t));
// The mailto's URL-safe spellings, removed (`@` and `.` are not letters or digits either); a markdown
// backslash escape (`\[at\]`, as pandoc writes it) is not a break.
const AT_DOT = /\s*[([{<]\s*(?:at|dot)\s*[)\]}>]\s*|\s(?:at|dot)(?=\s)/g;
const atDotOf = (ct: string) => lettersDigits(ct.replace(/\\/g, "").replace(AT_DOT, " "));
export const canonAtDot = (t: string) => atDotOf(canonText(t));

// rw-p6a-resolve2 attempt 2 (cost, not meaning): canonText piece by piece, each distinct piece once.
// PLAIN characters: ASCII and U+FFFD (the replacement character a decoder writes for a byte that is not
// UTF-8). A text splits BEFORE every PLAIN character into pieces (a PLAIN character and the run of other
// characters after it; such a run at the start), and canonText(text) is the pieces' canonText joined, up
// to the choice between σ and ς:
//   - NFD and NFKC: a PLAIN character is a starter with no decomposition that never composes with the
//     character before it (NFC_QC / NFKC_QC = Yes) and blocks any composition or reordering across it, so
//     normalisation never crosses the split (Unicode UAX #15, normalization boundaries); STRIP and
//     LOOKALIKE are per character and match no PLAIN character;
//   - the case fold: toUpperCase has no context; toLowerCase's only context is Final_Sigma (V8, the root
//     locale), which picks σ or ς for a Σ by its neighbours - a piece may pick the other one;
//   - every step keeps a PLAIN character PLAIN (ASCII lowercased, U+FFFD itself), so the split holds
//     through every round, and a piece that is stable stays stable (the whole stops at the same round or
//     later; the cap of 4 rounds is shared). A PLAIN text's canon is its lowercase.
// σ and ς are both letters (lettersDigits keeps both) and neither is in AT_DOT, so for an ASCII secret
// every check below answers the same on the joined pieces as on canonText; judgeSecret uses canonPieces
// only when every configured secret is ASCII (canonText otherwise). The decoded bytes of a base64 or hex
// run (U+FFFD and control characters around single ASCII characters) repeat their pieces: one
// canonTextFull per distinct piece. resolve2_cost_test.ts A7-5e4 compares the two (σ and ς read as one)
// on every BMP character before, after and between PLAIN characters, and on generated texts; A7-5e3
// compares judgeSecret with the a06b72f one (credentials_oracle.ts).
const RC = String.fromCharCode(0xfffd);
const PLAIN_ONLY = new RegExp(`^[\\x00-\\x7f${RC}]*$`);
const NOT_PLAIN = new RegExp(`[^\\x00-\\x7f${RC}]+`, "g");
const PIECES = new Map<string, string>();
let piecesChars = 0;
export function canonPieces(t: string): string {
  if (PLAIN_ONLY.test(t)) return t.toLowerCase();
  const out: string[] = [];
  let last = 0;
  for (const m of t.matchAll(NOT_PLAIN)) {
    const start = m.index! > 0 ? m.index! - 1 : 0; // the PLAIN character before the run is in its piece
    if (start > last) out.push(t.slice(last, start).toLowerCase());
    last = m.index! + m[0].length;
    const piece = t.slice(start, last);
    let c = PIECES.get(piece);
    if (c === undefined) {
      c = canonTextFull(piece);
      if (piecesChars > 4_000_000) {
        PIECES.clear();
        piecesChars = 0;
      }
      PIECES.set(piece, c);
      piecesChars += piece.length + c.length;
    }
    out.push(c);
  }
  if (last < t.length) out.push(t.slice(last).toLowerCase());
  return out.join("");
}
// AT_DOT somewhere in a text: its two alternatives without the optional whitespace around them (a text
// holds a match of AT_DOT exactly when it holds one of these)
const AT_DOT_ANY = /[([{<]\s*(?:at|dot)\s*[)\]}>]|\s(?:at|dot)\s/;

// ── the encodings ───────────────────────────────────────────────────────────────────────────────
// rw-p6a-resolve2 attempt 2 (cost, not meaning): one decoder instance (decode() without `stream` keeps
// no state between calls), and the base64 / hex bytes read through a table instead of atob +
// Uint8Array.from(callback) / match(/../g) + parseInt - the same bytes (resolve2_cost_test.ts A7-5e1 compares
// every decoder with the a06b72f one, credentials_oracle.ts).
const UTF8 = new TextDecoder("utf-8", { fatal: false });
const utf8 = (b: Uint8Array) => UTF8.decode(b);
const B64 = new Int8Array(128).fill(-1);
"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => B64[c.charCodeAt(0)] = i);
B64["-".charCodeAt(0)] = 62; // base64url, read as + and / (base64Runs)
B64["_".charCodeAt(0)] = 63;
// `s` from `from` to `to` (a multiple of 4, every character in the alphabet above), as bytes
function b64Bytes(s: string, from: number, to: number): Uint8Array {
  const out = new Uint8Array(((to - from) / 4) * 3);
  for (let i = from, o = 0; i < to; i += 4, o += 3) {
    const n = (B64[s.charCodeAt(i)] << 18) | (B64[s.charCodeAt(i + 1)] << 12) | (B64[s.charCodeAt(i + 2)] << 6) | B64[s.charCodeAt(i + 3)];
    out[o] = n >> 16;
    out[o + 1] = (n >> 8) & 255;
    out[o + 2] = n & 255;
  }
  return out;
}
const HEX = new Int8Array(128).fill(-1);
"0123456789abcdef".split("").forEach((c, i) => {
  HEX[c.charCodeAt(0)] = i;
  HEX[c.toUpperCase().charCodeAt(0)] = i;
});
// `s` from `from`, `n` pairs of hex digits, as bytes
function hexBytes(s: string, from: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let k = 0, i = from; k < n; k++, i += 2) out[k] = (HEX[s.charCodeAt(i)] << 4) | HEX[s.charCodeAt(i + 1)];
  return out;
}
const percent = (t: string) =>
  t.indexOf("%") < 0 ? t : t.replace(/(?:%[0-9a-f]{2})+/gi, (m) => utf8(hexBytes(m.replace(/%/g, ""), 0, m.length / 3)));
// a run of an encoding's alphabet: whitespace, invisible characters and a markdown backslash escape
// inside it are not breaks. attempt 2 (cost): squeeze, base64 and hex all start from it, so the last one
// is kept; STRIP matches no ASCII character, so an ASCII text skips it - the same string either way.
const NON_ASCII = /[^\x00-\x7f]/;
let packedOf = "", packedIs = "", runsIs: string[] = [];
const packed = (t: string) => {
  if (t !== packedOf) {
    packedIs = !NON_ASCII.test(t) ? t.replace(/[\s\\]+/g, "") : t.length < 2048 ? packOne(t) : packChunks(t);
    runsIs = Array.from(packedIs.matchAll(/[A-Za-z0-9+/_-]{12,}/g), (m) => m[0]);
    packedOf = t;
  }
  return packedIs;
};
const packOne = (t: string) => t.replace(/[\s\\]+/g, "").replace(STRIP, "");
// packing removes characters one by one, so a text packs chunk by chunk (any split); a long non-ASCII
// text's chunks (chunkEnds) are packed once each while views() runs (PACKED)
let PACKED: Map<string, string> | null = null;
function packChunks(t: string): string {
  const out: string[] = [];
  let from = 0;
  for (const to of chunkEnds(t)) {
    const x = t.slice(from, to);
    let p = PACKED?.get(x);
    if (p === undefined) {
      p = packOne(x);
      PACKED?.set(x, p);
    }
    out.push(p);
    from = to;
  }
  return out.join("");
}
// the runs of the base64 alphabet (12+ characters) in packed(t), in order: every maximal run, since the
// pattern is greedy and one character class
const runsOf = (t: string) => (packed(t), runsIs);
// A run decodes to the same text wherever it stands; the views of one text share most of their runs
// (a tag removed here, an escape undone there), so views() keeps what each run decoded to (RUNS) while it
// runs. Same output with or without it.
let RUNS: Map<string, string> | null = null;
function base64Runs(t: string): string {
  const out: string[] = [];
  for (const run of runsOf(t)) {
    const hit = RUNS?.get("b" + run);
    if (hit !== undefined) {
      out.push(hit);
      continue;
    }
    const parts: string[] = [];
    for (let k = 0; k < 4; k++) {
      const len = run.length - k;
      const body = len - (len % 4);
      if (body < 12) continue;
      parts.push(utf8(b64Bytes(run, k, k + body)));
    }
    const d = parts.join("\n"); // k = 0 always decodes (a run has 12+ characters): never empty
    RUNS?.set("b" + run, d);
    out.push(d);
  }
  return out.join("\n");
}
// attempt 2 (cost): the hex alphabet is inside the base64 one, so every run of 16+ hex digits in packed(t)
// lies inside one of runsOf(t) (16 >= 12) and is found there, in the same order
function hexRuns(t: string): string {
  const out: string[] = [];
  for (const b of runsOf(t)) {
    if (b.length < 16) continue;
    let d = RUNS?.get("h" + b);
    if (d === undefined) {
      const parts: string[] = [];
      for (const m of b.matchAll(/[0-9a-f]{16,}/gi)) {
        const run = m[0];
        parts.push(utf8(hexBytes(run, 0, run.length >> 1)), utf8(hexBytes(run, 1, (run.length - 1) >> 1)));
      }
      d = parts.length ? parts.join("\n") : "";
      RUNS?.set("h" + b, d);
    }
    if (d) out.push(d);
  }
  return out.join("\n");
}
// a markdown backslash escape undone (`\<sup\>`, `&\#50;`: the MD output's spelling of text)
// attempt 2 (cost): a decoder whose every pattern starts with a character the text does not hold
// returns the text unchanged without running them (the same string)
const unescape = (t: string) => t.indexOf("\\") < 0 ? t : t.replace(/\\([!-/:-@[-`{-~])/g, "$1");
const untag = (t: string) =>
  t.indexOf("<") < 0 && t.indexOf("]]>") < 0 ? t : stripRealTags(t).replace(/<!\[CDATA\[|\]\]>/gi, "");
const loose = (t: string) => t.indexOf("<") < 0 ? t : t.replace(/<[^<>]*>/g, "");
// NFKC changes no ASCII text
const compat = (t: string) => NON_ASCII.test(t) ? t.normalize("NFKC") : t;
const entity = (t: string) => t.indexOf("&") < 0 ? t : decodeEntitiesDeep(t);

// The ONE list: each decoder and the depth it is followed to.
export const ENCODINGS: { name: string; depth: number; decode: (t: string) => string }[] = [
  { name: "squeeze", depth: 1, decode: packed },
  { name: "compat", depth: 1, decode: compat },
  { name: "untag", depth: 3, decode: untag },
  { name: "loose", depth: 1, decode: loose },
  { name: "unescape", depth: 2, decode: unescape },
  { name: "entity", depth: 4, decode: entity }, // attempt 6: 3 -> 4
  { name: "percent", depth: 4, decode: percent }, // attempt 6: 3 -> 4
  { name: "base64", depth: 2, decode: base64Runs },
  { name: "hex", depth: 2, decode: hexRuns },
];
export const MAX_VIEWS = 512;
// Judging stopped before a verdict (rw-p6a-resolve2): the views cap, or the caller's deadline. Never a
// finding: the verifier answers its own code (verify.ts `verification-budget`), not `credential`.
export class OverBudget extends Error {}
export class TooManyViews extends OverBudget {
  constructor() {
    super(`more than ${MAX_VIEWS} views`);
  }
}
export class OutOfTime extends OverBudget {
  constructor() {
    super("its time budget ran out");
  }
}
const checkTime = (deadline: number) => {
  if (deadline !== Infinity && performance.now() > deadline) throw new OutOfTime();
};

// Every view of `s`: the raw text and every decoding of it within the depths above. `deadline`
// (performance.now() ms; verify.ts's budget) is checked before every decoding.
export function views(s: string, deadline = Infinity): string[] {
  const outer = RUNS;
  RUNS = outer ?? new Map();
  PACKED = PACKED ?? new Map();
  try {
    return viewsOf(s, deadline);
  } finally {
    RUNS = outer;
    if (!outer) {
      PACKED = null;
      packedOf = packedIs = "";
      runsIs = [];
    }
  }
}
function viewsOf(s: string, deadline: number): string[] {
  const seen = new Set<string>([s]);
  const queue: { t: string; used: number[] }[] = [{ t: s, used: ENCODINGS.map(() => 0) }];
  for (let q = queue.shift(); q; q = queue.shift()) {
    const { t, used } = q;
    ENCODINGS.forEach((e, i) => {
      if (used[i] >= e.depth) return;
      checkTime(deadline);
      const d = e.decode(t);
      if (!d || seen.has(d)) return;
      seen.add(d);
      if (seen.size > MAX_VIEWS) throw new TooManyViews();
      const next = [...used];
      next[i]++;
      queue.push({ t: d, used: next });
    });
  }
  return [...seen];
}

// The base64 of a secret, at each of the three byte alignments it can have inside a longer encoded
// run (the last partial group dropped), standard and URL alphabets; and of each of those (depth 2).
function b64(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (let j = 0; j < 3; j++) {
    const sub = bytes.slice(j);
    const full = Math.floor(sub.length / 3) * 3;
    if (full < 9) continue;
    const b = btoa(String.fromCharCode(...sub.slice(0, full)));
    out.push(b, b.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return out;
}
export function base64Forms(x: string, depth = 2): string[] {
  const enc = new TextEncoder();
  const one = b64(enc.encode(x));
  if (depth < 2) return one;
  return [...new Set([...one, ...one.flatMap((f) => b64(enc.encode(f)))])];
}

// What judgeSecret looks for in a view, per secret k (the a06b72f checks, in their order):
//   low  k as written, case-insensitive, in the view lowercased          (low.includes(k.low))
//   sq   the same with the view's whitespace removed                      (sq.includes(k.low))
//   c    canon(k) in canon(view), or in canonAtDot(view)                  (c / ca .includes(k.c), k.c 8+)
//   b    one of k's base64 forms in the view                              (v.includes(f))
type Key = { x: string; low: string; c: string; b: string[] };
type Hits = { low: boolean[]; sq: boolean[]; c: boolean[]; b: boolean[]; ct: string };
type Judged = Hits & { lowForm: string; sqForm: string; cForm: string };
const lettersOf = (ct: string, plain: boolean) => plain ? ct.replace(/[^a-z0-9]+/g, "") : lettersDigits(ct);
// the a06b72f way, on the whole view: canonText (any secret), or canonPieces (an ASCII secret, below)
function wholeHits(v: string, keys: Key[], ascii: boolean): Judged {
  const plain = PLAIN_ONLY.test(v);
  const low = v.toLowerCase();
  const sq = low.replace(/\s+/g, "");
  const ct = plain ? low : ascii ? canonPieces(v) : canonText(v);
  const c = lettersOf(ct, plain);
  return {
    low: keys.map((k) => low.includes(k.low)),
    sq: keys.map((k) => sq.includes(k.low)),
    c: keys.map((k) => k.c.length >= 8 && c.includes(k.c)),
    b: keys.map((k) => k.b.some((f) => v.includes(f))),
    ct,
    lowForm: low,
    sqForm: sq,
    cForm: c,
  };
}

// rw-p6a-resolve2 attempt 2 (cost, not meaning): a long view that is not PLAIN, judged CHUNK BY CHUNK.
// It splits before line feeds and U+0000-U+0002 (chunkEnds: ASCII characters, so canonPieces' split holds;
// chosen by the character, so two views that differ in a few places - the views of a decoded run, a tag
// removed here, an escape undone there - split alike everywhere else and share most of their chunks).
// Each distinct chunk's forms (lowercase, without whitespace, canon, letters and digits) and whether each
// holds each secret's pattern are computed once (CHUNKS). A pattern in the joined form either lies inside
// one chunk's form, or crosses a boundary: then it lies inside the last (length - 1) characters of the
// form so far plus the first (length - 1) of the next chunk's form (take the last boundary it crosses) -
// `edge` below tests exactly those windows. Lowercasing, removing whitespace and keeping letters and digits
// are per character but for toLowerCase's Final_Sigma, so the joined forms equal the whole view's up to
// σ / ς (canonPieces): for an ASCII secret every check answers the same. ASCII secrets only.
const CHUNK_AT = /[\n\x00-\x02]/g;
// where a long text's chunks end: before a line feed or U+0000-U+0002 at least 128 characters on, and at
// its end (packed() splits the same way)
function chunkEnds(v: string): number[] {
  const ends: number[] = [];
  let from = 0;
  for (;;) {
    CHUNK_AT.lastIndex = from + 128;
    const m = CHUNK_AT.exec(v);
    if (!m) break;
    ends.push(m.index);
    from = m.index;
  }
  ends.push(v.length);
  return ends;
}
type Chunk = { raw: string; j: Judged };
const CHUNKS = new Map<string, Chunk>();
let chunksChars = 0;
function chunkOf(x: string, keys: Key[]): Chunk {
  let ch = CHUNKS.get(x);
  if (ch === undefined) {
    ch = { raw: x, j: wholeHits(x, keys, true) };
    if (chunksChars > 64_000_000) {
      CHUNKS.clear();
      chunksChars = 0;
    }
    CHUNKS.set(x, ch);
    chunksChars += 4 * x.length;
  }
  return ch;
}
// a form joined chunk by chunk, keeping only its last `keep` characters: does `pats[i]` cross a boundary?
class Edge {
  tail = "";
  hit: boolean[];
  private any: RegExp | null; // one pass for all the patterns; which ones, only when it finds one
  constructor(private pats: string[], private keep: number) {
    this.hit = pats.map(() => false);
    const ps = pats.filter((p) => p);
    this.any = ps.length ? new RegExp(ps.map((p) => p.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("|")) : null;
  }
  next(form: string) {
    if (this.tail && this.any) {
      const w = this.tail + form.slice(0, this.keep);
      if (this.any.test(w)) {
        this.pats.forEach((p, i) => {
          if (p && w.includes(p)) this.hit[i] = true;
        });
      }
    }
    this.tail = form.length >= this.keep ? form.slice(form.length - this.keep) : (this.tail + form).slice(-this.keep);
  }
}
function chunkHits(v: string, keys: Key[]): Hits {
  const max = (ps: string[]) => Math.max(1, ...ps.map((p) => p.length)) - 1;
  const lowP = keys.map((k) => k.low), cP = keys.map((k) => (k.c.length >= 8 ? k.c : ""));
  const bP = keys.flatMap((k) => k.b);
  const eLow = new Edge(lowP, max(lowP)), eSq = new Edge(lowP, max(lowP)), eC = new Edge(cP, max(cP)), eB = new Edge(bP, max(bP));
  const h: Hits = { low: keys.map(() => false), sq: keys.map(() => false), c: keys.map(() => false), b: keys.map(() => false), ct: "" };
  const ct: string[] = [];
  let from = 0;
  for (const to of chunkEnds(v)) {
    const ch = chunkOf(v.slice(from, to), keys);
    from = to;
    keys.forEach((_, i) => {
      h.low[i] ||= ch.j.low[i];
      h.sq[i] ||= ch.j.sq[i];
      h.c[i] ||= ch.j.c[i];
      h.b[i] ||= ch.j.b[i];
    });
    eLow.next(ch.j.lowForm);
    eSq.next(ch.j.sqForm);
    eC.next(ch.j.cForm);
    eB.next(ch.raw);
    ct.push(ch.j.ct);
  }
  let j = 0;
  keys.forEach((k, i) => {
    h.low[i] ||= eLow.hit[i];
    h.sq[i] ||= eSq.hit[i];
    h.c[i] ||= eC.hit[i];
    for (const _ of k.b) h.b[i] ||= eB.hit[j++];
  });
  h.ct = ct.join("");
  return h;
}
// the memos hold slices of the views: emptied when a judging ends
const forget = () => {
  CHUNKS.clear();
  chunksChars = 0;
  PIECES.clear();
  piecesChars = 0;
};

// The verdict on a text under the invariant above: the configured secret it carries ({ secret }), or
// { unjudged } when judging stopped first (more than MAX_VIEWS views, or past `deadline`), or null.
export type Verdict = { secret: string } | { unjudged: string };
export function judgeSecret(s: string, secrets: string[], deadline = Infinity): Verdict | null {
  const live = secrets.filter((x) => x && x.length >= 4);
  if (!live.length || !s) return null;
  try {
    const all = views(s, deadline);
    const keys: Key[] = live.map((x) => ({ x, low: x.toLowerCase(), c: canon(x), b: base64Forms(x) }));
    // attempt 2 (cost): an ASCII secret (every configured one: a key and a mailto) is looked for with
    // canonPieces, a long non-PLAIN view chunk by chunk (chunkHits); any other secret as at a06b72f
    const ascii = keys.every((k) => ASCII_ONLY.test(k.x));
    for (const v of all) {
      checkTime(deadline);
      const h = ascii && v.length >= 2048 && !PLAIN_ONLY.test(v) ? chunkHits(v, keys) : wholeHits(v, keys, ascii);
      // canonAtDot(view): with no at/dot spelling in it, it IS canon(view) (a backslash is not a letter)
      const nb = h.ct.indexOf("\\") < 0 ? h.ct : h.ct.replace(/\\/g, "");
      const ca = AT_DOT_ANY.test(nb) ? atDotOf(h.ct) : null;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (h.low[i] || h.sq[i]) return { secret: k.x };
        if (k.c.length >= 8 && (h.c[i] || (ca !== null && ca.includes(k.c)))) return { secret: k.x };
        if (h.b[i]) return { secret: k.x };
      }
    }
    return null;
  } catch (e) {
    if (e instanceof OverBudget) return { unjudged: e.message };
    throw e;
  } finally {
    forget();
  }
}

// What the input doors refuse (resolver unsafe / carries, the cached-row check, the exporter's error
// bodies): non-null when the text carries a configured secret - the secret - or could not be judged -
// UNJUDGED, fail closed, which names no secret.
export const UNJUDGED = "(not judged: over the credential check's budget)";
export function secretIn(s: string, secrets: string[]): string | null {
  const v = judgeSecret(s, secrets);
  return v === null ? null : "secret" in v ? v.secret : UNJUDGED;
}

// The credential's KIND, the only thing an error body says about it (rw-p6a-resolve2, B2: attempt 6 put
// its first two characters and its length in every 503). The mailto is the one with an `@` (as
// configured, or URL-encoded by secretForms).
export const credentialKind = (secret: string) => (/@|%40/i.test(secret) ? "the Crossref mailto" : "the OpenAlex key");

// The secrets as configured, and URL-encoded.
export const secretForms = (secrets: string[]) =>
  [...new Set(secrets.filter((s) => s && s.length >= 4).flatMap((s) => [s, encodeURIComponent(s)]))];

// Credential-shaped text (P3a scholarly.ts SECRET_SHAPED, narrowed to what a request carries): a
// key/mailto assignment, or a URL with a query string - in the raw, the real-tags-removed and the
// normalised text.
const SHAPED = /(?:api[_-]?key|mailto)\s*=|https?:\/\/[^\s]*\?/i;
function normaliseText(s: string): string {
  let t = s;
  for (let k = 0; k < 3; k++) t = decodeEntities(stripRealTags(t));
  return t.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export const credentialShaped = (s: string) => SHAPED.test(s) || SHAPED.test(stripRealTags(s)) || SHAPED.test(normaliseText(s));
