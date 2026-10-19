// TEST ORACLE (rw-p6a-resolve2 attempt 2): credentials.ts exactly as committed at a06b72f, kept only so
// resolve2_test.ts can prove the attempt-2 cost changes answer the same as the a06b72f invariant (views,
// canon, judgeSecret) on every text it is given. Never imported by the exporter.

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

// ── the encodings ───────────────────────────────────────────────────────────────────────────────
const utf8 = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(b);
const percent = (t: string) =>
  t.replace(/(?:%[0-9a-f]{2})+/gi, (m) => utf8(Uint8Array.from(m.slice(1).split("%"), (h) => parseInt(h, 16))));
// a run of an encoding's alphabet: whitespace, invisible characters and a markdown backslash escape
// inside it are not breaks
const packed = (t: string) => t.replace(/[\s\\]+/g, "").replace(STRIP, "");
function base64Runs(t: string): string {
  const out: string[] = [];
  for (const m of packed(t).matchAll(/[A-Za-z0-9+/_-]{12,}/g)) {
    const run = m[0].replace(/-/g, "+").replace(/_/g, "/");
    for (let k = 0; k < 4; k++) {
      const s = run.slice(k);
      const body = s.slice(0, s.length - (s.length % 4));
      if (body.length < 12) continue;
      out.push(utf8(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))));
    }
  }
  return out.join("\n");
}
function hexRuns(t: string): string {
  const out: string[] = [];
  for (const m of packed(t).matchAll(/[0-9a-f]{16,}/gi)) {
    for (let k = 0; k < 2; k++) {
      const s = m[0].slice(k);
      const pairs = s.slice(0, s.length - (s.length % 2)).match(/../g) ?? [];
      out.push(utf8(Uint8Array.from(pairs, (h) => parseInt(h, 16))));
    }
  }
  return out.join("\n");
}
// a markdown backslash escape undone (`\<sup\>`, `&\#50;`: the MD output's spelling of text)
const unescape = (t: string) => t.replace(/\\([!-/:-@[-`{-~])/g, "$1");
const untag = (t: string) => stripRealTags(t).replace(/<!\[CDATA\[|\]\]>/gi, "");
const loose = (t: string) => t.replace(/<[^<>]*>/g, "");

// The ONE list: each decoder and the depth it is followed to.
export const ENCODINGS: { name: string; depth: number; decode: (t: string) => string }[] = [
  { name: "squeeze", depth: 1, decode: packed },
  { name: "compat", depth: 1, decode: (t) => t.normalize("NFKC") },
  { name: "untag", depth: 3, decode: untag },
  { name: "loose", depth: 1, decode: loose },
  { name: "unescape", depth: 2, decode: unescape },
  { name: "entity", depth: 4, decode: decodeEntitiesDeep }, // attempt 6: 3 -> 4
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

// The verdict on a text under the invariant above: the configured secret it carries ({ secret }), or
// { unjudged } when judging stopped first (more than MAX_VIEWS views, or past `deadline`), or null.
export type Verdict = { secret: string } | { unjudged: string };
export function judgeSecret(s: string, secrets: string[], deadline = Infinity): Verdict | null {
  const live = secrets.filter((x) => x && x.length >= 4);
  if (!live.length || !s) return null;
  try {
    const all = views(s, deadline);
    const keys = live.map((x) => ({ x, low: x.toLowerCase(), c: canon(x), b: base64Forms(x) }));
    for (const v of all) {
      checkTime(deadline);
      const low = v.toLowerCase();
      const sq = low.replace(/\s+/g, "");
      const ct = canonText(v); // once per view: canon and canonAtDot share it (rw-p6a-resolve2, cost)
      const c = lettersDigits(ct);
      const ca = atDotOf(ct);
      for (const k of keys) {
        if (low.includes(k.low) || sq.includes(k.low)) return { secret: k.x };
        if (k.c.length >= 8 && (c.includes(k.c) || ca.includes(k.c))) return { secret: k.x };
        if (k.b.some((f) => v.includes(f))) return { secret: k.x };
      }
    }
    return null;
  } catch (e) {
    if (e instanceof OverBudget) return { unjudged: e.message };
    throw e;
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
