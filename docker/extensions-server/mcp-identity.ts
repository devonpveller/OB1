// mcp-identity.ts - WHO a request to this MCP server acts for (research-workbench rw-mcp-identity, operator 2026-11-04:
// "after this is deployed its per user. Can't put that off").
//
// One file, two servers: openbrain-mcp (integrations/kubernetes-deployment) and openbrain-ext (docker/extensions-server)
// carry byte-identical copies (mcp-identity.test.ts refuses a drift). No import but node:async_hooks, so the copy is
// self-contained.
//
// THE LANES, by key (x-brain-key, or ?key=):
//   MCP_ACCESS_KEY           full lane. The operator's own clients (Claude Code / Desktop through openbrain-gateway,
//                            agent-bridge, OB1 services). It acts as the operator: subject = WORKSPACE_DEFAULT_SUB (the
//                            operator's REAL subject; blank = no identity, never the placeholder word "operator").
//   MCP_PERSONAL_ACCESS_KEY  personal lane (openbrain-mcpo). mcpo cannot carry a user (one shared upstream session), so
//                            this lane has NO identity: shared rows only, every write refused.
//   MCP_OWUI_ACCESS_KEY      owui lane. Held only by Open WebUI's native MCP connection, which ALSO sends the signed-in
//                            user's Authentik access token (auth_type system_oauth: Authorization: Bearer <jwt>).
//                            Subject = the token's `sub` (the Authentik subject, the identity seam's key) after the
//                            signature (RS256 / ES256 over a STATIC JWKS from configuration: no fetch, no egress), the
//                            issuer, the audience and the times are checked. No token = no identity (shared only, no
//                            writes); a token that fails any check = 401, never a downgrade.
//
// FORGED IDENTITY IS REFUSED, NEVER IGNORED: identity material (an Authorization header, x-on-behalf-of,
// x-openwebui-user-*, x-authentik-*, x-ob-user / x-ob-subject, x-user-id) on the full or personal lane is 403; on the owui
// lane only the bearer token may name a user, so the others are 403 there too.
//
// THE SUBJECT IS HELD PER REQUEST in an AsyncLocalStorage (callerStore.run around the request); currentCaller() throws
// outside a request, so no code path can fall back to a default subject by accident.

import { AsyncLocalStorage } from "node:async_hooks";

export type Lane = "full" | "personal" | "owui";

export interface Caller {
  lane: Lane;
  /** The subject this request acts for, or null = no verified identity (shared rows only, every write refused). */
  subject: string | null;
  /** How the subject was established. */
  via: "operator-key" | "token" | "none";
  /** True when the subject is the operator's (WORKSPACE_DEFAULT_SUB). */
  operator: boolean;
}

export interface OidcConfig {
  issuer: string;
  audience: string;
  keys: JsonWebKey[];
}

export interface IdentityConfig {
  fullKey: string;
  personalKey: string;
  owuiKey: string;
  /** The operator's subject (WORKSPACE_DEFAULT_SUB), or null when it is not set. */
  operatorSub: string | null;
  oidc: OidcConfig | null;
  warnings: string[];
}

const PLACEHOLDER = "operator";
const LEEWAY_SEC = 60;

/** The identity seam's subject rule (workbench onBehalfSubject) plus: never the seam's placeholder word. */
export function validSubject(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s !== raw || s.length > 256) return null;
  if (/[\x00-\x1f\x7f\s]/.test(s)) return null;
  if (/^(service|system|anonymous):/i.test(s)) return null;
  if (s.toLowerCase() === PLACEHOLDER) return null;
  return s;
}

