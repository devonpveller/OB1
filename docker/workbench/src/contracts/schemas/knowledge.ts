// Knowledge-graph reads: neighbours, claims, search, timeline, trail.
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, Json, recordState, StateDetail, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

export const GraphNode = z.object({
  kind: registryValue(REGISTRY.nodeKinds, "page"),
  id: z.string().openapi({ example: FX.pageEntity, description: "a page slug, or a uuid for sources and claims" }),
  title: z.string(),
  page_class: registryValue(REGISTRY.pageClasses, "entity").nullable(),
  state: recordState("current"),
  distance: z.number().int(),
  // research-workbench P8a-1 (D5: suppression status shows wherever a source is listed; D1: contested marks)
  lifecycle: registryValue(REGISTRY.sourceStates, "active").nullable().openapi({
    description: "a source or report leaf page (content/source/<id>): its source's lifecycle state (erased when only " +
      "its tombstone is left); null for every other page",
  }),
  contested: z.boolean().openapi({
    description: "a source leaf page whose source grounds a contradicted claim, or a claim through a contradicts edge " +
      "(the hub context's contested rule, documents/hub.ts); false for every other page",
  }),
}).openapi("GraphNode");

export const GraphLink = z.object({
  source: z.string(),
  target: z.string(),
}).openapi("GraphLink");

export const Neighbours = z.object({
  root: z.string(),
  depth: z.number().int(),
  truncated: z.boolean(),
  nodes: z.array(GraphNode),
  links: z.array(GraphLink),
}).openapi("Neighbours");

export const ClaimSourceEdge = z.object({
  edge_id: z.number().int(),
  source_id: uuid(),
  edge_type: registryValue(REGISTRY.claimEdgeTypes, "states"),
  lifecycle: registryValue(REGISTRY.sourceStates, "active"),
  title: z.string(),
  url: z.string().nullable(),
}).openapi("ClaimSourceEdge");

export const Claim = z.object({
  id: uuid(FX.claim),
  text: z.string(),
  epistemic_tag: z.string(),
  status: z.string(),
  confidence: z.number(),
  contradicted: z.boolean(),
  grounded: z.boolean(),
  state: recordState("current"),
  state_detail: StateDetail,
  thread_id: uuid(FX.thread).nullable(),
  synthesis_id: uuid(FX.synthesis).nullable(),
  edges_by_type: z.record(z.string(), z.number().int()),
  sources: z.array(ClaimSourceEdge),
  // research-workbench P3b (the claims ledger)
  verdict: z.string().nullable().openapi({
    example: "supports",
    description: "the entailment verdict (D10) on the line the claim was filed from - an entailment_verdicts key, read from " +
      "the latest research job that filed THIS claim id (its curator's filed[] list); null = not judged (filed before P3a, " +
      "on no judged line, or its text edited since)",
  }),
  corroborations: z.number().int().openapi({
    description: "independent further sources that state or corroborate it (claim_confidence's count: distinct " +
      "non-suppressed sources with a states / corroborates edge, minus one)",
  }),
  contradicted_by_newer: z.boolean().openapi({
    description: "a claim or source created after this claim contradicts it",
  }),
}).openapi("Claim");

export const Claims = z.object({
  count: z.number().int(),
  claims: z.array(Claim),
}).openapi("Claims");

export const SearchHit = z.object({
  kind: registryValue(REGISTRY.nodeKinds, "page"),
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  state: recordState("current"),
  lifecycle: registryValue(REGISTRY.sourceStates, "active").nullable(),
  page_class: registryValue(REGISTRY.pageClasses, "entity").nullable(),
}).openapi("SearchHit");

export const Search = z.object({
  query: z.string(),
  kinds: z.array(registryValue(REGISTRY.nodeKinds, "page")),
  scope: z.object({ refinery_id: uuid(FX.idea).nullable() }),
  count: z.number().int(),
  results: z.array(SearchHit),
}).openapi("Search");

