// rwr-own-thoughts-search-api: the caller's OWN saved thoughts, text search. Reads public.thoughts, which carries the
// owner in user_id (PD1, slot 440: every personal row is its owner's; the unowned rows are the shared corpus and are
// NOBODY's own). The ONE owner filter is `user_id = $1`, with $1 the subject the identity seam resolved - the route
// passes nothing else, and no other query on this table exists in this file. The workbench's database role (ob_app_memory,
// a member of service_role) is further bounded by the table's own row-level policy (the ops plane), which only narrows.
// No embedding is asked for: text search needs none, so no query text leaves the process and no model key is involved.
import type { Db } from "../db.ts";

export interface OwnThoughtRow {
  id: string;
  content: string;
  created_at: string | Date;
}

export const MIN_Q = 2;
export const MAX_Q = 200;
export const MAX_LIMIT = 50;

// LIKE's own wildcards (and its escape) in the caller's text are literal characters
export const likeEscape = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`);

export function searchOwn(db: Db, sub: string, q: string, limit: number): Promise<OwnThoughtRow[]> {
  return db.query<OwnThoughtRow>(
    `SELECT t.id::text AS id, t.content, t.created_at
       FROM public.thoughts t
      WHERE t.user_id = $1 AND t.user_id <> ''
        AND t.content ILIKE '%' || $2 || '%'
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $3`,
    [sub, likeEscape(q), limit],
  );
}
