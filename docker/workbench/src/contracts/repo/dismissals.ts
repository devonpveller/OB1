// Cleanup "Not again for this" (research-workbench redesign, rwr-cleanup): the reads and writes over
// public.cleanup_dismissals (init-cleanup-dismissals.sql, slot 710).
//
// Per user (07-MULTI-USER): owner_sub is the identity seam's subject_sub; EVERY statement here filters or writes by
// it, so no other person's dismissal is ever selected, counted or deleted. The ref is not checked against any shared
// table, so a dismissal is never an existence oracle for a source or a marker; deleting another person's row finds
// nothing, the same answer as a missing row. Nothing here touches a shared table.
import type { Db } from "../db.ts";
import { type RegistryReader, requireRegistered, REGISTRY } from "../registry.ts";
import type { Identity } from "../../middleware/identity.ts";

export interface DismissalRow {
  id: string;
  kind: string;
  ref: string;
  created_at: string;
}
const COLS = `id, kind, ref, created_at`;

export async function addDismissal(db: Db, reg: RegistryReader, who: Identity, b: { kind: string; ref: string }): Promise<DismissalRow> {
  await requireRegistered(reg, REGISTRY.dismissalKinds, b.kind);
  // One dismissal per person per thing: dismissing it twice answers the same row. The table is granted SELECT, INSERT and
  // DELETE only (nothing updates a dismissal), so a repeat is DO NOTHING and the existing row is read back.
  // The read-back is a SEPARATE statement: inside the insert's own statement it reads the statement's snapshot, so a row that a
  // concurrent identical insert committed after that snapshot is invisible, the read finds nothing and the route answered 500
  // (found by the tester, 5-7 of 25 parallel POSTs). A new statement sees what is committed. If the row was taken back in the
  // gap between the two statements, the loop inserts again.
  const args = [who.sub, b.kind, b.ref];
  for (let attempt = 0; attempt < 3; attempt++) {
    const ins = await db.query<DismissalRow>(
      `INSERT INTO public.cleanup_dismissals (owner_sub, kind, ref) VALUES ($1, $2, $3)
       ON CONFLICT (owner_sub, kind, ref) DO NOTHING RETURNING ${COLS}`,
      args,
    );
    if (ins[0]) return ins[0];
    const had = await db.query<DismissalRow>(
      `SELECT ${COLS} FROM public.cleanup_dismissals WHERE owner_sub = $1 AND kind = $2 AND ref = $3`,
      args,
    );
    if (had[0]) return had[0];
  }
  throw new Error("dismissal: neither inserted nor found after 3 tries");
}
export async function listDismissals(db: Db, who: Identity, o: { limit: number; kind?: string }) {
  const args: unknown[] = [who.sub];
  let w = "owner_sub = $1";
  if (o.kind) {
    args.push(o.kind);
    w += ` AND kind = $${args.length}`;
  }
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.cleanup_dismissals WHERE ${w}`, args))[0].n;
  args.push(o.limit);
  const rows = await db.query<DismissalRow>(
    `SELECT ${COLS} FROM public.cleanup_dismissals WHERE ${w} ORDER BY created_at DESC, id LIMIT $${args.length}`,
    args,
  );
  return { dismissals: rows, total };
}

// Take a dismissal back: only the person's own; false (not found) for another person's or a missing one.
export async function removeDismissal(db: Db, who: Identity, id: string): Promise<boolean> {
  const r = await db.query<{ id: string }>(`DELETE FROM public.cleanup_dismissals WHERE owner_sub = $1 AND id = $2 RETURNING id`, [who.sub, id]);
  return r.length > 0;
}
