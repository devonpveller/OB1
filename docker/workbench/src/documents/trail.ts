// The removal trail of user documents (rwr-docs-lifecycle-api): one line per document removed for good, and (rwr-trail-grants-exact)
// one per document put back (restored from the trash, unarchived), and (rw-idea-reopen-trail, slot 690) one per idea reopened.
// Per owner (slot 510, user_document_trail): the line names the document by id and path, never its
// text or title; it is read only through the identity seam, for the caller's own subject.
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";

export type TrailKind = "delete_forever" | "empty_trash" | "nightly_expired" | "restored" | "unarchived" | "reopened";
export const NIGHTLY_ACTOR = "system:nightly";

export interface TrailLine {
  id: string;
  kind: TrailKind;
  path: string | null; // null for a 'reopened' line: it names the idea, never a document
  idea_id: string | null; // the idea of a 'reopened' line; null for every other kind
  actor_sub: string;
  trashed_at: string | null;
  created_at: string;
}

export interface TrailInput {
  owner_sub: string;
  actor_sub: string;
  kind: TrailKind;
  document_id: string | null;
  path: string; // a removal / put-back line always names a vault path (a reopened line goes through writeReopened)
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

// rw-idea-reopen-trail: the line of an idea reopened from the archive (slot 690). Owner = the idea's owner, actor = the
// caller, subject = the idea id; no path, no document, no idea text (the table's shape CHECK refuses a reopen line that
// carries one). Pass the transaction handle so the line commits with the reopen.
export async function writeReopened(db: Db, owner_sub: string, actor_sub: string, idea_id: string): Promise<void> {
  await db.query(
    `INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id) VALUES ($1, $2, 'reopened', $3::uuid)`,
    [owner_sub, actor_sub, idea_id],
  );
}

// The caller's own lines, newest first. The owner filter is the identity seam's subject, in the query.
export async function readTrail(db: Db, who: Identity, limit = 100): Promise<{ lines: TrailLine[]; total: number }> {
  const n = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
  const lines = await db.query<TrailLine>(
    `SELECT id::text AS id, kind, path, idea_id::text AS idea_id, actor_sub, trashed_at::text AS trashed_at, created_at::text AS created_at
       FROM public.user_document_trail WHERE owner_sub = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [who.sub, n],
  );
  const total = Number((await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.user_document_trail WHERE owner_sub = $1`, [who.sub],
  ))[0]?.n ?? 0);
  return { lines, total };
}
