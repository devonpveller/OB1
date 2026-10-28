// The identity seam (rw-p2b-workspace, operator 2026-10-28). ONE place resolves who the request's
// user is - a stable subject id and a display name - and nothing else in the P2b code reads auth.
// Every piece of user front-end state (user documents, their listing and refinery pick-ups, what a
// user has read in the bell, the workspace's layout and UI preferences) is written with that
// subject as owner_sub and read filtered by it; the knowledge database (what research produces)
// carries no owner and is the same for everyone.
//
// Until single sign-on lands (a separate item: Authentik at the edge) the seam returns ONE configured
// default identity: WORKSPACE_DEFAULT_SUB / WORKSPACE_DEFAULT_NAME. WORKSPACE_DEFAULT_SUB is
// OPERATOR-SET (operator 2026-10-28): the Authentik subject of the one user every existing private
// context row belongs to, read from Open WebUI's user record (its oauth JSON, oidc.sub) - never
// written into code or docs; init-documents.sql back-fills owner_sub from the same value. Blank (a
// fresh install, the lab) falls back to the placeholder "operator" / "Operator".
// WORKSPACE_IDENTITY_HEADER (shipped BLANK = off) names a request header the seam takes the subject
// from instead - the extension point the sign-on item fills (with the edge stripping any client copy
// of it); the lab tests set it to prove two identities see only their own state.
import type { Context, Next } from "hono";

// TWO subjects (operator 2026-10-28): `sub` is subject_sub - whose data is shown and written (every
// read of user state filters by it); `actor` is actor_sub - who is acting. They are equal until admin
// impersonation lands (rw-identity: an admin views a user's UI as that user after giving a reason, the
// switch logged, every admin action in an append-only admin_audit log); every per-user write records
// both already, so that item needs no schema change.
export interface Identity {
  sub: string; // subject_sub: the Authentik subject id whose data this is - what owner_sub stores
  actor: string; // actor_sub: who acted - what actor_sub stores
  name: string; // display name
  key: string; // a filesystem-safe form of sub: the user's directory in the documents tree
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// The directory key of a subject: the subject itself when it is a safe name, else a hash of it.
export async function ownerKey(sub: string): Promise<string> {
  return SAFE.test(sub) && sub !== "." && sub !== ".." ? sub : `h-${(await sha256Hex(sub)).slice(0, 32)}`;
}

export interface IdentityConfig {
  defaultSub: string;
  defaultName: string;
  header: string; // "" = off
  nameHeader: string;
}

export function identityConfig(env = (k: string) => Deno.env.get(k)): IdentityConfig {
  return {
    defaultSub: (env("WORKSPACE_DEFAULT_SUB") ?? "").trim() || "operator",
    defaultName: (env("WORKSPACE_DEFAULT_NAME") ?? "").trim() || "Operator",
    header: (env("WORKSPACE_IDENTITY_HEADER") ?? "").trim(),
    nameHeader: (env("WORKSPACE_IDENTITY_NAME_HEADER") ?? "").trim(),
  };
}

export async function resolveIdentity(header: (name: string) => string | undefined, cfg: IdentityConfig): Promise<Identity> {
  const fromHeader = cfg.header ? (header(cfg.header) ?? "").trim().slice(0, 256) : "";
  const sub = fromHeader || cfg.defaultSub;
  const name = (fromHeader && cfg.nameHeader ? (header(cfg.nameHeader) ?? "").trim().slice(0, 256) : "") ||
    (fromHeader ? sub : cfg.defaultName);
  return { sub, actor: sub, name, key: await ownerKey(sub) };
}

const KEY = "identity";

export function identitySeam(cfg: IdentityConfig = identityConfig()) {
  return async (c: Context, next: Next) => {
    c.set(KEY as never, await resolveIdentity((n) => c.req.header(n), cfg) as never);
    await next();
  };
}

// The request's identity, as the seam resolved it. A route that runs without the seam (a test that
// mounts a router alone) gets the default identity.
export async function identityOf(c: Context): Promise<Identity> {
  const got = c.get(KEY as never) as Identity | undefined;
  return got ?? await resolveIdentity(() => undefined, identityConfig());
}
