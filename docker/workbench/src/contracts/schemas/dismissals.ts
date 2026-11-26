// Cleanup "Not again for this" (research-workbench redesign, rwr-cleanup): a person tells Cleanup not to show them a
// reopen candidate or a suggestion again. Per user: whose dismissal it is comes from the identity seam, no request
// body has a user field and an unknown field is refused (strict schemas). What can be dismissed is the
// dismissal_kinds registry, never a closed list here. A dismissal hides the thing for that person only.
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, uuid } from "./common.ts";

const ID = "d15a0000-0000-4000-8000-000000000001";
// a C0 control character or DEL is refused: a NUL would otherwise reach Postgres (22021)
const CLEAN = (s: string) => !/[\u0000-\u001F\u007F]/.test(s);

export const Dismissal = z.object({
  id: uuid(ID, "dismissal id"),
  kind: registryValue(REGISTRY.dismissalKinds, "reopen_candidate"),
  ref: z.string().min(1).max(200).openapi({ example: "22222222-2222-4222-8222-222222222222", description: "the tombstone id (a reopen candidate) or the scan's key (a suggestion)" }),
  created_at: Iso,
}).openapi("Dismissal");

export const Dismissals = z.object({
  dismissals: z.array(Dismissal),
  total: z.number().int().openapi({ description: "the caller's own dismissals, not only this page" }),
}).openapi("Dismissals");

export const DismissalCreate = z.object({
  kind: registryValue(REGISTRY.dismissalKinds, "reopen_candidate"),
  ref: z.string().min(1).max(200).refine(CLEAN, { message: "must not contain control characters" }).openapi({ example: "22222222-2222-4222-8222-222222222222" }),
}).strict().openapi("DismissalCreate");

export const DismissalRemoved = z.object({ id: uuid(ID, "the dismissal that was taken back") }).openapi("DismissalRemoved");

const T = "2026-10-17T12:00:00.000Z";
export const DSX = {
  dismissal: { id: ID, kind: "reopen_candidate", ref: "22222222-2222-4222-8222-222222222222", created_at: T },
  dismissals: { dismissals: [] as unknown[], total: 1 },
  create: { kind: "reopen_candidate", ref: "22222222-2222-4222-8222-222222222222" },
  removed: { id: ID },
};
DSX.dismissals.dismissals.push(DSX.dismissal);
