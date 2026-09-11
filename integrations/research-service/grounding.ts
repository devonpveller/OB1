/**
 * grounding.ts — every number in a cited line must exist in a cited source.
 *
 * PLAN-research-trust-2026-09-11 Phase 2.3. Pure: no deps, no env, no I/O.
 *
 * The failure this exists for (audit 2026-09-11): job ce398d06 emitted
 *   "[INFERRED] Thermal throttling and automatic shutdown at approximately
 *    95°C is documented for the NVIDIA DGX Spark … [Source 5, 6]"
 * and the digits "95" are in neither cited source's stored text. The curator
 * then wrote it as a grounded claim at 0.51. The synthesizer is told never to
 * invent a number; this is the check that the instruction was followed.
 *
 * Index-safety is a hard requirement: buildCitedAndRenumber() runs AFTER this
 * and maps [Source N] -> the compacted cited list, so this must preserve the
 * line count and every citation marker byte-for-byte.
 */

/** Lines this applies to. [GAP] asserts nothing and carries no citation. */
const TAGGED_RE = /^\[(SOURCED|INFERRED|UNCERTAIN)\]/i;
const CITE_BRACKET_RE = /\[Sources?\b[^\]]*\]/gi;

/** Numbers are compared as digit strings; 95 and 95.0 are not the same token. */
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

/** Normalise for comparison: unicode-fold, collapse whitespace, strip thin/nb spaces. */
function normalise(s: string): string {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[    ]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Every numeric token asserted by a line, with the [Source N] citation removed
 * first so the citation's own digits are never mistaken for a claimed figure.
 * Returns digit strings in order of appearance, de-duplicated.
 */
export function numbersIn(line: string): string[] {
  const body = normalise(line).replace(CITE_BRACKET_RE, " ");
  const out: string[] = [];
  for (const m of body.match(NUMBER_RE) || []) {
    // Trim a trailing separator ("in 2025, the" -> "2025").
    const tok = m.replace(/[.,]$/, "");
    if (tok && !out.includes(tok)) out.push(tok);
  }
  return out;
}

/**
 * English word forms for the small integers. A source that says "thirty
 * participants" DOES support a line that says "30 participants", and the first
 * version of this check downgraded exactly that line in the 100 Hz run (the
 * CAREN trial, which the audit had verified as supported). A digits-only
 * comparison is not a grounding check, it is a spelling check.
 */
const WORD_NUMBERS: Record<string, string> = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five",
  "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten",
  "11": "eleven", "12": "twelve", "13": "thirteen", "14": "fourteen",
  "15": "fifteen", "16": "sixteen", "17": "seventeen", "18": "eighteen",
  "19": "nineteen", "20": "twenty", "30": "thirty", "40": "forty",
  "50": "fifty", "60": "sixty", "70": "seventy", "80": "eighty",
  "90": "ninety", "100": "hundred", "1000": "thousand",
};

/** Does this digit string occur in the text as a number rather than inside a longer one? */
function occurs(textN: string, num: string): boolean {
  const word = WORD_NUMBERS[num];
  if (word && new RegExp("(?<![a-z])" + word + "(?![a-z])").test(textN)) return true;
  // Digit-boundary match: "95" must not be satisfied by "1195" or "95.6" -> but
  // "26" IS satisfied by "26%" and "0.0055" by "p = 0.0055".
  const esc = num.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
  if (new RegExp("(?<![\\d.,])" + esc + "(?![\\d])").test(textN)) return true;
  // A figure written with a thousands separator in the source ("1,881" vs "1881").
  if (/^\d{4,}$/.test(num)) {
    const grouped = num.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return new RegExp("(?<![\\d.,])" + grouped + "(?![\\d])").test(textN);
  }
  return false;
}

export interface GroundNumbersResult { ok: boolean; missing: string[]; }

/**
 * Check one line's numbers against the held text of the sources IT cites.
 * `citedTexts` is already resolved by the caller — an empty list means there is
 * nothing to check against, which is not evidence of fabrication, so it passes.
 */
export function groundNumbers(line: string, citedTexts: string[]): GroundNumbersResult {
  const nums = numbersIn(line);
  const texts = (citedTexts || []).map(normalise).filter((t) => t.length > 0);
  if (!nums.length || !texts.length) return { ok: true, missing: [] };
  const missing = nums.filter((n) => !texts.some((t) => occurs(t, n)));
  return { ok: missing.length === 0, missing };
}

/** 1-based [Source N] numbers a line cites. */
function citedIndices(line: string): number[] {
  const out: number[] = [];
  for (const bracket of line.match(CITE_BRACKET_RE) || []) {
    for (const d of bracket.match(/\d+/g) || []) {
      const n = parseInt(d, 10);
      if (n > 0 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

export interface NumericGroundingResult {
  synthesis: string;
  /** One entry per downgraded line: "95 °C (line 14)" style, for the run record. */
  ungrounded: string[];
}

/**
 * Walk a tagged synthesis; downgrade every [SOURCED]/[INFERRED] line that
 * asserts a number none of its own cited sources holds. The line becomes
 * [UNCERTAIN] and gains "(unverified figure: N)" — it is NOT deleted, because
 * the sentence may still be right and a silent deletion is its own dishonesty.
 *
 * Line count and every [Source N] marker are preserved (buildCitedAndRenumber
 * runs after this and depends on both).
 */
export function applyNumericGrounding(
  synthesis: string,
  poolTexts: Array<string | null | undefined>,
): NumericGroundingResult {
  const ungrounded: string[] = [];
  const lines = String(synthesis || "").split("\n");
  const out = lines.map((line) => {
    if (!TAGGED_RE.test(line.trim())) return line;
    const idx = citedIndices(line);
    if (!idx.length) return line;
    const texts = idx
      .map((n) => poolTexts[n - 1])
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (!texts.length) return line;               // unresolvable citation: no verdict
    const { ok, missing } = groundNumbers(line, texts);
    if (ok) return line;
    ungrounded.push(missing.join(", "));
    const retagged = line.replace(/^(\s*)\[(SOURCED|INFERRED|UNCERTAIN)\]/i, "$1[UNCERTAIN]");
    // Append the note at the very end so the citation stays where renderers and
    // the curator's parser expect it… but keep the citation last, since
    // downstream regexes anchor on "ends with its citation".
    const note = ` (unverified figure: ${missing.join(", ")})`;
    const lastCite = retagged.lastIndexOf("[Source");
    if (lastCite < 0) return retagged + note;
    return retagged.slice(0, lastCite).trimEnd() + note + " " + retagged.slice(lastCite);
  });
  return { synthesis: out.join("\n"), ungrounded };
}
