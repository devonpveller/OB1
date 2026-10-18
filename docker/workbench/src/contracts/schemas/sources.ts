// Source records and the D5 lifecycle: reference, chunk context, diffCheck, quality,
// dependence / sever / suppress / erase, tombstones and the admission gate.
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, Json, recordState, StateDetail, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";
import { ReferenceRecordShape } from "./references.ts";

const lifecycle = (example = "active") => registryValue(REGISTRY.sourceStates, example);

export const TombstoneAttempt = z.object({
  path: registryValue(REGISTRY.admissionPaths, "intake"),
  outcome: registryValue(REGISTRY.admissionOutcomes, "refused"),
  session_id: z.string().nullable(),
  note: z.string().nullable(),
  attempted_at: Iso,
}).openapi("TombstoneAttempt");

const TombstoneShape = z.object({
  id: uuid(FX.tombstoneAutomation),
  source_id: uuid(FX.sourceErased),
  url: z.string().openapi({ example: FX.erasedUrl, description: "the original link (urn:openbrain:source:<id> when it had none)" }),
  title: z.string(),
  reason_type: registryValue(REGISTRY.erasureReasons, "debunked"),
  note: z.string().nullable(),
  batch_run_id: z.string().nullable(),
  eraser_kind: registryValue(REGISTRY.erasers, "automation"),
  eraser_run_id: z.string().nullable(),
  eraser_user: z.string().nullable(),
  confidence: z.number().nullable(),
  score_version: z.string().nullable(),
  fingerprint: z.string().nullable(),
  erased_at: Iso,
  lifted_at: Iso.nullable(),
  lifted_by: z.string().nullable(),
  readmitted_source_id: uuid().nullable(),
  attempts: z.array(TombstoneAttempt),
});
export const Tombstone = TombstoneShape.openapi("Tombstone");

const SourceBodyShape = z.object({
  title: z.string(),
  url: z.string().nullable(),
  content_type: registryValue(REGISTRY.contentTypes, "web_article"),
  domain: z.string().nullable(),
  family: registryValue(REGISTRY.sourceFamilies, "general"),
  excerpt: z.string().openapi({ description: "the first 500 characters of the requested revision" }),
  created_at: Iso,
  updated_at: Iso,
});
export const SourceBody = SourceBodyShape.openapi("SourceBody");

const HeldBodyShape = z.object({
  refinery_id: uuid(FX.idea),
  title: z.string(),
  url: z.string().nullable(),
  excerpt: z.string(),
  user_source_status: registryValue(REGISTRY.userSourceStatuses, "held"),
});
export const HeldBody = HeldBodyShape.openapi("HeldBody");

// reference(id, version?) - one shape for every lifecycle state. `source` is present for
// active / suppressed / unlinked, `tombstone` for erased, `held` for held; state 'omitted'
// (evidence-only callers) carries none of them. P2a: when the id is a REFERENCE RECORD (kind
// 'reference'), `record` carries it and the target part is read at the pinned revision
// (requested_version = the pin; state 'updated' when the source has moved on).
export const Reference = z.object({
  id: uuid(),
  kind: registryValue(REGISTRY.nodeKinds, "source"),
  state: recordState("active"),
  state_detail: StateDetail,
  lifecycle: lifecycle().nullable(),
  version: z.number().int().nullable().openapi({ description: "the current revision" }),
  requested_version: z.number().int().nullable(),
  source: SourceBodyShape.nullable(),
  tombstone: TombstoneShape.nullable(),
  held: HeldBodyShape.nullable(),
  record: ReferenceRecordShape.nullable(),
}).openapi("Reference");

export const ChunkLine = z.object({
  idx: z.number().int(),
  content: z.string(),
  is_target: z.boolean(),
}).openapi("ChunkLine");

export const ChunkContext = z.object({
  chunk_id: z.string().openapi({ example: `${FX.sourceActive}:1` }),
  source_id: uuid(),
  idx: z.number().int(),
  window: z.number().int(),
  state: recordState("active"),
  state_detail: StateDetail,
  lifecycle: lifecycle().nullable(),
  chunks: z.array(ChunkLine),
}).openapi("ChunkContext");

// P2a: a reference is either a reference record id (its pin, chunk and quote are read from the
// record) or, as in P0, a bare pin (source_id + revision [+ chunk_idx]). One shape, no union:
// exactly one of the two forms must be given.
export const DiffCheckRef = z.object({
  reference_id: uuid(FX.referenceSpan, "a reference record id").optional(),
  source_id: uuid().optional(),
  revision: z.number().int().min(1).optional(),
  chunk_idx: z.number().int().min(0).optional(),
}).refine((r) => (r.reference_id !== undefined) !== (r.source_id !== undefined && r.revision !== undefined) &&
  (r.reference_id === undefined || (r.source_id === undefined && r.revision === undefined && r.chunk_idx === undefined)), {
  message: "give reference_id, or source_id + revision (+ chunk_idx) - not both",
}).openapi("DiffCheckRef");

// Either a list of references (at most 200) or a holder whose every reference is checked.
export const DiffCheckRequest = z.object({
  references: z.array(DiffCheckRef).min(1).max(200).optional(),
  holder: z.object({
    kind: registryValue(REGISTRY.referenceHolderKinds, "legacy_note"),
    ref: z.string().min(1).openapi({ example: FX.refNotePath }),
  }).optional().openapi({ description: "check every reference a note or user document holds" }),
}).refine((b) => (b.references !== undefined) !== (b.holder !== undefined), {
  message: "give references or holder, not both",
}).openapi("DiffCheckRequest");

