// Which key the request came with (rw-identity). The doors a browser reaches the workbench through
// (the viewer's /workbench forwarder; any edge that injects the key) send the DOOR key; the services
// on the internal network (openbrain-mcp's contract tools, openbrain-wiki) send WORKBENCH_KEY.
//
//   WORKSPACE_DOOR_KEY   blank as shipped = the door sends WORKBENCH_KEY, as before. REQUIRED once
//                        sign-in is configured, and different from WORKBENCH_KEY: then a request with
//                        WORKBENCH_KEY is a service (identity service:internal), never a browser, and
//                        a request with the door key is a browser that must be signed in.
//   WORKSPACE_SERVICE_KEYS  extra named service keys, name=key;name=key (each its own identity,
//                        service:<name>); blank as shipped.
// A browser can never present a service key: the doors drop any key a client sends and inject theirs.

export interface KeyRing {
  door: string; // "" = the door uses WORKBENCH_KEY
  internal: string; // WORKBENCH_KEY
  services: Map<string, string>; // key -> name
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function keyRing(env: (k: string) => string | undefined, signIn: boolean): KeyRing {
  const internal = (env("WORKBENCH_KEY") || env("MCP_ACCESS_KEY") || "").trim(); // as config.workbenchKey
  const door = (env("WORKSPACE_DOOR_KEY") ?? "").trim();
  const services = new Map<string, string>();
  for (const entry of (env("WORKSPACE_SERVICE_KEYS") ?? "").split(/[;\n]/).map((e) => e.trim()).filter(Boolean)) {
    const m = /^([^=]+)=(.+)$/.exec(entry);
    if (!m || !NAME.test(m[1].trim()) || m[2].trim().length < 16) throw new Error("WORKSPACE_SERVICE_KEYS entry is not name=key (key >= 16 chars)");
    const k = m[2].trim();
    if (k === internal || k === door || services.has(k)) throw new Error("WORKSPACE_SERVICE_KEYS: a key is reused");
    services.set(k, m[1].trim());
  }
  if (door && door.length < 16) throw new Error("WORKSPACE_DOOR_KEY must be at least 16 characters");
  if (signIn) {
    if (!door) throw new Error("sign-in (WORKSPACE_OIDC_*) needs WORKSPACE_DOOR_KEY: the key the viewer's forwarder injects for browsers");
    if (door === internal) throw new Error("WORKSPACE_DOOR_KEY must differ from WORKBENCH_KEY");
  }
  return { door, internal, services };
}

export type KeyKind = { kind: "door" } | { kind: "service"; name: string } | null;

// door: a browser's request; service: a named internal caller; null: no valid key.
export function keyKind(key: string, ring: KeyRing, signIn: boolean): KeyKind {
  if (!key) return null;
  if (ring.door && key === ring.door) return { kind: "door" };
  if (ring.internal && key === ring.internal) return signIn ? { kind: "service", name: "internal" } : { kind: "door" };
  const svc = ring.services.get(key);
  return svc ? { kind: "service", name: svc } : null;
}
