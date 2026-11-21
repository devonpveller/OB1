// Flag for cleanup (research-workbench redesign, rwr-flags-api): a person flags a source, a claim or a
// reference as wrong, low quality, a duplicate or other, with an optional note and where the flag was made
// from. A flag changes nothing about the flagged item. Every enumerated kind is a registry (flag_reasons,
// flag_item_kinds, flag_from_kinds, flag_states), never a closed list here. No request body has a user field:
// whose flag it is comes from the identity seam, and an unknown field is refused (strict schemas).
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

const FLAG = "f1a90000-0000-4000-8000-000000000001";
const NOTE = z.string().max(2000);

export const FlagFrom = z.object({
  kind: registryValue(REGISTRY.flagFromKinds, "document", "where the flag was made from: a document or a source"),
  ref: z.string().min(1).max(1024).openapi({ example: "documents/lab-user/notes.md", description: "the document's vault path, or the source's id" }),
}).strict().openapi("FlagFrom");

export const Flag = z.object({
  id: uuid(FLAG, "flag id"),
  item_kind: registryValue(REGISTRY.flagItemKinds, "source"),
  item_id: uuid(FX.sourceActive, "the flagged source / claim / reference id"),
  reason: registryValue(REGISTRY.flagReasons, "low_quality"),
  note: NOTE.openapi({ description: "the flagger's own note; shown only to the flagger and to admins, never on a shared surface" }),
  from: FlagFrom.openapi({ description: "the link back to where the flag was made" }),
  state: registryValue(REGISTRY.flagStates, "open"),
  created_at: Iso,
  updated_at: Iso,
  flagged_by: z.string().nullable().openapi({ description: "who flagged it: set ONLY in an admin's all-flags listing, null for everyone else" }),
}).openapi("Flag");

export const Flags = z.object({
  flags: z.array(Flag),
  total: z.number().int().openapi({ description: "the caller's own flags (all flags for an admin asking scope=all), not only this page" }),
}).openapi("Flags");

export const FlagCreate = z.object({
  item_kind: registryValue(REGISTRY.flagItemKinds, "source"),
  item_id: uuid(FX.sourceActive, "the source / claim / reference id"),
  reason: registryValue(REGISTRY.flagReasons, "low_quality"),
  note: NOTE.optional(),
  from: FlagFrom,
}).strict().openapi("FlagCreate");

export const FlagUpdate = z.object({
  reason: registryValue(REGISTRY.flagReasons, "duplicate").optional(),
  note: NOTE.optional(),
  state: registryValue(REGISTRY.flagStates, "withdrawn").optional(),
}).strict().openapi("FlagUpdate");

const T = "2026-10-17T12:00:00.000Z";
export const FLX = {
  flag: {
    id: FLAG, item_kind: "source", item_id: FX.sourceActive, reason: "low_quality", note: "thin and repeated elsewhere",
    from: { kind: "source", ref: FX.sourceActive }, state: "open", created_at: T, updated_at: T, flagged_by: null,
  },
  flags: { flags: [] as unknown[], total: 1 },
  create: { item_kind: "source", item_id: FX.sourceActive, reason: "low_quality", note: "thin and repeated elsewhere", from: { kind: "source", ref: FX.sourceActive } },
  update: { reason: "duplicate", note: "same text as another source" },
};
FLX.flags.flags.push(FLX.flag);
