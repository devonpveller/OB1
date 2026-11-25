// rwr-own-thoughts-search-api: the caller's OWN saved thoughts, text search - through ONE owner-scoped database function,
// owner_private_thoughts_search (slot 530, SECURITY DEFINER, executable by ob_workbench alone), never a table. Thoughts the
// person saved with exposure 'personal' are invisible to the workbench's table grant (row-level policy); the function reads
// both planes and filters `user_id = <subject>` on the thought's own owner column. The subject is the one the identity
// seam resolved - the route passes nothing else - and the function answers nothing for an unusable one.
// A missing function (42883: slot 530 not applied) or a role that may not run it (42501: the workbench still logs in as
// ob_app_memory) reads as nothing: fail closed, the same empty answer as a person with no thoughts.
// No embedding is asked for: text search needs none, so no query text leaves the process and no model key is involved.
import type { Db } from "../db.ts";

export interface OwnThoughtRow {
  thought_id: string;
  title: string;
  snippet_src: string;
  created_at: string | Date;
}

export const MIN_Q = 2;
export const MAX_Q = 200;
export const MAX_LIMIT = 50;

export async function searchOwn(db: Db, sub: string, q: string, limit: number): Promise<OwnThoughtRow[]> {
  try {
    return await db.query<OwnThoughtRow>(
      `SELECT thought_id::text AS thought_id, title, snippet_src, created_at
         FROM public.owner_private_thoughts_search($1, $2, $3)`,
      [sub, q, limit],
    );
  } catch (e) {
    const code = (e as { fields?: { code?: string } }).fields?.code;
    if (code === "42883" || code === "42501") return [];
    throw e;
  }
}
