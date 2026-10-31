// Which key the request came with (rw-identity). The doors a browser reaches the workbench through
// (the viewer's /workbench forwarder; any edge that injects the key) send the DOOR key; the services
// on the internal network (openbrain-mcp's contract tools, openbrain-wiki) send WORKBENCH_KEY.
//
//   WORKSPACE_DOOR_KEY   blank as shipped = the door sends WORKBENCH_KEY, as before. REQUIRED once
//                        sign-in is configured, and different from WORKBENCH_KEY: then a request with
//                        WORKBENCH_KEY is a service (identity service:internal), never a browser, and
//                        a request with the door key is a browser that must carry Authentik's signed
//                        token (X-authentik-jwt; src/identity/forward_auth.ts).
//   WORKSPACE_SERVICE_KEYS  extra named service keys, name=key;name=key (each its own identity,
//                        service:<name>); blank as shipped.
// A browser can never present a service key: the doors drop any key a client sends and inject theirs.
import { createHash, timingSafeEqual } from "node:crypto";

export interface KeyRing {
  door: string; // "" = the door uses WORKBENCH_KEY
  internal: string; // WORKBENCH_KEY
  services: Map<string, string>; // key -> name
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// rw-identity-harden: the ONE comparison of key material in the workbench - constant time over
// equal-length SHA-256 digests, so neither a key's content nor its length shows in the timing.
const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
export function sameKey(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function keyRing(env: (k: string) => string | undefined, signIn: boolean): KeyRing {
  const internal = (env("WORKBENCH_KEY") || env("MCP_ACCESS_KEY") || "").trim(); // as config.workbenchKey
  const door = (env("WORKSPACE_DOOR_KEY") ?? "").trim();
  const services = new Map<string, string>();
  for (const entry of (env("WORKSPACE_SERVICE_KEYS") ?? "").split(/[;\n]/).map((e) => e.trim()).filter(Boolean)) {
    const m = /^([^=]+)=(.+)$/.exec(entry);
    if (!m || !NAME.test(m[1].trim()) || m[2].trim().length < 16) throw new Error("WORKSPACE_SERVICE_KEYS entry is not name=key (key >= 16 chars)");
    const k = m[2].trim();
    if (sameKey(k, internal) || sameKey(k, door) || [...services.keys()].some((s) => sameKey(s, k))) throw new Error("WORKSPACE_SERVICE_KEYS: a key is reused");
    services.set(k, m[1].trim());
  }
  if (door && door.length < 16) throw new Error("WORKSPACE_DOOR_KEY must be at least 16 characters");
  if (signIn) {
    if (!door) throw new Error("forward-auth sign-in (WORKSPACE_FORWARD_AUTH_*) needs WORKSPACE_DOOR_KEY: the key the viewer's forwarder injects for browsers");
    if (sameKey(door, internal)) throw new Error("WORKSPACE_DOOR_KEY must differ from WORKBENCH_KEY");
  }
  return { door, internal, services };
}

export type KeyKind = { kind: "door" } | { kind: "service"; name: string } | null;

// door: a browser's request; service: a named internal caller; null: no valid key.
export function keyKind(key: string, ring: KeyRing, signIn: boolean): KeyKind {
  if (!key) return null;
  if (ring.door && sameKey(key, ring.door)) return { kind: "door" };
  if (ring.internal && sameKey(key, ring.internal)) return signIn ? { kind: "service", name: "internal" } : { kind: "door" };
  // every service key is compared (no Map lookup by the presented key: a hash is not constant time)
  let svc: string | null = null;
  for (const [k, name] of ring.services) if (sameKey(key, k)) svc = name;
  return svc ? { kind: "service", name: svc } : null;
}
