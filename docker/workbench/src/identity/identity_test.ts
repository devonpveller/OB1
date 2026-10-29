// deno test src/identity/identity_test.ts - rw-identity, the pure half (no network, no database): the
// sign-in's configuration is inert unless set and refused when half set; PKCE S256; the authorize URL;
// every ID-token check (signature RS256/ES256/HS256, alg none, issuer, audience, azp, expiry, nonce,
// reserved subjects); the cookies' attributes; the return_to guard; the key ring; the seam's modes
// (no sign-in = exactly the P2b seam; sign-in = the identity header ignored, no session = 401, a
// service has no user front end). The image build runs this file (the test stage's gate).
import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { authorizeUrl, b64url, challengeOf, oidcConfig, pkcePair, type ProviderMeta, verifyIdToken } from "./oidc.ts";
import { clearSessionCookie, loginCookie, readCookie, safeReturnTo, SESSION_COOKIE, sessionCookie } from "./cookies.ts";
import { keyKind, keyRing } from "./keys.ts";
import { identityConfig, identityOf, identitySeam, resolveIdentity, seamDeps } from "../middleware/identity.ts";

const env = (m: Record<string, string>) => (k: string) => m[k];
const OIDC = {
  WORKSPACE_OIDC_ISSUER: "https://auth.example/application/o/research/",
  WORKSPACE_OIDC_CLIENT_ID: "research-workspace",
  WORKSPACE_OIDC_REDIRECT_URI: "https://research.example/workbench/auth/callback",
};

Deno.test("config: no WORKSPACE_OIDC_* = no sign-in (inert as shipped)", () => {
  assertEquals(oidcConfig(env({})), null);
  assertEquals(identityConfig(env({})).signIn, false);
});

Deno.test("config: a half-configured sign-in refuses to start; http issuer refused", () => {
  assertThrows(() => oidcConfig(env({ WORKSPACE_OIDC_ISSUER: OIDC.WORKSPACE_OIDC_ISSUER })), Error, "half configured");
  assertThrows(() => oidcConfig(env({ WORKSPACE_OIDC_CLIENT_SECRET: "s" })), Error, "half configured");
  assertThrows(() => oidcConfig(env({ ...OIDC, WORKSPACE_OIDC_ISSUER: "http://auth.example/application/o/research/" })), Error, "https");
  const c = oidcConfig(env({ ...OIDC, WORKSPACE_OIDC_ADMIN_GROUP: "research-admins" }))!;
  assertEquals([c.clientId, c.adminGroup, c.scopes, c.sessionSeconds], ["research-workspace", "research-admins", "openid profile email", 12 * 3600]);
});

Deno.test("PKCE: S256 = base64url(SHA-256(verifier)) - the expected value computed independently with node:crypto; a fresh pair verifies", async () => {
  assertEquals(await challengeOf("dBjftJeZ4CVP-mA92Q9TV7tY8TlVN4u3ZxLpv6IiPcg"), "pnU7jgjM1aidWemVYNPDCPBjQV6c1_x_pp__d9-cGF0");
  const p = await pkcePair();
  assert(p.verifier.length >= 43 && p.verifier.length <= 128);
  assertEquals(await challengeOf(p.verifier), p.challenge);
});

Deno.test("authorize URL: code flow, S256 challenge, state, nonce, redirect, openid scope", () => {
  const meta: ProviderMeta = { issuer: OIDC.WORKSPACE_OIDC_ISSUER, authorization_endpoint: "https://auth.example/application/o/authorize/", token_endpoint: "https://auth.example/application/o/token/", jwks_uri: "https://auth.example/jwks" };
  const u = new URL(authorizeUrl(meta, oidcConfig(env(OIDC))!, { state: "st", nonce: "no", challenge: "ch" }));
  const q = Object.fromEntries(u.searchParams);
  assertEquals(q, { response_type: "code", client_id: "research-workspace", redirect_uri: OIDC.WORKSPACE_OIDC_REDIRECT_URI, scope: "openid profile email", state: "st", nonce: "no", code_challenge: "ch", code_challenge_method: "S256" });
});

