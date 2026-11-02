// The private action record behind every user-attributed D5 write (rw-p8a2-cleanup round 3b; reviewer: the actor
// mask fails open). A shared D5 row - a tombstone's eraser_user / lifted_by / batch_run_id, a trail event's actor,
// a suppression's retracted_by and suppression_context.suppressed_by - NEVER holds a signed-in subject: it holds
// `cleanup-action:<id>`, and public.cleanup_actions (350-init-cleanup.sql, per user) maps that id to owner_sub.
// Who acted is then answered per viewer (erased_by_you, may_lift) by looking the private row up for the caller;
// nothing that copies a shared row (another table, a log, an export, an MCP tool) can carry the subject, because
// it is not there.
import type { Db } from "../db.ts";
import type { Identity } from "../../middleware/identity.ts";
import { ACTION_REF } from "../logic/cleanup.ts";

export { ACTION_REF };

export interface ActionRow {
  id: string;
  kind: string;
  reason_type: string | null;
  source_id: string | null;
  tombstone_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
}
export const ACTION_COLS = `id, kind, reason_type, source_id, tombstone_id, detail, created_at, finished_at`;

export interface ActionFields {
  reason_type?: string | null;
  source_id?: string | null;
  tombstone_id?: string | null;
  detail?: Record<string, unknown>;
  finished?: boolean;
}

// The private row of action `id`, owned by the identity seam's subject (owner_sub) and naming who acted (actor_sub).
// Insert it in the SAME transaction as the shared write that carries its ref.
export async function recordAction(db: Db, who: Identity, id: string, kind: string, f: ActionFields = {}): Promise<ActionRow> {
  return (await db.query<ActionRow>(
    `INSERT INTO public.cleanup_actions (id, owner_sub, actor_sub, kind, reason_type, source_id, tombstone_id, detail, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CASE WHEN $9 THEN now() END)
     RETURNING ${ACTION_COLS}`,
    [id, who.sub, who.actor, kind, f.reason_type ?? null, f.source_id ?? null, f.tombstone_id ?? null,
      JSON.stringify(f.detail ?? {}), f.finished !== false],
  ))[0];
}

// SQL: the shared value `refExpr` is a ref whose private row the subject `subExpr` owns.
export const OWNS_REF = (refExpr: string, subExpr: string) =>
  `EXISTS (SELECT 1 FROM public.cleanup_actions own_ca WHERE 'cleanup-action:' || own_ca.id::text = ${refExpr} AND own_ca.owner_sub = ${subExpr})`;

export async function ownsRef(db: Db, ref: string | null | undefined, sub: string): Promise<boolean> {
  if (!ref || !sub) return false;
  const r = await db.query<{ owns: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.cleanup_actions
                     WHERE 'cleanup-action:' || id::text = $1 AND owner_sub = $2) AS owns`,
    [ref, sub],
  );
  return r[0]?.owns === true;
}

// A signed-in caller (the identity seam's user or edge-header identity) is named in a shared row only by a fresh
// action ref; the single-user default and a service keep the route's fallback (no subject of a person is involved).
export function signedIn(who: Identity): boolean {
  return who.kind === "user" || who.kind === "header";
}
