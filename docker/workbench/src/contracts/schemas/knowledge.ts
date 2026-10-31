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
    description: "the entailment verdict (D10) on the cited line the claim was filed from - an entailment_verdicts key, " +
      "read from the job that filed the claim's synthesis; null = not judged (filed before P3a, or on no judged line)",
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
}).openapi("TrailEntry");

export const Trail = z.object({
  entries: z.array(TrailEntry),
}).openapi("Trail");
