// Credential-shaped text, judged on what a READER sees (rw-p6a-resolve attempts 3 and 4). PURE.
//
// Attempt 2 compared the stored strings with the key: a title holding `tadv2s<i></i>ynthkey...` is not
// the key, so it was cached - and citeproc dropped the empty tag, so every output printed the key.
// Attempt 3 normalised the text first, but its normaliser deleted ANY `<...>` span, not only tags, and
// only the normalised text was searched: `Angle < KEY > title` normalised to `angle title`, so the
// key was cached and printed in every format but the DOCX (tester t-rw-p6a-3b, ADV-4).
//
// attempt 4: the check NEVER deletes content before matching on its own. The secret is searched in
// several FORMS of the text, and a hit in any one refuses:
//   (a) the RAW text;
//   (b) the text with only REAL tags removed - a strict tag grammar (REAL_TAG: `<` + a letter or `/`
//       + a name + attributes + `>`) and HTML comments; anything else (`< KEY >`, `<1 KEY>`, a lone
//       `<`) is text and stays;
//   (c) the normalised text: (b), entities and markdown backslash escapes undone, invisible
//       characters (soft hyphen, zero-width, joiners, bidi controls, variation selectors, tags)
//       removed, whitespace collapsed;
//   (d) attempt 3's loose form (every `<...>` span removed), kept ONLY as one more form, so nothing
//       attempt 3 refused is accepted now;
// each as it is and with all whitespace removed (a line break in a PDF splits nothing); and
//   (e) TRANSFORMED (tester N2): each of the above NFKC-folded (fullwidth letters), `%xx`
//       percent-decoded (twice), `(at)` / `[at]` / ` at ` read as `@` and `(dot)` / ` dot ` as `.`,
//       and with every character that is not a letter or digit removed (a `-`, `.`, `\` or `< >`
//       between the halves of a key is not a separator a reader cannot see through);
//   (f) the secret's base64 (standard and URL alphabets, every byte alignment) in the raw text.
// The same test judges a record before it is cached (resolver.ts unsafe: the CSL item AND the raw
// upstream strings) and every output before it is served (verify.ts checkText, secretInBytes).

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: ".", hyphen: "-", dash: "-",
  colon: ":", lowbar: "_", sol: "/", equals: "=", quest: "?", num: "#", shy: "", zwj: "", zwnj: "",
};
export const decodeEntities = (s: string) =>
  s.replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16) || 0x20, 0x10ffff)))
    .replace(/&#([0-9]+);?/g, (_m, n) => String.fromCodePoint(Math.min(Number(n) || 0x20, 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[(n as string).toLowerCase()] ?? m);

export const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]|[\u{e0000}-\u{e0fff}]/gu;

// A REAL tag: `<name attr="v" ...>` or `</name>`; a quoted value holds no `<` or `>` (so a scan
// stops at the next bracket: linear time). Anything else between `<` and `>` is text.
const ATTR = String.raw`(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'=<>\x60]+))?)`;
export const REAL_TAG = new RegExp(String.raw`<(?:[A-Za-z][A-Za-z0-9-]*${ATTR}*\s*\/?|\/[A-Za-z][A-Za-z0-9-]*\s*)>`, "g");
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
export const stripRealTags = (s: string) => s.replace(COMMENT, "").replace(REAL_TAG, "");

const finish = (t: string) => t.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().toLowerCase();

// (c) the normalised text: real tags removed, entities undone (three rounds: `&amp;lt;i&amp;gt;`),
// escapes undone, invisibles removed, whitespace collapsed, lower-cased.
export function normaliseText(s: string): string {
  let t = s;
  for (let k = 0; k < 3; k++) t = decodeEntities(stripRealTags(t));
  return finish(t);
}
// (d) attempt 3's form: every `<...>` span removed. One form among the others, never the only one.
function looseText(s: string): string {
  let t = s;
  for (let k = 0; k < 3; k++) t = decodeEntities(t.replace(/<[^<>]*>/g, ""));
  return finish(t);
}

const percentDecode = (t: string) => t.replace(/%([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
// (e) a transformed form: NFKC, percent-decoded twice, at/dot spelled out read as `@` and `.`
function fold(t: string): string {
  let f = t.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/g, " ").toLowerCase();
  f = percentDecode(percentDecode(f)).normalize("NFKC").toLowerCase();
  return f.replace(/\s?[([{<]\s?at\s?[)\]}>]\s?/g, "@").replace(/ at /g, "@")
    .replace(/\s?[([{<]\s?dot\s?[)\]}>]\s?/g, ".").replace(/ dot /g, ".");
}
const squeeze = (t: string) => t.replace(/\s+/g, "");
const alnum = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "");

// Every form of `s` a secret is searched in (lower-cased).
export function textForms(s: string): string[] {
  const out = new Set<string>();
  for (const b of [s.toLowerCase(), stripRealTags(s).toLowerCase(), normaliseText(s), looseText(s)]) {
    const f = fold(b);
    for (const x of [b, squeeze(b), f, squeeze(f), alnum(f)]) if (x) out.add(x);
  }
  return [...out];
}

// (f) the base64 of a secret, at each of the three byte alignments it can have inside a longer
// encoded run (the last partial group dropped), standard and URL alphabets.
export function base64Forms(x: string): string[] {
  const bytes = new TextEncoder().encode(x);
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

// The configured secret (if any) the text carries, in any form above.
export function secretIn(s: string, secrets: string[]): string | null {
  if (!secrets.length || !s) return null;
  const forms = textForms(s);
  const rawSqueezed = squeeze(s);
  for (const x of secrets) {
    const k = squeeze(x.toLowerCase());
    if (k.length < 4) continue;
    const a = alnum(k);
    if (forms.some((f) => f.includes(k) || (a.length >= 8 && f.includes(a)))) return x;
    if (base64Forms(x).some((b) => s.includes(b) || rawSqueezed.includes(b))) return x;
  }
  return null;
}

// The secrets as configured, and URL-encoded.
export const secretForms = (secrets: string[]) =>
  [...new Set(secrets.filter((s) => s && s.length >= 4).flatMap((s) => [s, encodeURIComponent(s)]))];

// Credential-shaped text (P3a scholarly.ts SECRET_SHAPED, narrowed to what a request carries): a
// key/mailto assignment, or a URL with a query string - in the raw, the real-tags-removed and the
// normalised text.
const SHAPED = /(?:api[_-]?key|mailto)\s*=|https?:\/\/[^\s]*\?/i;
export const credentialShaped = (s: string) => SHAPED.test(s) || SHAPED.test(stripRealTags(s)) || SHAPED.test(normaliseText(s));