function sameKey(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Read the configuration once at start. Throws (the server must not start) on a half-configured owui lane, a key reused
 * across lanes, an invalid WORKSPACE_DEFAULT_SUB, or a JWKS with no usable key.
 */
export function loadIdentityConfig(get: (k: string) => string | undefined): IdentityConfig {
  const warnings: string[] = [];
  const fullKey = (get("MCP_ACCESS_KEY") ?? "").trim();
  let personalKey = (get("MCP_PERSONAL_ACCESS_KEY") ?? "").trim();
  const owuiKey = (get("MCP_OWUI_ACCESS_KEY") ?? "").trim();
  if (personalKey && sameKey(personalKey, fullKey)) {
    warnings.push("MCP_PERSONAL_ACCESS_KEY equals MCP_ACCESS_KEY and is IGNORED: the personal lane is off.");
    personalKey = "";
  }
  const rawDefault = get("WORKSPACE_DEFAULT_SUB") ?? "";
  let operatorSub: string | null = null;
  if (rawDefault.trim()) {
    operatorSub = validSubject(rawDefault.trim());
    if (!operatorSub) {
      throw new Error("WORKSPACE_DEFAULT_SUB is not a usable subject (blank, the placeholder 'operator', a reserved prefix, white space or > 256 chars)");
    }
  } else {
    warnings.push("WORKSPACE_DEFAULT_SUB is not set: the full lane has NO identity (shared rows only, every write refused).");
  }
  const issuer = (get("MCP_OWUI_OIDC_ISSUER") ?? "").trim();
  const audience = (get("MCP_OWUI_OIDC_AUDIENCE") ?? "").trim();
  const jwksRaw = (get("MCP_OWUI_OIDC_JWKS") ?? "").trim();
  const anyOwui = !!(owuiKey || issuer || audience || jwksRaw);
  let oidc: OidcConfig | null = null;
  if (anyOwui) {
    const missing = [
      ["MCP_OWUI_ACCESS_KEY", owuiKey], ["MCP_OWUI_OIDC_ISSUER", issuer], ["MCP_OWUI_OIDC_AUDIENCE", audience],
      ["MCP_OWUI_OIDC_JWKS", jwksRaw],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`the owui lane is half-configured: ${missing.join(", ")} not set (set all four, or none)`);
    if (owuiKey.length < 32) throw new Error("MCP_OWUI_ACCESS_KEY is shorter than 32 characters");
    if (sameKey(owuiKey, fullKey) || (personalKey && sameKey(owuiKey, personalKey))) {
      throw new Error("MCP_OWUI_ACCESS_KEY must differ from MCP_ACCESS_KEY and MCP_PERSONAL_ACCESS_KEY");
    }
    if (!operatorSub) throw new Error("the owui lane needs WORKSPACE_DEFAULT_SUB (the operator's subject) to tell the operator from other users");
    if (!/^https:\/\//.test(issuer)) throw new Error("MCP_OWUI_OIDC_ISSUER must be an https URL");
    let doc: unknown;
    try { doc = JSON.parse(jwksRaw); } catch { throw new Error("MCP_OWUI_OIDC_JWKS is not JSON"); }
    const all = (doc && typeof doc === "object" && Array.isArray((doc as { keys?: unknown }).keys))
      ? (doc as { keys: JsonWebKey[] }).keys : [];
    const keys = all.filter((k) => k && typeof k === "object" && (k.kty === "RSA" || (k.kty === "EC" && k.crv === "P-256")) &&
      (!k.use || k.use === "sig") && !("d" in k));
    if (!keys.length) throw new Error("MCP_OWUI_OIDC_JWKS has no usable public signing key (RSA, or EC P-256)");
    oidc = { issuer, audience, keys };
  }
  if (!fullKey) throw new Error("MCP_ACCESS_KEY is not set");
  return { fullKey, personalKey, owuiKey, operatorSub, oidc, warnings };
}

/** Which lane a key opens, or null (401). */
export function laneOf(provided: string | null | undefined, cfg: IdentityConfig): Lane | null {
  if (!provided) return null;
  if (sameKey(provided, cfg.fullKey)) return "full";
  if (cfg.personalKey && sameKey(provided, cfg.personalKey)) return "personal";
  if (cfg.owuiKey && sameKey(provided, cfg.owuiKey)) return "owui";
  return null;
}

/** Headers that name a user. Only the owui lane's bearer token may; anything else carrying one is refused. */
const IDENTITY_HEADER = /^(x-on-behalf-of|x-openwebui-user-.*|x-authentik-.*|x-ob-(user|subject|sub)(-.*)?|x-user-id|x-forwarded-user|x-remote-user|remote-user)$/i;

export type Resolution = { ok: true; caller: Caller } | { ok: false; status: 401 | 403; error: string };

/**
 * Resolve the caller of one request. `headerNames` lists every header name on the request; `header` reads one.
 * `nowSec` is injectable for tests.
 */
export async function resolveCaller(
  header: (n: string) => string | undefined | null,
  headerNames: string[],
  queryKey: string | null,
  cfg: IdentityConfig,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<Resolution> {
  const lane = laneOf(header("x-brain-key") || queryKey, cfg);
  if (!lane) return { ok: false, status: 401, error: "Invalid or missing access key" };
  const named = headerNames.filter((n) => IDENTITY_HEADER.test(n));
  if (named.length) {
    return { ok: false, status: 403, error: `refused: this request names a user in ${named.join(", ")}; only Open WebUI's signed-in user token may name a user` };
  }
  const auth = header("authorization");
  if (lane === "full") {
    if (auth) return { ok: false, status: 403, error: "refused: the full lane acts as the operator; it never takes an Authorization header" };
    return { ok: true, caller: { lane, subject: cfg.operatorSub, via: cfg.operatorSub ? "operator-key" : "none", operator: !!cfg.operatorSub } };
  }
  if (lane === "personal") {
    if (auth) return { ok: false, status: 403, error: "refused: the personal lane carries no user; it never takes an Authorization header" };
    return { ok: true, caller: { lane, subject: null, via: "none", operator: false } };
  }
  // owui
  if (!auth) return { ok: true, caller: { lane, subject: null, via: "none", operator: false } };
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth);
  if (!m) return { ok: false, status: 401, error: "refused: the Authorization header is not a bearer JWT" };
  try {
    const sub = await verifyUserToken(m[1], cfg.oidc!, nowSec);
    const operator = !!cfg.operatorSub && sub === cfg.operatorSub;
    return { ok: true, caller: { lane, subject: sub, via: "token", operator } };
  } catch (e) {
    return { ok: false, status: 401, error: `refused: the user token is not valid (${(e as Error).message})` };
  }
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : s.length % 4 === 0 ? "" : null;
  if (pad === null) throw new Error("bad base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> {
  const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64urlBytes(s)));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
  return v as Record<string, unknown>;
}

const ALGS: Record<string, { kty: string; imp: RsaHashedImportParams | EcKeyImportParams; ver: AlgorithmIdentifier | EcdsaParams }> = {
  RS256: { kty: "RSA", imp: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, ver: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", imp: { name: "ECDSA", namedCurve: "P-256" }, ver: { name: "ECDSA", hash: "SHA-256" } },
};

/** Verify an Authentik access token; returns its subject or throws a short reason (never the token). */
export async function verifyUserToken(token: string, oidc: OidcConfig, nowSec: number): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWS");
  let head: Record<string, unknown>, claims: Record<string, unknown>;
  try { head = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw new Error("unreadable"); }
  const alg = typeof head.alg === "string" ? head.alg : "";
  const spec = ALGS[alg];
  if (!spec) throw new Error(`algorithm ${alg || "missing"} is not accepted`);
  if (head.crit !== undefined) throw new Error("crit header not supported");
  const kid = typeof head.kid === "string" ? head.kid : null;
  const cands = oidc.keys.filter((k) => k.kty === spec.kty && (kid === null ? true : (k as { kid?: string }).kid === kid) &&
    (!(k as { alg?: string }).alg || (k as { alg?: string }).alg === alg));
  if (!cands.length) throw new Error("no matching key");
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let sig: Uint8Array<ArrayBuffer>;
  try { sig = b64urlBytes(parts[2]); } catch { throw new Error("unreadable signature"); }
  let good = false;
  for (const jwk of cands) {
    try {
      const { kid: _k, alg: _a, use: _u, key_ops: _o, ...pub } = jwk as Record<string, unknown>;
      const key = await crypto.subtle.importKey("jwk", pub as JsonWebKey, spec.imp, false, ["verify"]);
      if (await crypto.subtle.verify(spec.ver, key, sig, data)) { good = true; break; }
    } catch { /* try the next key */ }
  }
  if (!good) throw new Error("bad signature");
  if (claims.iss !== oidc.issuer) throw new Error("wrong issuer");
  const aud = claims.aud;
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.includes(oidc.audience)) throw new Error("wrong audience");
  if (claims.azp !== undefined && claims.azp !== oidc.audience) throw new Error("wrong authorized party");
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new Error("no expiry");
  if (exp + LEEWAY_SEC < nowSec) throw new Error("expired");
  for (const k of ["nbf", "iat"]) {
    const v = claims[k];
    if (v !== undefined && (typeof v !== "number" || v - LEEWAY_SEC > nowSec)) throw new Error(`${k} in the future`);
  }
  const sub = validSubject(claims.sub);
  if (!sub) throw new Error("no usable subject");
  return sub;
}

