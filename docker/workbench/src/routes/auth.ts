// /workbench/auth - sign-in with Authentik, sign-out, who am I, and admin impersonation with its
// audit log (rw-identity; 07-MULTI-USER, operator 2026-10-28).
//
//   GET  /login?return_to=/workspace/   starts a sign-in: state + nonce + PKCE (S256), a browser
//                                       binding cookie, then 302 to the provider
//   GET  /callback?code&state           the provider's answer: the state must be this browser's and
//                                       unused, the code is exchanged with the PKCE verifier, the ID
//                                       token's signature, issuer, audience, expiry and nonce checked;
//                                       then a session cookie and 302 back
//   GET  /me                            the request's identity and the sign-in mode (open: the
//                                       workspace page asks before it renders)
//   POST /logout                        ends the session (revoked server-side, cookie cleared)
//   POST /impersonate {sub, reason}     admins only; a reason is required; logged
//   POST /impersonate/end               back to the admin's own identity; logged
//   GET  /users                         admins only: whom an admin can impersonate (users who signed in)
//   GET  /audit?actor&subject&action&since&limit   admins only: the audit log (reading it is logged)
// Every POST here is a write through the viewer's forwarder, so it needs the viewer's own Origin
// (the forwarder's CSRF guard) - the workspace page's fetch sends it.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../contracts/db.ts";
import { authorizeUrl, displayName, groupsOf, OidcError, type OidcConfig, pkcePair, Provider, randomToken } from "../identity/oidc.ts";
import { clearLoginCookie, clearSessionCookie, LOGIN_COOKIE, loginCookie, readCookie, safeReturnTo, sessionCookie } from "../identity/cookies.ts";
import * as store from "../identity/store.ts";
import { identityOf, type Identity } from "../middleware/identity.ts";
import { reasonProblem } from "../identity/reason.ts";

export interface AuthDeps {
  db: Db;
  oidc: OidcConfig | null;
  provider: Provider | null;
  mode: "oidc" | "header" | "default";
}


function me(who: Identity, mode: AuthDeps["mode"]) {
  const signedIn = who.kind === "user";
  return {
    mode,
    signed_in: mode === "oidc" ? signedIn : true,
    kind: who.kind ?? "default",
    subject_sub: who.kind === "anonymous" ? null : who.sub,
    actor_sub: who.kind === "anonymous" ? null : who.actor,
    name: who.name,
    actor_name: who.actorName ?? who.name,
    admin: !!who.admin,
    impersonating: who.impersonating ? { sub: who.sub, name: who.name, reason: who.impersonating.reason, since: who.impersonating.since } : null,
    login: mode === "oidc" ? "/workbench/auth/login" : null,
    logout: mode === "oidc" ? "/workbench/auth/logout" : null,
  };
}

const noStore = (c: Context) => c.header("cache-control", "no-store");

