// Auth (G7): the browser is already an authenticated operator (Authelia
// forward_auth on the wiki subdomain), and Caddy INJECTS the shared secret as
// `X-Brain-Key` when it proxies to us — the secret never reaches client JS.
// We trust that header on app-net. The service is never host-published except
// an optional 127.0.0.1 debug port, so a missing/incorrect header = reject.
import type { Context, Next } from "hono";
import { config } from "../config.ts";

export async function requireBrainKey(c: Context, next: Next) {
  const key = c.req.header("X-Brain-Key") || c.req.header("x-brain-key") || "";
  if (!config.workbenchKey || key !== config.workbenchKey) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
