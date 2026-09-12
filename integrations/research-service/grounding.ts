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
  return numbersWithUnits(line).map((n) => n.num);
}

export interface ClaimedNumber { num: string; unit: string; }

/**
 * Every numeric token a line asserts, with the unit written immediately after
 * it (normalised, lower-cased, "°c" for both "95 °C" and "95C"). The unit is
 * what stops "the chassis is 95 mm wide" from grounding a claimed "95 °C".
 */
export function numbersWithUnits(line: string): ClaimedNumber[] {
  const body = normalise(line).replace(CITE_BRACKET_RE, " ");
  const out: ClaimedNumber[] = [];
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(body)) !== null) {
    // Trim a trailing separator ("in 2025, the" -> "2025").
    const tok = m[0].replace(/[.,]$/, "");
    if (!tok || out.some((o) => o.num === tok)) continue;
    const after = body.slice(m.index + m[0].length).replace(/^[\s ]*/, "");
    const um = after.match(UNIT_RE);
    const unit = um ? um[0].replace(/[\s°]/g, "").toLowerCase() : "";
    out.push({ num: tok, unit });
  }
  return out;
}

/** Cut pointer spans (citations, page and figure numbers) out of a source text. */
function stripPointers(textN: string): string {
  let out = textN;
  for (const re of POINTER_SPANS) out = out.replace(re, " ");
  return out;
}

/**
 * English word forms for the small integers. A source that says "thirty
 * participants" DOES support a line that says "30 participants", and the first
 * version of this check downgraded exactly that line in the 100 Hz run (the
 * CAREN trial, which the audit had verified as supported). A digits-only
 * comparison is not a grounding check, it is a spelling check.
 *
 * 0, 1 and 2 and the magnitudes "hundred"/"thousand" were here and are GONE
 * (tester's B5): "no ONE reported a failure" grounded a claimed 1, "TWO
 * engineers reviewed the design" grounded a claimed 2, and "several HUNDRED
 * subjects" grounded a claimed 100. Those are among the commonest words in
 * English, so the table made the check weakest exactly where fabricated figures
 * are most plausible. Three upward is specific enough to mean the number.
 */
const WORD_NUMBERS: Record<string, string> = {
  "3": "three", "4": "four", "5": "five",
  "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten",
  "11": "eleven", "12": "twelve", "13": "thirteen", "14": "fourteen",
  "15": "fifteen", "16": "sixteen", "17": "seventeen", "18": "eighteen",
  "19": "nineteen", "20": "twenty", "30": "thirty", "40": "forty",
  "50": "fifty", "60": "sixty", "70": "seventy", "80": "eighty", "90": "ninety",
};

/**
 * Spans in a SOURCE text where a number is a POINTER, not a measurement:
 * a citation index, a reference marker, a page or figure number. They are cut
 * out before the comparison — otherwise any stray "[95]" or "page 95" in a
 * fetched page grounds a fabricated "95 °C", and real pages are full of them.
 */
const POINTER_SPANS: RegExp[] = [
  /\[\s*sources?\s+\d+(\s*,\s*\d+)*\s*\]/gi,
  /\bsources?\s+\d+\b/gi,
  /\[\s*\d+(\s*[,-]\s*\d+)*\s*\]/g,
  /\b(pages?|pp?)\.?\s*\d+(\s*[-–]\s*\d+)?/gi,
  /\b(fig(ure)?|table|chapter|section|ref(erence)?|note)\.?\s*\d+(\.\d+)*/gi,
];

/** Units a figure can carry. A claim that names one must match it in the source. */
// Case-insensitive: `normalise()` lower-cases the text before this runs, so an
// uppercase-only class silently matched nothing and every unit came back "".
const UNIT_RE =
  /^(°?\s?[cf]\b|%|mm|cm|km|kg|mg|lb|kw|mw|mv|ma|khz|mhz|ghz|hz|gb|mb|tb|kb|ms|min|hr|hours?|days?|years?|bar|psi|rpm|db|ft|in|[mgwva]\b|s\b|h\b)/i;

/**
 * Does this figure occur in the text as the number the claim asserts? When the
 * claim carries a UNIT, the source must carry the same unit next to the same
 * digits — otherwise "the chassis is 95 mm wide" grounds a fabricated "95 °C".
 */
