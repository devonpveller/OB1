// The cleanup view (research-workbench P8a, rw-p8a2-cleanup; D5 items 5-7): the suppressed / unlinked
// listing with dependence counts, the manual sever and erase, the process-all run, the reopen
// candidates and the lift - every write recorded as the CALLER'S cleanup action (identity seam).
// The examples are hand-written over contract-test/fixtures.sql (as the P4b card is); the
// conformance test validates each one against its schema.
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, Json, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";
import { DEPENDENCE_KINDS, fullCounts } from "../logic/cleanup.ts";

const ACTION = "c1ea0000-0000-4000-8000-000000000001";

export const CleanupSource = z.object({
  id: uuid(FX.sourceSuppressed),
  title: z.string(),
  url: z.string().nullable(),
  lifecycle: registryValue(REGISTRY.sourceStates, "suppressed").openapi({ description: "suppressed or unlinked: the status every listed source carries" }),
  reason: z.string().nullable().openapi({ description: "why it was suppressed" }),
  suppressed_at: Iso,
  unlinked_at: Iso.nullable(),
  counts: z.object(Object.fromEntries(DEPENDENCE_KINDS.map((k) => [k, z.number().int()])) as Record<(typeof DEPENDENCE_KINDS)[number], z.ZodNumber>)
    .catchall(z.number().int())
    .openapi("CleanupCounts", { description: "dependence connections per kind: every kind of the dependence_kinds registry, zero-filled (a kind added later appears beside them)" }),
  blocking: z.number().int().openapi({ description: "connections that block erasure" }),
  severable: z.number().int().openapi({ description: "connections the sever tool may remove" }),
  total: z.number().int(),
  erase_allowed: z.boolean().openapi({ description: "true only when unlinked with zero blocking connections (the erase gate)" }),
}).openapi("CleanupSource");

export const CleanupSources = z.object({
  sources: z.array(CleanupSource),
  total: z.number().int().openapi({ description: "every suppressed or unlinked source, not only this page" }),
}).openapi("CleanupSources");

export const CleanupSeverRequest = z.object({
  kind: registryValue(REGISTRY.dependenceKinds, "chunk").optional(),
  ref: z.string().optional(),
  all: z.boolean().optional().openapi({ description: "sever every severable connection" }),
}).strict().openapi("CleanupSeverRequest");

export const CleanupEraseRequest = z.object({
  reason_type: registryValue(REGISTRY.erasureReasons, "deliberate"),
  note: z.string().max(2000).optional().openapi({ description: "optional on a manual erase" }),
}).strict().openapi("CleanupEraseRequest");

// D5 item 4: the bulk run takes ONE reason type for the batch and nothing else - a note is refused.
export const ProcessAllRequest = z.object({
  reason_type: registryValue(REGISTRY.erasureReasons, "deliberate"),
  source_ids: z.array(uuid(FX.sourceUnlinked)).min(1).max(500).openapi({ description: "the marked sources (the view sends every listed one)" }),
}).strict().openapi("ProcessAllRequest");

export const CleanupLiftRequest = z.object({
  note: z.string().max(2000).optional(),
}).strict().openapi("CleanupLiftRequest");

export const ProcessAllItem = z.object({
  source_id: uuid(FX.sourceUnlinked),
  outcome: z.string().openapi({ description: "erased | blocked (a connection the sever tool cannot remove) | skipped (not suppressed or unlinked) | failed" }),
  severed: z.number().int(),
  blocking: z.number().int(),
  tombstone_id: uuid().nullable(),
  detail: z.string().nullable(),
}).openapi("ProcessAllItem");

export const CleanupAction = z.object({
  id: uuid(ACTION, "the action id; the shared rows it wrote name it as cleanup-action:<id>"),
  kind: z.string().openapi({ description: "sever | erase | lift | process_all" }),
  reason_type: z.string().nullable(),
  source_id: uuid().nullable(),
  tombstone_id: uuid().nullable(),
  detail: Json,
  created_at: Iso,
  finished_at: Iso.nullable(),
}).openapi("CleanupAction");

export const CleanupActions = z.object({ actions: z.array(CleanupAction) }).openapi("CleanupActions");

export const ProcessAllResult = z.object({
  action: CleanupAction,
  reason_type: z.string(),
  items: z.array(ProcessAllItem),
  erased: z.number().int(),
}).openapi("ProcessAllResult");

const AttemptScore = z.object({
  available: z.boolean().optional(),
  value: z.number().nullable().optional(),
  floor: z.number().nullable().optional(),
  version: z.string().nullable().optional(),
  reason: z.string().optional(),
});

export const CandidateEvidence = z.object({
  path: registryValue(REGISTRY.admissionPaths, "intake"),
  outcome: registryValue(REGISTRY.admissionOutcomes, "candidate"),
  session_id: z.string().nullable().openapi({ description: "the session that returned it (shared, as on the trail)" }),
  note: z.string().nullable().openapi({ description: "the door's reopen note: what returned it, why it looks promising" }),
  attempted_at: Iso,
  reason: z.string().nullable().openapi({ description: "what the admission gate decided, and why" }),
  score: AttemptScore.nullable(),
}).openapi("CandidateEvidence");

