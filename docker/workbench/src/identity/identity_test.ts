// deno test src/identity/identity_test.ts - rw-identity, the pure half (no network, no database).
// rw-identity2 (Authentik forward-auth): the forward-auth configuration is inert unless set, refused
// when half set or with a retired WORKSPACE_OIDC_* variable; the outpost's token (X-authentik-jwt) is
// verified HS256-only with the client secret - every other alg (none, RS256 incl. the RS256-with-the-
// secret key confusion, HS384/512, ES256), a forged, tampered, expired, future, wrong-issuer,
// wrong-audience or subject-less token is refused; admin is the token's group on every request; the
// key ring; the seam's modes (no sign-in = exactly the P2b seam; forward-auth = the identity header and
// the unsigned X-authentik-* headers ignored, no valid token = 401, a service has no user front end).
// The image build runs this file (the test stage's gate).
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { forwardAuthConfig, isAdmin, TOKEN_HEADER, verifyForwardToken } from "./forward_auth.ts";
import { keyKind, keyRing } from "./keys.ts";
import { canonicalPath, identityConfig, identityOf, identitySeam, resolveIdentity, routePath, seamDeps } from "../middleware/identity.ts";
import { REASON_MIN, reasonProblem } from "./reason.ts";

const env = (m: Record<string, string>) => (k: string) => m[k];
const SECRET = "lab-client-secret-0123456789abcdef0123456789abcdef";
const FA = {
  WORKSPACE_FORWARD_AUTH_ISSUER: "https://auth.example/application/o/research/",
  WORKSPACE_FORWARD_AUTH_CLIENT_ID: "research-proxy",
  WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: SECRET,
};

