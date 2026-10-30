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
// SIGN-IN (rw-identity, 07-MULTI-USER; rw-identity2: Authentik forward-auth): with
// WORKSPACE_FORWARD_AUTH_* configured (src/identity/forward_auth.ts) the subject comes from the
// request's signed Authentik token alone (X-authentik-jwt, HS256 with the proxy provider's client
// secret; verified here on every request) and WORKSPACE_IDENTITY_HEADER is IGNORED - no header can
// stand in for a sign-in, nor can the unsigned X-authentik-* headers. The key a request came with says
// what it is (src/identity/keys.ts): the door key is a browser (no valid token = 401, bar /auth/me and
// health); WORKBENCH_KEY or a WORKSPACE_SERVICE_KEYS key is a service on the internal network,
// identity service:<name>, which has no user front end (403 on the documents and workspace routes).
// An admin (WORKSPACE_FORWARD_AUTH_ADMIN_GROUP in the token's groups, re-read on every request) may
// impersonate a user after giving a reason: subject_sub becomes that user, actor_sub stays the admin,
// and every request made while impersonating is written to admin_audit BEFORE it runs (a request that
// cannot be recorded does not run: 503). The impersonation is a short-lived row keyed by the admin's
// subject (store.ts); an admin no longer in the group has it ended (recorded) on the next request.
import type { Context, Next } from "hono";
import type { Db } from "../contracts/db.ts";
import { type ForwardAuthConfig, forwardAuthConfig, isAdmin, TOKEN_HEADER, verifyForwardToken } from "../identity/forward_auth.ts";
import { keyKind, keyRing, type KeyRing } from "../identity/keys.ts";
import { audit, endImpersonation, impersonationOf, seeUser } from "../identity/store.ts";

// TWO subjects (operator 2026-10-28): `sub` is subject_sub - whose data is shown and written (every
// read of user state filters by it); `actor` is actor_sub - who is acting. They are equal except while
// an admin impersonates a user (rw-identity): then sub is the user and actor the admin.
export interface Identity {
  sub: string; // subject_sub: the Authentik subject id whose data this is - what owner_sub stores
  actor: string; // actor_sub: who acted - what actor_sub stores
  name: string; // display name
  key: string; // a filesystem-safe form of sub: the user's directory in the documents tree
  kind?: "default" | "header" | "user" | "service" | "anonymous";
  admin?: boolean; // the signed-in user's token names WORKSPACE_FORWARD_AUTH_ADMIN_GROUP (this request)
  actorName?: string;
  impersonating?: { reason: string; since: string; until?: string } | null;
  session?: string; // the impersonation's reference (admin_audit.session_ref); never a token
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
  signIn?: boolean; // WORKSPACE_FORWARD_AUTH_* configured
}

