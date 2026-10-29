// Sign-in with Authentik (rw-identity, 07-MULTI-USER; operator 2026-10-28): the research front end
// signs its users in itself, with OpenID Connect - the authorization code flow with PKCE (S256), a
// state bound to the browser that started it and a nonce bound into the ID token - exactly as Open
// WebUI does for its own users (frontend/docker-compose.yml, edge-b3-oidc: env-only provider
// settings, nothing kept in a database or a UI).
//
// SHIPPED INERT. With WORKSPACE_OIDC_ISSUER, WORKSPACE_OIDC_CLIENT_ID and WORKSPACE_OIDC_REDIRECT_URI
// all blank there is no sign-in and the identity seam behaves exactly as before (one default identity,
// WORKSPACE_DEFAULT_SUB). Setting SOME of them is refused at start-up (a half-configured sign-in never
// silently falls back to the single-user mode). The issuer must be https: the discovery document,
// the token endpoint and the signing keys are fetched from it.
//
// Everything here is pure or takes its fetch as a parameter, so it is unit-tested without a network
// (src/identity/identity_test.ts); the lab (contract-test/run-identity-tests.ps1) runs the whole flow
// against a stub OpenID provider over TLS.

export interface OidcConfig {
  issuer: string; // exactly the provider's `iss` (Authentik: https://<host>/application/o/<slug>/)
  clientId: string;
  clientSecret: string; // blank = a public client (PKCE alone)
  redirectUri: string; // https://<the edge>/workbench/auth/callback
  scopes: string;
  adminGroup: string; // blank = nobody is an admin
  postLogoutUri: string; // blank = no provider logout redirect
  sessionSeconds: number;
}

const OIDC_VARS = ["WORKSPACE_OIDC_ISSUER", "WORKSPACE_OIDC_CLIENT_ID", "WORKSPACE_OIDC_REDIRECT_URI"] as const;

export function oidcConfig(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): OidcConfig | null {
  const v = (k: string) => (env(k) ?? "").trim();
  const set = OIDC_VARS.filter((k) => v(k));
  const extra = ["WORKSPACE_OIDC_CLIENT_SECRET", "WORKSPACE_OIDC_ADMIN_GROUP", "WORKSPACE_OIDC_POST_LOGOUT_URI"].filter((k) => v(k));
  if (!set.length && !extra.length) return null;
  if (set.length !== OIDC_VARS.length) {
    const missing = OIDC_VARS.filter((k) => !v(k));
    throw new Error(`sign-in is half configured: set ${missing.join(", ")} too, or clear every WORKSPACE_OIDC_* variable`);
  }
  let iss: URL;
  try { iss = new URL(v("WORKSPACE_OIDC_ISSUER")); } catch { throw new Error("WORKSPACE_OIDC_ISSUER is not a URL"); }
  if (iss.protocol !== "https:") throw new Error("WORKSPACE_OIDC_ISSUER must be https (its keys and tokens are fetched from it)");
  try { new URL(v("WORKSPACE_OIDC_REDIRECT_URI")); } catch { throw new Error("WORKSPACE_OIDC_REDIRECT_URI is not a URL"); }
  const hours = Number(v("WORKSPACE_SESSION_HOURS") || "12");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) throw new Error("WORKSPACE_SESSION_HOURS must be between 0 and 720");
  return {
    issuer: v("WORKSPACE_OIDC_ISSUER"),
    clientId: v("WORKSPACE_OIDC_CLIENT_ID"),
    clientSecret: v("WORKSPACE_OIDC_CLIENT_SECRET"),
    redirectUri: v("WORKSPACE_OIDC_REDIRECT_URI"),
    scopes: v("WORKSPACE_OIDC_SCOPES") || "openid profile email",
    adminGroup: v("WORKSPACE_OIDC_ADMIN_GROUP"),
    postLogoutUri: v("WORKSPACE_OIDC_POST_LOGOUT_URI"),
    sessionSeconds: Math.round(hours * 3600),
  };
}

// ── encodings ─────────────────────────────────────────────────────────────────────────────────
export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256b64url(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

// ── PKCE (RFC 7636, S256 only) ────────────────────────────────────────────────────────────────
export async function challengeOf(verifier: string): Promise<string> {
  return await sha256b64url(verifier);
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48); // 64 characters, inside RFC 7636's 43..128
  return { verifier, challenge: await challengeOf(verifier) };
}

// ── discovery ─────────────────────────────────────────────────────────────────────────────────
export interface ProviderMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
async function fetchJson(f: Fetch, url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) throw new OidcError(`the provider answered ${r.status} for ${new URL(url).pathname}: ${String(body.error ?? text).slice(0, 200)}`);
  return body;
}

export class OidcError extends Error {}

export async function discover(cfg: OidcConfig, f: Fetch = fetch): Promise<ProviderMeta> {
  const url = cfg.issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";
  const m = await fetchJson(f, url) as unknown as ProviderMeta;
  // OpenID Connect Discovery 1.0 section 4.3: the document's issuer is the configured one, exactly
  if (m.issuer !== cfg.issuer) throw new OidcError(`the provider's issuer ${m.issuer} is not WORKSPACE_OIDC_ISSUER`);
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof m[k] !== "string" || !/^https:\/\//.test(m[k])) throw new OidcError(`the provider's ${k} is missing or not https`);
  }
  return m;
}

