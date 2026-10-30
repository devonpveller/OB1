// Sign-in by Authentik forward-auth (rw-identity2, operator 2026-10-29: "forward-auth, yes"). The
// workbench signs nobody in itself: the operator's Traefik guards /workbench (and the viewer pages that
// serve it) with Authentik's forward-auth middleware (a proxy provider), so Authentik alone does the
// sign-in, its session, MFA and the sign-out. On every request it lets through, the Authentik outpost
// hands Traefik `X-authentik-jwt` - the ID token the outpost got for the signed-in user in its own code
// flow against the proxy provider - and Traefik copies it onto the request (authResponseHeaders). The
// viewer's /workbench forwarder passes it on unchanged. This module verifies it, on EVERY request.
//
// What Authentik signs it with (checked in Authentik 2026.8.5's source and docs, rw-identity findings
// "Round 7"): a proxy provider has NO signing key (`ProxyProvider.set_oauth_defaults()` sets
// `signing_key = None` on every create and update), so its ID token is HS256 with the provider's CLIENT
// SECRET and its JWKS is empty. So the key here is that client secret (WORKSPACE_FORWARD_AUTH_CLIENT_SECRET,
// held only in OB1/docker/.env) and the ONLY algorithm accepted is HS256: `alg: none`, RS256 / ES256 (and
// so the RS256-with-the-secret key confusion), HS384 / HS512 and anything else are refused by jose's
// allow-list before a signature is computed. Then iss (exactly WORKSPACE_FORWARD_AUTH_ISSUER), aud (the
// proxy provider's client id), exp (required; 30 s clock skew), iat (required) and a usable sub. The
// unsigned X-authentik-username / -uid / -groups headers are NEVER read: only the token's claims count.
// Admin = WORKSPACE_FORWARD_AUTH_ADMIN_GROUP in the token's `groups`, read from the token on every request
// (a user removed from the group in Authentik is not an admin once the outpost's next token says so;
// the token lives at most the provider's token validity - the deploy notes say so).
//
// SHIPPED INERT. With WORKSPACE_FORWARD_AUTH_ISSUER, _CLIENT_ID and _CLIENT_SECRET all blank there is no
// sign-in (one default identity, WORKSPACE_DEFAULT_SUB - exactly P2b). Setting only some is refused at
// start-up, as is a secret under 32 characters or any retired WORKSPACE_OIDC_* variable (the in-app
// OIDC sign-in is gone; a leftover value must not look like a sign-in that is on).
// Neither the secret nor a token is ever logged or returned.
import { jwtVerify } from "jose";

export const TOKEN_HEADER = "x-authentik-jwt";
// Authentik's outpost sign-out, on the host the outpost serves (single-application forward auth)
export const DEFAULT_SIGN_OUT = "/outpost.goauthentik.io/sign_out";
const SKEW_SECONDS = 30;
const MAX_TOKEN = 16384;

export interface ForwardAuthConfig {
  issuer: string; // exactly the token's `iss` (Authentik: https://<authentik>/application/o/<slug>/)
  audience: string; // the proxy provider's client id = the token's `aud`
  secret: Uint8Array; // the proxy provider's client secret (HS256 key)
  adminGroup: string; // blank = nobody is an admin
  signOutUrl: string; // where the workspace's Sign out goes (Authentik's outpost sign-out)
  impersonationMinutes: number; // an impersonation ends by itself after this long
}

const VARS = ["WORKSPACE_FORWARD_AUTH_ISSUER", "WORKSPACE_FORWARD_AUTH_CLIENT_ID", "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET"] as const;
const OPTIONAL = ["WORKSPACE_FORWARD_AUTH_ADMIN_GROUP", "WORKSPACE_FORWARD_AUTH_SIGN_OUT_URL"] as const;
const RETIRED = ["WORKSPACE_OIDC_ISSUER", "WORKSPACE_OIDC_CLIENT_ID", "WORKSPACE_OIDC_CLIENT_SECRET", "WORKSPACE_OIDC_REDIRECT_URI",
  "WORKSPACE_OIDC_ADMIN_GROUP", "WORKSPACE_OIDC_POST_LOGOUT_URI", "WORKSPACE_OIDC_SCOPES", "WORKSPACE_SESSION_HOURS"] as const;

