// research-workbench P3b - the trust panels' reads: the report credibility roll-up (D15 item 5, with
// the claim-kind weights it used), a session's coverage (needs by status, the topic estimate beside the
// anchor, the hubs it touches - D1) and a user document's coverage (its hubs and its sessions).
// The claims ledger reads claims() (knowledge.ts: verdict, corroborations, contradicted_by_newer) and
// the source quality panel reads quality() as they stand.
//
// No closed list (common.ts rule 1): a need's status and a family are strings, the statuses the research
// service writes (answered | partial | open | search_failed) are counted in an open record.
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

export const RollupWeight = z.object({
  family: registryValue(REGISTRY.sourceFamilies, "scholarly"),
  weight: z.number().openapi({ description: "the weight row's weight for the report's claim kind and this source family" }),
}).openapi("RollupWeight");

export const ReportCredibility = z.object({
  report_id: uuid(FX.synthesis, "the research synthesis (report) source").nullable(),
  job_id: uuid(FX.job, "the research job that wrote the roll-up").nullable(),
  recorded: z.boolean().openapi({ description: "false: no roll-up was recorded for this report (a run before P3a, or no job found)" }),
  value: z.number().nullable().openapi({ description: "the mean of the filed claims' D15 totals; null when nothing was filed or judged" }),
  claims: z.number().int(),
  below_floor: z.number().int(),
  judged_lines: z.number().int(),
  judged_not_filed: z.number().int(),
  claim_kind: registryValue(REGISTRY.claimKinds, "general_theory").nullable(),
  model_version: z.string().nullable(),
  weights: z.array(RollupWeight).openapi({ description: "the claim-kind weights the roll-up used, one per scored family" }),
  filed: z.boolean().nullable(),
  not_filed: z.string().nullable(),
  basis: z.string().nullable(),
  statement: z.string().openapi({ description: "the roll-up as one line, the weights named in it - never a bare number" }),
}).openapi("ReportCredibility");

export const Need = z.object({
  need: z.string(),
  status: z.string().openapi({ example: "answered", description: "answered | partial | open | search_failed (as the research service wrote it)" }),
}).openapi("Need");

export const HubMarker = z.object({
  centre: z.object({ slug: z.string(), title: z.string(), page_class: z.string().nullable(), in_degree: z.number().int() }),
  seeds: z.array(z.string()),
  links: z.array(z.object({ kind: z.string(), id: z.string() })),
  sources: z.number().int(),
  thin: z.boolean(),
  contested: z.boolean(),
  contested_claims: z.array(z.object({ claim_id: z.string(), text: z.string() })),
  why: z.array(z.string()),
}).openapi("HubMarker");

export const SessionCoverage = z.object({
  session_id: uuid(FX.job, "research job id"),
  status: z.string(),
  created_at: Iso,
  needs: z.array(Need),
  by_status: z.record(z.string(), z.number().int()).openapi({ description: "needs counted by status; never a percent" }),
  gaps: z.array(z.string()),
  topic_estimate: z.string().nullable().openapi({ description: "the tree's live topic estimate (P4a); null for a run before P4a" }),
  anchor: z.string().nullable().openapi({ description: "what the estimate is read against: the branch's anchor, or the root's own question" }),
  anchor_basis: z.string(),
  report_id: uuid(FX.synthesis, "the run's report (research synthesis source)").nullable(),
  credibility: ReportCredibility,
  hubs: z.array(HubMarker).openapi({ description: "the hubs the session's sources fall into - the P2b hub-context computation" }),
}).openapi("SessionCoverage");

export const DocumentSession = z.object({
  id: uuid(FX.job, "research job id"),
  status: z.string(),
  created_at: Iso,
  by_status: z.record(z.string(), z.number().int()),
  credibility: z.string().openapi({ description: "the session's report credibility statement" }),
}).openapi("DocumentSession");

export const DocumentCoverage = z.object({
  path: z.string(),
  computed_at: Iso,
  hubs: z.array(HubMarker),
  sessions: z.array(DocumentSession).openapi({ description: "the signed-in user's sessions started from this document or its refinery" }),
}).openapi("DocumentCoverage");
