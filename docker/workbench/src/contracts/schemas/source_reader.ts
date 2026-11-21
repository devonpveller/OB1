// rwr-source-reader-api: the source reader's read - one source's text in order, with the section each chunk sits
// in and the claims drawn from the source placed in the chunk their words are found in.
//
// What is STORED and what is DERIVED (findings: rwr-source-reader-api.md): the database holds the chunks
// (source_chunks) and a claim's edge to the SOURCE (claim_sources); it holds no section name, no claim-to-chunk
// link and no quote span. `section` is the markdown heading in force at the chunk's start; a claim's chunk and
// `span` are found from the claim's own words (logic/source_reader.ts). A span is present only for a verbatim
// match, and lies inside that chunk's `content`; a claim placed by word overlap has `span: null`; a claim that
// is not found in any chunk is listed in `unplaced_claims` - never dropped, never an error.
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { recordState, StateDetail, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

export const ReaderSpan = z.object({
  start: z.number().int().min(0).openapi({ description: "first character, an index into the chunk's content" }),
  end: z.number().int().min(1).openapi({ description: "one past the last character, an index into the chunk's content" }),
}).openapi("ReaderSpan");

export const ReaderClaim = z.object({
  claim_id: uuid(FX.claim),
  text: z.string(),
  edge_type: registryValue(REGISTRY.claimEdgeTypes, "states", "how this source stands to the claim"),
  epistemic_tag: z.string(),
  status: z.string(),
  span: ReaderSpan.nullable().openapi({ description: "where the claim's own words sit in the chunk; null when it was placed by overlap" }),
  overlap: z.number().min(0).max(1).nullable().openapi({
    description: "the share of the claim's words found in the chunk (1 for a verbatim match); null when not placed",
  }),
}).openapi("ReaderClaim");

export const ReaderChunk = z.object({
  idx: z.number().int().min(0),
  chunk_id: z.string().openapi({ example: `${FX.sourceActive}:0`, description: "<source uuid>:<idx>, the chunk context call's id" }),
  section: z.string().nullable().openapi({ description: "the heading in force at the start of the chunk; null when the text has none" }),
  content: z.string(),
  claims: z.array(ReaderClaim).openapi({ description: "claims drawn from this source whose words are found in this chunk" }),
}).openapi("ReaderChunk");

export const ReaderSection = z.object({
  name: z.string(),
  level: z.number().int().min(1).max(6),
  first_chunk_idx: z.number().int().min(0).nullable().openapi({ description: "the chunk the heading falls in; null when it cannot be found in the stored chunks" }),
}).openapi("ReaderSection");

export const SourceReader = z.object({
  source_id: uuid(FX.sourceActive),
  state: recordState("active"),
  state_detail: StateDetail,
  lifecycle: registryValue(REGISTRY.sourceStates, "active").nullable(),
  revision: z.number().int().min(1).nullable().openapi({ description: "the source's current revision; null for a private source, which keeps none" }),
  private: z.boolean().openapi({ description: "true when this is the caller's own private (inlet) source" }),
  title: z.string(),
  url: z.string().nullable(),
  sections: z.array(ReaderSection),
  chunks: z.array(ReaderChunk).openapi({ description: "in source order; empty when the record is omitted for an evidence-only caller" }),
  unplaced_claims: z.array(ReaderClaim),
}).openapi("SourceReader");

// The example Dredd checks the real answer against: the fixture's active source (contract-test/fixtures.sql).
export const SOURCE_READER_EXAMPLE = {
  source_id: FX.sourceActive, state: "active", state_detail: {}, lifecycle: "active", revision: 2, private: false,
  title: "Active fixture source", url: "https://example.org/active", sections: [],
  chunks: [
    { idx: 0, chunk_id: `${FX.sourceActive}:0`, section: null, content: "Alpha fixture text about contract retrieval.", claims: [] },
    { idx: 1, chunk_id: `${FX.sourceActive}:1`, section: null, content: "Beta sentence two.", claims: [] },
    { idx: 2, chunk_id: `${FX.sourceActive}:2`, section: null, content: "Gamma sentence three.", claims: [] },
  ],
  unplaced_claims: [
    { claim_id: FX.claim, text: "Fixture claim: contracts own record states.", edge_type: "states", epistemic_tag: "sourced", status: "active", span: null, overlap: null },
  ],
};