export const callerStore = new AsyncLocalStorage<Caller>();

/** The caller of the request being served. Throws outside a request: there is no default subject. */
export function currentCaller(): Caller {
  const c = callerStore.getStore();
  if (!c) throw new Error("no request identity in scope (refused: there is no default subject)");
  return c;
}

export const NO_IDENTITY_WRITE =
  "Refused: this request carries no verified user identity, so it can read shared material only and cannot write. " +
  "In Open WebUI, sign in with SSO (the Open Brain connection sends your sign-in); nothing was written.";

/** The subject a write is stamped with; throws the refusal when the request has no identity. */
export function writerSubject(): string {
  const s = currentCaller().subject;
  if (!s) throw new Error(NO_IDENTITY_WRITE);
  return s;
}

/**
 * openbrain-ext's row owner (a UUID column): the operator keeps DEFAULT_USER_ID (the existing rows); any other subject
 * gets a stable UUIDv5 of its subject in a fixed namespace, so each user has their own rows.
 */
export const EXT_USER_NAMESPACE = "6f1b3c2e-9a4d-5e8f-b7c6-0d1e2f3a4b5c";
export async function extUserId(subject: string, operatorSub: string | null, defaultUserId: string): Promise<string> {
  if (operatorSub && subject === operatorSub) return defaultUserId;
  return await uuidV5(EXT_USER_NAMESPACE, subject);
}

/** RFC 4122 name-based UUID, version 5 (SHA-1). */
export async function uuidV5(namespace: string, nameText: string): Promise<string> {
  const ns = namespace.replace(/-/g, "");
  const nsBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  const name = new TextEncoder().encode(nameText);
  const buf = new Uint8Array(16 + name.length);
  buf.set(nsBytes, 0); buf.set(name, 16);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
