// Credential-shaped text, judged on what a READER sees (rw-p6a-resolve attempt 3). PURE.
//
// Attempt 2 compared the stored strings with the key: a title holding `tadv2s<i></i>ynthkey...` is not
// the key, so it was cached - and citeproc dropped the empty tag, so every output printed the key.
// Here a string is NORMALISED first: tags (citeproc's own included) stripped, entities and markdown
// backslash escapes undone, invisible characters (soft hyphen, zero-width, joiners, bidi controls,
// variation selectors, tags) removed, whitespace collapsed; and it is compared both as it is and with
// all whitespace removed (a line break in a PDF splits nothing). The same test judges a record before
// it is cached (resolver.ts unsafe) and every output before it is served (verify.ts).

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: ".", hyphen: "-", dash: "-",
  colon: ":", lowbar: "_", sol: "/", equals: "=", quest: "?", num: "#", shy: "", zwj: "", zwnj: "",
};
export const decodeEntities = (s: string) =>
  s.replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16) || 0x20, 0x10ffff)))
    .replace(/&#([0-9]+);?/g, (_m, n) => String.fromCodePoint(Math.min(Number(n) || 0x20, 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[(n as string).toLowerCase()] ?? m);

export const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]|[\u{e0000}-\u{e0fff}]/gu;

export function normaliseText(s: string): string {
  let t = s;
  for (let k = 0; k < 3; k++) t = decodeEntities(t.replace(/<[^<>]*>/g, ""));
  return t.replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// The configured secret (if any) the text carries, normalised, as it is and with no whitespace.
export function secretIn(s: string, secrets: string[]): string | null {
  if (!secrets.length || !s) return null;
  const n = normaliseText(s);
  const squeezed = n.replace(/\s+/g, "");
  for (const x of secrets) {
    const k = x.toLowerCase().replace(/\s+/g, "");
    if (k.length >= 4 && (n.includes(k) || squeezed.includes(k))) return x;
  }
  return null;
}

// The secrets as configured, and URL-encoded.
export const secretForms = (secrets: string[]) =>
  [...new Set(secrets.filter((s) => s && s.length >= 4).flatMap((s) => [s, encodeURIComponent(s)]))];

// Credential-shaped text (P3a scholarly.ts SECRET_SHAPED, narrowed to what a request carries): a
// key/mailto assignment, or a URL with a query string - on the normalised text.
const SHAPED = /(?:api[_-]?key|mailto)\s*=|https?:\/\/[^\s]*\?/i;
export const credentialShaped = (s: string) => SHAPED.test(normaliseText(s));
