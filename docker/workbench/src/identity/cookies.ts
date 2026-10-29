// The session cookie (rw-identity). `__Host-` prefix: Secure, Path=/, no Domain - the browser holds
// it for the one origin the edge serves and sends it nowhere else. HttpOnly: no script reads it.
// SameSite=Strict for the session (every call that needs it is a same-origin fetch from the
// workspace page), SameSite=Lax for the short-lived sign-in binding: the provider's redirect back to
// /workbench/auth/callback is a cross-site top-level navigation, which a Strict cookie would not ride.
// The cookie carries a random token only; the server keeps its SHA-256 (workspace_sessions).

export const SESSION_COOKIE = "__Host-ob-ws-session";
export const LOGIN_COOKIE = "__Host-ob-ws-login";

function cookie(name: string, value: string, maxAge: number, sameSite: "Strict" | "Lax"): string {
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; Secure; HttpOnly; SameSite=${sameSite}`;
}

export const sessionCookie = (value: string, maxAge: number) => cookie(SESSION_COOKIE, value, maxAge, "Strict");
export const loginCookie = (value: string, maxAge = 600) => cookie(LOGIN_COOKIE, value, maxAge, "Lax");
export const clearSessionCookie = () => cookie(SESSION_COOKIE, "", 0, "Strict");
export const clearLoginCookie = () => cookie(LOGIN_COOKIE, "", 0, "Lax");

export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

// Where to land after sign-in: a path on this origin only (no scheme, no //host, no backslash).
export function safeReturnTo(v: string | undefined, fallback = "/workspace/"): string {
  const s = String(v ?? "").trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.includes("\\") || /[\u0000-\u001f]/.test(s) || s.length > 500) return fallback;
  return s;
}