export const ReopenCandidate = z.object({
  kind: z.string().openapi({ description: "proposed_contesting (debunked) | credibility_cleared | reopen_note (deliberate)" }),
  tombstone: z.object({
    id: uuid(FX.tombstoneAutomation),
    source_id: uuid(FX.sourceErased),
    url: z.string(),
    title: z.string(),
    reason_type: registryValue(REGISTRY.erasureReasons, "debunked"),
    note: z.string().nullable(),
    eraser_kind: registryValue(REGISTRY.erasers, "user"),
    erased_by_you: z.boolean(),
    erased_at: Iso,
    confidence: z.number().nullable(),
    score_version: z.string().nullable(),
  }),
  evidence: z.array(CandidateEvidence).min(1),
  dispute_preview: z.object({
    criticism: z.object({ tombstone_id: uuid(), reason_type: z.string(), note: z.string().nullable(), erased_at: Iso }),
    score: AttemptScore,
  }).nullable().openapi({ description: "debunked: what admitting it would attach - the debunking as criticism, the score that cleared the floor" }),
}).openapi("ReopenCandidate");

export const ReopenCandidates = z.object({ candidates: z.array(ReopenCandidate) }).openapi("ReopenCandidates");

export const CleanupLifted = z.object({
  action: CleanupAction,
  tombstone_id: uuid(FX.tombstoneToLift),
  lifted_at: Iso.nullable(),
}).openapi("CleanupLifted");

export const CleanupSevered = z.object({
  action: CleanupAction,
  severed: z.array(z.object({ kind: z.string(), ref: z.string() })),
  rescored_claims: z.number().int(),
  pending_compile: z.array(z.string()),
  lifecycle: z.string().nullable(),
  blocking: z.number().int(),
}).openapi("CleanupSevered");

export const CleanupErased = z.object({
  action: CleanupAction,
  tombstone_id: uuid(),
  reason_type: z.string(),
  note: z.string().nullable(),
}).openapi("CleanupErased");

const act = (kind: string, over: Record<string, unknown> = {}) => ({
  id: ACTION, kind, reason_type: null, source_id: null, tombstone_id: null, detail: {}, created_at: FX.at, finished_at: FX.at, ...over,
});

export const CX = {
  sources: {
    sources: [{
      id: FX.sourceSuppressed, title: "Suppressed fixture source", url: "https://example.org/suppressed", lifecycle: "suppressed",
      reason: "misattributed quote", suppressed_at: FX.at, unlinked_at: null, counts: fullCounts({ chunk: 1, claim_edge: 1 }), blocking: 2,
      severable: 2, total: 2, erase_allowed: false,
    }],
    total: 1,
  },
  severRequest: { all: true },
  eraseRequest: { reason_type: "deliberate", note: "removed from the cleanup view" },
  processAllRequest: { reason_type: "deliberate", source_ids: [FX.sourceActive] },
  liftRequest: { note: "reconsidered" },
  severed: { action: act("sever", { source_id: FX.sourceToSever }), severed: [{ kind: "chunk", ref: "0" }], rescored_claims: 0, pending_compile: [], lifecycle: "unlinked", blocking: 0 },
  erased: { action: act("erase", { reason_type: "deliberate", source_id: FX.sourceUnlinked, tombstone_id: FX.tombstoneToLift }), tombstone_id: FX.tombstoneToLift, reason_type: "deliberate", note: "removed from the cleanup view" },
  processAll: {
    action: act("process_all", { reason_type: "deliberate", detail: { sources: 1, erased: 0 } }), reason_type: "deliberate", erased: 0,
    items: [{ source_id: FX.sourceActive, outcome: "skipped", severed: 0, blocking: 0, tombstone_id: null, detail: "the source is active, not suppressed or unlinked" }],
  },
  candidates: {
    candidates: [{
      kind: "proposed_contesting",
      tombstone: { id: FX.tombstoneAutomation, source_id: FX.sourceErased, url: FX.erasedUrl, title: "Erased fixture source", reason_type: "debunked", note: null, eraser_kind: "user", erased_by_you: true, erased_at: FX.at, confidence: 0.42, score_version: "claim-confidence-mean-v1" },
      evidence: [{ path: "intake", outcome: "candidate", session_id: null, note: null, attempted_at: FX.at, reason: "re-scored 0.8 >= floor 0.5; user-erased: awaits the operator", score: { available: true, value: 0.8, floor: 0.5, version: "v2", reason: "scored" } }],
      dispute_preview: { criticism: { tombstone_id: FX.tombstoneAutomation, reason_type: "debunked", note: null, erased_at: FX.at }, score: { available: true, value: 0.8, floor: 0.5, version: "v2", reason: "scored" } },
    }],
  },
  lifted: { action: act("lift", { tombstone_id: FX.tombstoneToLift }), tombstone_id: FX.tombstoneToLift, lifted_at: FX.at },
  actions: { actions: [act("lift", { tombstone_id: FX.tombstoneToLift })] },
  action: act("lift", { tombstone_id: FX.tombstoneToLift }),
};
