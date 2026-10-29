// The identity seam (rw-p2b-workspace, operator 2026-10-28). ONE place resolves who the request's
// user is - a stable subject id and a display name - and nothing else in the P2b code reads auth.
// Every piece of user front-end state (user documents, their listing and refinery pick-ups, what a
// user has read in the bell, the workspace's layout and UI preferences) is written with that
// subject as owner_sub and read filtered by it; the knowledge database (what research produces)
// carries no owner and is the same for everyone.
//
// Without sign-in configured (as shipped) the seam returns ONE configured default identity:
// WORKSPACE_DEFAULT_SUB / WORKSPACE_DEFAULT_NAME. WORKSPACE_DEFAULT_SUB is
// OPERATOR-SET (operator 2026-10-28): the Authentik subject of the one user every existing private
// context row belongs to, read from Open WebUI's user record (its oauth JSON, oidc.sub) - never
// written into code or docs; init-documents.sql back-fills owner_sub from the same value. Blank (a
// fresh install, the lab) falls back to the placeholder "operator" / "Operator".
// WORKSPACE_IDENTITY_HEADER (shipped BLANK = off) names a request header the seam takes the subject
// from instead (a forward-auth edge that sets it; the lab tests use it for a second identity).
// DEPLOY RULE (round 2): whenever WORKSPACE_IDENTITY_HEADER is set the edge (Traefik / the Authentik
// outpost) MUST strip any client-sent copy of that header and set it itself - otherwise any client can
// claim any subject. The viewer's /workbench/* forwarder drops it (and its name header) from every
// client request since rw-identity, so the header can only come from a door that sets it itself.
//
// SIGN-IN (rw-identity, 07-MULTI-USER): with WORKSPACE_OIDC_* configured (src/identity/oidc.ts) the
// subject comes from the browser's session alone (src/routes/auth.ts signs it in with Authentik) and
// WORKSPACE_IDENTITY_HEADER is IGNORED - no header can stand in for a sign-in. The key a request came
// with says what it is (src/identity/keys.ts): the door key is a browser (no session = 401, bar the
// sign-in routes); WORKBENCH_KEY or a WORKSPACE_SERVICE_KEYS key is a service on the internal network,
// identity service:<name>, which has no user front end (403 on the documents and workspace routes).
// An admin (WORKSPACE_OIDC_ADMIN_GROUP) may impersonate a user after giving a reason: subject_sub
// becomes that user, actor_sub stays the admin, and every request of the impersonating session is
// written to admin_audit BEFORE it runs (a request that cannot be recorded does not run: 503).
import type { Context, Next } from "hono";
import type { Db } from "../contracts/db.ts";
import { oidcConfig, type OidcConfig } from "../identity/oidc.ts";
import { keyKind, keyRing, type KeyRing } from "../identity/keys.ts";
import { readCookie, SESSION_COOKIE } from "../identity/cookies.ts";
import { audit, sessionOf } from "../identity/store.ts";

// TWO subjects (operator 2026-10-28): `sub` is subject_sub - whose data is shown and written (every
// read of user state filters by it); `actor` is actor_sub - who is acting. They are equal except while
// an admin impersonates a user (rw-identity): then sub is the user and actor the admin.
export interface Identity {
  sub: string; // subject_sub: the Authentik subject id whose data this is - what owner_sub stores
  actor: string; // actor_sub: who acted - what actor_sub stores
  name: string; // display name
  key: string; // a filesystem-safe form of sub: the user's directory in the documents tree
  kind?: "default" | "header" | "user" | "service" | "anonymous";
  admin?: boolean; // the signed-in user is in WORKSPACE_OIDC_ADMIN_GROUP
  actorName?: string;
  impersonating?: { reason: string; since: string } | null;
  session?: string; // the session row's id hash (never the cookie's token)
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
  header: string; // "" = off (and always off while sign-in is configured)
  nameHeader: string;
  signIn?: boolean; // WORKSPACE_OIDC_* configured
}

export function identityConfig(env = (k: string) => Deno.env.get(k)): IdentityConfig {
  const signIn = oidcConfig(env) !== null;
  return {
    defaultSub: (env("WORKSPACE_DEFAULT_SUB") ?? "").trim() || "operator",
    defaultName: (env("WORKSPACE_DEFAULT_NAME") ?? "").trim() || "Operator",
    header: signIn ? "" : (env("WORKSPACE_IDENTITY_HEADER") ?? "").trim(),
    nameHeader: signIn ? "" : (env("WORKSPACE_IDENTITY_NAME_HEADER") ?? "").trim(),
    signIn,
  };
}

// The no-sign-in identity: the header's subject when WORKSPACE_IDENTITY_HEADER is on, else the default.
export async function resolveIdentity(header: (name: string) => string | undefined, cfg: IdentityConfig): Promise<Identity> {
  const fromHeader = cfg.header && !cfg.signIn ? (header(cfg.header) ?? "").trim().slice(0, 256) : "";
  const sub = fromHeader || cfg.defaultSub;
  const name = (fromHeader && cfg.nameHeader ? (header(cfg.nameHeader) ?? "").trim().slice(0, 256) : "") ||
    (fromHeader ? sub : cfg.defaultName);
  return { sub, actor: sub, name, key: await ownerKey(sub), kind: fromHeader ? "header" : "default", admin: false, impersonating: null };
}

export async function serviceIdentity(name: string): Promise<Identity> {
  const sub = `service:${name}`;
  return { sub, actor: sub, name: sub, key: await ownerKey(sub), kind: "service", admin: false, impersonating: null };
}

