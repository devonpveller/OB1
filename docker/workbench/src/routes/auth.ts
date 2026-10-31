// /workbench/auth - who am I, and admin impersonation with its audit log (rw-identity; 07-MULTI-USER,
// operator 2026-10-28). rw-identity2: Authentik signs users in and out at the edge (forward-auth), so
// there is no login, callback, logout or session here - the request's signed token is the sign-in
// (src/identity/forward_auth.ts, verified by the identity seam on every request).
//
//   GET  /me                            the request's identity and the sign-in mode (open: the
//                                       workspace page asks before it renders); with forward-auth it
//                                       names Authentik's sign-out URL (WORKSPACE_FORWARD_AUTH_SIGN_OUT_URL)
//   POST /impersonate {sub, reason}     admins only; a reason is required; logged
//   POST /impersonate/end               back to the admin's own identity; logged
//   GET  /users                         admins only: whom an admin can impersonate (users seen signed in)
//   GET  /audit?actor&subject&action&since&limit   admins only: the audit log (reading it is logged)
// Every POST here is a write through the viewer's forwarder, so it needs the viewer's own Origin
// (the forwarder's CSRF guard) - the workspace page's fetch sends it.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../contracts/db.ts";
import type { ForwardAuthConfig } from "../identity/forward_auth.ts";
import * as store from "../identity/store.ts";
import { identityOf, type Identity, rawTarget, seamPath } from "../middleware/identity.ts";
import { reasonProblem } from "../identity/reason.ts";

export interface AuthDeps {
  db: Db;
  fa: ForwardAuthConfig | null;
  mode: "forward-auth" | "header" | "default";
}

function me(who: Identity, deps: AuthDeps) {
  const fa = deps.mode === "forward-auth";
  return {
    mode: deps.mode,
    signed_in: fa ? who.kind === "user" : true,
    kind: who.kind ?? "default",
    subject_sub: who.kind === "anonymous" ? null : who.sub,
    actor_sub: who.kind === "anonymous" ? null : who.actor,
    name: who.name,
    actor_name: who.actorName ?? who.name,
    admin: !!who.admin,
    impersonating: who.impersonating
      ? { sub: who.sub, name: who.name, reason: who.impersonating.reason, since: who.impersonating.since, until: who.impersonating.until ?? null }
      : null,
    logout: fa ? deps.fa?.signOutUrl ?? null : null,
  };
}

const noStore = (c: Context) => c.header("cache-control", "no-store");

export function authRouter(deps: AuthDeps) {
  const r = new Hono();
  r.use("*", async (c, next) => {
    noStore(c);
    await next();
  });

  r.get("/me", async (c) => c.json(me(await identityOf(c), deps)));

  // ── admin ──────────────────────────────────────────────────────────────────────────────────
  const adminOnly = async (c: Context, action: string): Promise<Identity | Response> => {
    const who = await identityOf(c);
    if (who.kind !== "user" || !who.admin) {
      if (who.kind === "user") {
        await store.audit(deps.db, { actor_sub: who.actor, subject_sub: who.sub, action: "impersonate.refused", reason: `not an admin: ${action}`, method: c.req.method, route: seamPath(c), session_ref: who.session });
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
    // recorded BEFORE the switch: an impersonation that cannot be recorded never starts
    const ref = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await store.audit(deps.db, { actor_sub: who.actor, subject_sub: target, action: "impersonate.start", reason, session_ref: ref });
    const imp = await store.startImpersonation(deps.db, who.actor, target, reason, deps.fa?.impersonationMinutes ?? 60, ref);
    if (!imp) return await refuse(409, "already impersonating - end it first");
    return c.json({ impersonating: { sub: target, name: known.name, reason, since: imp.started_at, until: imp.expires_at } });
  });

  r.post("/impersonate/end", async (c) => {
    const who = await adminOnly(c, "impersonate/end");
    if (who instanceof Response) return who;
    if (!who.impersonating) return c.json({ error: "not impersonating" }, 409);
    // the end and its audit row: one transaction (rw-identity-harden F-d)
    await store.endImpersonation(deps.db, who.actor, (e) => e.reason);
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
    await store.audit(deps.db, { actor_sub: who.actor, subject_sub: who.sub, action: "audit.read", route: rawTarget(c.req.url).query, session_ref: who.session });
    return c.json({ entries: await store.auditLog(deps.db, { actor: q("actor"), subject: q("subject"), action: q("action"), since, limit }) });
  });

  return r;
}