// ── ID tokens ────────────────────────────────────────────────────────────────────────────────
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function rsa() {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", use: "sig", alg: "RS256" };
  const sign = async (header: Record<string, unknown>, claims: Record<string, unknown>) => {
    const data = `${enc(header)}.${enc(claims)}`;
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(data)));
    return `${data}.${b64url(sig)}`;
  };
  return { jwk, sign };
}
const now = Math.floor(Date.now() / 1000);
const good = { iss: OIDC.WORKSPACE_OIDC_ISSUER, aud: "research-workspace", sub: "ak-sub-alice", exp: now + 300, iat: now, nonce: "n-1", name: "Alice", groups: ["users"] };
const input = (keys: unknown[], extra: Record<string, unknown> = {}) => ({ issuer: OIDC.WORKSPACE_OIDC_ISSUER, audience: "research-workspace", nonce: "n-1", keys: keys as never, ...extra });

Deno.test("ID token: RS256 verifies; every claim check refuses", async () => {
  const k = await rsa();
  const h = { alg: "RS256", kid: "k1" };
  assertEquals((await verifyIdToken(await k.sign(h, good), input([k.jwk]))).sub, "ak-sub-alice");
  const refused = async (claims: Record<string, unknown>, msg: string, header: Record<string, unknown> = h) =>
    await assertRejects(async () => await verifyIdToken(await k.sign(header, claims), input([k.jwk])), Error, msg);
  await refused({ ...good, nonce: "n-other" }, "nonce");
  await refused({ ...good, nonce: undefined }, "nonce");
  await refused({ ...good, aud: "another-client" }, "not for this client");
  await refused({ ...good, aud: ["research-workspace", "x"], azp: "x" }, "azp");
  await refused({ ...good, iss: "https://evil.example/" }, "issuer");
  await refused({ ...good, exp: now - 3600 }, "expired");
  await refused({ ...good, iat: now + 3600 }, "future");
  await refused({ ...good, sub: "service:internal" }, "subject");
  await refused({ ...good, sub: "" }, "subject");
  await refused(good, "kid", { alg: "RS256", kid: "unknown" });
  // a valid token with one byte of its payload changed
  const t = await k.sign(h, good);
  const [a, b, c] = t.split(".");
  const tampered = `${a}.${enc({ ...good, sub: "ak-sub-mallory" })}.${c}`;
  void b;
  await assertRejects(() => verifyIdToken(tampered, input([k.jwk])), Error, "signature");
  // alg none: never
  await assertRejects(() => verifyIdToken(`${enc({ alg: "none" })}.${enc(good)}.`, input([k.jwk])), Error, "not accepted");
  // another key's signature
  const other = await rsa();
  await assertRejects(async () => verifyIdToken(await other.sign(h, good), input([k.jwk])), Error, "signature");
});

