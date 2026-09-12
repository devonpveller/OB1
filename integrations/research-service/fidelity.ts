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

export interface FidelityRecord {
  /** Cited sentences and table cells presented to the judge. */
  checked: number;
  stronger: number;
  unsupported: number;
  /** …of those, fixed by the targeted re-render. */
  rewritten: number;
  /** …and fixed by falling back to the synthesis line verbatim. */
  replaced: number;
  /** Set when the check did not run. The document is untouched. */
  error?: string;
}

export function emptyFidelity(): FidelityRecord {
  return { checked: 0, stronger: 0, unsupported: 0, rewritten: 0, replaced: 0 };
}

/** One checkable piece of the rendered document. */
export interface CitedUnit {
  /** The text as it stands in the document. */
  text: string;
  /** 0-based line index in the document. */
  line: number;
  /** For a table row, which cell; -1 for prose. */
  cell: number;
  /** [Source N] numbers this unit (or its row) carries. */
  citations: number[];
}

const CITE_RE = /\[Sources?\s*[^\]]*\]/gi;
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
  lines.forEach((line, i) => {
    if (isTableRow(line)) {
      if (isTableRule(line)) { headerSeen = true; return; }
      if (!headerSeen) return;                       // the header row names columns
      const rowCites = citationsIn(line);
      if (!rowCites.length) return;
      const cells = line.split("|");
      // The row's FIRST populated cell is its label - "Thermal / fans", "Power
      // supply (PSU)" - and a label is not a claim. Judging one against the
      // row's sources got it rewritten into a paragraph, which shifted every
      // column of that row. The claims are in the cells after it.
      let seen = 0;
      cells.forEach((c, j) => {
        const text = c.trim();
        if (!text) return;
        if (!text.replace(CITE_RE, "").trim()) return;   // the Source cell itself
        if (seen++ === 0) return;                        // the row label
        if (!isClaimLike(text)) return;
        out.push({ text, line: i, cell: j, citations: rowCites });
      });
      return;
    }
    headerSeen = false;
    if (!citationsIn(line).length) return;
    for (const s of splitSentences(line)) {
      const cites = citationsIn(s);
      if (cites.length && isClaimLike(s)) {
        out.push({ text: s.trim(), line: i, cell: -1, citations: cites });
      }
    }
  });
  return out;
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
  const parts = String(line || "")
    .split(/(?<=(?:[a-z0-9]{2}|[)\]"'”])[.?!])\s+(?=[A-Z(\[*_-])/g);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The synthesis lines a unit's citations point at. */
export function referenceLines(synthesis: string, citations: number[]): string[] {
  const want = new Set(citations);
  return String(synthesis || "").split(/\r?\n/)
    .filter((l) => citationsIn(l).some((n) => want.has(n)))
    .map((l) => l.trim())
    .filter(Boolean);
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
UNSUPPORTED - the sentence asserts something the cited lines do not contain at all: a name, a standard, a product, an organisation, a procedure or a figure that is not there.

Judge ONLY against the lines given for that item, and judge the CLAIM, not the style:
- A sentence that combines, shortens or reorders its cited lines is SAME.
- A practical instruction the lines support ("check the fans for dust", "test both DIMM slots") is SAME, even though the lines describe rather than instruct.
- Dropping detail is WEAKER, which is fine. Only an increase in force, scope, certainty or specificity is STRONGER.
Do not explain, do not add any other word.

Return ONLY JSON: {"verdicts": ["SAME", "STRONGER", ...]} - exactly one entry per item, in order.`;

export const REWRITE_SYS =
  `You repair sentences in a finished report that claimed MORE than the source lines they cite. For each numbered item you are given the sentence as written and the GROUNDED LINES it cites.

Rewrite the sentence so it says exactly what those lines say - no more, no less - keeping its [Source N] citations, its format (a table cell stays a short cell, a checklist item stays an instruction), and its wording wherever the wording was already right. USUALLY ONE CLAUSE IS THE PROBLEM: hedge or delete that clause and leave the rest of the sentence alone. Do not restate the whole line; do not turn a short cell into a paragraph. Never add a name, standard, product, organisation, number or procedure the lines do not contain. Prefer the lines' own hedging words ("makes it difficult", "reported", "may") over absolutes.

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
    `${i + 1}. SENTENCE: ${u.text}\n   CITED LINES:\n` +
    referenceLines(synthesis, u.citations).map((l) => `   - ${l}`).join("\n"),
  ).join("\n\n");
}

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

export interface FidelityResult { rendered: string; record: FidelityRecord; }

/**
 * Check a rendered report against its synthesis and correct what overstates it.
 * FAIL-OPEN: on any error the document comes back exactly as it went in.
 */
export async function checkRenderFidelity(
  deps: Deps, rendered: string, synthesis: string,
): Promise<FidelityResult> {
  const record = emptyFidelity();
  const doc = String(rendered || "");
  if (!doc.trim() || !String(synthesis || "").trim()) return { rendered: doc, record };

  try {
    const units = citedUnits(doc).filter((u) => referenceLines(synthesis, u.citations).length > 0);
    if (!units.length) return { rendered: doc, record };

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
    record.checked = units.length;
    record.stronger = verdicts.filter((v) => v === "STRONGER").length;
    record.unsupported = verdicts.filter((v) => v === "UNSUPPORTED").length;

    const bad = units.filter((_u, i) => verdicts[i] === "STRONGER" || verdicts[i] === "UNSUPPORTED");
    if (!bad.length) return { rendered: doc, record };

    const lines = doc.split(/\r?\n/);

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

    const rewritten: CitedUnit[] = [];
    bad.forEach((u, i) => {
      const next = (fixed[String(i + 1)] || "").trim();
      if (next && next !== u.text) {
        applyUnit(lines, u, next);
        rewritten.push({ ...u, text: next });
      } else {
        rewritten.push(u);
      }
    });

    // Re-judge what was rewritten. Anything still overstating its sources is
    // REPLACED by those sources, which cannot overstate them.
    let second: Verdict[] = [];
    try {
      second = [];
      for (let i = 0; i < rewritten.length; i += BATCH) {
        second.push(...await judge(rewritten.slice(i, i + BATCH)));
      }
    } catch {
      // The re-judge is the optional half: if it cannot run, trust nothing and
      // replace every sentence the FIRST judge condemned.
      second = rewritten.map(() => "STRONGER" as Verdict);
    }

    rewritten.forEach((u, i) => {
      if (second[i] === "STRONGER" || second[i] === "UNSUPPORTED") {
        let verbatim = verbatimFallback(referenceLines(synthesis, u.citations), u.text);
        // Inside a table the row already has a Source column; repeating the
        // citation in the cell makes the row read twice.
        if (u.cell >= 0) verbatim = verbatim.replace(CITE_RE, "").replace(/\s+([.,;])/g, "$1").trim();
        if (verbatim) {
          applyUnit(lines, u, verbatim);
          record.replaced++;
          return;
        }
      }
      if (u.text !== bad[i].text) record.rewritten++;
    });

    return { rendered: lines.join("\n"), record };
  } catch (e) {
    // Fail OPEN. The document is the renderer's, unchanged, and the run records
    // that nothing checked it.
    return { rendered: doc, record: { ...emptyFidelity(), error: String((e as Error).message) } };
  }
}
