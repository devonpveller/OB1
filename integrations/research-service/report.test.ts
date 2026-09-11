/**
 * RED-first tests for honest report rendering (PLAN-research-trust Phase 4).
 *
 * The artefacts (audit 2026-09-11):
 *   - job ce398d06 rendered "coverage 22%" while 0 of its 6 needs were answered:
 *     `coverage` was 1 - gap_ratio over synthesis LINES, which measures how much
 *     of the writing carried a citation, not how much of the question was answered.
 *   - job 8c9b4f1d retrieved nothing relevant and was rendered as a scientific
 *     paper titled "Absence of Evidence for 100 Hz Auditory Tones…", which reads
 *     as a literature finding. The literature exists; the search failed.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  answeredCount,
  coverageFooter,
  failureNotice,
  searchHealthLabel,
  shouldClassifyTemplate,
  type NeedState,
  type SearchRecord,
} from "./report.ts";

const needs6: NeedState[] = [
  { need: "common failure modes for the OptiPlex 3050?", status: "open" },
  { need: "thermal / capacitor / CPU socket issues?", status: "search_failed" },
  { need: "how to verify BIOS integrity?", status: "search_failed" },
  { need: "how to run ePSA diagnostics?", status: "search_failed" },
  { need: "how to check SMART status?", status: "search_failed" },
  { need: "visual red flags on a used unit?", status: "search_failed" },
];

const optiplexRecord: SearchRecord = {
  queries: [
    { query: "OptiPlex 3050 failure modes", verdict: "collapsed", hits: 10, overlap: 0, collapsedOn: "most" },
    { query: "OptiPlex 3050 capacitor problems", verdict: "collapsed", hits: 10, overlap: 0, collapsedOn: "dell" },
  ],
  hits: 63, fetched: 32, readable: 26, relevant: 0, collapsed: 41, offtopic: 0, ok: 0, empty: 0, errors: 0,
};

Deno.test("answeredCount counts only answered needs", () => {
  assertEquals(answeredCount(needs6), 0);
  assertEquals(answeredCount([{ need: "a", status: "answered" }, { need: "b", status: "open" }]), 1);
});

Deno.test("the footer says how much of the QUESTION was answered, never 'coverage 22%'", () => {
  const foot = coverageFooter(needs6, optiplexRecord, "search_degraded");
  assertStringIncludes(foot, "needs answered 0 of 6");
  assertStringIncludes(foot, "0 relevant of 32 fetched");
  assertStringIncludes(foot, "63 hits");
  assertStringIncludes(foot, "41 junk");
  assertStringIncludes(foot, "search: DEGRADED");
  assert(!/coverage \d+%/.test(foot), foot);
});

Deno.test("a healthy run's footer does NOT claim the search was degraded", () => {
  const ok: SearchRecord = { queries: [], hits: 40, fetched: 30, readable: 28, relevant: 9,
                             collapsed: 0, offtopic: 0, ok: 6, empty: 0, errors: 0 };
  const foot = coverageFooter(
    [{ need: "a", status: "answered" }, { need: "b", status: "answered" }], ok, "complete");
  assertStringIncludes(foot, "needs answered 2 of 2");
  assertEquals(searchHealthLabel(ok), "ok");
  assert(!foot.includes("DEGRADED"), foot);
});

Deno.test("the failure notice answers 'did it find anything?' in its first line", () => {
  const text = failureNotice(
    "Dell OptiPlex 3050 used purchase: common failure modes…", "Dell OptiPlex 3050",
    needs6, optiplexRecord, "search_degraded");
  const first = text.trim().split("\n")[0];
  assertStringIncludes(first, "#");
  assertStringIncludes(text, "**Answer.**");
  assertStringIncludes(text, "search failure, not evidence of absence");
  assertStringIncludes(text, "Dell OptiPlex 3050");
  // It must never be dressed up as a finding.
  assert(!/absence of evidence for/i.test(text), "must not read as a literature finding");
  assertStringIncludes(text, "## Search record");
  assertStringIncludes(text, "needs answered 0 of 6");
});

Deno.test("the failure notice names the queries that were tried and their verdicts", () => {
  const text = failureNotice("q", "OptiPlex 3050", needs6, optiplexRecord, "search_degraded");
  assertStringIncludes(text, "OptiPlex 3050 failure modes");
  assertStringIncludes(text, "collapsed");
  assertStringIncludes(text, "most");
});

Deno.test("a report is only classified into a topic template once the evidence carries it", () => {
  assertEquals(shouldClassifyTemplate(0), false);
  assertEquals(shouldClassifyTemplate(2), false);
  assertEquals(shouldClassifyTemplate(3), true);
});

Deno.test("failure notice stays short — it is a notice, not a report", () => {
  const text = failureNotice("q", "OptiPlex 3050", needs6, optiplexRecord, "search_degraded");
  const words = text.split(/\s+/).filter(Boolean).length;
  assert(words <= 600, `failure notice is ${words} words`);
});