// No chunk TEXT crosses the wire here: ids, revisions and states only (P2a acceptance 4).
export const DiffCheckResult = z.object({
  reference_id: uuid(FX.referenceSpan).nullable().openapi({ description: "null for a bare pin" }),
  source_id: uuid(),
  pinned_revision: z.number().int(),
  current_revision: z.number().int().nullable(),
  out_of_date: z.boolean(),
  chunk_idx: z.number().int().nullable(),
  equivalent_current_chunk_id: z.string().nullable().openapi({
    example: `${FX.refSource}:1`,
    description: "the chunk of the current revision that stands for the pinned one: the pinned chunk " +
      "while the pin is current; once out of date, the chunk the reference scope's reanchor rule finds " +
      "(span: the chunk containing the quote; source: the first chunk); null when none does",
  }),
  anchor: registryValue(REGISTRY.referenceAnchorOutcomes, "requoted"),
  state: recordState("updated"),
  lifecycle: lifecycle().nullable(),
}).openapi("DiffCheckResult");

export const DiffCheck = z.object({ results: z.array(DiffCheckResult) }).openapi("DiffCheck");

export const QualityFactor = z.object({
  name: z.string(),
  value: z.number(),
  reason: z.string(),
}).openapi("QualityFactor");

export const Quality = z.object({
  source_id: uuid(),
  state: recordState("active"),
  state_detail: StateDetail,
  lifecycle: lifecycle().nullable(),
  family: registryValue(REGISTRY.sourceFamilies, "general"),
  score: z.object({
    value: z.number().nullable().openapi({ description: "the database (admission) score" }),
    refinery_scoped: z.number().nullable().openapi({ description: "held sources only: the score inside their refinery, user_provided included" }),
    version: z.string(),
    computed_from: z.string(),
  }),
  factors: z.array(QualityFactor),
}).openapi("Quality");

export const Connection = z.object({
  kind: registryValue(REGISTRY.dependenceKinds, "claim_edge"),
  ref: z.string(),
  detail: Json,
  blocks_erase: z.boolean(),
  severable: z.boolean(),
}).openapi("Connection");

export const Dependence = z.object({
  source_id: uuid(FX.sourceSuppressed),
  lifecycle: lifecycle("suppressed").nullable(),
  blocking: z.number().int(),
  total: z.number().int(),
  counts: z.record(z.string(), z.number().int()).openapi({ description: "connections per dependence kind" }),
  claims_by_edge_type: z.record(z.string(), z.number().int()),
  connections: z.array(Connection),
  erase_allowed: z.boolean(),
}).openapi("Dependence");

export const SeverRequest = z.object({
  kind: registryValue(REGISTRY.dependenceKinds, "chunk").optional(),
  ref: z.string().optional(),
  all: z.boolean().optional().openapi({ description: "sever every severable connection" }),
  by: z.string().optional(),
}).openapi("SeverRequest");

export const SeverResult = z.object({
  source_id: uuid(FX.sourceToSever),
  severed: z.array(z.object({ kind: z.string(), ref: z.string() })),
  rescored_claims: z.number().int(),
  pending_compile: z.array(z.string()),
  lifecycle: lifecycle("unlinked").nullable(),
  blocking: z.number().int(),
}).openapi("SeverResult");

export const SuppressRequest = z.object({
  reason: z.string().min(1),
  by: z.string().optional(),
}).openapi("SuppressRequest");

export const SuppressResult = z.object({
  source_id: uuid(FX.sourceToSuppress),
  lifecycle: lifecycle("suppressed"),
  reason: z.string(),
  context: Json,
  rescored_claims: z.number().int(),
  blocking: z.number().int(),
}).openapi("SuppressResult");

export const Eraser = z.object({
  kind: registryValue(REGISTRY.erasers, "user"),
  run_id: z.string().optional(),
  user: z.string().optional(),
}).openapi("Eraser");

export const EraseRequest = z.object({
  reason_type: registryValue(REGISTRY.erasureReasons, "deliberate"),
  note: z.string().optional(),
  batch_run_id: z.string().optional(),
  eraser: Eraser,
}).openapi("EraseRequest");

export const EraseResult = z.object({ tombstone: Tombstone }).openapi("EraseResult");

export const LiftRequest = z.object({
  by: z.string().min(1),
  note: z.string().optional(),
}).openapi("LiftRequest");

export const AdmissionCandidate = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  content_type: registryValue(REGISTRY.contentTypes, "web_article").optional(),
}).openapi("AdmissionCandidate");

export const AdmissionRequest = z.object({
  url: z.string().min(1),
  path: registryValue(REGISTRY.admissionPaths, "intake"),
  session_id: z.string().optional(),
  note: z.string().optional(),
  candidate: AdmissionCandidate.optional(),
}).openapi("AdmissionRequest");

const AdmissionScoreShape = z.object({
  available: z.boolean(),
  value: z.number().nullable(),
  floor: z.number().nullable(),
  version: z.string().nullable(),
  reason: z.string(),
});
export const AdmissionScore = AdmissionScoreShape.openapi("AdmissionScore");

export const AdmissionDecision = z.object({
  url: z.string(),
  path: registryValue(REGISTRY.admissionPaths, "intake"),
  outcome: registryValue(REGISTRY.admissionOutcomes, "refused"),
  admits: z.boolean(),
  reason: z.string(),
  tombstone: TombstoneShape.nullable(),
  source_id: uuid().nullable(),
  dispute_id: uuid().nullable(),
  score: AdmissionScoreShape.nullable(),
}).openapi("AdmissionDecision");
