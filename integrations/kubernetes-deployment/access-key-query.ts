// rw-mcp-identity round 5 (PD2's integration round): which `?key=` is an ACCESS key.
//
// The identity middleware (index.ts) hands `?key=` to resolveCaller, which refuses a request whose header key differs
// from it (round 2: "two different access keys"). That is right where `?key=` IS an access key: the MCP transport (the
// catch-all) and POST /research/persist, which both accept the access key as `?key=` today. It is wrong where the route
// owns a `key` parameter of its own:
//   GET /research/lookup?key=<research_key> - `key` is the research key being looked up, never an access key.
// There `?key=` is not offered to resolveCaller, so the access key must come in a header (x-brain-key / x-access-key),
// and the header rules (one key, no user header, the lane's token rules) apply unchanged.
//
// The match is exact (method and path). Any other spelling falls through to the default: `?key=` IS an access key,
// so the round-2 rule still refuses two different keys there.

/** Routes whose own `key` query parameter is not an access key: "METHOD /path". */
export const KEY_PARAM_NOT_ACCESS_KEY: ReadonlySet<string> = new Set(["GET /research/lookup"]);

/** The `?key=` value to offer resolveCaller as an access key, or null when this route's `key` is its own parameter. */
export function accessKeyFromQuery(method: string, path: string, params: URLSearchParams): string | null {
  if (KEY_PARAM_NOT_ACCESS_KEY.has(`${method.toUpperCase()} ${path}`)) return null;
  return params.get("key");
}
