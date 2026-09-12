/**
 * report.ts — what the reader is told about how much of their question was
 * answered, and what a run with nothing to report looks like.
 *
 * PLAN-research-trust-2026-09-11 Phase 4. Pure: no deps, no env, no I/O.
 *
 * Two failures this exists for (audit 2026-09-11):
 *   - "coverage 22%" on a run that answered 0 of 6 needs. The number was
 *     1 - gap_ratio computed over synthesis LINES: it measured what fraction of
 *     the writing carried a citation, and was rendered as if it measured the
 *     question. Coverage is now answered needs over needs, and nothing else.
 *   - A run that retrieved no relevant page at all was classified as a
 *     scientific paper and titled "Absence of Evidence for 100 Hz Auditory
 *     Tones…". That is a literature finding. The literature exists (the audit
 *     found it with one outside search); what failed was the retrieval. A run
 *     that found nothing now renders a NOTICE that says so, and never reaches
 *     a template at all.
 */

export type NeedStatus = "answered" | "partial" | "open" | "search_failed";
export interface NeedState { need: string; status: NeedStatus; }

export interface SearchRecordEntry {
  query: string;
  verdict: "ok" | "collapsed" | "offtopic" | "empty" | "error";
  hits: number;
  overlap: number;
  /** Share of hits carrying the subject entity's core, when it was the gate. */
  entityShare?: number;
  /** Whether the entity gate was used, or why it was not. */
  entityStatus?: "used" | "missing" | "rejected";
  collapsedOn?: string;
}

export interface SearchRecord {
  queries: SearchRecordEntry[];
  /** Raw hits the engines returned across all calls. */
  hits: number;
  /** Pages fetched successfully. */
  fetched: number;
  /** …of which had an extract worth reading (>= READABLE_MIN_CHARS). */
  readable: number;
  /** …of which survived the relevance gate. */
  relevant: number;
  /** Search calls by verdict. `offtopic` = a full page of hits, none of which
   *  mentioned the query. It fails the run exactly as a collapse does. */
  ok: number;
  collapsed: number;
  offtopic: number;
  empty: number;
  errors: number;
  /** Searches judged WITHOUT an entity gate, and why. Surfaced in the footer:
   *  a reader who sees "search: ok" is entitled to know it was decided by the
   *  weaker overlap rule. */
  entity_missing?: number;
  entity_rejected?: number;
  /** Runs whose extracted subject was a TOPIC and had to be shortened to the
   *  name inside it. Shown in the footer: the operator is entitled to know the
   *  search ran on something other than what the planner named. */
  entity_shortened?: number;
}

export function emptySearchRecord(): SearchRecord {
  return { queries: [], hits: 0, fetched: 0, readable: 0, relevant: 0,
           ok: 0, collapsed: 0, offtopic: 0, empty: 0, errors: 0,
           entity_missing: 0, entity_rejected: 0, entity_shortened: 0 };
}

// ── Coverage reconciliation (research-trust-entity, 2026-09-11) ────────────
// Live dry run 1f2ff740 cited 11 sources, grounded 25 lines about the OptiPlex
// 3050, and printed "needs answered 0 of 6": the COVERAGE_STAGED judge marked
// every need open. Both halves can be true — sources can support many facts
// without settling any one sub-question — and what was false was the footer's
// SILENCE about the second number. So:
//
//   * a need the synthesis actually grounded is never left `open`; it becomes
//     `partial`, which is what it is;
//   * `answered` is never manufactured here — overruling the judge with a term
//     overlap would be a worse lie than the one being fixed;
//   * `search_failed` is never reopened: if the search for that need failed,
//     a line grounded from the REUSE pool does not mean it succeeded;
//   * the footer prints the partial count, so body and footer agree.

const GROUND_TAG_RE = /^\s*\[(SOURCED|INFERRED|UNCERTAIN)\]/i;
const CITE_RE = /\[Sources?\b[^\]]*\]/i;
const NEED_STOP = new Set(
  ("a an the and or of for to in on at by with from as is are was were be been " +
   "what which who how why when where does do did can could should would will " +
   "this that these those it its their there here about into over under than " +
   "any some other specific known associated used using have has had more most")
    .split(" "),
);
function needTerms(s: string): string[] {
  return [...new Set((String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 2 && !NEED_STOP.has(t)))];
}

/**
 * For each need, did the synthesis GROUND something about it? A line counts
 * only if it is tagged, carries a citation, and shares at least two
 * distinctive terms with the need — one shared word is the topic, not the need.
 */
export function groundedNeeds(needs: string[], synthesis: string): boolean[] {
  const lines = String(synthesis || "").split(/\r?\n/)
    .filter((l) => GROUND_TAG_RE.test(l) && CITE_RE.test(l))
    .map((l) => new Set(needTerms(l)));
  return (needs || []).map((need) => {
    const nt = needTerms(need);
    if (nt.length < 2) return false;
    return lines.some((lt) => nt.filter((t) => lt.has(t)).length >= 2);
  });
}

/** Reconcile the judge's per-need verdicts with what the synthesis grounded. */
export function reconcileNeedsStatus(needs: NeedState[], synthesis: string): NeedState[] {
  const list = needs || [];
  if (!String(synthesis || "").trim()) return list;
  const grounded = groundedNeeds(list.map((n) => n.need), synthesis);
  return list.map((n, i) =>
    n.status === "open" && grounded[i] ? { ...n, status: "partial" as NeedStatus } : n
  );
}

export function partialCount(needs: NeedState[]): number {
  return (needs || []).filter((n) => n.status === "partial").length;
}

export function answeredCount(needs: NeedState[]): number {
  return (needs || []).filter((n) => n.status === "answered").length;
}