export function identityConfig(env = (k: string) => Deno.env.get(k)): IdentityConfig {
  const signIn = forwardAuthConfig(env) !== null;
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

// The signed-in user's identity, from the request's Authentik token; null when there is no valid
// token. The admin flag is the token's (this request's); an impersonation is the admin's stored row.
export async function tokenIdentity(db: Db | null, token: string, fa: ForwardAuthConfig): Promise<Identity | null> {
  const claims = await verifyForwardToken(token, fa, (why) => console.warn(`[identity] forward-auth token refused: ${why}`));
  if (!claims) return null;
  const admin = isAdmin(claims, fa);
  if (db) await seeUser(db, { sub: claims.sub, name: claims.name, email: claims.email, is_admin: admin });
  const self: Identity = {
    sub: claims.sub, actor: claims.sub, name: claims.name, key: await ownerKey(claims.sub), kind: "user", admin,
    actorName: claims.name, impersonating: null,
  };
  if (!db) return self;
  if (!admin) {
    // left the admin group (or never in it): an impersonation it started ends now, recorded
    const ended = await endImpersonation(db, claims.sub);
    if (ended) {
      await audit(db, { actor_sub: claims.sub, subject_sub: ended.target_sub, action: "impersonate.end", reason: "no longer in the admin group", session_ref: ended.ref });
    }
    return self;
  }
  const imp = await impersonationOf(db, claims.sub);
  if (!imp) return self;
  return {
    sub: imp.target_sub, actor: claims.sub, name: imp.target_name || imp.target_sub, key: await ownerKey(imp.target_sub), kind: "user", admin: true,
    actorName: claims.name, impersonating: { reason: imp.reason, since: imp.started_at, until: imp.expires_at }, session: imp.ref,
  };
}

export interface SeamDeps {
  db: Db | null;
  fa: ForwardAuthConfig | null;
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

// rw-identity2 (review r-identity B1): the seam and the router must judge ONE string. Hono routes on
// the path decoded once (decodeURI, which keeps %2F) and decodes params once more, so a spelling whose
// segments become "/" or ".." only after a second decode (%252e%252e, ..%2F, %5c) was judged here as
// one route (routePath: /workbench/health/..., OPEN) and routed as another (the notes handler). A
// path is CANONICAL when no decoding can change its shape: no encoded "%", "/", "\" or "." (%25 %2F
// %5C %2E, any case), no NUL, no backslash, valid percent-encoding, no empty, "." or ".." segment (a
// ";param" suffix does not hide one) bar one trailing "/", and routePath of it is the path itself.
// Returns the canonical path, or null - the seam answers null with 400 before it judges anything.
// rw-identity3 (review r-identity2 B1b): a raw ";" is refused too - no client sends one (every client
// encodes per segment, encodeURIComponent turns ";" into %3B), and it is how a dot segment hides.
// The value returned is the path exactly as the router matches it (routerPath), so the seam's every
// decision, the audit route and owner-scope judge the router's own string.
const ENCODED_SHAPE = /%(25|2f|5c|2e|00)|[\\;]/i;
export function canonicalPath(raw: string): string | null {
  if (!raw.startsWith("/") || ENCODED_SHAPE.test(raw)) return null;
  let d: string;
  try { d = decodeURIComponent(raw); } catch { return null; }
  if (/[\x00-\x1f\x7f\\%]/.test(d)) return null;
  const body = d.length > 1 && d.endsWith("/") ? d.slice(0, -1) : d;
  if (body !== "/") {
    for (const seg of body.slice(1).split("/")) {
      const name = seg.split(";")[0];
      if (name === "" || name === "." || name === "..") return null;
    }
  }
  return routePath(raw) === body ? routerPath(raw) : null;
}

// rw-identity3 (review r-identity2 B1b): the RAW path of the request, taken exactly as Hono's router
// takes it (hono/utils/url.ts getPath, pinned jsr:@hono/hono@4.13.5): the request URL from the first
// "/" after the scheme's "://" up to the first "?" or "#". NEVER new URL(c.req.url).pathname - WHATWG
// parsing resolves "." / ".." / "%2e" segments and turns "\" into "/" before the seam could see them,
// while Deno.serve hands the router the request target as sent. Returns the raw path and the query
// ("?..." up to any "#", or "").
export function rawTarget(url: string): { path: string; query: string } {
  const start = url.indexOf("/", url.indexOf(":") + 4);
  if (start === -1) return { path: "", query: "" };
  let i = start;
  for (; i < url.length; i++) {
    const ch = url.charCodeAt(i);
    if (ch === 63 || ch === 35) break; // "?" or "#"
  }
  const rest = url.slice(i);
  return { path: url.slice(start, i), query: rest.startsWith("?") ? rest.split("#")[0] : "" };
}

// The router's path for a raw path: getPath's decoding (tryDecodeURI, with its %25 -> %2525 guard), so
// what the seam stores is byte for byte c.req.path.
export function routerPath(raw: string): string {
  if (!raw.includes("%")) return raw;
  const p = raw.includes("%25") ? raw.replace(/%25/g, "%2525") : raw;
  try {
    return decodeURI(p);
  } catch {
    return p.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURI(m); } catch { return m; } });
  }
}

export function seamDeps(db: Db | null, env = (k: string) => Deno.env.get(k)): SeamDeps {
  const fa = forwardAuthConfig(env);
  return { db, fa, ring: keyRing(env, fa !== null), cfg: identityConfig(env), defaultSet: !!(env("WORKSPACE_DEFAULT_SUB") ?? "").trim() };
}

