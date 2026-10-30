// The identity's storage (rw-identity; tables in OB1/docker/init-identity.sql, slot 290). There is no
// session here: Authentik keeps the sign-in (forward-auth, rw-identity2) and every request carries its
// signed token (src/identity/forward_auth.ts).
//   workspace_users          the users the workbench has seen signed in (an admin picks whom to
//                            impersonate here); refreshed from the token at most every few minutes
//   workspace_impersonation  one row per admin who is impersonating: whom, why, since, until (short-
//                            lived, keyed by the admin's subject; ends by itself when it expires)
//   admin_audit              APPEND-ONLY: every admin action and every request made while
//                            impersonating (the table refuses UPDATE, DELETE and TRUNCATE)
import type { Db } from "../contracts/db.ts";

const SEEN_REFRESH_MS = 5 * 60_000;
const seen = new Map<string, { at: number; sig: string }>();

// Record (or refresh) a signed-in user; at most one write per user per few minutes and per change.
export async function seeUser(db: Db, u: { sub: string; name: string; email: string; is_admin: boolean }): Promise<void> {
  const sig = `${u.name}\u0000${u.email}\u0000${u.is_admin}`;
  const last = seen.get(u.sub);
  if (last && last.sig === sig && Date.now() - last.at < SEEN_REFRESH_MS) return;
  await db.query(
    `INSERT INTO public.workspace_users (sub, name, email, is_admin) VALUES ($1, $2, $3, $4)
     ON CONFLICT (sub) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, is_admin = EXCLUDED.is_admin, last_seen = now()`,
    [u.sub, u.name, u.email, u.is_admin],
  );
  if (seen.size > 10_000) seen.clear();
  seen.set(u.sub, { at: Date.now(), sig });
}

export interface Impersonation {
  target_sub: string;
  target_name: string;
  reason: string;
  ref: string; // what the audit rows of this impersonation carry as session_ref
  started_at: string;
  expires_at: string;
}

// The admin's live impersonation, or null. An expired one is removed here and its end recorded.
export async function impersonationOf(db: Db, adminSub: string): Promise<Impersonation | null> {
  const ended = await db.query<{ target_sub: string; reason: string; ref: string }>(
    `DELETE FROM public.workspace_impersonation WHERE admin_sub = $1 AND expires_at <= now() RETURNING target_sub, reason, ref`,
    [adminSub],
  );
  for (const e of ended) {
    await audit(db, { actor_sub: adminSub, subject_sub: e.target_sub, action: "impersonate.end", reason: `expired (${e.reason.slice(0, 200)})`, session_ref: e.ref });
  }
  const rows = await db.query<Impersonation>(
    `SELECT i.target_sub, coalesce(u.name, '') AS target_name, i.reason, i.ref,
            i.started_at::text AS started_at, i.expires_at::text AS expires_at
       FROM public.workspace_impersonation i LEFT JOIN public.workspace_users u ON u.sub = i.target_sub
      WHERE i.admin_sub = $1 AND i.expires_at > now()`,
    [adminSub],
  );
  return rows[0] ?? null;
}

// Starts an impersonation; null when the admin already has one (nesting is refused).
export async function startImpersonation(db: Db, adminSub: string, target: string, reason: string, minutes: number, ref: string): Promise<Impersonation | null> {
  const rows = await db.query<Impersonation>(
    `INSERT INTO public.workspace_impersonation (admin_sub, target_sub, reason, ref, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
     ON CONFLICT (admin_sub) DO NOTHING
     RETURNING target_sub, '' AS target_name, reason, ref, started_at::text AS started_at, expires_at::text AS expires_at`,
    [adminSub, target, reason, ref, minutes],
  );
  return rows[0] ?? null;
}

export async function endImpersonation(db: Db, adminSub: string): Promise<{ target_sub: string; reason: string; ref: string } | null> {
  const rows = await db.query<{ target_sub: string; reason: string; ref: string }>(
    `DELETE FROM public.workspace_impersonation WHERE admin_sub = $1 RETURNING target_sub, reason, ref`,
    [adminSub],
  );
  return rows[0] ?? null;
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
