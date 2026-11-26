// The document's "to place" queue (research-workbench redesign, rwr-doc-toplace-api): a cite a person gathered for a
// document and has not placed yet. Whose queue it is comes from the identity seam alone: no request body has a user
// field and an unknown field is refused (strict schemas). A response never carries an owner, an actor or a count of
// anyone else's rows. A kind of form (chip, transclusion) is a value the route checks, never an enum here.
import { z } from "../deps.ts";
import { Iso, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";
import { ReferenceRecord } from "./references.ts";
import { EX } from "./examples.ts";

const PENDING = "9e1d0000-0000-4000-8000-000000000001";
// a C0 control character (bar tab, newline, carriage return) or DEL is refused here: a NUL would otherwise reach Postgres (22021)
const CLEAN = (s: string) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
const CLEAN_MSG = { message: "must not contain control characters" };
const PATH = z.string().min(1).max(1024).refine(CLEAN, CLEAN_MSG);
// the limits count code points, not UTF-16 units (an emoji is one character), so the stored text and the limit agree
const CODEPOINTS = (n: number) => (s: string) => Array.from(s).length <= n;
const SECTION = z.string().refine(CODEPOINTS(200), { message: "at most 200 characters" }).refine(CLEAN, CLEAN_MSG).openapi({ maxLength: 200 });
const QUOTE = z.string().refine(CODEPOINTS(4000), { message: "at most 4000 characters" }).refine(CLEAN, CLEAN_MSG).openapi({ maxLength: 4000 });

export const PendingRef = z.object({
  id: uuid(PENDING, "pending reference id"),
  path: z.string().openapi({ example: FX.documentPath, description: "the document's vault path (the caller's own)" }),
  source_id: uuid(FX.sourceActive, "the cited source").nullable().openapi({ description: "the cited source, or null when a claim is cited" }),
  claim_id: uuid(FX.claim, "the cited claim").nullable().openapi({ description: "the cited claim, or null when a source is cited" }),
  section: SECTION.openapi({ description: "an optional section label ('' when none)" }),
  quote: QUOTE.openapi({ description: "an optional quote the reference will pin ('' when none)" }),
  added_from: z.string().openapi({ example: "source", description: "where the cite was gathered: a short label" }),
  created_at: Iso,
}).openapi("PendingRef");

export const PendingRefs = z.object({
  path: z.string().openapi({ example: FX.documentPath }),
  pending_refs: z.array(PendingRef),
  total: z.number().int().openapi({ description: "the caller's own queue for this document, not only this page" }),
}).openapi("PendingRefs");

export const PendingRefCreate = z.object({
  path: PATH.openapi({ example: FX.documentPath, description: "the document's vault path (full, or relative to the caller's own directory)" }),
  source_id: uuid(FX.sourceActive, "the cited source").optional(),
  claim_id: uuid(FX.claim, "the cited claim").optional(),
  section: SECTION.optional(),
  quote: QUOTE.optional(),
  added_from: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_.:-]{0,63}$/).openapi({
    example: "source", description: "where the cite was gathered: a short lower-case label such as source, search, chat",
  }),
}).strict().openapi("PendingRefCreate");

export const PendingRefPlace = z.object({
  form: z.string().optional().openapi({ example: "chip", description: "chip (default: a citation at the cursor) or transclusion (protected quoted text; needs a quote)" }),
}).strict().openapi("PendingRefPlace");

export const PendingRefPlaced = z.object({
  pending_ref_id: uuid(PENDING, "the queue row that was placed and removed"),
  form: z.string().openapi({ example: "chip" }),
  record: ReferenceRecord,
  insert: z.string().openapi({ description: "the text to put at the cursor" }),
}).openapi("PendingRefPlaced");

export const PendingRefRemoved = z.object({
  removed: uuid(PENDING, "the queue row that was removed"),
}).openapi("PendingRefRemoved");

const T = "2026-10-17T12:00:00.000Z";
const row = {
  id: PENDING, path: FX.documentPath, source_id: FX.sourceActive, claim_id: null, section: "Opening", quote: "",
  added_from: "source", created_at: T,
};
export const PRX = {
  ref: row,
  refs: { path: FX.documentPath, pending_refs: [row], total: 1 },
  create: { path: FX.documentPath, source_id: FX.sourceActive, section: "Opening", added_from: "source" },
  place: { form: "chip" },
  placed: { pending_ref_id: PENDING, form: "chip", record: (EX.referenceCreated as { record: unknown }).record, insert: "[@ref:f2000000-0000-4000-8000-0000000000c1]" },
  removed: { removed: PENDING },
};
