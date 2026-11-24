// A person's own inlet connections (rwr-imports-server-api): ONE read, through slot 600's inlet_connections_of(sub).
// The subject is the identity seam's (who.sub); the function answers rows owned by that subject and nothing for any other
// or any unusable one. This file never names the table: the table is readable by no app role (slot 470).
import type { Db } from "../db.ts";
import type { Identity } from "../../middleware/identity.ts";

export interface InletConnectionRow {
  kind: string;
  created_at: string;
  updated_at: string;
}

export async function connectionsOf(db: Db, who: Identity): Promise<InletConnectionRow[]> {
  const rows = await db.query<{ kind: string; created_at: unknown; updated_at: unknown }>(
    `SELECT kind, created_at, updated_at FROM public.inlet_connections_of($1)`, [who.sub]);
  // the driver hands timestamps back as Date objects
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return rows.map((r) => ({ kind: String(r.kind), created_at: iso(r.created_at), updated_at: iso(r.updated_at) }));
}
