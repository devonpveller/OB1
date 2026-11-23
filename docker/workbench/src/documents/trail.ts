// The removal trail of user documents (rwr-docs-lifecycle-api): one line per document removed for good, and (rwr-trail-grants-exact)
// one per document put back (restored from the trash, unarchived).
// Per owner (slot 510, user_document_trail): the line names the document by id and path, never its
// text or title; it is read only through the identity seam, for the caller's own subject.
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";

export type TrailKind = "delete_forever" | "empty_trash" | "nightly_expired" | "restored" | "unarchived";
export const NIGHTLY_ACTOR = "system:nightly";

export interface TrailLine {
  id: string;
  kind: TrailKind;
  path: string;
  actor_sub: string;
  trashed_at: string | null;
  created_at: string;
}

export interface TrailInput {
  owner_sub: string;
  actor_sub: string;
  kind: TrailKind;
  document_id: string | null;
  path: string;
  trashed_at: Date | null;
}

// Writes the line and returns its id. It is written only after the file is really gone (removeTrashed).
export async function writeTrail(db: Db, t: TrailInput): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, document_id, path, trashed_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [t.owner_sub, t.actor_sub, t.kind, t.document_id, t.path, t.trashed_at],
  );
  return r[0].id;
}

// The caller's own lines, newest first. The owner filter is the identity seam's subject, in the query.
export async function readTrail(db: Db, who: Identity, limit = 100): Promise<{ lines: TrailLine[]; total: number }> {
  const n = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
  const lines = await db.query<TrailLine>(
    `SELECT id::text AS id, kind, path, actor_sub, trashed_at::text AS trashed_at, created_at::text AS created_at
       FROM public.user_document_trail WHERE owner_sub = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [who.sub, n],
  );
  const total = Number((await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.user_document_trail WHERE owner_sub = $1`, [who.sub],
  ))[0]?.n ?? 0);
  return { lines, total };
}