// what a browser without a valid token may still reach: health, and who-am-I (the page asks first)
const OPEN = /^\/workbench\/(health(\/|$)|auth\/me$)/;
// a user's front end: never a service's
const USER_ONLY = /^\/workbench\/(documents|workspace|auth\/(impersonate|users|audit))(\/|$)/;
// the reads that can carry a research job's original prompt (round 4, F4)
const JOB_READS = /^\/workbench\/contract\/(sessions|jobs|timeline)(\/|$)/;

const KEY = "identity";
const PATH_KEY = "identityPath";

// The path the seam judged - the router's own (canonical) path, computed once by the seam and kept on
// the context, so nothing after it re-derives one. Without the seam (a router mounted alone in a test)
// it is derived the same way, from the raw target.
export function seamPath(c: Context): string {
  const got = c.get(PATH_KEY as never) as string | undefined;
  if (got !== undefined) return got;
  const raw = rawTarget(c.req.url).path;
  return canonicalPath(raw) ?? routerPath(raw);
}

// F-b (review r-identity2): an edge doing Authentik forward-auth in front of a workbench whose
// WORKSPACE_FORWARD_AUTH_* are blank would have every user served as WORKSPACE_DEFAULT_SUB
const AUTHENTIK_HEADER = /^x-authentik-/i;

export function identitySeam(deps: SeamDeps = seamDeps(null)) {
  return async (c: Context, next: Next) => {
    // B1/B1b: the RAW target (as the router routes it, never a WHATWG-normalised URL); a path the
    // router could read differently from this seam is refused before any decision
    const target = rawTarget(c.req.url);
    const path = canonicalPath(target.path);
    if (path === null) return c.json({ error: "not a canonical path: no encoded '/', '\\', '.' or '%', no ';' or '\\', and no empty, '.' or '..' segment" }, 400);
    c.set(PATH_KEY as never, path as never);
    const route = path + target.query;
    if (!deps.fa) {
      for (const [name] of c.req.raw.headers) {
        if (AUTHENTIK_HEADER.test(name)) {
          console.warn(`[identity] a request carries ${name} but forward-auth is not configured: refused (503)`);
          return c.json({ error: "forward-auth is not configured on the workbench (WORKSPACE_FORWARD_AUTH_* are blank), but this request carries Authentik forward-auth headers (X-authentik-*); refused rather than served as the default user" }, 503);
        }
      }
    }
    const kk = keyKind(c.req.header("x-brain-key") ?? "", deps.ring, deps.fa !== null);
    let who: Identity;
    if (kk?.kind === "service") who = await serviceIdentity(kk.name);
    else if (!deps.fa) who = await resolveIdentity((n) => c.req.header(n), deps.cfg);
    else {
      try {
        who = (await tokenIdentity(deps.db, c.req.header(TOKEN_HEADER) ?? "", deps.fa)) || ANONYMOUS;
      } catch (e) {
        console.error("[identity] the identity store failed, request refused:", (e as Error).message);
        return c.json({ error: "the identity store is not answering" }, 503);
      }
    }
    c.set(KEY as never, who as never);
    if (who.kind === "anonymous" && !OPEN.test(path)) {
      return c.json({ error: "sign in first (through the edge: Authentik forward-auth)" }, 401);
    }
    if (who.kind === "service" && USER_ONLY.test(path)) {
      return c.json({ error: "a service has no user front end; sign in as a user" }, 403);
    }
    // round 4 (F4): with sign-in on and WORKSPACE_DEFAULT_SUB unset, a job nobody owns is readable by an
    // admin who is not impersonating (documents/ownership.ts) - every such read is recorded first
    if (deps.fa && !deps.defaultSet && who.kind === "user" && who.admin && !who.impersonating && deps.db &&
        c.req.method === "GET" && JOB_READS.test(path)) {
      try {
        await audit(deps.db, {
          actor_sub: who.actor, subject_sub: who.sub, action: "request", method: c.req.method, route,
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
          route, reason: who.impersonating.reason, session_ref: who.session,
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
