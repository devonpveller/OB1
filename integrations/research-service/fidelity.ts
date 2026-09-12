/**
 * fidelity.ts — does each sentence of the RENDERED report say what the line it
 * cites actually said?
 *
 * The tester found this by reading the document, which is the only way it could
 * have been found. In the buyer's guide for job 33250e9b, one table cell cited
 * [Source 13] and read:
 *
 *     Physical connector is non-standard; no off-the-shelf ATX or SFX drop-in available
 *
 * while the synthesis line it was built from says the proprietary connector
 *
 *     …makes it DIFFICULT for users to install aftermarket PSUs…
 *
 * Two things changed in that cell. The names ATX and SFX are not in the
 * synthesis — `renderGroundingDiff` catches those. And "makes it difficult"
 * became "no … available": a hedge turned into an absolute, presented as fact
 * under a citation that does not support it. **Nothing in this engine could see
 * that**, and the tester proved it: "It is impossible to install aftermarket
 * PSUs" and "The unit always fails within a year" both pass the diff clean,
 * because the diff compares numbers, URLs and names, and modality is none of
 * those.
 *
 * Two guards, because neither is sufficient alone:
 *   - the GROUNDING RULES now forbid both moves explicitly (templates.ts);
 *   - and every rendered sentence that carries a citation is CHECKED against
 *     the lines it cites, by a judge that answers in one word.
 *
 * The judge is advisory in the same way the skeptic is: it fails OPEN. A judge
 * that errors, times out or answers nonsense leaves the document exactly as the
 * renderer wrote it and records that it was not checked. A report is never
 * withheld because a checker broke.
 *
 * What it does with a bad sentence is deliberately graduated:
 *   STRONGER / UNSUPPORTED  -> one targeted re-render of those sentences only
 *   still bad after that    -> replaced with the cited synthesis line VERBATIM
 * The last step cannot fail: the synthesis line is the grounded text, tags
 * stripped and citation kept. It reads worse than good prose and it is true,
 * which is the trade this whole workstream keeps making.
 */
import type { Deps } from "./harness.ts";
import { renderGroundingDiff } from "./grounding.ts";

export interface FidelityRecord {
  /** Sentences and table cells presented to the judge. */
  checked: number;
  /** Every unit the document HAS (`countUnits`), checked or not. The footer
   *  says "N of M" because a coverage number with no denominator is what the
   *  tester's X1 and X4 were both about: a confident "checked: 32" that no
   *  committed artifact reproduces, over a document with sentences the checker
   *  silently skipped. */
  units: number;
  /** M - N: units the check could not judge (no reference lines, or a batch
   *  that failed). Printed, never rounded away. */
  unchecked: number;
  stronger: number;
  unsupported: number;
  /** …of those, fixed by the targeted re-render. */
  rewritten: number;
  /** …and fixed by falling back to the synthesis line verbatim. */
  replaced: number;
  /** Names the grounding diff flagged that are GONE from the delivered
   *  document because this check removed them. Counted only when the recount
   *  says so - "blocked" is a claim about the artifact, not about intent. */
  names_blocked: string[];
  /** Set when the check did not run. The document is untouched. */
  error?: string;
}

export function emptyFidelity(): FidelityRecord {
  return { checked: 0, units: 0, unchecked: 0, stronger: 0, unsupported: 0, rewritten: 0,
           replaced: 0, names_blocked: [] };
}

/**
 * Does this text use a name the evidence never earned?
 *
 * `renderGroundingDiff` has been REPORTING these since research-trust-report -
 * ATX and SFX in one item, BSOD in the next, OEM in the one after - into a
 * field on a job row that the colleague reading the report never sees. This is
 * the same measurement given teeth: a unit that uses one is UNSUPPORTED before
 * any judge is asked, because a name no source uses is a fact no source
 * supports, and no amount of hedging makes it grounded.
 */
export function namesIn(text: string, flagged: string[]): string[] {
  const t = String(text || "");
  return flagged.filter((n) => new RegExp(`(?<![A-Za-z0-9])${n}(?![A-Za-z0-9])`).test(t));
}

/** One checkable piece of the rendered document. */
export interface CitedUnit {
  /** The text EXACTLY as it stands in the delivered document. Every edit is
   *  made against this span, so a document with nothing to correct comes back
   *  byte-identical. */
  text: string;
  /** The same span with its citation moved inside the sentence - the VIEW the
   *  judge reads, and nothing else. It is never written back. */
  view: string;
  /** False when the unit cannot be safely edited (a bullet that wraps onto the
   *  next line). It is still COUNTED, and lands in `unchecked`: the tester's X2
   *  found such a bullet absent from M entirely, which is the coverage gap this
   *  module exists to close wearing a different hat. */
  judgeable: boolean;
  /** 0-based line index in the document. */
  line: number;
  /** For a table row, which cell; -1 for prose. */
  cell: number;
  /** [Source N] numbers this unit (or its row) carries. Empty for an UNCITED
   *  unit in a findings section - which is checked anyway, against the nearest
   *  synthesis lines, because "drop the citation" was the open bypass. */
  citations: number[];
  /** The `## heading` this unit sits under, "" before the first one. */
  section: string;
  /** Flagged names this unit uses (filled by the check, not by extraction). */
  names?: string[];
}

const CITE_RE = /\[Sources?\s*[^\]]*\]/gi;
/** A synthesis line that carries evidence: tagged, and therefore not a [GAP]. */
const GROUNDED_LINE = /^\s*\[(SOURCED|INFERRED|UNCERTAIN)\]/i;
const TAG_RE = /^\s*\[(SOURCED|INFERRED|UNCERTAIN)\]\s*/i;

