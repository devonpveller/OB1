// The app's last-resort error answer (rw-identity-harden, review r-identity2/3 F-h): an error no route
// answered itself is logged here and answered without its text - no request URL, no exception message,
// no stack ever reaches a caller (as the contract API's fail() already does).
import type { Context } from "hono";

export function internalError(err: unknown, c: Context): Response {
  console.error("[workbench] error:", (err as Error)?.message || err);
  return c.json({ error: "internal" }, 500);
}
