/**
 * inlet-owner.ts - whose rows this inlet writes (research-workbench rw-inlet-stamp, plan 08 PD2, slot 470).
 *
 * The owner of what an inlet brings in comes from the inlet's OWN owner record, never from a constant or an owner
 * variable: the database's `inlet_connections` row for the connection this container serves (INLET_CONNECTION, an id
 * such as `gmail` that names a connection, never a person), read through `rpc/inlet_connection_owner`. Until per-user
 * connections (PD4) that row is the operator's subject; PD4 adds one row per user and passes each connection's id - the
 * writers do not change.
 *
 * No connection, no recorded owner, or an owner that is not a valid subject = InletOwnerError, BEFORE the writer fetches
 * or writes anything. The database refuses an unowned personal row anyway (slot 470's guard); this makes the writer stop
 * first and say why. The subject is never logged.
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

/** The connection this container serves (INLET_CONNECTION), or an error. */
export function inletConnection(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  const c = (get("INLET_CONNECTION") ?? "").trim();
  if (!c) throw new InletOwnerError("INLET_CONNECTION is not set (the inlet connection this container serves, e.g. gmail)");
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(c)) throw new InletOwnerError("INLET_CONNECTION is not a connection id");
  return c;
}

/**
 * The owner of `connection`, from the database's record (PostgREST `rpc/inlet_connection_owner`).
 * `restBase` is the PostgREST base the caller already uses (e.g. `${SUPABASE_URL}/rest/v1`); `headers` its own.
 */
export async function inletOwner(
  restBase: string,
  connection: string,
  headers: Record<string, string> = {},
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(`${restBase.replace(/\/+$/, "")}/rpc/inlet_connection_owner`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ p_id: connection }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new InletOwnerError(`the owner record could not be read (${(e as Error).message})`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new InletOwnerError(`no owner is recorded for inlet connection '${connection}' (HTTP ${res.status})`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    v = undefined;
  }
  if (!subjectOk(v)) throw new InletOwnerError(`the owner recorded for inlet connection '${connection}' is not a valid subject`);
  return v;
}