const ANONYMOUS: Identity = { sub: "anonymous:", actor: "anonymous:", name: "", key: "h-anonymous", kind: "anonymous", admin: false, impersonating: null };

// The signed-in browser's identity, from its session cookie; null when it has no live session.
export async function sessionIdentity(db: Db, token: string): Promise<Identity | null> {
  const s = await sessionOf(db, token);
  if (!s) return null;
  if (s.imp_sub && s.is_admin) {
    return {
      sub: s.imp_sub, actor: s.sub, name: s.imp_name || s.imp_sub, key: await ownerKey(s.imp_sub), kind: "user", admin: true,
      actorName: s.name, impersonating: { reason: s.imp_reason ?? "", since: s.imp_started_at ?? "" }, session: s.id_hash,
    };
  }
  return {
    sub: s.sub, actor: s.sub, name: s.name || s.sub, key: await ownerKey(s.sub), kind: "user", admin: s.is_admin,
    actorName: s.name, impersonating: null, session: s.id_hash,
  };
}

export interface SeamDeps {
  db: Db | null;
  oidc: OidcConfig | null;
  ring: KeyRing;
  cfg: IdentityConfig;
  defaultSet?: boolean; // WORKSPACE_DEFAULT_SUB is set (round 4: else an admin reads ownerless prompts, audited)
}

// round 4 (tester F2): the path the ROUTER will route - percent-decoding repeated until stable,
// backslashes as slashes, empty and "." segments dropped, ".." resolved. Every scope decision of the
// seam is taken on it, so /workbench/%64ocuments is /workbench/documents here too.
export function routePath(raw: string): string {
  let p = raw;
  for (let i = 0; i < 4; i++) {
    let d: string;
    try { d = decodeURIComponent(p); } catch { break; }
    if (d === p) break;
    p = d;
  }
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

export function seamDeps(db: Db | null, env = (k: string) => Deno.env.get(k)): SeamDeps {
  const oidc = oidcConfig(env);
  return { db, oidc, ring: keyRing(env, oidc !== null), cfg: identityConfig(env), defaultSet: !!(env("WORKSPACE_DEFAULT_SUB") ?? "").trim() };
}

// what a browser without a session may still reach: the sign-in itself
const OPEN = /^\/workbench\/(health(\/|$)|auth\/(login|callback|me|logout)$)/;
// a user's front end: never a service's
const USER_ONLY = /^\/workbench\/(documents|workspace|auth\/(impersonate|users|audit))(\/|$)/;
// the reads that can carry a research job's original prompt (round 4, F4)
const JOB_READS = /^\/workbench\/contract\/(sessions|jobs|timeline)(\/|$)/;

const KEY = "identity";

export function identitySeam(deps: SeamDeps = seamDeps(null)) {
  return async (c: Context, next: Next) => {
    const kk = keyKind(c.req.header("x-brain-key") ?? "", deps.ring, deps.oidc !== null);
    let who: Identity;
    if (kk?.kind === "service") who = await serviceIdentity(kk.name);
    else if (!deps.oidc) who = await resolveIdentity((n) => c.req.header(n), deps.cfg);
    else who = (deps.db && await sessionIdentity(deps.db, readCookie(c.req.header("cookie"), SESSION_COOKIE))) || ANONYMOUS;
    c.set(KEY as never, who as never);
    const url = new URL(c.req.url);
    const path = routePath(url.pathname);
    if (who.kind === "anonymous" && !OPEN.test(path)) {
      return c.json({ error: "sign in first", login: "/workbench/auth/login" }, 401);
    }
    if (who.kind === "service" && USER_ONLY.test(path)) {
      return c.json({ error: "a service has no user front end; sign in as a user" }, 403);
    }
    // round 4 (F4): with sign-in on and WORKSPACE_DEFAULT_SUB unset, a job nobody owns is readable by an
    // admin who is not impersonating (documents/ownership.ts) - every such read is recorded first
    if (deps.oidc && !deps.defaultSet && who.kind === "user" && who.admin && !who.impersonating && deps.db &&
        c.req.method === "GET" && JOB_READS.test(path)) {
      try {
        await audit(deps.db, {
          actor_sub: who.actor, subject_sub: who.sub, action: "request", method: c.req.method, route: url.pathname + url.search,
          reason: "an admin read of research that may carry ownerless prompts (WORKSPACE_DEFAULT_SUB unset)", session_ref: who.session,
        });
      } catch (e) {
        console.error("[identity] admin_audit write failed, request refused:", (e as Error).message);
        return c.json({ error: "this request could not be recorded in the admin audit log, so it was not run" }, 503);
      }
    }
    if (who.impersonating && deps.db) {
      try {
        await audit(deps.db, {
          actor_sub: who.actor, subject_sub: who.sub, action: "request", method: c.req.method,
          route: url.pathname + url.search, reason: who.impersonating.reason, session_ref: who.session,
        });
      } catch (e) {
        console.error("[identity] admin_audit write failed, request refused:", (e as Error).message);
        return c.json({ error: "this request could not be recorded in the admin audit log, so it was not run" }, 503);
      }
    }
    await next();
  };
}

// The request's identity, as the seam resolved it. A route that runs without the seam (a test that
// mounts a router alone) gets the default identity.
export async function identityOf(c: Context): Promise<Identity> {
  const got = c.get(KEY as never) as Identity | undefined;
  return got ?? await resolveIdentity(() => undefined, identityConfig());
}