export const TimelineEvent = z.object({
  at: Iso,
  kind: registryValue(REGISTRY.timelineEventKinds, "source_revision"),
  ref: z.string(),
  summary: z.string(),
  // research-workbench P8a-1: the source an event is about, and its lifecycle state NOW (D5)
  source_id: uuid().nullable().openapi({ description: "the source a source_revision or trail event is about; null otherwise" }),
  lifecycle: registryValue(REGISTRY.sourceStates, "active").nullable().openapi({
    description: "that source's lifecycle state now (erased when only its tombstone is left); null when the event is about no source",
  }),
}).openapi("TimelineEvent");

export const Timeline = z.object({
  from: Iso.nullable(),
  to: Iso.nullable(),
  events: z.array(TimelineEvent),
}).openapi("Timeline");

export const TrailEntry = z.object({
  kind: registryValue(REGISTRY.trailEventKinds, "suppressed"),
  source_id: uuid(FX.sourceSuppressed),
  tombstone_id: uuid(FX.tombstoneAutomation).nullable(),
  state: recordState("suppressed"),
  reason: z.string().nullable(),
  context: Json,
  at: Iso,
  counts_as_evidence: z.boolean().openapi({ description: "always false: nothing on the trail is evidence" }),
  // research-workbench P8a-1 (D5): the source's lifecycle state NOW, so the trail panel shows its status
  lifecycle: registryValue(REGISTRY.sourceStates, "suppressed").openapi({
    description: "the entry's source's lifecycle state now (erased when only its tombstone is left)",
  }),
}).openapi("TrailEntry");

// research-workbench P8a-1: what the pre-ingestion stage recorded about a hit, from both of its records -
// P3a's admission trail (origin "admission": the leads and the found_via paths they opened) and P4a's
// per-source events of a research session (origin "session"). Shared research, but an entry of another
// user's research tree is withheld, as the research flow withholds it (07-MULTI-USER).
export const LeadTrailEntry = z.object({
  id: z.string().openapi({ description: "the admission trail entry id (a session event carries the same id in its trail)" }),
  origin: z.string().openapi({ example: "admission", description: "admission (P3a research_admission_trail) or session (P4a research_job_events)" }),
  stage: registryValue(REGISTRY.admissionTrailKinds, "lead"),
  url: z.string(),
  source_id: uuid().nullable().openapi({ description: "the source the hit is (or became), when there is one" }),
  lifecycle: registryValue(REGISTRY.sourceStates, "active").nullable().openapi({
    description: "that source's lifecycle state now (erased when only its tombstone is left); null when no source",
  }),
  found_via: z.string().nullable().openapi({ description: "the lead's trail id (or a held source id) this hit was reached through" }),
  path: z.array(Json).openapi({ description: "the found_via path P3a recorded (empty when none)" }),
  score: z.number().nullable(),
  floor: z.number().nullable(),
  family: z.string().nullable(),
  reasons: z.array(z.string()),
  job_id: uuid(FX.job).nullable(),
  at: Iso,
  counts_as_evidence: z.boolean().openapi({ description: "always false: nothing on the trail is evidence" }),
}).openapi("LeadTrailEntry");

export const Trail = z.object({
  entries: z.array(TrailEntry),
  leads: z.array(LeadTrailEntry).openapi({
    description: "P8a-1: the admission trail's lead entries and found_via paths (origin admission) and the research " +
      "sessions' per-source trail events (origin session), newest first; empty under a metadata filter",
  }),
}).openapi("Trail");

// research-workbench P8a-1 (D5): the lifecycle state of a batch of sources, so every panel that lists a
// source shows its suppression status. Shared knowledge only: a sources row or a tombstone. A held source
// (per refinery) and an unknown id or URL are simply absent - never a hint that something exists.
export const SourceStatesRequest = z.object({
  ids: z.array(z.string()).max(200).optional(),
  urls: z.array(z.string()).max(200).optional(),
}).openapi("SourceStatesRequest");

export const SourceStateRow = z.object({
  id: uuid(FX.sourceSuppressed),
  url: z.string().nullable(),
  lifecycle: registryValue(REGISTRY.sourceStates, "suppressed"),
  tombstone_id: uuid().nullable(),
}).openapi("SourceStateRow");

export const SourceStates = z.object({
  by_id: z.record(z.string(), SourceStateRow),
  by_url: z.record(z.string(), SourceStateRow),
}).openapi("SourceStates");