Deno.test("ID token: ES256 and HS256 (Authentik without a signing key signs with the client secret)", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "e1" };
  const data = `${enc({ alg: "ES256", kid: "e1" })}.${enc(good)}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(data)));
  assertEquals((await verifyIdToken(`${data}.${b64url(sig)}`, input([jwk]))).sub, "ak-sub-alice");
  const hk = await crypto.subtle.importKey("raw", new TextEncoder().encode("client-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hd = `${enc({ alg: "HS256" })}.${enc(good)}`;
  const hs = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hk, new TextEncoder().encode(hd))));
  assertEquals((await verifyIdToken(`${hd}.${hs}`, input([], { clientSecret: "client-secret" }))).sub, "ak-sub-alice");
  await assertRejects(() => verifyIdToken(`${hd}.${hs}`, input([], { clientSecret: "wrong" })), Error, "signature");
  await assertRejects(() => verifyIdToken(`${hd}.${hs}`, input([])), Error, "CLIENT_SECRET");
});

Deno.test("cookies: __Host- session is Secure, HttpOnly, SameSite=Strict, Path=/; the login binding is Lax", () => {
  const s = sessionCookie("tok", 3600);
  assertMatch(s, /^__Host-ob-ws-session=tok; Path=\/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict$/);
  assertMatch(loginCookie("b"), /^__Host-ob-ws-login=b; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/);
  assertMatch(clearSessionCookie(), /Max-Age=0/);
  assertEquals(readCookie("a=1; __Host-ob-ws-session=xyz; b=2", SESSION_COOKIE), "xyz");
  assertEquals(readCookie(undefined, SESSION_COOKIE), "");
});

Deno.test("return_to: a path on this origin only", () => {
  assertEquals(safeReturnTo("/workspace/?doc=documents/x.md"), "/workspace/?doc=documents/x.md");
  for (const bad of ["//evil.example/", "https://evil.example/", "javascript:alert(1)", "/\\evil", "", undefined]) assertEquals(safeReturnTo(bad), "/workspace/");
});

Deno.test("keys: sign-in needs its own door key; which key decides door or service", () => {
  assertThrows(() => keyRing(env({ WORKBENCH_KEY: "internal-key-0123456789" }), true), Error, "WORKSPACE_DOOR_KEY");
  assertThrows(() => keyRing(env({ WORKBENCH_KEY: "same-key-0123456789", WORKSPACE_DOOR_KEY: "same-key-0123456789" }), true), Error, "differ");
  const ring = keyRing(env({ WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DOOR_KEY: "door-key-0123456789", WORKSPACE_SERVICE_KEYS: "agent-org=agent-key-0123456789" }), true);
  assertEquals(keyKind("door-key-0123456789", ring, true), { kind: "door" });
  assertEquals(keyKind("internal-key-0123456789", ring, true), { kind: "service", name: "internal" });
  assertEquals(keyKind("agent-key-0123456789", ring, true), { kind: "service", name: "agent-org" });
  assertEquals(keyKind("forged", ring, true), null);
  // without sign-in, WORKBENCH_KEY is the browser's door, as before
  assertEquals(keyKind("internal-key-0123456789", keyRing(env({ WORKBENCH_KEY: "internal-key-0123456789" }), false), false), { kind: "door" });
});

// ── the seam's modes, over a router mounted with it ──────────────────────────────────────────
function mount(e: Record<string, string>) {
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(null, env(e))));
  app.get("/workbench/contract/documents", async (c) => c.json(await identityOf(c)));
  app.get("/workbench/documents/folders", async (c) => c.json(await identityOf(c)));
  app.get("/workbench/auth/me", async (c) => c.json(await identityOf(c)));
  return (path: string, h: Record<string, string>) => app.request(path, { headers: h });
}

Deno.test("seam without sign-in: exactly the P2b seam (default identity; the header when configured)", async () => {
  const base = { WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DEFAULT_SUB: "ak-default" };
  const r = await (mount(base))("/workbench/contract/documents", { "x-brain-key": "internal-key-0123456789", "x-test-sub": "bob" });
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals([j.sub, j.actor, j.kind], ["ak-default", "ak-default", "default"]);
  const h = await (mount({ ...base, WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" }))("/workbench/contract/documents", { "x-brain-key": "internal-key-0123456789", "x-test-sub": "bob" });
  assertEquals((await h.json()).sub, "bob");
  assertEquals((await resolveIdentity(() => "bob", identityConfig(env({})))).sub, "operator");
});

Deno.test("seam with sign-in: the identity header is ignored, no session = 401, a service has no user front end", async () => {
  const on = { ...OIDC, WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DOOR_KEY: "door-key-0123456789", WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" };
  const call = mount(on);
  const door = { "x-brain-key": "door-key-0123456789" };
  const bypass = await call("/workbench/contract/documents", { ...door, "x-test-sub": "ak-sub-alice" });
  assertEquals(bypass.status, 401, "the header never stands in for a sign-in");
  assertEquals((await call("/workbench/auth/me", door)).status, 200, "the sign-in routes stay open");
  assertEquals(identityConfig(env(on)).header, "", "the header is off while sign-in is configured");
  const svc = { "x-brain-key": "internal-key-0123456789" };
  const s = await call("/workbench/contract/documents", { ...svc, "x-test-sub": "ak-sub-alice" });
  assertEquals((await s.json()).sub, "service:internal");
  assertEquals((await call("/workbench/documents/folders", svc)).status, 403);
});
