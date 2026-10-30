// Who is signed in (rw-identity). The workbench answers GET /workbench/auth/me before the workspace
// renders: with sign-in configured (mode "forward-auth", rw-identity2) and no valid Authentik token on
// the request, the workspace shows the sign-in screen and nothing else; without sign-in (mode "default"
// / "header") it renders as before. An older workbench without /workbench/auth answers 404: treated as
// no sign-in, exactly as before. Authentik signs users in and out at the edge (Traefik forward-auth):
// signing in is loading the page through the edge again; signing out is a link to Authentik's outpost
// sign-out (`logout`). Nothing here decides who the user is - the workbench's identity seam does.
import { get, post } from "./api";

export const A = "/workbench/auth";

export interface Me {
  mode: "forward-auth" | "header" | "default";
  signed_in: boolean;
  kind: string;
  subject_sub: string | null;
  actor_sub: string | null;
  name: string;
  actor_name: string;
  admin: boolean;
  impersonating: { sub: string; name: string; reason: string; since: string; until?: string | null } | null;
  logout: string | null; // Authentik's sign-out URL (forward-auth), else null
}

let me: Me | null = null;

export function setMe(m: Me | null) {
  me = m;
}

export function currentMe(): Me | null {
  return me;
}

export async function loadMe(): Promise<Me | null> {
  try {
    me = await get<Me>(`${A}/me`);
  } catch {
    me = null;
  }
  return me;
}

export function needsSignIn(m: Me | null): boolean {
  return !!m && m.mode === "forward-auth" && !m.signed_in;
}

// Sign in = this page again, through the edge (Authentik's forward-auth sends an unsigned-in browser to
// its own sign-in and back). Only a path on this origin.
export function signInHref(here: string): string {
  const s = String(here || "");
  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") ? s : "/workspace/";
}

// Sign out = Authentik's (the outpost's sign-out ends the Authentik session for this application).
export function signOutHref(m: Me | null): string {
  return m?.logout || "/outpost.goauthentik.io/sign_out";
}

// The reason rule (the workbench's src/identity/reason.ts): REASON_MIN visible characters, one a letter
// or digit; zero-width characters and white space do not count.
export const REASON_MIN = 8;
const INVISIBLE = /[\s\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu;
const FILLERS = new Set(["\u115f", "\u1160", "\u3164", "\uffa0"]);
// round 5: letters and digits only, by Unicode category (the Hangul fillers excluded)
export function reasonOk(reason: string): boolean {
  void INVISIBLE;
  let n = 0;
  for (const ch of reason.normalize("NFC")) if (/[\p{L}\p{N}]/u.test(ch) && !FILLERS.has(ch)) n++;
  return n >= REASON_MIN;
}

// The reason is required BEFORE anything is sent (the workbench refuses without one as well).
export async function impersonate(sub: string, reason: string) {
  if (!sub) throw new Error("choose the user to impersonate");
  if (!reasonOk(reason)) throw new Error(`a reason is required (at least ${REASON_MIN} visible characters)`);
  return await post(`${A}/impersonate`, { sub, reason: reason.trim() });
}

export async function endImpersonation() {
  return await post(`${A}/impersonate/end`);
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_sub: string;
  subject_sub: string;
  action: string;
  reason: string | null;
  method: string | null;
  route: string | null;
}

export async function users(): Promise<{ sub: string; name: string; email: string; is_admin: boolean }[]> {
  return (await get(`${A}/users`)).users ?? [];
}

export async function auditLog(f: { actor?: string; subject?: string; action?: string; limit?: number } = {}): Promise<AuditEntry[]> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") q.set(k, String(v));
  return (await get(`${A}/audit?${q}`)).entries ?? [];
}
