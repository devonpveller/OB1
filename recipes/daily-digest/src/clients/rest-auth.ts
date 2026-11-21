/**
 * rw-rest-door-auth: the REST door (openbrain-rest -> PostgREST) refuses a request that does not carry this
 * service's own token - a JWT minted per caller (OB1/docker/rest-door/mint-rest-tokens.ps1) whose role holds only
 * what the caller uses; for the digest and the podcast its `sub` is the run owner (WORKSPACE_DEFAULT_SUB), so a
 * setting is read for the owner the token names, never for an owner the request names. OPEN_BRAIN_REST_TOKEN;
 * blank = no header = 401 at the door.
 */
export function restAuthHeaders(): Record<string, string> {
  let t = "";
  try { t = (Deno.env.get("OPEN_BRAIN_REST_TOKEN") ?? "").trim(); } catch { t = ""; }
  return t ? { Authorization: `Bearer ${t}` } : {};
}