function citationsIn(text: string): number[] {
  const out = new Set<number>();
  for (const b of String(text || "").match(CITE_RE) || []) {
    for (const d of b.match(/\d+/g) || []) out.add(parseInt(d, 10));
  }
  return [...out].sort((a, b) => a - b);
}

/** Enough words to be an assertion rather than a label or a heading. */
function isClaimLike(text: string): boolean {
  const words = text.replace(CITE_RE, " ").trim().split(/\s+/).filter(Boolean);
  return words.length >= 5;
}

/**
 * Put a trailing citation back INSIDE its sentence.
 *
 * The tester's X1: a sentence written "The PSU makes it difficult to upgrade.
 * [Source 13]" split into a claim with no citation and a citation with no
 * claim, and yielded ZERO units - the guard silently skipped it while the
 * footer still reported a confident count. The production convention puts the
 * citation before the stop; nothing enforced it. This normalises the other
 * spelling rather than trusting the convention, and it is deterministic: only
 * whitespace and the position of the bracket change.
 */
/** stop + space + citation, at the END of a span (see normaliseCitations). */
const CITE_AFTER_STOP =
  /((?:[a-z0-9]{2}|[)\]"'”])[.?!])[ \t]+(\[Sources?[^\]]*\])[ \t]*\.?\s*$/;

export function normaliseCitations(text: string): string {
  // A VIEW, and only a view. This used to run on the text that SHIPS, and the
  // tester found what that costs: moving the citation before the stop also ate
  // the space after it, so "...services. [Source 4, 5] The answer..." was
  // delivered as "...services [Source 4, 5].The answer...", and "e.g. [Source 3]
  // dust" as "e.g [Source 3].dust". A detector that edits the document it is
  // inspecting is not a detector.
  //
  // So: the sentence is normalised for the JUDGE to read, the unit keeps its
  // ORIGINAL span, and every correction is applied to that span. A document with
  // nothing to correct comes back byte for byte - `fidelity.test.ts` pins that
  // over all four committed documents, and pins that a second pass changes
  // nothing either.
  //
  // TWO guards, and between them "e.g.", "approx.", "Fig.", "Inc." and "vs."
  // are safe without a list of abbreviations:
  //   - the SPLITTER's rule, reused: a stop needs two alphanumerics (or a
  //     closing bracket) before it;
  //   - and the citation must END the span. A citation with text after it did
  //     not close a sentence - it is an abbreviation ("approx. [Source 2] 180 W")
  //     or a mid-sentence reference, and either way there is nothing to move.
  return String(text || "").replace(
    CITE_AFTER_STOP,
    (_m: string, stop: string, cite: string) => `${stop.slice(0, -1)} ${cite}${stop.slice(-1)}`,
  );
}

const isTableRow = (l: string) => /^\s*\|/.test(l);
const isTableRule = (l: string) => /^\s*\|[\s:|-]*\|?\s*$/.test(l) && /-/.test(l);

/**
 * Split a rendered document into the pieces that make a claim.
 *
 * A TABLE ROW's citations belong to every cell in it: the row cites once, in
 * its Source column, and the sentence that overstates its source is in a
 * different cell — which is exactly the shape of the defect this exists for.
 * Cells are units so a bad one can be replaced on its own without destroying
 * the table around it.
 *
 * A sentence with no citation is not checked. It is summary, structure or a
 * heading, and there is nothing to compare it against; the [GAP] questions in
 * the limitations section are deliberately uncited and must stay untouched.
 */
export function citedUnits(rendered: string): CitedUnit[] {
  const out: CitedUnit[] = [];
  const lines = String(rendered || "").split(/\r?\n/);
  let headerSeen = false;
  let section = "";
  let inFence = false;
  const unit = (text: string, line: number, cell: number, citations: number[], judgeable = true) =>
    ({ text, view: normaliseCitations(text), line, cell, citations, section, judgeable });

  lines.forEach((line, i) => {
    // A fenced block is code, not prose. A `programming-doc` render is ASKED for
    // code samples, and a "[Source 3]" inside one was being presented to the
    // judge as a claim and could be rewritten (tester X2).
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;

    // THE CHECK'S OWN APPARATUS is not a claim. A replaced long cell leaves
    // "see Note 3 below the table" in the column and the grounded sentence in a
    // blockquote under it; both are this module's writing, and the note is
    // verbatim evidence. Judging them made a second pass condemn the marker
    // (nothing in the sources says "see Note 3"), renumber it, and append a
    // SECOND copy of every note - the idempotence invariant, breaking on the
    // module's own output.
    if (NOTE_LINE.test(line)) return;

    const heading = line.match(/^##\s+(.*?)\s*$/);
    if (heading) { section = heading[1]; headerSeen = false; return; }

    if (isTableRow(line)) {
      if (isTableRule(line)) { headerSeen = true; return; }
      if (!headerSeen) return;                       // the header row names columns
      const rowCites = citationsIn(line);
      const cells = line.split("|");
      // The row's FIRST populated cell is its label - "Thermal / fans", "Power
      // supply (PSU)" - and a label is not a claim. Judging one against the
      // row's sources got it rewritten into a paragraph, which shifted every
      // column of that row. The claims are in the cells after it.
      //
      // Every OTHER populated cell is a unit, however short. There is no word
      // floor inside a table: the floor existed to keep labels out, the label
      // rule does that directly, and "Fans are proprietary" is exactly the
      // four-word claim the tester's X2 showed slipping through.
      let seen = 0;
      cells.forEach((c, j) => {
        const text = c.trim();
        if (!text) return;
        if (!codeStripped(text).replace(CITE_RE, "").trim()) return;   // the Source cell itself
        if (seen++ === 0) return;                                      // the row label
        if (NOTE_MARKER.test(text)) return;                            // this module's own marker
        out.push(unit(text, i, j, rowCites));
      });
      return;
    }
    headerSeen = false;

    // A BULLET THAT WRAPS. Its claim used to be invisible: neither checked, nor
    // counted in M, nor reported in U (tester X2). It is counted now and never
    // edited - an edit addressed by line and cell cannot safely span two lines,
    // and a unit the check will not touch belongs in `unchecked`, out loud.
    if (isBullet(line) && continuesOnNextLine(lines, i)) {
      const joined = [line, ...trailingContinuation(lines, i)].join(" ").trim();
      const cites = citationsIn(joined);
      if (cites.length || isEvidenceSection(section)) {
        if (isClaimLike(joined)) out.push(unit(joined, i, -1, cites, false));
      }
      return;
    }
    // …and the continuation lines themselves are part of that unit, not units.
    if (isContinuationOfBullet(lines, i)) return;

    for (const span of splitSentences(line)) {
      const text = span.trim();
      if (!text) continue;
      const cites = citationsIn(codeStripped(text));
      // A cited sentence is always checked. An UNCITED one is checked too, but
      // only where the template asks for evidence: the action/findings section,
      // the table section, and "what the evidence does not settle". Not the
      // title, not the executive summary, and never Limitations - those [GAP]
      // questions are uncited BY DESIGN and must survive untouched.
      if (!cites.length && !isEvidenceSection(section)) continue;
      if (!isClaimLike(text)) continue;
      if (/^[#>|\-*_]+$/.test(text)) continue;
      out.push(unit(text, i, -1, cites));
    }
  });
  return out;
}

/** An inline code span is code, not prose: a citation inside one is not a citation. */
function codeStripped(text: string): string {
  return String(text || "").replace(/`[^`]*`/g, " ");
}

const isBullet = (l: string) => /^\s*([-*+]|\d+\.)\s/.test(l) || /^\s*- \[[ x]\]\s/.test(l);
/** What `placeNotes` writes under a table, and what `applyUnit` leaves in the cell. */
const NOTE_LINE = /^\s*>\s*\*\*Note\s+\d+\.\*\*/;
const NOTE_MARKER = /^see Note\s+\d+\s+below the table$/;

/** Lines that continue a bullet: indented or plain prose, until a blank line,
 *  another bullet, a heading, a table row or a fence. */
function isPlainContinuation(l: string | undefined): boolean {
  if (l === undefined) return false;
  if (!l.trim()) return false;
  if (isBullet(l) || isTableRow(l) || /^\s*#/.test(l) || /^\s*(```|~~~)/.test(l)) return false;
  if (/^\s*>/.test(l)) return false;
  return true;
}
function continuesOnNextLine(lines: string[], i: number): boolean {
  return isPlainContinuation(lines[i + 1]);
}
function trailingContinuation(lines: string[], i: number): string[] {
  const out: string[] = [];
  for (let k = i + 1; isPlainContinuation(lines[k]); k++) out.push(lines[k].trim());
  return out;
}
function isContinuationOfBullet(lines: string[], i: number): boolean {
  if (!isPlainContinuation(lines[i])) return false;
  for (let k = i - 1; k >= 0; k--) {
    if (isBullet(lines[k])) return true;
    if (!isPlainContinuation(lines[k])) return false;
  }
  return false;
}

/** Sections whose sentences are expected to rest on evidence. */
export function isEvidenceSection(heading: string): boolean {
  const h = String(heading || "").toLowerCase();
  if (!h) return false;
  if (/limitation|open question/.test(h)) return false;   // the [GAP] questions
  if (/executive summary/.test(h)) return false;          // compression, by design
  return true;
}

/**
 * How many units the document HAS. Pure, and the denominator the footer prints:
 * the tester's X4 found three counts of one document and the reviewer's K.10 a
 * fourth, none of which a reader could reproduce from a committed file. This
 * one they can - it is a function of the document alone.
 */
export function countUnits(rendered: string): number {
  return citedUnits(String(rendered || "")).length;
}

/**
 * Sentences, keeping each citation with the sentence it closes.
 *
 * A break needs three things: a full stop, whitespace, and a capital after it -
 * and, before the stop, two ordinary characters or a closing bracket. That last
 * condition is what keeps "e.g. SSDs" and "U.S. models" in one piece without a
 * list of abbreviations: an abbreviation's stop follows a SINGLE letter, a
 * sentence's does not. "1.5 GB" survives because no space follows its point,
 * and "[Source 3, 4]." because a bracket closes it.
 */
export function splitSentences(line: string): string[] {
  return String(line || "").split(SENTENCE_BREAK).map((p) => p.trim()).filter(Boolean);
}

/**
 * A sentence ends at a stop preceded by two ordinary characters (or a closing
 * bracket) and followed by whitespace and a capital - and NEVER before a
 * citation bracket. A citation that follows the stop belongs to the sentence it
 * closes, so "...to upgrade. [Source 13]" is ONE span and stays one: splitting
 * there was the tester's X1, which produced a claim with no citation and a
 * citation with no claim, and therefore no unit at all.
 *
 * The cost is a coarser unit where a citation sits mid-line between two
 * sentences ("...services. [Source 4, 5] The answer is X."): the judge gets both
 * sentences and their sources together. Coarser is the price of never touching
 * what ships, and it is the right side of that trade - the alternative moved the
 * citation in the delivered document.
 */
const SENTENCE_BREAK = /(?<=(?:[a-z0-9]{2}|[)\]"'”])[.?!])\s+(?=[A-Z(*_-])/g;

/**
 * Break a COARSE span into its sentences, keeping each citation with the
 * sentence it closes.
 *
 * A span is coarse exactly because `SENTENCE_BREAK` will not split before a
 * citation - that rule is what keeps "…to upgrade. [Source 13]" in one piece.
 * So the cut for a repair goes AFTER such a citation, when more text follows
 * it: "The PSU fails with a brief green LED. [Source 7]" | "The connector is
 * proprietary [Source 13]." Each half keeps its own source, which is what makes
 * a per-sentence verdict meaningful.
 */
export function splitCoarseSpan(text: string): string[] {
  return String(text || "")
    .split(/(?<=[.?!][ \t]\[Sources?[^\]]*\])\s+(?=[A-Z(*_-])/g)
    .map((p) => p.trim()).filter(Boolean);
}

/** The synthesis lines a unit's citations point at. */
export function referenceLines(synthesis: string, citations: number[]): string[] {
  const want = new Set(citations);
  return String(synthesis || "").split(/\r?\n/)
    .filter((l) => citationsIn(l).some((n) => want.has(n)))
    .map((l) => l.trim())
    .filter(Boolean);
}

const CONTENT_RE = /[a-z0-9]{4,}/g;
function contentWords(text: string): Set<string> {
  return new Set((String(text || "").toLowerCase().replace(CITE_RE, " ").match(CONTENT_RE) || []));
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** Two shared content words: the same floor the entity gate settled on, for the
 *  same reason - one is a coincidence. */
export const NEAREST_MIN_OVERLAP = 2;

/**
 * The synthesis lines an UNCITED unit is about, by word overlap.
 *
 * The tester's X2: "the check constrains sentences that cite; it does not stop
 * a model from asserting something absolute in a sentence that cites nothing".
 * Dropping the citation was the bypass, so a sentence in an evidence section is
 * now judged whether or not it carries one - against the lines it is closest
 * to. When NOTHING in the synthesis reaches the floor, the sentence is about
 * nothing in the evidence, and that verdict does not need a model.
 */
export function nearestLines(synthesis: string, text: string, max = 2): string[] {
  const want = contentWords(text);
  if (!want.size) return [];
  return String(synthesis || "").split(/\r?\n/)
    .map((l) => l.trim())
    // GROUNDED lines only. A [GAP] line is the synthesizer saying what it could
    // not find; pasting one into a report as the correction for an overstated
    // sentence puts "[GAP]" and an ungrounded sentence in front of a reader -
    // measured on the comparison render, which acquired the literal name "GAP"
    // that way.
    .filter((l) => GROUNDED_LINE.test(l))
    .map((l) => ({ line: l, score: overlap(want, contentWords(l)) }))
    .filter((x) => x.score >= NEAREST_MIN_OVERLAP)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.line);
}

/** What a unit is judged against: its citations, or its nearest lines. */
export function evidenceFor(synthesis: string, unit: CitedUnit): string[] {
  return unit.citations.length
    ? referenceLines(synthesis, unit.citations)
    : nearestLines(synthesis, unit.text);
}

/**
 * Citations a unit carries that contribute nothing to it.
 *
 * The tester's X3: `referenceLines` returns the UNION of every line matching any
 * cited number, so citing broadly can only make a verdict look better - there is
 * no penalty for naming a source a sentence does not use. In the shipped render
 * a motherboard row cited [1, 2, 3, 4] where two of the four are YouTube repair
 * videos that evidence none of the symptoms listed. Reported, not corrected: a
 * citation the row does not use is a provenance defect for a reader to see, and
 * deleting it would be the engine editing a claim's evidence on a word count.
 */
export function supersetCitations(rendered: string, synthesis: string): string[] {
  const out: string[] = [];
  for (const u of citedUnits(rendered)) {
    if (u.citations.length < 2) continue;
    const words = contentWords(u.text);
    for (const n of u.citations) {
      const lines = referenceLines(synthesis, [n]);
      if (!lines.length) { out.push(`[Source ${n}] cites nothing in the synthesis`); continue; }
      if (!lines.some((l) => overlap(words, contentWords(l)) >= NEAREST_MIN_OVERLAP)) {
        out.push(`[Source ${n}] in "${u.text.replace(CITE_RE, "").trim().slice(0, 60)}"`);
      }
    }
  }
  return [...new Set(out)].sort();
}

/**
 * The replacement for a sentence that still overstates its sources: the grounded
 * line itself, tag dropped, citation kept.
 *
 * ONE sentence for one sentence. The first version pasted every synthesis line
 * that shared a citation, and on the 33250e9b render that turned one summary
 * sentence citing [Source 13, 17] into five long lines in the executive summary
 * - true, and worse than what it replaced. A unit that cites broadly is usually
 * a summary; the honest minimum is to put back the line it drifted furthest
 * from, not the whole file.
 *
 * The line chosen is the one that shares the most words with the sentence being
 * replaced, so the replacement lands on the same subject; ties go to the line
 * that shares the most citations.
 */
export function verbatimFallback(refs: string[], written = "", max = 1): string {
  const words = new Set((written.toLowerCase().match(/[a-z0-9]{4,}/g) || []));
  const scored = refs.map((l) => {
    const lw = new Set(l.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
    let shared = 0;
    for (const w of words) if (lw.has(w)) shared++;
    return { line: l, shared };
  });
  scored.sort((a, b) => b.shared - a.shared);
  return scored.slice(0, Math.max(1, max))
    .map((x) => x.line.replace(TAG_RE, "").trim()).join(" ");
}

export type Verdict = "SAME" | "WEAKER" | "STRONGER" | "UNSUPPORTED";
const VERDICTS = new Set(["SAME", "WEAKER", "STRONGER", "UNSUPPORTED"]);

export const FIDELITY_SYS =
  `You compare SENTENCES from a finished report against the GROUNDED LINES each one cites. For every numbered item, answer with ONE word:

SAME        - the sentence says what the cited lines say, no more.
WEAKER      - the sentence claims LESS than the cited lines (a hedge added, a figure softened). This is acceptable.
STRONGER    - the sentence claims MORE: a hedge became an absolute ("makes it difficult" -> "is impossible", "no ... available"), "some"/"reported" became "all"/"always", "may" became "does", a ranking or a count the lines do not make.
UNSUPPORTED - the sentence asserts something the lines do not contain at all: a name, a standard, a product, an organisation, a procedure or a figure that is not there.

Some items carry NEAREST LINES instead of CITED LINES: the sentence cites nothing, and those are the closest lines in the evidence. Judge it exactly the same way - a claim that rests on nothing in the evidence is UNSUPPORTED whether or not it names a source.

A sentence that states an ABSENCE in the evidence - "not described in the sources", "the sources do not say", "no source documents this" - is SAME. It claims nothing about the world, and an honest report is allowed to say what it could not find.

Judge ONLY against the lines given for that item, and judge the CLAIM, not the style:
- A sentence that combines, shortens or reorders its cited lines is SAME.
- A practical instruction the lines support ("check the fans for dust", "test both DIMM slots") is SAME, even though the lines describe rather than instruct.
- Dropping detail is WEAKER, which is fine. Only an increase in force, scope, certainty or specificity is STRONGER.
Do not explain, do not add any other word.

Return ONLY JSON: {"verdicts": ["SAME", "STRONGER", ...]} - exactly one entry per item, in order.`;

export const REWRITE_SYS =
  `You repair sentences in a finished report that claimed MORE than the source lines they cite. For each numbered item you are given the sentence as written and the GROUNDED LINES it cites.

Rewrite the sentence so it says exactly what those lines say - no more, no less - keeping its [Source N] citations, its format (a table cell stays a short cell, a checklist item stays an instruction), and its wording wherever the wording was already right. USUALLY ONE CLAUSE IS THE PROBLEM: hedge or delete that clause and leave the rest of the sentence alone. Do not restate the whole line; do not turn a short cell into a paragraph. Never add a name, standard, product, organisation, number or procedure the lines do not contain. Prefer the lines' own hedging words ("makes it difficult", "reported", "may") over absolutes.

If an item is an OPEN QUESTION - it asks what the evidence does not cover, and it appears in a limitations list - keep it a question, keep what it is asking about, and only remove or replace the names listed as unearned. Never answer it, and never delete the question.

If an item lists NAMES THE EVIDENCE NEVER USES, you must return a rewrite for it: describe the thing in the evidence's own words instead ("a replacement part from the manufacturer" rather than an OEM part), or drop the clause that needed the name. Returning nothing for such an item leaves the name standing.

Return ONLY JSON: {"fixed": {"<item number>": "<the rewritten sentence>", ...}} - only the items you changed.`;

/** How many units go into one judge call. */
const BATCH = 10;

function parseVerdicts(raw: string, n: number): Verdict[] | null {
  try {
    const parsed = JSON.parse(raw) as { verdicts?: unknown };
    const v = parsed?.verdicts;
    if (!Array.isArray(v) || v.length !== n) return null;
    const out = v.map((x) => String(x).trim().toUpperCase());
    if (!out.every((x) => VERDICTS.has(x))) return null;
    return out as Verdict[];
  } catch {
    return null;
  }
}

function itemBlock(units: CitedUnit[], synthesis: string): string {
  return units.map((u, i) =>
    `${i + 1}. SENTENCE: ${u.view}\n` +
    (u_names(u).length
      ? `   NAMES THE EVIDENCE NEVER USES (remove or replace each one; do not substitute another name): ${u_names(u).join(", ")}\n`
      : "") +
    `   ${u.citations.length ? "CITED LINES" : "NEAREST LINES (the sentence cites nothing)"}:\n` +
    evidenceFor(synthesis, u).map((l) => `   - ${l}`).join("\n"),
  ).join("\n\n");
}

const u_names = (u: CitedUnit): string[] => u.names ?? [];

/** Replace one unit's text in the document, in place. */
export function applyUnit(lines: string[], unit: CitedUnit, next: string): void {
  const line = lines[unit.line];
  if (line === undefined) return;
  if (unit.cell >= 0) {
    const cells = line.split("|");
    if (cells[unit.cell] === undefined) return;
    const pad = /^\s/.test(cells[unit.cell]) ? " " : "";
    const tail = /\s$/.test(cells[unit.cell]) ? " " : "";
    cells[unit.cell] = `${pad}${next.replace(/\|/g, "/").trim()}${tail}`;
    lines[unit.line] = cells.join("|");
    return;
  }
  lines[unit.line] = line.replace(unit.text, next);
}

/** A replaced table cell longer than this is moved under the table (K.9). */
export const CELL_NOTE_WORDS = 25;

export function wordCount(text: string): number {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Put each note under the table its cell belongs to, whole and cited.
 *
 * `applyUnit` already addresses a unit by line and cell, so this is a rendering
 * choice and not a new judgement: nothing decides where to cut a claim, because
 * nothing cuts one.
 */
export function placeNotes(
  lines: string[], notes: Array<{ line: number; label: string; text: string }>,
  eol = "\n",
): string {
  if (!notes.length) return lines.join(eol);
  const out = [...lines];
  // Group by the table each note came from (the last row at or after its line),
  // and insert from the bottom up so earlier indices stay valid.
  const byEnd = new Map<number, Array<{ label: string; text: string }>>();
  for (const n of notes) {
    let end = n.line;
    while (end + 1 < out.length && /^\s*\|/.test(out[end + 1])) end++;
    const list = byEnd.get(end) ?? [];
    list.push({ label: n.label, text: n.text });
    byEnd.set(end, list);
  }
  for (const end of [...byEnd.keys()].sort((a, b) => b - a)) {
    const block = byEnd.get(end)!.map((n) => `> **${n.label}.** ${n.text}`);
    out.splice(end + 1, 0, "", ...block);
  }
  return out.join(eol);
}

/**
 * Count the DELIVERED document, and how much of it this check actually saw.
 *
 * M is `countUnits(delivered)` - a pure function of the artifact the reader
 * holds. N is the units of that artifact whose text the check judged or wrote;
 * U is the rest. Taking both numbers on the same document is the whole point:
 * "checked 34 of 32" was the first thing this produced when the denominator
 * came from one document and the numerator from another.
 */
function countAgainst(record: FidelityRecord, delivered: string, judged: Set<string>): void {
  const finalUnits = citedUnits(delivered);
  record.units = finalUnits.length;
  record.checked = finalUnits.filter((u) => judged.has(u.text)).length;
  record.unchecked = Math.max(0, record.units - record.checked);
}

/** Is this line inside the limitations section? */
function isLimitationsLine(lines: string[], at: number): boolean {
  for (let k = at; k >= 0; k--) {
    const h = lines[k].match(/^##\s+(.*?)\s*$/);
    if (h) return /limitation|open question/i.test(h[1]);
  }
  return false;
}

export interface FidelityResult { rendered: string; record: FidelityRecord; }

/**
 * Check a rendered report against its synthesis and correct what overstates it.
 * FAIL-OPEN: on any error the document comes back exactly as it went in.
 */
export async function checkRenderFidelity(
  deps: Deps, rendered: string, synthesis: string,
): Promise<FidelityResult> {
  const record = emptyFidelity();
  // The document is NOT normalised. Detection reads a normalised VIEW of each
  // unit; the unit keeps its ORIGINAL span and every edit is made against that,
  // so a render with nothing to correct is delivered byte for byte.
  const doc = String(rendered || "");
  // The document's OWN line ending survives a correction. A checked-out file on
  // Windows is CRLF, and rejoining it with "\n" rewrote every line of a
  // document one sentence of which was wrong - the byte-identity invariant with
  // a different mechanism.
  const eol = doc.includes("\r\n") ? "\r\n" : "\n";
  if (!doc.trim() || !String(synthesis || "").trim()) return { rendered: doc, record };

  try {
    const all = citedUnits(doc);
    record.units = all.length;

    // ── The NAMES gate ────────────────────────────────────────────────────
    // A name the grounded answer never uses is not a claim the evidence can
    // support, so the unit carrying it is UNSUPPORTED before a judge is asked.
    // BSOD is exempt because the synthesis writes "Blue Screen of Death" -
    // decided by an expansion match in grounding.ts, never by a list.
    //
    // The LIMITATIONS list is covered too, and this is the arguable half, so it
    // is stated: a [GAP] line is the SYNTHESIZER's account of what it could not
    // find, not a source's, so a name that appears only there is as unearned as
    // one the renderer invented. Live run a205845d put "non-OEM" in front of a
    // reader that way, and this render puts ESR and HDD there. Those lines are
    // rewritten and never verbatim-replaced: a grounded line is not an answer
    // to an open question.
    const flaggedNames = renderGroundingDiff(doc, synthesis, "").names;
    const namesBefore = new Set(flaggedNames);
    const withNames: CitedUnit[] = [];
    if (flaggedNames.length) {
      for (const u of all) {
        u.names = namesIn(u.view, flaggedNames);
      }
      // …and the lines no unit covers, which is where a [GAP] question lives.
      const covered = new Set(all.map((u) => u.line));
      doc.split(/\r?\n/).forEach((line, i) => {
        if (covered.has(i)) return;
        const hit = namesIn(line, flaggedNames);
        if (!hit.length) return;
        if (!isClaimLike(line)) return;
        withNames.push({
          text: line.trim(), view: normaliseCitations(line.trim()), line: i, cell: -1,
          citations: citationsIn(codeStripped(line)), section: "", judgeable: true, names: hit,
        });
      });
    }
    // A unit that cannot be edited safely is never judged - it is COUNTED, and
    // it lands in `unchecked` where a reader can see it.
    const editable = all.filter((u) => u.judgeable);
    // A unit with NO evidence to judge against - a citation that matches no
    // line, or an uncited sentence with nothing near it - splits two ways: an
    // uncited one in an evidence section is UNSUPPORTED on the spot (a claim
    // resting on nothing in the evidence needs no model to see), a cited one is
    // left alone and COUNTED as unchecked, because the citation may simply have
    // been renumbered out from under it.
    const units: CitedUnit[] = [];
    const orphans: CitedUnit[] = [];
    for (const u of editable) {
      if (evidenceFor(synthesis, u).length) units.push(u);
      else if (!u.citations.length) orphans.push(u);
    }
    record.unchecked = all.length - units.length - orphans.length;
    if (!units.length && !orphans.length) return { rendered: doc, record };

    const judge = async (batch: CitedUnit[]): Promise<Verdict[]> => {
      const raw = await deps.chat(
        FIDELITY_SYS,
        `GROUNDED LINES are the only evidence. Items:\n\n${itemBlock(batch, synthesis)}`,
        { json: true, nothink: true },
      );
      const v = parseVerdicts(raw, batch.length);
      if (!v) throw new Error("fidelity judge returned no usable verdicts");
      return v;
    };

    const verdicts: Verdict[] = [];
    for (let i = 0; i < units.length; i += BATCH) {
      verdicts.push(...await judge(units.slice(i, i + BATCH)));
    }
    record.checked = units.length + orphans.length;
    record.stronger = verdicts.filter((v) => v === "STRONGER").length;
    record.unsupported = verdicts.filter((v) => v === "UNSUPPORTED").length + orphans.length;

    const bad = units.filter((_u, i) =>
      verdicts[i] === "STRONGER" || verdicts[i] === "UNSUPPORTED" || (u_names(units[i]).length > 0));
    // A named unit the judge blessed is still counted as unsupported: the judge
    // was asked about the claim, and the name is a claim it could not see.
    record.unsupported += units.filter((u, i) =>
      verdicts[i] === "SAME" || verdicts[i] === "WEAKER" ? u_names(u).length > 0 : false).length;
    if (!bad.length && !orphans.length && !withNames.length) {
      countAgainst(record, doc, new Set(units.map((u) => u.text)));
      return { rendered: doc, record };
    }
    if (!bad.length && !orphans.length) {
      // Names only, and none of them inside a unit: nothing to judge, but the
      // limitations lines still get their rewrite below.
    }

    const lines = doc.split(/\r?\n/);
    bad.push(...orphans, ...withNames);

    // One targeted re-render of the offending sentences, and only those.
    let fixed: Record<string, string> = {};
    try {
      const raw = await deps.chat(
        REWRITE_SYS, `Items:\n\n${itemBlock(bad, synthesis)}`, { json: true, nothink: true },
      );
      const parsed = JSON.parse(raw) as { fixed?: Record<string, unknown> };
      if (parsed?.fixed && typeof parsed.fixed === "object") {
        fixed = Object.fromEntries(
          Object.entries(parsed.fixed).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch { /* the verbatim fallback below is the guarantee, not this */ }

    // ── COARSE UNITS ARE CORRECTED PER SENTENCE ───────────────────────────
    // A citation sitting mid-line between two sentences gives one span holding
    // both ("The PSU fails with a brief green LED. [Source 7] The connector is
    // proprietary [Source 13]."). Replacing the whole span because one half is
    // wrong rewrites a sentence nobody complained about. So a condemned span
    // with more than one sentence is re-asked per sentence, and only the
    // failing sentences are corrected - the sibling stays byte-identical.
    const refined: CitedUnit[] = [];
    for (const u of bad) {
      const parts = splitSentences(u.text).flatMap((p) => splitCoarseSpan(p));
      if (parts.length < 2) { refined.push(u); continue; }
      const subs: CitedUnit[] = parts.map((p) => ({
        ...u,
        text: p,
        view: normaliseCitations(p),
        citations: citationsIn(codeStripped(p)).length ? citationsIn(codeStripped(p)) : u.citations,
        names: namesIn(p, u_names(u)),
      }));
      let subVerdicts: Verdict[];
      try {
        subVerdicts = await judge(subs);
      } catch {
        // If the per-sentence pass cannot run, the span is corrected whole -
        // the coarse behaviour, which is the safe one.
        refined.push(u);
        continue;
      }
      const failing = subs.filter((sub, k) =>
        subVerdicts[k] === "STRONGER" || subVerdicts[k] === "UNSUPPORTED" || u_names(sub).length > 0);
      // Every sentence failing is the same as the span failing; keep it whole
      // so the verbatim fallback can replace it with one grounded line.
      refined.push(...(failing.length === 0 || failing.length === subs.length ? [u] : failing));
    }
    bad.length = 0;
    bad.push(...refined);

    // A named unit the rewriter ignored gets ONE more ask, and only that unit.
    // Measured across three documents: the model silently declines to rewrite an
    // open QUESTION in a limitations list, and the alternative to asking again
    // is either leaving the name or deleting words out of someone's question -
    // which is the clipping rule K.9 refused.
    const stubborn = bad.filter((u, i) => u_names(u).length > 0 && !(fixed[String(i + 1)] || "").trim());
    if (stubborn.length) {
      try {
        const raw = await deps.chat(
          REWRITE_SYS,
          `You returned no rewrite for these, and each one uses a name the evidence never uses. ` +
          `A rewrite is required for every item here.\n\nItems:\n\n${itemBlock(stubborn, synthesis)}`,
          { json: true, nothink: true },
        );
        const parsed = JSON.parse(raw) as { fixed?: Record<string, unknown> };
        if (parsed?.fixed && typeof parsed.fixed === "object") {
          for (const [k, v] of Object.entries(parsed.fixed)) {
            const at = bad.indexOf(stubborn[parseInt(k, 10) - 1]);
            if (at >= 0) fixed[String(at + 1)] = String(v);
          }
        }
      } catch { /* the name stays, and the recount will not call it blocked */ }
    }

    const rewritten: CitedUnit[] = [];
    const changed: boolean[] = [];
    bad.forEach((u, i) => {
      const next = (fixed[String(i + 1)] || "").trim();
      if (next && next !== u.text) {
        applyUnit(lines, u, next);
        rewritten.push({ ...u, text: next });
        changed.push(true);
      } else {
        rewritten.push(u);
        changed.push(false);
      }
    });

    // Re-judge what was REWRITTEN, and only that. A unit the rewriter did not
    // touch cannot "come back" better: re-asking the same judge about the same
    // sentence is a second opinion, not a repair, and on the comparison render
    // it flip-flopped ten cells from UNSUPPORTED to SAME and left them standing.
    // The first verdict stands for anything unchanged.
    const toReJudge = rewritten.filter((_u, i) => changed[i]);
    let second: Verdict[] = rewritten.map((_u, i) => changed[i] ? "SAME" : "STRONGER");
    if (toReJudge.length) {
      try {
        const verdicts2: Verdict[] = [];
        for (let i = 0; i < toReJudge.length; i += BATCH) {
          verdicts2.push(...await judge(toReJudge.slice(i, i + BATCH)));
        }
        let k = 0;
        second = rewritten.map((_u, i) => changed[i] ? verdicts2[k++] : "STRONGER");
      } catch {
        // The re-judge is the optional half: if it cannot run, trust nothing and
        // replace every sentence the FIRST judge condemned.
        second = rewritten.map(() => "STRONGER" as Verdict);
      }
    }

    // Every text this check has seen or written. The footer's N is counted over
    // the DELIVERED document against this set, so "N of M" is two numbers about
    // one artifact - the tester's X4 and the reviewer's K.10 were both about a
    // count taken on a document nobody holds.
    const judged = new Set<string>([...units, ...orphans].map((u) => u.text));
    const notes: Array<{ line: number; label: string; text: string }> = [];
    rewritten.forEach((u, i) => {
      if (second[i] === "STRONGER" || second[i] === "UNSUPPORTED") {
        // An open question is never answered with a grounded line. A [GAP] item
        // in the limitations list is corrected by rewriting it or not at all;
        // pasting evidence over a question about what the evidence lacks would
        // be the worst sentence this module could write.
        if (isLimitationsLine(lines, u.line) && !u.citations.length) {
          // A rewrite of an open question still counts as a correction: the
          // text changed, and a counter that only counts REPLACEMENTS reported
          // "0 corrected" over a document whose questions had been rewritten.
          if (u.text !== bad[i].text) { judged.add(u.text); record.rewritten++; }
          return;
        }
        const refs = u.citations.length
          ? referenceLines(synthesis, u.citations)
          : nearestLines(synthesis, bad[i].text);
        let verbatim = verbatimFallback(refs, u.text);
        if (verbatim && u.cell >= 0) {
          // The reviewer's K.9: keep the verbatim line exactly, and fix the
          // LAYOUT instead. A long grounded sentence in a column whose siblings
          // are clauses reads badly as a table and is exactly right as
          // evidence, and any rule that CLIPPED it to fit could land on
          // "...install aftermarket PSUs" and re-create the overstatement the
          // replacement was repairing. So the cell gets a marker and the
          // sentence goes under the table, whole.
          const cited = verbatim;
          verbatim = verbatim.replace(CITE_RE, "").replace(/\s+([.,;])/g, "$1").trim();
          if (wordCount(verbatim) > CELL_NOTE_WORDS) {
            const n = notes.length + 1;
            notes.push({ line: u.line, label: `Note ${n}`, text: cited });
            const marker = `see Note ${n} below the table`;
            applyUnit(lines, u, marker);
            judged.add(marker);
            judged.add(`**Note ${n}.** ${cited}`);
            judged.add(cited);
            record.replaced++;
            return;
          }
        }
        if (verbatim) {
          applyUnit(lines, u, verbatim);
          judged.add(verbatim);
          record.replaced++;
          return;
        }
      }
      if (u.text !== bad[i].text) { judged.add(u.text); record.rewritten++; }
    });

    const finalDoc = placeNotes(lines, notes, eol);
    countAgainst(record, finalDoc, judged);
    // BLOCKED means gone from the delivered document, and it is measured on
    // that document rather than asserted from intent: a rewrite that failed to
    // drop the name is not a block, and the name stays visible in
    // `prose_ungrounded.names` where the run already reports it.
    if (namesBefore.size) {
      const after = new Set(renderGroundingDiff(finalDoc, synthesis, "").names);
      record.names_blocked = [...namesBefore].filter((n) => !after.has(n)).sort();
    }
    return { rendered: finalDoc, record };
  } catch (e) {
    // Fail OPEN. The document is the renderer's, unchanged, and the run records
    // that nothing checked it.
    return { rendered: doc, record: { ...emptyFidelity(), error: String((e as Error).message) } };
  }
}
