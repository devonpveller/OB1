// research-workbench P3b - the examples of the trust reads (schemas/trust.ts), over contract-test/fixtures.sql:
// the fixture job 99999999 is an Open WebUI job with no recorded owner (the default identity's in the
// lab), its result carries no needs and no curator answer, so its coverage has no needs, no report and
// no recorded roll-up; the fixture synthesis 77777777 was filed by no job, so its roll-up is "not
// recorded". The conformance test validates each against its schema.
// deno-lint-ignore-file
import { FX } from "./fixtures.ts";

const notRecorded = (report: string | null, job: string | null) => ({
  report_id: report, job_id: job, recorded: false, value: null, claims: 0, below_floor: 0, judged_lines: 0, judged_not_filed: 0,
  claim_kind: null, model_version: null, weights: [], filed: null, not_filed: null, basis: null,
  statement: "Report credibility: not recorded for this report (its run predates the D15 roll-up, or no research job filed it)",
});

export const TRUST_EX = {
  reportCredibility: notRecorded(FX.synthesis, null),
  sessionCoverage: {
    session_id: FX.job, status: "done", created_at: FX.at, needs: [],
    by_status: { answered: 0, partial: 0, open: 0, search_failed: 0 }, gaps: ["what about erasure?"],
    topic_estimate: null, anchor: "fixture question", anchor_basis: "the session's own question (a root has no other anchor)",
    report_id: null, credibility: notRecorded(null, FX.job), hubs: [],
  },
  documentCoverage: {
    path: FX.documentPath, computed_at: FX.at,
    hubs: [{
      centre: { slug: FX.pageEntity, title: "Tool Fixture", page_class: "entity", in_degree: 0 },
      seeds: [FX.pageLeafActive], links: [{ kind: "source", id: FX.sourceActive }], sources: 2, thin: true, contested: false,
      contested_claims: [], why: ["2 source page(s) around the centre (thin below 3)", "no contradicted claim grounded here"],
    }],
    sessions: [],
  },
};
