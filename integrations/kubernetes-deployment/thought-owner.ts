// thought-owner.ts - whose thoughts this server reads and writes (research-workbench rw-inlet-owner, plan 08 PD1, slot 410;
// the subject made per request by rw-mcp-identity).
// Slot 410 gives every personal thought an owner (thoughts.user_id). A thought read answers the shared rows (no owner)
// plus the reader's own. THE ONE PLACE the subject is decided for every thought read and owner stamp: thoughtReader()
// returns the request's subject from mcp-identity.ts (the full lane = the operator, WORKSPACE_DEFAULT_SUB; the owui lane =
// the verified token's sub; no identity = null). With null, the clause below reads shared rows only (user_id = NULL is
// never true). Outside a request it throws: there is no default subject. index.ts names no subject anywhere else (a
// source check in thought-owner.test.ts).
import { currentCaller, writerSubject } from "./mcp-identity.ts";

export function thoughtReader(): string | null {
  return currentCaller().subject;
}

/** The subject a write (a capture, an idea, an agent memory) is stamped with; throws the refusal with no identity. */
export function thoughtWriter(): string {
  return writerSubject();
}

/** The owner clause for `FROM thoughts`, against the SQL parameter `param` holding the reader's subject (or NULL). */
export function thoughtOwnerSql(param: string, alias = ""): string {
  const c = alias ? `${alias}.user_id` : "user_id";
  return `(${c} IS NULL OR ${c} = ${param})`;
}