function occurs(textN: string, num: string, unit = ""): boolean {
  if (unit) {
    const esc = num.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
    const u = unit.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
    // NOT `\b` after the unit: `%` is a non-word character, so `%\b` needs a
    // word character next to it and "26% motion sickness" failed to match the
    // claim's own "26%". That downgraded the verified 100 Hz GVS line.
    return new RegExp("(?<![\\d.,])" + esc + "\\s*°?\\s*" + u + "(?![a-z0-9])", "i").test(textN);
  }
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
  const nums = numbersWithUnits(line);
  const texts = (citedTexts || [])
    .map((t) => stripPointers(normalise(t)))
    .filter((t) => t.length > 0);
  if (!nums.length || !texts.length) return { ok: true, missing: [] };
  const missing = nums
    .filter((n) => !texts.some((t) => occurs(t, n.num, n.unit)))
    .map((n) => n.num);
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


// ── The RENDERED document against the grounded answer (research-trust-report) ──
// The template renderer is a model writing prose from the tagged synthesis, and
// it is the last place a fact can enter the run ungrounded. Measured on the
// buyer's-guide render of job 33250e9b: with the grounding rules as they were,
// it invented a duration ("wait 30 seconds"), a count ("repeat three times")
// and an abbreviation the answer never used. Tightening the rules removed every
// number; what survives is the occasional STANDARD the answer does not name -
// "no standard ATX connector present", from a source that only says the
// connector is proprietary.
//
// So the run measures its own report the way it already measures its figures
// (applyNumericGrounding): nothing is blocked, nothing is rewritten, and
// nothing is hidden. A leak is recorded on the run and printed in the progress
// log, where the next person to look at this can see it and decide.
//
// Approximate by design, in the direction of FALSE ALARMS, never silence:
//   numbers - exact, after the citation markers are removed
//   urls    - exact
//   names   - ACRONYMS and model codes only (two or more capitals, plural
//             folded, hyphens split). Sentence-initial capitals are not names,
//             and a TitleCase check drowns the real signal in "Check", "Verify",
//             "One".

export interface RenderGroundingDiff {
  numbers: string[];
  urls: string[];
  names: string[];
  /** Citations a unit carries that contribute nothing to it (tester X3).
   *  Filled by the harness from `supersetCitations`; [] when not computed. */
  citations?: string[];
}

const RENDER_URL_RE = /https?:\/\/[^\s)\]]+/g;
const RENDER_ACRONYM_RE = /[A-Za-z0-9]+/g;

/**
 * Is this name earned by the evidence, even though the evidence never writes it?
 *
 * "BSOD" is not in the synthesis; "Blue Screen of Death" is, and a report that
 * abbreviates a phrase its sources spell out has invented nothing. The test is
 * an EXPANSION MATCH and not a list of known abbreviations:
 *   - the name appears as a whole word, case-insensitively, anywhere in the
 *     evidence ("RBAC" in a source that writes "RBAC"), or
 *   - some run of consecutive words in the evidence has initials that spell it
 *     (B-lue S-creen o-f D-eath).
 *
 * Deliberately generous on the second rule - "of" counts, because the phrases
 * people abbreviate include their small words - and deliberately silent about
 * WHICH abbreviations exist, because four items in this workstream have now
 * failed on a hand-written list of surface strings.
 */
export function expansionMatch(name: string, evidence: string): boolean {
  const n = String(name || "").trim();
  if (n.length < 2) return false;
  const text = String(evidence || "");
  if (new RegExp(`(?<![A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(text)) {
    return true;
  }
  const want = n.toLowerCase();
  // Initials of consecutive words, per LINE: a phrase does not span a newline,
  // and letting it would make any long document contain every acronym.
  for (const line of text.split(/\r?\n/)) {
    const words = line.match(/[A-Za-z][A-Za-z0-9'-]*/g) || [];
    const initials = words.map((w) => w[0].toLowerCase()).join("");
    if (initials.includes(want)) return true;
  }
  return false;
}

/** The lines of a synthesis that are GROUNDED - tagged and cited. */
export function groundedText(synthesis: string): string {
  return String(synthesis || "").split(/\r?\n/)
    .filter((l) => /^\s*\[(SOURCED|INFERRED|UNCERTAIN)\]/i.test(l))
    .join("\n");
}

function acronymSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text || "").match(RENDER_ACRONYM_RE) || []) {
    const core = w.length > 2 && w.endsWith("s") && w.slice(0, -1) === w.slice(0, -1).toUpperCase()
      ? w.slice(0, -1)
      : w;
    if (/^[A-Z]{2,}[0-9]*$/.test(core)) out.add(core);
  }
  return out;
}

/**
 * What the RENDERED document says that the grounded answer does not. `query` is
 * included in the reference text because the reader's own words are not a
 * fabrication when the report repeats them.
 */
export function renderGroundingDiff(
  rendered: string, synthesis: string, query = "",
): RenderGroundingDiff {
  // HTML comments are the engine's own machinery (the incomplete directive, an
  // evidence file's provenance header) and are not part of the document.
  const doc = String(rendered || "").replace(/<!--[\s\S]*?-->/g, " ");
  const ref = `${synthesis || ""}\n${query || ""}`;
  const docNums = new Set(stripPointers(normalise(doc)).match(NUMBER_RE) || []);
  const refNums = new Set(stripPointers(normalise(ref)).match(NUMBER_RE) || []);
  const docUrls = new Set(doc.match(RENDER_URL_RE) || []);
  const refUrls = new Set(ref.match(RENDER_URL_RE) || []);
  // NAMES are judged against the GROUNDED lines only, and the query. A [GAP]
  // line is the synthesizer's own words about what it could not find - not a
  // source's - so a name that appears only there is as unearned as one the
  // renderer invented. Measured live (run a205845d): "non-OEM" reached the
  // Limitations list because a [GAP] line said "a non-OEM fan", and no source
  // in that run ever wrote OEM.
  //
  // Numbers and URLs keep the whole synthesis as their reference: a figure
  // inside a [GAP] QUESTION is a question, not an assertion, and flagging it
  // would report the report for asking about the thing it was asked about.
  const refNames = acronymSet(`${groundedText(synthesis || "")}\n${query || ""}`);
  const docNames = acronymSet(doc);
  const grounded = `${groundedText(synthesis || "")}\n${query || ""}`;
  return {
    numbers: [...docNums].filter((n) => !refNums.has(n)).sort(),
    urls: [...docUrls].filter((u) => !refUrls.has(u)).sort(),
    names: [...docNames]
      .filter((n) => !refNames.has(n))
      .filter((n) => !expansionMatch(n, grounded))
      .sort(),
  };
}
