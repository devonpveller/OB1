// The reference record (research-workbench P2a): a source pointer, anchor selectors, provenance,
// the pinned revision and chunk, and a state - held ONCE in reference_records; notes and user
// documents hold its id (reference_holders), never a copy.
//
// The contract's three rules hold here (common.ts): no enum/literal/union - scopes, provenances,
// states, selector kinds, holder kinds, origins and anchor outcomes are registry values; every
// record carries its state; ids are uuids.
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, Json, recordState, StateDetail, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

// W3C Web Annotation TextQuoteSelector: the exact text, with the text around it so the anchor
// survives a repeated phrase. `exact` must not be empty - a reference without a quote is refused.
const QuoteShape = z.object({
  exact: z.string().min(1).openapi({ example: "Alpha fixture text about contract retrieval." }),
  prefix: z.string().openapi({ example: "" }),
  suffix: z.string().openapi({ example: " Beta sentence two." }),
});
export const QuoteSelector = QuoteShape.openapi("QuoteSelector");

// TextPositionSelector: character offsets of `exact` in the PINNED revision's text.
const PositionShape = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  field: z.string().optional().openapi({
    description: "the source field the offsets index; absent = the pinned revision's content " +
      "(a whole-source anchor on a source with no text indexes its title)",
  }),
}).refine((p) => p.end >= p.start, { message: "position.end must not precede position.start" });
export const PositionSelector = PositionShape.openapi("PositionSelector");

// PDF: the page and the quads covering the quoted span, page-normalised (0..1), 8 numbers each.
const PdfShape = z.object({
  page: z.number().int().min(1),
  quads: z.array(z.array(z.number()).length(8)).min(1),
});
export const PdfSelector = PdfShape.openapi("PdfSelector");

// quote and position are required for every reference; pdf is required for the content types
// the reference_selector_kinds registry names (the database trigger enforces that rule, so no
// writer can bypass it). A selector kind added to the registry is accepted here as an extra key
// and validated by the trigger against its registry definition.
const SelectorsShape = z.object({
  quote: QuoteShape,
  position: PositionShape,
  pdf: PdfShape.optional(),
}).catchall(Json).openapi({
  description: "Anchor selectors, keyed by reference_selector_kinds: quote (required), position " +
    "(required), pdf (required for the content types its registry entry names), plus any registered kind.",
});
export const Selectors = SelectorsShape;

export const ReferenceRecordShape = z.object({
  id: uuid(FX.referenceSpan, "reference id"),
  source_id: uuid(FX.refSource, "the source pointer (a source or a held source)"),
  scope: registryValue(REGISTRY.referenceScopes, "span"),
  provenance: registryValue(REGISTRY.referenceProvenances, "user"),
  pinned_revision: z.number().int().min(1).openapi({
    description: "the revision of the source the reference was placed on; it never moves (a held source is always 1)",
  }),
  chunk_idx: z.number().int().nullable().openapi({ description: "the chunk of the pinned revision the quote sits in" }),
  state: registryValue(REGISTRY.referenceStates, "pinned"),
  selectors: SelectorsShape,
  created_by: z.string().nullable(),
  created_at: Iso,
});
export const ReferenceRecord = ReferenceRecordShape.openapi("ReferenceRecord");

const HolderShape = z.object({
  kind: registryValue(REGISTRY.referenceHolderKinds, "legacy_note"),
  ref: z.string().min(1).openapi({ example: FX.refNotePath, description: "the vault path of the note or document" }),
});
export const Holder = HolderShape.openapi("Holder");

export const ReferenceCreateRequest = z.object({
  source_id: uuid(FX.refSource),
  selectors: SelectorsShape,
  provenance: registryValue(REGISTRY.referenceProvenances, "user"),
  scope: registryValue(REGISTRY.referenceScopes, "span").optional(),
  chunk_idx: z.number().int().min(0).optional().openapi({
    description: "omit to locate the quote among the pinned revision's chunks",
  }),
  holder: HolderShape.extend({
    origin: registryValue(REGISTRY.referenceOrigins, "added").optional(),
  }).optional().openapi({ description: "attach the new reference to a note or user document" }),
  by: z.string().optional(),
}).openapi("ReferenceCreateRequest");

// One held reference, BODY-LESS: ids, pin and order only, so a holder's list can be read (and a
// document opened) without fetching any source text; the selectors come with reference(id).
const HeldReferenceShape = z.object({
  seq: z.number().int(),
  number: z.number().int().nullable().openapi({ description: "the citation number on export (null: not numbered)" }),
  origin: registryValue(REGISTRY.referenceOrigins, "cited"),
  cited_ref: z.string().openapi({ description: "the id as the holder writes it" }),
  reference_id: uuid(FX.referenceSpan).nullable().openapi({
    description: "null: the cited id resolves to no source (kept only so the numbering stays whole)",
  }),
  source_id: uuid().nullable(),
  pinned_revision: z.number().int().nullable(),
  scope: registryValue(REGISTRY.referenceScopes, "source").nullable(),
  provenance: registryValue(REGISTRY.referenceProvenances, "user").nullable(),
});
export const HeldReference = HeldReferenceShape.openapi("HeldReference");

export const ReferenceCreated = z.object({
  record: ReferenceRecord,
  held: HeldReferenceShape.nullable(),
}).openapi("ReferenceCreated");

export const HolderReferences = z.object({
  holder_kind: registryValue(REGISTRY.referenceHolderKinds, "legacy_note"),
  holder_ref: z.string(),
  state: recordState("current"),
  state_detail: StateDetail,
  migrated_at: Iso.nullable(),
  references: z.array(HeldReferenceShape),
}).openapi("HolderReferences");