export function authRouter(deps: AuthDeps) {
  const r = new Hono();
  r.use("*", async (c, next) => {
    noStore(c);
    await next();
  });

  r.get("/me", async (c) => c.json(me(await identityOf(c), deps.mode)));

  r.get("/login", async (c) => {
    if (!deps.oidc || !deps.provider) return c.json({ error: "sign-in is not configured (WORKSPACE_OIDC_*)" }, 404);
    let meta;
    try { meta = await deps.provider.meta(); } catch (e) {
      console.error("[auth] provider discovery failed:", (e as Error).message);
      return c.json({ error: "the sign-in provider is not answering" }, 502);
    }
    const state = randomToken(32);
    const nonce = randomToken(32);
    const binding = randomToken(32);
    const { verifier, challenge } = await pkcePair();
    await store.createPending(deps.db, { state, binding, nonce, verifier, return_to: safeReturnTo(c.req.query("return_to")) });
    c.header("set-cookie", loginCookie(binding));
    return c.redirect(authorizeUrl(meta, deps.oidc, { state, nonce, challenge }), 302);
  });

  r.get("/callback", async (c) => {
    if (!deps.oidc || !deps.provider) return c.json({ error: "sign-in is not configured (WORKSPACE_OIDC_*)" }, 404);
    c.header("set-cookie", clearLoginCookie(), { append: true });
    const err = c.req.query("error");
    // the state is consumed whatever the answer, so it can never be replayed
    const pending = await store.consumePending(deps.db, c.req.query("state") ?? "", readCookie(c.req.header("cookie"), LOGIN_COOKIE));
    if (err) return c.json({ error: `the provider refused the sign-in: ${String(err).slice(0, 100)}` }, 400);
    if (!pending) return c.json({ error: "this sign-in is not valid here (unknown, used or expired state, or started in another browser) - sign in again" }, 400);
    const code = c.req.query("code") ?? "";
    if (!code) return c.json({ error: "the provider sent no code" }, 400);
    let claims;
    try {
      const t = await deps.provider.exchange(code, pending.verifier);
      claims = await deps.provider.verify(t.id_token, pending.nonce);
    } catch (e) {
      const msg = e instanceof OidcError ? e.message : "the provider could not be reached";
      console.error("[auth] sign-in refused:", (e as Error).message);
      return c.json({ error: `sign-in refused: ${msg}` }, 400);
    }
    const admin = !!deps.oidc.adminGroup && groupsOf(claims).includes(deps.oidc.adminGroup);
    const user = { sub: claims.sub, name: displayName(claims), email: String(claims.email ?? "").slice(0, 200), is_admin: admin };
    await store.upsertUser(deps.db, user);
    const token = await store.createSession(deps.db, user, deps.oidc.sessionSeconds);
    c.header("set-cookie", sessionCookie(token, deps.oidc.sessionSeconds), { append: true });
    return c.redirect(pending.return_to, 302);
  });

  r.post("/logout", async (c) => {
    const who = await identityOf(c);
    if (who.session) {
      if (who.impersonating) {
        await store.audit(deps.db, { actor_sub: who.actor, subject_sub: who.sub, action: "impersonate.end", reason: "signed out", session_ref: who.session });
      }
      await store.revokeSession(deps.db, who.session);
    }
    c.header("set-cookie", clearSessionCookie(), { append: true });
    let endSession: string | null = null;
    if (deps.provider && deps.oidc) {
      try {
        const m = await deps.provider.meta();
        if (m.end_session_endpoint) {
          const u = new URL(m.end_session_endpoint);
          u.searchParams.set("client_id", deps.oidc.clientId);
          if (deps.oidc.postLogoutUri) u.searchParams.set("post_logout_redirect_uri", deps.oidc.postLogoutUri);
          endSession = u.toString();
        }
      } catch { /* the local session is ended either way */ }
    }
    return c.json({ signed_out: true, end_session: endSession });
  });

  // ── admin ──────────────────────────────────────────────────────────────────────────────────
  const adminOnly = async (c: Context, action: string): Promise<Identity | Response> => {
    const who = await identityOf(c);
    if (who.kind !== "user" || !who.admin) {
      if (who.kind === "user") {
        await store.audit(deps.db, { actor_sub: who.actor, subject_sub: who.sub, action: "impersonate.refused", reason: `not an admin: ${action}`, method: c.req.method, route: new URL(c.req.url).pathname, session_ref: who.session });
      }
      return c.json({ error: "admins only" }, 403);
    }
    return who;
  };

  r.post("/impersonate", async (c) => {
    const who = await adminOnly(c, "impersonate");
    if (who instanceof Response) return who;
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* empty */ }
    const target = typeof body.sub === "string" ? body.sub.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const refuse = async (status: 400 | 404 | 409, msg: string) => {
      await store.audit(deps.db, { actor_sub: who.actor, subject_sub: target || who.sub, action: "impersonate.refused", reason: `${msg}${reason ? ` (reason given: ${reason.slice(0, 200)})` : ""}`, session_ref: who.session });
      return c.json({ error: msg }, status);
    };
    if (who.impersonating) return await refuse(409, "already impersonating - end it first");
    const bad = reasonProblem(reason);
    if (bad) return await refuse(400, bad);
    if (!target) return await refuse(400, "name the user (sub) to impersonate");
    if (target === who.actor) return await refuse(400, "that is you");
    const known = await store.knownUser(deps.db, target);
    if (!known) return await refuse(404, "no user with this subject has signed in");
    await store.audit(deps.db, { actor_sub: who.actor, subject_sub: target, action: "impersonate.start", reason, session_ref: who.session });
    await store.setImpersonation(deps.db, who.session!, { sub: target, reason });
    return c.json({ impersonating: { sub: target, name: known.name, reason } });
  });

  r.post("/impersonate/end", async (c) => {
    const who = await adminOnly(c, "impersonate/end");
    if (who instanceof Response) return who;
    if (!who.impersonating) return c.json({ error: "not impersonating" }, 409);
    await store.audit(deps.db, { actor_sub: who.actor, subject_sub: who.sub, action: "impersonate.end", reason: who.impersonating.reason, session_ref: who.session });
    await store.setImpersonation(deps.db, who.session!, null);
    return c.json({ impersonating: null });
  });

  r.get("/users", async (c) => {
    const who = await adminOnly(c, "users");
    if (who instanceof Response) return who;
    await store.audit(deps.db, { actor_sub: who.actor, subject_sub: who.sub, action: "users.read", session_ref: who.session });
    return c.json({ users: await store.users(deps.db) });
  });

  r.get("/audit", async (c) => {
    const who = await adminOnly(c, "audit");
    if (who instanceof Response) return who;
    const q = (k: string) => (c.req.query(k) ?? "").trim() || undefined;
    const limit = Math.min(1000, Math.max(1, Number(q("limit") ?? 200) || 200));
    const since = q("since");
    if (since && Number.isNaN(Date.parse(since))) return c.json({ error: "since is not a time" }, 400);
    await store.audit(deps.db, { actor_sub: who.actor, subject_sub: who.sub, action: "audit.read", route: new URL(c.req.url).search, session_ref: who.session });
    return c.json({ entries: await store.auditLog(deps.db, { actor: q("actor"), subject: q("subject"), action: q("action"), since, limit }) });
  });

  return r;
}
