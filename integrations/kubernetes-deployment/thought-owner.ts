// thought-owner.ts - whose thoughts this server reads (research-workbench rw-inlet-owner, plan 08 PD1, slot 410).
// Slot 410 gives every personal thought an owner (thoughts.user_id). A thought read answers the shared rows (no owner)
// plus the reader's own. This server's lanes have one subject: the operator's (WORKSPACE_DEFAULT_SUB, blank =
// "operator", the identity seam's placeholder - the same rule as idea-tools.ts), so on today's single-user stack it reads
// what it read before. A lane that one day carries another user reads shared rows plus theirs, never the operator's.
// THE ONE PLACE the lane's subject is decided for every thought read (index.ts calls only thoughtReader(); a source check
// in thought-owner.test.ts refuses a read without the clause). rw-mcp-identity replaces this function's body with the
// request's per-user subject; nothing else in index.ts names a subject for a thought read.
import { ideaOwner } from "./idea-tools.ts";

export function thoughtReader(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  return ideaOwner(get);
}

/** The owner clause for `FROM thoughts`, against the SQL parameter `param` holding the reader's subject. */
export function thoughtOwnerSql(param: string, alias = ""): string {
  const c = alias ? `${alias}.user_id` : "user_id";
  return `(${c} IS NULL OR ${c} = ${param})`;
}
