/**
 * RED-first tests for coverage-vs-footer consistency
 * (harness item research-trust-entity, acceptance 7).
 *
 * The artefact: LIVE dry run 1f2ff740, recorded in
 * `fixtures/dryrun-optiplex-1f2ff740.json`. It cited 11 sources, its synthesis
 * carries 25 grounded lines stating findings about the OptiPlex 3050 — and its
 * footer printed **needs answered 0 of 6**, because the COVERAGE_STAGED judge
 * marked every need `open`. The operator is shown a report full of findings
 * over a line that says nothing was answered.
 *
 * Both halves can be true at once: sources can support many facts without
 * settling any one sub-question. What was false was the footer's silence about
 * the second number.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  coverageFooter, groundedNeeds, reconcileNeedsStatus, type NeedState, type SearchRecord,
} from "./report.ts";

type Run = {
  needs: string[];
  needs_status: NeedState[];
  synthesis: string;
  cited_sources: Array<{ url: string | null; title: string }>;
  search_record: SearchRecord;
};
const run: Run = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/dryrun-optiplex-1f2ff740.json", import.meta.url)),
);

Deno.test("the recorded run really did contradict itself", () => {
  assertEquals(run.needs_status.length, 6);
  assertEquals(run.needs_status.filter((n) => n.status === "open").length, 6);
  assertEquals(run.cited_sources.length, 11);
  const grounded = run.synthesis.split("\n")
    .filter((l) => /^\[(SOURCED|INFERRED|UNCERTAIN)\]/.test(l.trim()));
  assert(grounded.length >= 20, `${grounded.length} grounded lines`);
});

Deno.test("groundedNeeds attributes a grounded line to the need it is about", () => {
  const needs = [
    "What specific thermal management problems or overheating issues are associated with the OptiPlex 3050?",
    "How do I bake a sourdough loaf?",
  ];
  const synth = [
    "[SOURCED] The OptiPlex 3050 M.2 slot overheating is a documented thermal problem. [Source 3]",
    "[GAP] Nothing about proving dough.",
  ].join("\n");
  const hit = groundedNeeds(needs, synth);
  assertEquals(hit[0], true);
  assertEquals(hit[1], false);
});

Deno.test("groundedNeeds ignores [GAP] lines and uncited assertions", () => {
  const needs = ["What thermal management problems affect the OptiPlex 3050?"];
  assertEquals(groundedNeeds(needs,
    "[GAP] What thermal management problems affect the OptiPlex 3050?")[0], false);
  assertEquals(groundedNeeds(needs,
    "[SOURCED] Thermal management problems on the OptiPlex 3050 are common.")[0], false,
    "an uncited line grounds nothing");
  assertEquals(groundedNeeds(needs,
    "[SOURCED] Thermal management problems on the OptiPlex 3050 are common. [Source 2]")[0], true);
});

Deno.test("ACCEPTANCE 7: a need the synthesis grounded is never left 'open'", () => {
  const reconciled = reconcileNeedsStatus(run.needs_status, run.synthesis);
  assertEquals(reconciled.length, 6);
  const partial = reconciled.filter((n) => n.status === "partial").length;
  assert(partial > 0, "the run grounded 25 lines and not one need was reconciled");
  for (const n of reconciled) {
    if (n.status === "open") {
      assert(!groundedNeeds([n.need], run.synthesis)[0],
        `need left open although the synthesis grounds it: ${n.need.slice(0, 60)}`);
    }
  }
});

Deno.test("ACCEPTANCE 7: the footer states the partial count, so body and footer agree", () => {
  const reconciled = reconcileNeedsStatus(run.needs_status, run.synthesis);
  const foot = coverageFooter(reconciled, run.search_record, "complete");
  const partial = reconciled.filter((n) => n.status === "partial").length;
  assert(foot.includes(`${partial} partly`), foot);
  // The old footer is still there and still honest about what was SETTLED.
  assert(/needs answered \d+ of 6/.test(foot), foot);
});

Deno.test("reconciliation never downgrades, and never invents an 'answered'", () => {
  const before: NeedState[] = [
    { need: "the OptiPlex 3050 thermal problems", status: "answered" },
    { need: "the OptiPlex 3050 capacitor problems", status: "search_failed" },
    { need: "something nothing was found about", status: "open" },
  ];
  const synth = "[SOURCED] OptiPlex 3050 thermal problems are documented. [Source 1]\n" +
                "[SOURCED] OptiPlex 3050 capacitor problems are documented. [Source 2]";
  const after = reconcileNeedsStatus(before, synth);
  assertEquals(after[0].status, "answered", "an answered need stays answered");
  assertEquals(after[1].status, "search_failed",
    "a need whose SEARCH failed is not reopened by a line the reuse pool grounded");
  assertEquals(after[2].status, "open", "a need with no grounded line stays open");
  assertEquals(after.filter((n) => n.status === "answered").length, 1,
    "reconciliation must never manufacture an 'answered'");
});

Deno.test("a run with no synthesis is unchanged", () => {
  const before: NeedState[] = [{ need: "a", status: "open" }];
  assertEquals(reconcileNeedsStatus(before, ""), before);
  assertEquals(reconcileNeedsStatus(before, "   "), before);
});

Deno.test("the footer omits the partial clause when there is none", () => {
  const rec: SearchRecord = { queries: [], hits: 10, fetched: 5, readable: 5, relevant: 3,
    ok: 2, collapsed: 0, offtopic: 0, empty: 0, errors: 0,
    entity_missing: 0, entity_rejected: 0 };
  const foot = coverageFooter(
    [{ need: "a", status: "answered" }, { need: "b", status: "open" }], rec, "complete");
  assert(!foot.includes("partly"), foot);
});
