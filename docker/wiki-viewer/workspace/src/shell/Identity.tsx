// The signed-in user in the workspace (rw-identity): the sign-in screen, the account menu in the
// title bar, the impersonation banner and the admin panel (impersonate after giving a reason; read
// the audit log). Every decision is the workbench's (/workbench/auth); this only shows it.
import { useEffect, useState } from "react";
import {
  type AuditEntry, auditLog, currentMe, endImpersonation, impersonate, REASON_MIN, signInHref, signOut, users,
} from "../lib/auth";

const reload = () => location.reload();

export function SignIn({ here }: { here: string }) {
  return (
    <div className="ws-signin" role="main">
      <h1>Research workspace</h1>
      <p>Sign in to see your documents, ideas and research.</p>
      <a className="ws-signin-btn" data-testid="sign-in" href={signInHref(here)}>Sign in</a>
    </div>
  );
}

// Shown on every screen while an admin views a user's workspace as that user.
export function ImpersonationBanner({ onEnd = reload }: { onEnd?: () => void }) {
  const me = currentMe();
  const [err, setErr] = useState("");
  if (!me?.impersonating) return null;
  const end = async () => {
    try {
      await endImpersonation();
      onEnd();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="ws-banner" role="alert" data-testid="impersonation-banner">
      <strong>Viewing as {me.impersonating.name}</strong>
      <span> - you are {me.actor_name}, an admin. Reason: {me.impersonating.reason}. Everything you do is recorded in the audit log.</span>
      <button type="button" data-testid="end-impersonation" onClick={end}>End</button>
      {err && <span className="ws-error"> {err}</span>}
    </div>
  );
}

export function AdminPanel({ onSwitch = reload }: { onSwitch?: () => void }) {
  const [list, setList] = useState<{ sub: string; name: string; email: string }[]>([]);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const me = currentMe();
  useEffect(() => {
    users().then((u) => setList(u.filter((x) => x.sub !== me?.actor_sub))).catch((e) => setErr((e as Error).message));
  }, [me?.actor_sub]);
  const ready = !!target && reason.trim().length >= REASON_MIN && !me?.impersonating;
  const start = async () => {
    try {
      await impersonate(target, reason);
      onSwitch();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="ws-admin" data-testid="admin-panel">
      <h3>Impersonate a user</h3>
      <label>User
        <select data-testid="imp-user" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">choose...</option>
          {list.map((u) => <option key={u.sub} value={u.sub}>{u.name || u.email || u.sub}</option>)}
        </select>
      </label>
      <label>Reason (required, recorded)
        <textarea data-testid="imp-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      </label>
      <button type="button" data-testid="imp-start" disabled={!ready} onClick={start}>Impersonate</button>
      {err && <p className="ws-error">{err}</p>}
      <h3>Audit log</h3>
      <button type="button" data-testid="audit-load" onClick={() => auditLog({ limit: 200 }).then(setEntries).catch((e) => setErr((e as Error).message))}>Load</button>
      {entries && (
        <table className="ws-audit" data-testid="audit-table">
          <thead><tr><th>When</th><th>Admin</th><th>User</th><th>Action</th><th>Reason</th><th>Request</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}><td>{e.at}</td><td>{e.actor_sub}</td><td>{e.subject_sub}</td><td>{e.action}</td><td>{e.reason ?? ""}</td><td>{e.method ? `${e.method} ${e.route}` : (e.route ?? "")}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// In the title bar: the user's name; Sign out when sign-in is on; Admin for admins.
export function AccountMenu() {
  const me = currentMe();
  const [admin, setAdmin] = useState(false);
  if (!me || me.mode !== "oidc" || !me.signed_in) return null;
  const out = async () => {
    try { location.href = await signOut(); } catch { location.href = "/workspace/"; }
  };
  return (
    <span className="ws-account">
      <span className="ws-muted" data-testid="account-name">{me.actor_name}</span>
      {me.admin && (
        <button type="button" className="ws-tb-btn" data-testid="admin" aria-expanded={admin} onClick={() => setAdmin(!admin)}>Admin</button>
      )}
      <button type="button" className="ws-tb-btn" data-testid="sign-out" onClick={out}>Sign out</button>
      {admin && <div className="ws-popover" role="dialog" aria-label="admin"><AdminPanel /></div>}
    </span>
  );
}
