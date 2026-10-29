// The sign-in's storage (rw-identity; tables in OB1/docker/init-identity.sql, slot 280):
//   workspace_login_pending  one row per sign-in in flight: the state (hashed), the browser binding
//                            (hashed), the nonce, the PKCE verifier, where to land; single use, 10 min
//   workspace_sessions       one row per signed-in browser: the token's SHA-256 (the token itself is
//                            only in the browser's cookie), the user, admin or not, an impersonation
//   workspace_users          the users who have signed in (an admin picks whom to impersonate here)
//   admin_audit              APPEND-ONLY: every admin action and every request made while
//                            impersonating (the table refuses UPDATE, DELETE and TRUNCATE)
import type { Db } from "../contracts/db.ts";
import { randomToken, sha256b64url } from "./oidc.ts";

export interface Pending {
  nonce: string;
  verifier: string;
  return_to: string;
}

export async function createPending(db: Db, p: Pending & { state: string; binding: string }): Promise<void> {
  await db.query(`DELETE FROM public.workspace_login_pending WHERE expires_at < now()`);
  await db.query(
    `INSERT INTO public.workspace_login_pending (state_hash, binding_hash, nonce, verifier, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
    [await sha256b64url(p.state), await sha256b64url(p.binding), p.nonce, p.verifier, p.return_to],
  );
}

// Single use: the row is deleted as it is read, whatever happens next. Null when the state is
// unknown, used, expired, or was started by another browser (the binding cookie disagrees).
export async function consumePending(db: Db, state: string, binding: string): Promise<Pending | null> {
  // the state row is deleted even when the binding is missing (a state shown by another browser is
  // burnt, never left for a replay)
  if (!state) return null;
  const rows = await db.query<Pending & { binding_hash: string; live: boolean }>(
    `DELETE FROM public.workspace_login_pending WHERE state_hash = $1
     RETURNING binding_hash, nonce, verifier, return_to, (expires_at > now()) AS live`,
    [await sha256b64url(state)],
  );
  const r = rows[0];
  if (!r || !r.live || !binding || r.binding_hash !== await sha256b64url(binding)) return null;
  return { nonce: r.nonce, verifier: r.verifier, return_to: r.return_to };
}

export interface SessionRow {
  id_hash: string;
  sub: string;
  name: string;
  is_admin: boolean;
  imp_sub: string | null;
  imp_name: string | null;
  imp_reason: string | null;
  imp_started_at: string | null;
}

export async function upsertUser(db: Db, u: { sub: string; name: string; email: string; is_admin: boolean }): Promise<void> {
  await db.query(
    `INSERT INTO public.workspace_users (sub, name, email, is_admin) VALUES ($1, $2, $3, $4)
     ON CONFLICT (sub) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, is_admin = EXCLUDED.is_admin, last_seen = now()`,
    [u.sub, u.name, u.email, u.is_admin],
  );
}

export async function createSession(db: Db, u: { sub: string; name: string; is_admin: boolean }, seconds: number): Promise<string> {
  const token = randomToken(32);
  await db.query(`DELETE FROM public.workspace_sessions WHERE expires_at < now() - interval '1 day'`);
  await db.query(
    `INSERT INTO public.workspace_sessions (id_hash, sub, name, is_admin, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [await sha256b64url(token), u.sub, u.name, u.is_admin, seconds],
  );
  return token;
}

export async function sessionOf(db: Db, token: string): Promise<SessionRow | null> {
  if (!token || token.length > 200) return null;
  const rows = await db.query<SessionRow>(
    `SELECT s.id_hash, s.sub, s.name, s.is_admin, s.imp_sub, u.name AS imp_name, s.imp_reason, s.imp_started_at::text AS imp_started_at
       FROM public.workspace_sessions s LEFT JOIN public.workspace_users u ON u.sub = s.imp_sub
      WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [await sha256b64url(token)],
  );
  return rows[0] ?? null;
}

export async function revokeSession(db: Db, idHash: string): Promise<void> {
  await db.query(`UPDATE public.workspace_sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL`, [idHash]);
}

export async function setImpersonation(db: Db, idHash: string, target: { sub: string; reason: string } | null): Promise<void> {
  await db.query(
    `UPDATE public.workspace_sessions SET imp_sub = $2, imp_reason = $3, imp_started_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash, target?.sub ?? null, target?.reason ?? null],
  );
}

export async function knownUser(db: Db, sub: string): Promise<{ sub: string; name: string } | null> {
  const rows = await db.query<{ sub: string; name: string }>(`SELECT sub, name FROM public.workspace_users WHERE sub = $1`, [sub]);
  return rows[0] ?? null;
}

export async function users(db: Db, limit = 500) {
  return await db.query<{ sub: string; name: string; email: string; is_admin: boolean; last_seen: string }>(
    `SELECT sub, name, email, is_admin, last_seen::text AS last_seen FROM public.workspace_users ORDER BY last_seen DESC LIMIT $1`,
    [limit],
  );
}

export interface AuditEntry {
  actor_sub: string;
  subject_sub: string;
  action: "impersonate.start" | "impersonate.end" | "impersonate.refused" | "request" | "audit.read" | "users.read";
  reason?: string | null;
  method?: string | null;
  route?: string | null;
  session_ref?: string | null;
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO public.admin_audit (actor_sub, subject_sub, action, reason, method, route, session_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actor_sub, e.subject_sub, e.action, e.reason ?? null, e.method ?? null, e.route?.slice(0, 1000) ?? null, e.session_ref?.slice(0, 12) ?? null],
  );
}

export async function auditLog(db: Db, f: { actor?: string; subject?: string; action?: string; since?: string; limit: number }) {
  return await db.query(
    `SELECT id, at::text AS at, actor_sub, subject_sub, action, reason, method, route, session_ref
       FROM public.admin_audit
      WHERE ($1::text IS NULL OR actor_sub = $1) AND ($2::text IS NULL OR subject_sub = $2)
        AND ($3::text IS NULL OR action = $3) AND ($4::timestamptz IS NULL OR at >= $4::timestamptz)
      ORDER BY id DESC LIMIT $5`,
    [f.actor || null, f.subject || null, f.action || null, f.since || null, f.limit],
  );
}