export function forwardAuthConfig(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): ForwardAuthConfig | null {
  const v = (k: string) => (env(k) ?? "").trim();
  const retired = RETIRED.filter((k) => v(k));
  if (retired.length) {
    throw new Error(`${retired.join(", ")}: the in-app OIDC sign-in was removed (rw-identity2) - sign-in is Authentik forward-auth now (WORKSPACE_FORWARD_AUTH_*); clear these`);
  }
  const set = VARS.filter((k) => v(k));
  if (!set.length && !OPTIONAL.some((k) => v(k))) return null;
  if (set.length !== VARS.length) {
    throw new Error(`forward-auth sign-in is half configured: set ${VARS.filter((k) => !v(k)).join(", ")} too, or clear every WORKSPACE_FORWARD_AUTH_* variable`);
  }
  try { new URL(v("WORKSPACE_FORWARD_AUTH_ISSUER")); } catch { throw new Error("WORKSPACE_FORWARD_AUTH_ISSUER is not a URL (it is the token's iss, exactly)"); }
  if (v("WORKSPACE_FORWARD_AUTH_CLIENT_SECRET").length < 32) throw new Error("WORKSPACE_FORWARD_AUTH_CLIENT_SECRET must be at least 32 characters (Authentik's are 128)");
  const signOut = v("WORKSPACE_FORWARD_AUTH_SIGN_OUT_URL") || DEFAULT_SIGN_OUT;
  if (!(signOut.startsWith("/") && !signOut.startsWith("//")) && !/^https?:\/\/[^\s]+$/.test(signOut)) {
    throw new Error("WORKSPACE_FORWARD_AUTH_SIGN_OUT_URL must be a path on this origin or an http(s) URL");
  }
  const minutes = Number(v("WORKSPACE_IMPERSONATION_MINUTES") || "60");
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error("WORKSPACE_IMPERSONATION_MINUTES must be between 1 and 1440");
  return {
    issuer: v("WORKSPACE_FORWARD_AUTH_ISSUER"),
    audience: v("WORKSPACE_FORWARD_AUTH_CLIENT_ID"),
    secret: new TextEncoder().encode(v("WORKSPACE_FORWARD_AUTH_CLIENT_SECRET")),
    adminGroup: v("WORKSPACE_FORWARD_AUTH_ADMIN_GROUP"),
    signOutUrl: signOut,
    impersonationMinutes: Math.round(minutes),
  };
}

export interface ForwardClaims {
  sub: string;
  name: string;
  email: string;
  groups: string[];
}

// A user's subject: what Authentik says, printable, never one of the reserved non-user forms.
export function validSubject(s: string): boolean {
  return s.length > 0 && s.length <= 255 && !/[\u0000-\u001f\u007f]/.test(s) && !/^(service|system|anonymous):/i.test(s);
}

// The verified claims of the request's token, or null (no token, or any check failed). `why` gets a
// short reason for the log - never the token.
export async function verifyForwardToken(token: string, cfg: ForwardAuthConfig, why?: (reason: string) => void): Promise<ForwardClaims | null> {
  if (!token) return null;
  if (token.length > MAX_TOKEN) { why?.("token too long"); return null; }
  try {
    const { payload } = await jwtVerify(token, cfg.secret, {
      algorithms: ["HS256"],
      issuer: cfg.issuer,
      audience: cfg.audience,
      clockTolerance: SKEW_SECONDS,
      requiredClaims: ["sub", "exp", "iat"],
    });
    // jose checks exp and nbf; a token issued in the future (beyond the skew) is refused here
    if (typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + SKEW_SECONDS) { why?.("iat in the future"); return null; }
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!validSubject(sub)) { why?.("subject not usable"); return null; }
    const str = (k: string) => (typeof payload[k] === "string" ? payload[k] as string : "");
    const groups = Array.isArray(payload.groups) ? (payload.groups as unknown[]).filter((g): g is string => typeof g === "string") : [];
    return {
      sub,
      name: (str("name") || str("preferred_username") || str("email") || sub).slice(0, 200),
      email: str("email").slice(0, 200),
      groups,
    };
  } catch (e) {
    // the error code and, for a claim check, WHICH claim (iss / aud / exp ...) - never its value
    const x = e as { code?: string; claim?: string; name?: string };
    why?.(`${x.code ?? x.name ?? "invalid"}${x.claim ? ` (${x.claim})` : ""}`);
    return null;
  }
}

export function isAdmin(c: ForwardClaims, cfg: ForwardAuthConfig): boolean {
  return !!cfg.adminGroup && c.groups.includes(cfg.adminGroup);
}