export function authorizeUrl(meta: ProviderMeta, cfg: OidcConfig, p: { state: string; nonce: string; challenge: string }): string {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes.split(/\s+/).includes("openid") ? cfg.scopes : `openid ${cfg.scopes}`);
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeCode(meta: ProviderMeta, cfg: OidcConfig, code: string, verifier: string, f: Fetch = fetch): Promise<{ id_token: string }> {
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (cfg.clientSecret) {
    // client_secret_basic (RFC 6749 2.3.1: each part form-encoded first)
    headers.authorization = "Basic " + btoa(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`);
  } else {
    form.set("client_id", cfg.clientId);
  }
  const body = await fetchJson(f, meta.token_endpoint, { method: "POST", headers, body: form.toString() });
  if (typeof body.id_token !== "string") throw new OidcError("the token response carries no id_token");
  return { id_token: body.id_token };
}

// ── the ID token ──────────────────────────────────────────────────────────────────────────────
export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface Claims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  azp?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  groups?: unknown;
  [k: string]: unknown;
}

export interface VerifyInput {
  issuer: string;
  audience: string;
  nonce: string;
  keys: Jwk[];
  clientSecret?: string;
  now?: number; // seconds
  skew?: number; // seconds
}

async function verifyKey(alg: string, jwk: Jwk | null, secret: string | undefined): Promise<{ key: CryptoKey; algo: AlgorithmIdentifier | EcdsaParams }> {
  if (alg === "RS256") {
    if (!jwk || jwk.kty !== "RSA") throw new OidcError("no RSA signing key for the ID token");
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return { key, algo: { name: "RSASSA-PKCS1-v1_5" } };
  }
  if (alg === "ES256") {
    if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256") throw new OidcError("no P-256 signing key for the ID token");
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { key, algo: { name: "ECDSA", hash: "SHA-256" } };
  }
  if (alg === "HS256") {
    // Authentik signs with the client secret when the provider has no signing key selected
    if (!secret) throw new OidcError("an HS256 ID token needs WORKSPACE_OIDC_CLIENT_SECRET");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return { key, algo: { name: "HMAC" } };
  }
  throw new OidcError(`ID token algorithm ${alg} is not accepted (RS256, ES256, HS256)`);
}

// OpenID Connect Core 1.0 section 3.1.3.7: signature, iss, aud (+ azp), exp, iat, nonce.
export async function verifyIdToken(jwt: string, v: VerifyInput): Promise<Claims> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new OidcError("the ID token is not a signed JWT");
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: Claims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    throw new OidcError("the ID token cannot be decoded");
  }
  const alg = String(header.alg ?? "");
  let jwk: Jwk | null = null;
  if (alg !== "HS256") {
    const candidates = v.keys.filter((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig"));
    jwk = candidates.length === 1 || header.kid ? candidates[0] ?? null : null;
    if (!jwk) throw new OidcError(header.kid ? `no provider key with kid ${header.kid}` : "the ID token names no key and the provider has several");
  }
  const { key, algo } = await verifyKey(alg, jwk, v.clientSecret);
  const ok = await crypto.subtle.verify(algo, key, fromB64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new OidcError("the ID token's signature does not verify");
  const now = v.now ?? Math.floor(Date.now() / 1000);
  const skew = v.skew ?? 60;
  if (claims.iss !== v.issuer) throw new OidcError("the ID token's issuer is not the configured one");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(v.audience)) throw new OidcError("the ID token is not for this client");
  if (aud.length > 1 && claims.azp !== v.audience) throw new OidcError("the ID token's azp is not this client");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new OidcError("the ID token has expired");
  if (typeof claims.iat !== "number" || claims.iat - skew > now) throw new OidcError("the ID token is issued in the future");
  if (!v.nonce || claims.nonce !== v.nonce) throw new OidcError("the ID token's nonce is not this sign-in's");
  if (typeof claims.sub !== "string" || !validSubject(claims.sub)) throw new OidcError("the ID token's subject is not usable");
  return claims;
}

// A user's subject: what the provider says, printable, never one of the reserved service forms.
export function validSubject(s: string): boolean {
  return s.length > 0 && s.length <= 255 && !/[\u0000-\u001f\u007f]/.test(s) && !/^(service|system):/i.test(s);
}

export function groupsOf(c: Claims): string[] {
  return Array.isArray(c.groups) ? c.groups.filter((g): g is string => typeof g === "string") : [];
}

export function displayName(c: Claims): string {
  return String(c.name || c.preferred_username || c.email || c.sub).slice(0, 200);
}

// The provider's keys, cached; an unknown kid refetches once (key rotation).
export class Provider {
  #meta: ProviderMeta | null = null;
  #keys: Jwk[] = [];
  constructor(readonly cfg: OidcConfig, private f: Fetch = fetch) {}
  async meta(): Promise<ProviderMeta> {
    if (!this.#meta) this.#meta = await discover(this.cfg, this.f);
    return this.#meta;
  }
  async keys(force = false): Promise<Jwk[]> {
    if (force || !this.#keys.length) {
      const j = await fetchJson(this.f, (await this.meta()).jwks_uri);
      this.#keys = Array.isArray(j.keys) ? j.keys as Jwk[] : [];
    }
    return this.#keys;
  }
  async verify(idToken: string, nonce: string): Promise<Claims> {
    const input = (keys: Jwk[]) => ({ issuer: this.cfg.issuer, audience: this.cfg.clientId, nonce, keys, clientSecret: this.cfg.clientSecret });
    try {
      return await verifyIdToken(idToken, input(await this.keys()));
    } catch (e) {
      if (e instanceof OidcError && /no provider key with kid/.test(e.message)) return await verifyIdToken(idToken, input(await this.keys(true)));
      throw e;
    }
  }
  async exchange(code: string, verifier: string) {
    return await exchangeCode(await this.meta(), this.cfg, code, verifier, this.f);
  }
}
