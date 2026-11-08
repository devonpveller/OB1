/**
 * Whose digest this is - THE ONE PLACE the run's owner comes from (rw-boundary-digest made it one function;
 * rw-inlet-stamp, plan 08 PD2, slot 470, replaced its body).
 *
 * The digest and its podcast serve ONE inlet connection: the mailbox the gmail pull reads (INLET_CONNECTION, an id
 * such as `gmail` that names a connection, never a person). The owner is what the database records for that
 * connection (`inlet_connections`, read through `rpc/inlet_connection_owner`) - the operator's subject until PD4 adds a
 * connection per user and the chain runs once per connection. No env owner variable, no literal, no fallback: a
 * missing connection, a missing record or an owner that is not a valid subject is an InletOwnerError, and the run
 * stops before it reads mail, asks for research or writes an episode.
 *
 * That owner owns the private hand-back of every research request the digest makes (POST /research/derived), the
 * daily episode (podcast_episodes.owner_sub, its transcript), the settings the digest and podcast read, and every
 * thought the digest reads is shared or theirs (src/clients/postgrest.ts). The Open Notebook capture (on-capture.ts)
 * is an admin CLI and takes its owner as an explicit --owner (ownerArg below). Nothing else in the recipe names the
 * owner (owner-sub.test.ts).
 */

export class InletOwnerError extends Error {
  constructor(msg: string) {
    super(`inlet owner: ${msg} - nothing was read or written`);
    this.name = "InletOwnerError";
  }
}

/** The same rule as the database's inlet_subject_ok(): a subject's shape, never a service principal, never "operator". */
export function subjectOk(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._@|+=:\/-]{0,254}$/.test(s) &&
    !/^(service|system|anonymous):/i.test(s) && s.toLowerCase() !== "operator";
}

/** The connection this container serves (INLET_CONNECTION). */
export function inletConnection(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  const c = (env("INLET_CONNECTION") ?? "").trim();
  if (!c) throw new InletOwnerError("INLET_CONNECTION is not set (the inlet connection this digest serves, e.g. gmail)");
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(c)) throw new InletOwnerError("INLET_CONNECTION is not a connection id");
  return c;
}

/** The owner of this run's inlet connection, from the database's record. `restBase` = BRAIN_REST_URL (the door). */
export async function digestOwner(
  restBase: string,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const connection = inletConnection(env);
  let res: Response;
  try {
    res = await fetchFn(`${restBase.replace(/\/+$/, "")}/rest/v1/rpc/inlet_connection_owner`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_id: connection }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new InletOwnerError(`the owner record could not be read (${(e as Error).message})`);
  }
  const text = await res.text();
  if (!res.ok) throw new InletOwnerError(`no owner is recorded for inlet connection '${connection}' (HTTP ${res.status})`);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    v = undefined;
  }
  if (!subjectOk(v)) throw new InletOwnerError(`the owner recorded for inlet connection '${connection}' is not a valid subject`);
  return v;
}

/** A resolver for long-lived services: asks the record until it answers, then keeps the answer. */
export function digestOwnerResolver(
  restBase: string,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
  fetchFn: typeof fetch = fetch,
): () => Promise<string> {
  let known: string | null = null;
  return async () => {
    if (known) return known;
    known = await digestOwner(restBase, env, fetchFn);
    return known;
  };
}

/** An admin CLI's explicit owner (--owner=<subject>), or an error. */
export function ownerArg(args: string[] = Deno.args): string {
  const v = args.find((a) => a.startsWith("--owner="))?.slice("--owner=".length);
  if (v === undefined) throw new InletOwnerError("--owner=<subject> is required (the subject these rows belong to)");
  if (!subjectOk(v)) throw new InletOwnerError("--owner is not a valid subject (blank, a service: principal, or the literal operator)");
  return v;
}