/**
 * A topic template (scientific paper, product comparison, …) states a shape the
 * evidence has to fill. Below three answered needs there is no shape to fill,
 * and the template's own headings become assertions the run cannot support —
 * which is how a zero-finding run acquired an Abstract and a Discussion.
 */
export const TEMPLATE_MIN_ANSWERED = 3;
export function shouldClassifyTemplate(answered: number): boolean {
  return answered >= TEMPLATE_MIN_ANSWERED;
}

/** "ok" | "DEGRADED" — from measurement, not from whether an engine errored. */
export function searchHealthLabel(r: SearchRecord): "ok" | "DEGRADED" {
  if (!r) return "ok";
  // A search that returned junk is a failed search whether or not we could name
  // the token it piled onto.
  const junk = (r.collapsed || 0) + (r.offtopic || 0);
  if (junk > 0 && junk >= r.ok) return "DEGRADED";
  if (r.ok === 0 && (junk > 0 || r.empty > 0)) return "DEGRADED";
  return "ok";
}

/**
 * The one-line footer. Replaces `coverage NN%`, which answered a question
 * nobody asked.
 */
export function coverageFooter(
  needs: NeedState[],
  record: SearchRecord,
  backstop?: string | null,
): string {
  const parts: string[] = [];
  const partial = partialCount(needs);
  parts.push(
    `needs answered ${answeredCount(needs)} of ${(needs || []).length}` +
    (partial ? ` (${partial} partly)` : ""),
  );
  if (record) {
    const hitBits: string[] = [`${record.hits} hits`];
    const junkCalls = (record.collapsed || 0) + (record.offtopic || 0);
    if (junkCalls) hitBits.push(`${junkCalls} junk`);
    parts.push(
      `sources ${record.relevant} relevant of ${record.fetched} fetched (${hitBits.join(", ")})`,
    );
    const health = searchHealthLabel(record);
    if (health === "DEGRADED") {
      parts.push(`search: DEGRADED (${junkCalls} of ${junkCalls + record.ok + record.empty} searches returned junk)`);
    }
  }
  if (record && record.entity_shortened) {
    parts.push(`subject shortened to its name (${record.entity_shortened}x)`);
  }
  if (record) {
    const noGate = (record.entity_missing || 0) + (record.entity_rejected || 0);
    if (noGate) {
      const why = record.entity_rejected
        ? `${record.entity_rejected} rejected the run's subject`
        : `${record.entity_missing} had no subject to check`;
      parts.push(`entity gate: ${noGate} search(es) judged without it (${why})`);
    }
  }
  if (backstop && backstop !== "complete") parts.push(`stopped early: ${backstop}`);
  return parts.join(" · ");
}

const BACKSTOP_REASON: Record<string, string> = {
  search_degraded: "the search engines returned results for a single word of the query instead of the query",
  fetch_degraded: "almost nothing that was found could be fetched and read",
  wall_time: "the run hit its time limit before finding a usable source",
  max_fetch: "the run hit its fetch budget before finding a usable source",
  max_timeouts: "too many page fetches timed out",
  no_relevant_sources: "no retrieved page was about the subject",
};

function needTable(needs: NeedState[]): string {
  const rows = (needs || []).map((n) => `| ${n.need.replace(/\|/g, "/")} | ${n.status} |`);
  return ["| Need | Status |", "|---|---|", ...rows].join("\n");
}

function queryTable(record: SearchRecord, max = 12): string {
  const rows = (record?.queries || []).slice(0, max).map((q) => {
    const why = q.verdict === "collapsed" && q.collapsedOn
      ? `collapsed onto "${q.collapsedOn}"`
      : q.verdict;
    return `| ${q.query.replace(/\|/g, "/")} | ${q.hits} | ${why} |`;
  });
  if (!rows.length) return "_No web search was run._";
  return ["| Query tried | Hits | Verdict |", "|---|---|---|", ...rows].join("\n");
}

/**
 * The whole report for a run that retrieved nothing relevant. Answer first, in
 * the first line, so a reader knows within one sentence that nothing was found
 * and WHY — and cannot mistake it for a finding about the world.
 */
export function failureNotice(
  query: string,
  subject: string,
  needs: NeedState[],
  record: SearchRecord,
  backstop: string,
): string {
  const subj = (subject || "").trim() || "the subject of this question";
  const reason = BACKSTOP_REASON[backstop] || "the retrieval step failed";
  const out: string[] = [];
  out.push(`# No sources about ${subj} were retrieved`);
  out.push("");
  out.push(
    `**Answer.** No source relevant to ${subj} was retrieved, so this run has nothing ` +
    `to report about it. This is a **search failure, not evidence of absence**: ` +
    `${reason}. The question is unanswered, not answered in the negative. ` +
    `Re-run it once the search plane is healthy before concluding anything.`,
  );
  out.push("");
  out.push("## What was asked");
  out.push("");
  out.push(needTable(needs));
  out.push("");
  out.push("## Search record");
  out.push("");
  out.push(queryTable(record));
  out.push("");
  out.push(
    `Hits ${record?.hits ?? 0} · fetched ${record?.fetched ?? 0} · ` +
    `readable ${record?.readable ?? 0} · relevant **${record?.relevant ?? 0}**.`,
  );
  out.push("");
  out.push(`_— ${coverageFooter(needs, record, backstop)}_`);
  return out.join("\n");
}

/**
 * A title may not assert that something does not exist unless the run actually
 * covered the ground. "Absence of Evidence for 100 Hz Auditory Tones" was
 * written over a pool the engine never retrieved.
 */
const ABSENCE_TITLE_RE = /^#\s*.*\b(absence of evidence|no evidence (for|of)|lack of evidence)\b/im;
export function titleAssertsAbsence(markdown: string): boolean {
  return ABSENCE_TITLE_RE.test(String(markdown || ""));
}
