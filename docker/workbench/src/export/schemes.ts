// Text that names an unsafe URL scheme (rw-p6a-resolve attempt 3). PURE.
//
// Written as text, `javascript:...` is inert, but a reader that auto-links would make it a link, and
// the output verification (verify.ts) refuses these strings in every output. So no text the export
// writes carries one: the note's text, its code and math, its title and every reference field are
// defanged - the colon becomes `[:]`, the defanging convention, visibly. Invisible characters
// (zero-width, soft hyphen, BOM) between the letters do not hide a scheme from either side.
const I = "[\\u00ad\\u034f\\u180e\\u200b-\\u200f\\u2060-\\u2064\\ufeff]*";
const word = (w: string) => w.split("").join(I);
const SCHEME = `(?:${["javascript", "vbscript", "livescript"].map(word).join("|")})${I}\\s*${I}`;
const DATA = `${word("data")}${I}\\s*`;
const FILE = `${word("file")}${I}\\s*`;

// (an inline raster image, data:image/png|jpeg|gif|webp, is inert and may stay)
const MIME = "\\s*(?!image/(?:png|jpe?g|gif|webp)[;,])[a-z-]+/";
export const UNSAFE_SCHEME_TEXT = new RegExp(`${SCHEME}:|${DATA}:${MIME}|${FILE}:\\s*//`, "i");

export const defang = (s: string) =>
  s.replace(new RegExp(`(${SCHEME}):`, "gi"), "$1[:]")
    .replace(new RegExp(`(${DATA}):(${MIME})`, "gi"), "$1[:]$2")
    .replace(new RegExp(`(${FILE}):(\\s*//)`, "gi"), "$1[:]$2");

// Text (not code) never holds three colons in a row: pandoc's markdown writer does not escape a line of
// colons, and a reader with fenced divs would open a div - with attributes - on one (the MD export
// re-read by pandoc's default reader). A word joiner (U+2060, invisible, no glyph drawn) goes between
// the second and the third colon.
const WJ = String.fromCharCode(0x2060);
export const noColonRuns = (s: string) => s.replace(/::(?=:)/g, "::" + WJ);
