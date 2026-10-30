// Auth (G7): the browser's door (the viewer's /workbench forwarder, or an edge proxy) INJECTS the
// shared secret as `X-Brain-Key` when it forwards to us - the secret never reaches client JS. The
// service is never host-published except an optional 127.0.0.1 debug port, so a missing/incorrect
// header = reject. rw-identity: the accepted keys are the key ring's (src/identity/keys.ts) - the
// door key (WORKSPACE_DOOR_KEY, when set), WORKBENCH_KEY and any WORKSPACE_SERVICE_KEYS key; WHICH
// one it is decides the identity (src/middleware/identity.ts), never this gate.
import type { Context, Next } from "hono";
import { keyKind, type KeyRing } from "../identity/keys.ts";

export function requireKey(ring: KeyRing) {
  return async (c: Context, next: Next) => {
    const key = c.req.header("X-Brain-Key") || "";
    if (!ring.internal && !ring.door) return c.json({ error: "unauthorized" }, 401);
    if (!keyKind(key, ring, true)) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}