// ── a lab signer standing in for Authentik's outpost (WebCrypto only; jose is the product's) ────
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function hmac(alg: "SHA-256" | "SHA-384" | "SHA-512", secret: string, data: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: alg }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))));
}
async function hs(claims: Record<string, unknown>, o: { alg?: string; secret?: string; hash?: "SHA-256" | "SHA-384" | "SHA-512" } = {}) {
  const data = `${enc({ alg: o.alg ?? "HS256", typ: "JWT" })}.${enc(claims)}`;
  return `${data}.${await hmac(o.hash ?? "SHA-256", o.secret ?? SECRET, data)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = (extra: Record<string, unknown> = {}) => ({
  iss: FA.WORKSPACE_FORWARD_AUTH_ISSUER, aud: "research-proxy", sub: "ak-sub-alice", exp: now() + 300, iat: now(),
  name: "Alice", email: "alice@example", groups: ["users"], ...extra,
});

Deno.test("config: no WORKSPACE_FORWARD_AUTH_* = no sign-in (inert as shipped)", () => {
  assertEquals(forwardAuthConfig(env({})), null);
  assertEquals(identityConfig(env({})).signIn, false);
});

Deno.test("config: half-configured, a short secret or a retired WORKSPACE_OIDC_* variable refuses to start", () => {
  assertThrows(() => forwardAuthConfig(env({ WORKSPACE_FORWARD_AUTH_ISSUER: FA.WORKSPACE_FORWARD_AUTH_ISSUER })), Error, "half configured");
  assertThrows(() => forwardAuthConfig(env({ WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: SECRET })), Error, "half configured");
  assertThrows(() => forwardAuthConfig(env({ WORKSPACE_FORWARD_AUTH_ADMIN_GROUP: "research-admins" })), Error, "half configured");
  assertThrows(() => forwardAuthConfig(env({ ...FA, WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: "short" })), Error, "32");
  assertThrows(() => forwardAuthConfig(env({ ...FA, WORKSPACE_FORWARD_AUTH_ISSUER: "not a url" })), Error, "URL");
  assertThrows(() => forwardAuthConfig(env({ ...FA, WORKSPACE_FORWARD_AUTH_SIGN_OUT_URL: "//evil.example/x" })), Error, "SIGN_OUT");
  for (const k of ["WORKSPACE_OIDC_ISSUER", "WORKSPACE_OIDC_CLIENT_SECRET", "WORKSPACE_SESSION_HOURS"]) {
    assertThrows(() => forwardAuthConfig(env({ [k]: "x" })), Error, "removed");
  }
  const c = forwardAuthConfig(env({ ...FA, WORKSPACE_FORWARD_AUTH_ADMIN_GROUP: "research-admins" }))!;
  assertEquals([c.audience, c.adminGroup, c.signOutUrl, c.impersonationMinutes], ["research-proxy", "research-admins", "/outpost.goauthentik.io/sign_out", 60]);
  assertEquals(TOKEN_HEADER, "x-authentik-jwt");
  // the secret is never part of what the config prints
  assert(!JSON.stringify({ ...c, secret: undefined }).includes(SECRET));
});

Deno.test("token: HS256 with the client secret verifies; admin is the token's group", async () => {
  const c = forwardAuthConfig(env({ ...FA, WORKSPACE_FORWARD_AUTH_ADMIN_GROUP: "research-admins" }))!;
  const v = await verifyForwardToken(await hs(good()), c);
  assertEquals([v?.sub, v?.name, v?.email], ["ak-sub-alice", "Alice", "alice@example"]);
  assertEquals(isAdmin(v!, c), false);
  const a = await verifyForwardToken(await hs(good({ groups: ["users", "research-admins"] })), c);
  assertEquals(isAdmin(a!, c), true);
  // removed from the group: the next token says so, and that request is not an admin's
  const b = await verifyForwardToken(await hs(good({ groups: ["users"] })), c);
  assertEquals(isAdmin(b!, c), false);
  // a 20 s clock skew is tolerated (exp just passed)
  assert(await verifyForwardToken(await hs(good({ exp: now() - 20 })), c));
});

Deno.test("token: every forgery, other alg, and claim failure is refused (null)", async () => {
  const c = forwardAuthConfig(env(FA))!;
  const refused = async (t: string, what: string) => {
    let why = "";
    assertEquals(await verifyForwardToken(t, c, (w) => why = w), null, what);
    assert(!why.includes(SECRET) && !(t.length >= 20 && why.includes(t.slice(0, 20))), `${what}: the reason names neither the secret nor the token (${why})`);
  };
  await refused("", "no token");
  await refused("not.a.jwt", "garbage");
  await refused(await hs(good(), { secret: "another-secret-0123456789abcdef0123456789" }), "another secret (forged)");
  await refused(await hs(good({ exp: now() - 3600 })), "expired");
  await refused(await hs(good({ exp: undefined })), "no exp");
  await refused(await hs(good({ iat: undefined })), "no iat");
  await refused(await hs(good({ iat: now() + 3600 })), "issued in the future");
  await refused(await hs(good({ nbf: now() + 3600 })), "not yet valid");
  await refused(await hs(good({ iss: "https://evil.example/application/o/research/" })), "wrong issuer");
  await refused(await hs(good({ iss: undefined })), "no issuer");
  await refused(await hs(good({ aud: "another-client" })), "wrong audience");
  await refused(await hs(good({ aud: undefined })), "no audience");
  for (const s of ["", "service:internal", "system:backfill", "anonymous:", "a\u0000b"]) await refused(await hs(good({ sub: s })), `subject ${JSON.stringify(s)}`);
  await refused(await hs(good({ sub: undefined })), "no subject");
  // one byte of the payload changed after signing
  const [h, , sig] = (await hs(good())).split(".");
  await refused(`${h}.${enc(good({ sub: "ak-sub-mallory" }))}.${sig}`, "tampered payload");
  // alg none, with and without a signature part
  await refused(`${enc({ alg: "none", typ: "JWT" })}.${enc(good())}.`, "alg none");
  await refused(`${enc({ alg: "none" })}.${enc(good())}`, "alg none, two parts");
  await refused(`${enc({ alg: "NONE" })}.${enc(good())}.`, "alg NONE");
  // RS256 / ES256 headers signed with the secret as an HMAC key: the RS256-with-the-secret key confusion
  await refused(await hs(good(), { alg: "RS256" }), "RS256 header, HMAC-signed with the secret");
  await refused(await hs(good(), { alg: "ES256" }), "ES256 header, HMAC-signed with the secret");
  await refused(await hs(good(), { alg: "PS256" }), "PS256 header");
  // other HMAC strengths, correctly signed with the secret: still not HS256
  await refused(await hs(good(), { alg: "HS384", hash: "SHA-384" }), "HS384");
  await refused(await hs(good(), { alg: "HS512", hash: "SHA-512" }), "HS512");
  // a real RS256 token from another key
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const data = `${enc({ alg: "RS256", kid: "k1" })}.${enc(good())}`;
  const rs = b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(data))));
  await refused(`${data}.${rs}`, "RS256 from another key");
  await refused("a".repeat(20000), "oversized");
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

Deno.test("seam with forward-auth: the token is the sign-in; the identity header and bare X-authentik-* are ignored; a service has no user front end", async () => {
  const on = { ...FA, WORKSPACE_FORWARD_AUTH_ADMIN_GROUP: "research-admins", WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DOOR_KEY: "door-key-0123456789", WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" };
  const call = mount(on);
  const door = { "x-brain-key": "door-key-0123456789" };
  const bypass = await call("/workbench/contract/documents", { ...door, "x-test-sub": "ak-sub-alice" });
  assertEquals(bypass.status, 401, "the header never stands in for a sign-in");
  const bare = await call("/workbench/contract/documents", { ...door, "x-authentik-uid": "ak-sub-alice", "x-authentik-username": "alice", "x-authentik-groups": "research-admins", "x-authentik-meta-jwks": "https://evil.example/jwks" });
  assertEquals(bare.status, 401, "unsigned X-authentik-* headers alone are never a sign-in");
  for (const t of ["", "x", await hs(good(), { secret: "forged-secret-0123456789abcdef0123456789" }), await hs(good({ exp: now() - 3600 })),
    await hs(good({ iss: "https://evil.example/" })), await hs(good({ aud: "other" })), `${enc({ alg: "none" })}.${enc(good())}.`, await hs(good(), { alg: "RS256" })]) {
    assertEquals((await call("/workbench/contract/documents", { ...door, [TOKEN_HEADER]: t, "x-authentik-uid": "ak-sub-alice" })).status, 401, `token ${t.slice(0, 30)}`);
  }
  const ok = await call("/workbench/contract/documents", { ...door, [TOKEN_HEADER]: await hs(good()), "x-test-sub": "ak-sub-bob", "x-authentik-uid": "ak-sub-bob" });
  assertEquals(ok.status, 200);
  const who = await ok.json();
  assertEquals([who.sub, who.actor, who.kind, who.admin], ["ak-sub-alice", "ak-sub-alice", "user", false], "the token's subject, never a header's");
  const adm = await (await call("/workbench/contract/documents", { ...door, [TOKEN_HEADER]: await hs(good({ groups: ["research-admins"] })) })).json();
  assertEquals(adm.admin, true);
  const left = await (await call("/workbench/contract/documents", { ...door, [TOKEN_HEADER]: await hs(good({ groups: [] })) })).json();
  assertEquals(left.admin, false, "removed from the group = not an admin on the next request");
  assertEquals((await call("/workbench/auth/me", door)).status, 200, "who-am-I stays open");
  assertEquals(identityConfig(env(on)).header, "", "the header is off while sign-in is configured");
  const svc = { "x-brain-key": "internal-key-0123456789" };
  const s = await call("/workbench/contract/documents", { ...svc, "x-test-sub": "ak-sub-alice" });
  assertEquals((await s.json()).sub, "service:internal");
  assertEquals((await call("/workbench/documents/folders", svc)).status, 403);
});

// round 4 (tester F2): the route scope judges the path the router will route - decoded, slashes collapsed
Deno.test("seam: a percent-encoded or doubled path is judged as the route it reaches", async () => {
  assertEquals(routePath("/workbench/%64ocuments/folders"), "/workbench/documents/folders");
  assertEquals(routePath("/workbench/%2564ocuments"), "/workbench/documents");
  assertEquals(routePath("/workbench/documents%2Ffolders"), "/workbench/documents/folders");
  assertEquals(routePath("/workbench//documents/./x/../folders"), "/workbench/documents/folders");
  assertEquals(routePath("/workbench/%E0%A4%A"), "/workbench/%E0%A4%A");
  const on = { ...FA, WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DOOR_KEY: "door-key-0123456789" };
  const call = mount(on);
  assertEquals((await call("/workbench/%64ocuments/folders", { "x-brain-key": "internal-key-0123456789" })).status, 403);
  // rw-identity2 (B1): a spelling that decoding could reshape is refused outright, before any decision
  for (const p of ["/workbench//documents/folders", "/workbench/%2564ocuments/folders"]) {
    const r = await call(p, { "x-brain-key": "internal-key-0123456789" });
    assertEquals(r.status, 400, `${p}: ${r.status}`);
  }
});

// rw-identity2 (review r-identity B1): the seam and the router judge ONE string. A path is canonical when
// no further decoding can change its shape; anything else is null (the seam answers 400).
Deno.test("canonicalPath: the canonical spellings pass unchanged; every reshaping spelling is null", () => {
  for (const p of ["/workbench/notes/a.md", "/workbench/documents/folders", "/workbench/health", "/workbench/auth/me",
    "/workbench/%64ocuments/folders", "/workbench/notes/my%20note.md", "/workbench/notes/caf%C3%A9.md",
    "/workbench/contract/chunks/abc:3/context", "/workbench/contract/settings/podcast.archive", "/workbench/notes/a..b.md", "/"]) {
    assertEquals(canonicalPath(p), routePath(p), p);
  }
  assertEquals(canonicalPath("/workbench/documents/"), "/workbench/documents", "one trailing slash is the same route's path");
  for (const p of [
    "/workbench/notes/%252e%252e/health/foo.md", "/workbench/notes/x/..%2F..%2Fhealth/foo.md",
    "/workbench/documents/references/%252e%252e%252f%252e%252e%252fhealth/repin", "/workbench/notes/%2e%2e/health/foo.md",
    "/workbench/notes/%2E%2E/health/foo.md", "/workbench/notes/x%2fy.md", "/workbench/notes/x%2Fy.md", "/workbench/notes/x%5cy.md",
    "/workbench/notes/x%5Cy.md", "/workbench/notes/x%252fy.md", "/workbench/notes/x%25y.md", "/workbench/notes/x\\y.md",
    "/workbench/notes/../health/x", "/workbench/notes/./a.md", "/workbench//notes/a.md", "/workbench/notes/a.md//",
    "/workbench/notes/..;x/health/foo.md", "/workbench/notes/.;x/a.md", "/workbench/notes/;x/a.md", "/workbench/notes/x%00.md",
    "/workbench/notes/%E0%A4%A", "/workbench/%2564ocuments", "/workbench/documents%2Ffolders", "workbench/notes",
  ]) assertEquals(canonicalPath(p), null, p);
});

// The reviewer's probe (journal/evidence/rw-identity/review-r-identity-seam-probe.ts), as a test: the
// router is Hono with the real seam in front, sign-in on, the door key, no session.
Deno.test("seam (B1): an anonymous browser never reaches a handler through a spelling the router reads differently", async () => {
  const on = { ...FA, WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DOOR_KEY: "door-key-0123456789" };
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(null, env(on))));
  const notes = new Hono();
  for (const m of ["get", "put", "delete"] as const) notes[m]("/:notePath{.+}", (c) => c.json({ reached: "notes", notePath: c.req.param("notePath") }));
  notes.post("/:notePath{.+}/restore", (c) => c.json({ reached: "restore" }));
  app.route("/workbench/notes", notes);
  const docs = new Hono();
  docs.post("/references/:id/repin", (c) => c.json({ reached: "repin", id: c.req.param("id") }));
  docs.delete("/references/:id", (c) => c.json({ reached: "unref", id: c.req.param("id") }));
  app.route("/workbench/documents", docs);
  app.get("/workbench/health", (c) => c.json({ ok: true }));
  const call = (method: string, p: string, key = "door-key-0123456789") => app.request("http://h" + p, { method, headers: { "x-brain-key": key } });
  assertEquals((await call("GET", "/workbench/notes/a.md")).status, 401, "the canonical spelling: sign in first");
  assertEquals((await call("GET", "/workbench/health")).status, 200, "health stays open");
  const spellings: [string, string][] = [
    ["GET", "/workbench/notes/%252e%252e/health/foo.md"], ["PUT", "/workbench/notes/%252e%252e/health/foo.md"],
    ["DELETE", "/workbench/notes/%252e%252e/health/foo.md"], ["POST", "/workbench/notes/%252e%252e/health/foo.md/restore"],
    ["GET", "/workbench/notes/x/..%2F..%2Fhealth/foo.md"], ["GET", "/workbench/notes/x/..%2f..%2fhealth/foo.md"],
    ["GET", "/workbench/notes/%252E%252E/health/foo.md"], ["GET", "/workbench/notes/x/..%5C..%5Chealth/foo.md"],
    ["GET", "/workbench/notes/x/..%255c..%255chealth/foo.md"], ["GET", "/workbench/notes/x/%252e%252e%252f%252e%252e%252fhealth/foo.md"],
    ["GET", "/workbench/notes/%25252e%25252e/health/foo.md"], ["GET", "/workbench/notes/x/..;p/..;p/health/foo.md"],
    ["POST", "/workbench/documents/references/%252e%252e%252f%252e%252e%252fhealth/repin"],
    ["POST", "/workbench/documents/references/..%2F..%2Fhealth/repin"],
    ["DELETE", "/workbench/documents/references/%252e%252e%252f%252e%252e%252fhealth"],
  ];
  for (const [m, p] of spellings) {
    const r = await call(m, p);
    const t = await r.text();
    assert(!t.includes("reached"), `${m} ${p}: a handler ran (${r.status} ${t.slice(0, 120)})`);
    assertEquals(r.status, 400, `${m} ${p}: ${r.status} ${t.slice(0, 120)}`);
  }
  // the mirror: a service key past USER_ONLY through a reshaping spelling of a documents route
  for (const p of ["/workbench/health/..%2F..%2Fdocuments/references/x/repin", "/workbench/notes/%252e%252e/..%2Fdocuments/references/x/repin",
    "/workbench/documents/references/%252e%252e%252f%252e%252e%252fhealth/repin"]) {
    const r = await call("POST", p, "internal-key-0123456789");
    const t = await r.text();
    assert(!t.includes("reached"), `service POST ${p}: a handler ran (${r.status} ${t.slice(0, 120)})`);
    assert(r.status === 400 || r.status === 403 || r.status === 404, `service POST ${p}: ${r.status}`);
  }
});

// round 4 (tester F3): a reason is visible characters - zero-width and white space do not count
Deno.test("reason: at least REASON_MIN visible characters with a letter or digit", () => {
  assertEquals(REASON_MIN, 8);
  for (const bad of ["", "   ", "\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b", " \u200b\u2060\ufeff\u00ad\u180e ", "a\u200bb\u200bc\u200bd", "abcdefg", "........", "--------!",
    // round 5 (tester attempt 2, F3b): only letters and digits count
    "a" + "\u{E0061}".repeat(7), "ab" + "\u2800".repeat(6), "a" + "\u{E0100}".repeat(7), "a" + "\u0300".repeat(7), "\u3164".repeat(8),
    "\u115f\u1160".repeat(4), "\uffa0".repeat(8), "a" + "\u{1BCA0}".repeat(7), "a" + "\ufffc".repeat(7), "\u00a0".repeat(8), "........a", "e\u0301e\u0301e\u0301e\u0301", "\u{F0000}".repeat(8)]) {
    assert(reasonProblem(bad), JSON.stringify(bad));
  }
  for (const ok of ["support ticket 42", "alice asked for help", "ticket#12", "\u00e9l\u00e8ve demande", "\u652f\u63f4\u8acb\u6c42\u7b2c\u5341\u4e8c\u53f7"]) assertEquals(reasonProblem(ok), null, ok);
  assert(reasonProblem("x".repeat(1001)));
});
