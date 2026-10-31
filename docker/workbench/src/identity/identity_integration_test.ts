// deno test src/identity/identity_integration_test.ts - rw-identity end to end, signed in the way
// Authentik forward-auth signs users in (rw-identity2): every request of a signed-in browser carries the
// outpost's token, X-authentik-jwt, which Traefik copies onto the request. Here a LAB SIGNER stands in
// for Authentik's outpost: it mints the same token shape (HS256 with the lab proxy provider's client
// secret; iss, aud = the client id, sub, exp, iat, name, email, groups), and the test sends it through
// the viewer's /workbench forwarder (as Traefik would) or direct with the door key. Clauses (the anchor's
// acceptance):
//   C4 authentication: no token, a forged / expired / wrong-issuer / wrong-audience / non-HS256 token
//      (alg none, RS256-with-the-secret, HS512), or bare X-authentik-* headers = 401; no in-app login,
//      session or cookie; admin re-read from the token on every request; the identity header cannot
//      stand in for a sign-in
//   C1 isolation (the basics; the route-wide sweep is isolation_sweep_test.ts)
//   C3 admin impersonation: a reason first; the switch and every request in admin_audit; retrievable;
//      append-only; a non-admin cannot impersonate
//   C2 the Open WebUI hand-off: on_behalf_of accepted from Open WebUI's key only; agent research under
//      a service identity
//   C5 no sign-in configured = exactly the P2b behaviour (a second workbench on the same database)
// SKIPPED unless IDENTITY_TEST_VIEWER is set: contract-test/run-identity-tests.ps1 runs it in its
// disposable lab. Never point it at a live stack (it writes audit rows), and never give it a real
// Authentik client secret.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const E = (k: string) => Deno.env.get(k) ?? "";
const VIEWER = E("IDENTITY_TEST_VIEWER").replace(/\/+$/, "");
const WB = E("IDENTITY_TEST_WB").replace(/\/+$/, "");
const WB_PLAIN = E("IDENTITY_TEST_WB_PLAIN").replace(/\/+$/, "");
const WB_NODEF = E("IDENTITY_TEST_WB_NODEF").replace(/\/+$/, ""); // sign-in on, WORKSPACE_DEFAULT_SUB blank
const RS = E("IDENTITY_TEST_RESEARCH").replace(/\/+$/, "");
const DOOR = E("IDENTITY_TEST_DOOR_KEY");
const INTERNAL = E("IDENTITY_TEST_INTERNAL_KEY");
const K = { owui: E("IDENTITY_TEST_OWUI_KEY"), ao: E("IDENTITY_TEST_AO_KEY"), ws: E("IDENTITY_TEST_WS_KEY"), shared: INTERNAL };
const USERS = (E("IDENTITY_TEST_USERS") ? JSON.parse(E("IDENTITY_TEST_USERS")) : []) as { login: string; sub: string; name: string; groups: string[] }[];
const sub = (login: string) => USERS.find((u) => u.login === login)?.sub ?? "";
// the lab proxy provider (the outpost's stand-in): issuer, client id, client secret, the admin group, sign-out
const FA = { iss: E("IDENTITY_TEST_FA_ISSUER"), aud: E("IDENTITY_TEST_FA_CLIENT_ID"), secret: E("IDENTITY_TEST_FA_SECRET"), signOut: E("IDENTITY_TEST_FA_SIGN_OUT") };
const ignore = !VIEWER;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };

function pool(user: string, password: string) {
  return new Pool({ hostname: E("CONTRACT_TEST_DB_HOST"), port: 5432, user, password, database: "openbrain" }, 1, true);
}
async function sql<T = Record<string, any>>(text: string, args: unknown[] = [], as: "postgres" | "app" = "postgres"): Promise<T[]> {
  const p = as === "postgres" ? pool("postgres", E("CONTRACT_TEST_DB_PASSWORD")) : pool("ob_app_memory", E("IDENTITY_TEST_APP_PASSWORD"));
  const c = await p.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
    await p.end();
  }
}

// ── the lab signer: Authentik's outpost token shape, HS256 with the lab client secret ────────────
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function hmac(hash: "SHA-256" | "SHA-512", secret: string, data: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))));
}
const now = () => Math.floor(Date.now() / 1000);
function claimsOf(login: string, extra: Record<string, unknown> = {}) {
  const u = USERS.find((x) => x.login === login);
  assert(u, `lab user ${login}`);
  return { iss: FA.iss, aud: FA.aud, sub: u.sub, exp: now() + 1800, iat: now(), name: u.name, preferred_username: login, email: `${login}@lab.invalid`, groups: u.groups, ...extra };
}
async function mint(claims: Record<string, unknown>, o: { alg?: string; secret?: string; hash?: "SHA-256" | "SHA-512" } = {}) {
  const data = `${enc({ alg: o.alg ?? "HS256", typ: "JWT" })}.${enc(claims)}`;
  return `${data}.${await hmac(o.hash ?? "SHA-256", o.secret ?? FA.secret, data)}`;
}
const TOKEN = "x-authentik-jwt";

// ── a browser behind the edge: the edge's token on every request, the viewer's Origin on every write
class Browser {
  token = "";
  requests = 0;
  constructor(readonly base = VIEWER) {}
  auth(): Record<string, string> {
    return this.token ? { [TOKEN]: this.token } : {};
  }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const url = path.startsWith("http") ? path : this.base + path;
    const h: Record<string, string> = { ...(url.startsWith(this.base) ? this.auth() : {}), ...headers };
    if (!["GET", "HEAD"].includes(method)) {
      h.origin ??= this.base;
      if (body !== undefined) h["content-type"] ??= "application/json";
    }
    if (url.startsWith(this.base)) this.requests++;
    const r = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, location: r.headers.get("location") ?? "", setCookie: r.headers.getSetCookie() };
  }
  // signed in as `login` at the edge: from now on every request carries the outpost's token
  async signIn(login: string, extra: Record<string, unknown> = {}) {
    this.token = await mint(claimsOf(login, extra));
    return this.token;
  }
}

const direct = async (base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text, setCookie: r.headers.getSetCookie() };
};

// rw-identity3 (review r-identity2 B1b): fetch (like every WHATWG client) resolves "." / ".." / "%2e"
// segments and turns "\\" into "/" before sending, so the B1 cases above never sent a raw target. This
// writes the request line itself over TCP: the bytes the workbench's router routes are the bytes sent.
async function rawDirect(base: string, method: string, target: string, headers: Record<string, string>) {
  const u = new URL(base);
  const conn = await Deno.connect({ hostname: u.hostname, port: Number(u.port || 80) });
  const CRLF = "\r\n";
  const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}${CRLF}`).join("");
  const len = ["PUT", "POST"].includes(method) ? `content-type: application/json${CRLF}content-length: 2${CRLF}` : "";
  await conn.write(new TextEncoder().encode(`${method} ${target} HTTP/1.1${CRLF}Host: ${u.host}${CRLF}${h}${len}Connection: close${CRLF}${CRLF}${len ? "{}" : ""}`));
  const buf = new Uint8Array(65536);
  let out = "";
  let n: number | null;
  while ((n = await conn.read(buf)) !== null) out += new TextDecoder().decode(buf.subarray(0, n));
  conn.close();
  const i = out.indexOf(CRLF + CRLF);
  return { status: Number(out.slice(9, 12)), text: i === -1 ? "" : out.slice(i + 4) };
}

// ── C4: authentication ────────────────────────────────────────────────────────────────────────
Deno.test({ name: "C4 sign-in: a valid Authentik token is the sign-in - who am I; no login route, no session, no cookie; sign-out is Authentik's", ...opts, fn: async () => {
  assert(FA.secret.length >= 32 && FA.iss && FA.aud, "the lab signer is configured");
  const b = new Browser();
  await b.signIn("alice");
  const me = await b.req("GET", "/workbench/auth/me");
  assertEquals([me.json.mode, me.json.signed_in, me.json.subject_sub, me.json.actor_sub, me.json.admin], ["forward-auth", true, sub("alice"), sub("alice"), false]);
  assertEquals(me.json.logout, FA.signOut, "Sign out = Authentik's outpost sign-out");
  const docs = await b.req("GET", "/workbench/contract/documents");
  assertEquals(docs.status, 200, docs.text);
  assertEquals([...me.setCookie, ...docs.setCookie].filter((c) => /ob-ws|session/i.test(c)), [], "the workbench sets no session cookie");
  // the in-app sign-in is gone: those routes are not routes (signed in = 404; anonymous = 401 like any user route)
  for (const p of ["/workbench/auth/login", "/workbench/auth/callback?code=x&state=y"]) assertEquals((await b.req("GET", p)).status, 404, p);
  assertEquals((await b.req("POST", "/workbench/auth/logout", {})).status, 404, "POST /workbench/auth/logout");
  assertEquals((await new Browser().req("GET", "/workbench/auth/login")).status, 401);
  // and so is their storage
  const t = await sql<{ s: string | null; p: string | null; i: string | null }>(
    `SELECT to_regclass('public.workspace_sessions')::text AS s, to_regclass('public.workspace_login_pending')::text AS p, to_regclass('public.workspace_impersonation')::text AS i`);
  assertEquals([t[0].s, t[0].p, t[0].i], [null, null, "workspace_impersonation"]);
  // anonymous who-am-I through the viewer: not signed in, the sign-out link still Authentik's
  const anon = await new Browser().req("GET", "/workbench/auth/me");
  assertEquals([anon.status, anon.json.mode, anon.json.signed_in, anon.json.subject_sub], [200, "forward-auth", false, null]);
} });

// every user route the anchor names, through the viewer (as Traefik would hand it on) and direct (door key)
const USER_ROUTES: [string, string, unknown?][] = [
  ["GET", "/workbench/contract/documents"], ["GET", "/workbench/documents/folders"], ["GET", "/workbench/workspace/whoami"],
  ["GET", "/workbench/auth/users"], ["GET", "/workbench/auth/audit"], ["GET", "/workbench/contract/sessions?limit=5"],
  ["GET", "/workbench/notes/a.md"], ["POST", "/workbench/documents", { title: "a write without a valid token" }],
  ["POST", "/workbench/auth/impersonate", { sub: "x", reason: "a write without a valid token" }],
];
Deno.test({ name: "C4 every request without a valid token is 401: none, forged, expired, wrong issuer, wrong audience, alg none, RS256-with-the-secret, HS512, bare X-authentik-* headers", ...opts, fn: async () => {
  const alice = claimsOf("alice", { groups: ["lab-users", "research-admins"] });
  const bare = { "x-authentik-uid": sub("alice"), "x-authentik-username": "alice", "x-authentik-groups": "lab-users|research-admins",
    "x-authentik-email": "alice@lab.invalid", "x-authentik-name": "Alice Lab", "x-authentik-meta-jwks": "https://evil.invalid/jwks" };
  const bad: [string, Record<string, string>][] = [
    ["no token", {}],
    ["bare X-authentik-* headers, no token", bare],
    ["forged (another secret)", { [TOKEN]: await mint(alice, { secret: "a-forger-secret-0123456789abcdef0123456789" }), ...bare }],
    ["expired", { [TOKEN]: await mint({ ...alice, exp: now() - 600, iat: now() - 900 }) }],
    ["wrong issuer", { [TOKEN]: await mint({ ...alice, iss: "https://evil.invalid/application/o/lab/" }) }],
    ["wrong audience", { [TOKEN]: await mint({ ...alice, aud: "another-provider" }) }],
    ["no exp", { [TOKEN]: await mint({ ...alice, exp: undefined }) }],
    ["alg none", { [TOKEN]: `${enc({ alg: "none", typ: "JWT" })}.${enc(alice)}.` }],
    ["RS256 header signed with the secret (key confusion)", { [TOKEN]: await mint(alice, { alg: "RS256" }) }],
    ["HS512 with the right secret", { [TOKEN]: await mint(alice, { alg: "HS512", hash: "SHA-512" }) }],
    ["tampered payload", { [TOKEN]: (await mint(alice)).replace(/^([^.]+)\.[^.]+\./, (_m, h) => `${h}.${enc({ ...alice, sub: sub("bob") })}.`) }],
    ["garbage", { [TOKEN]: "not-a-token" }],
    ["a reserved subject", { [TOKEN]: await mint({ ...alice, sub: "service:internal" }) }],
  ];
  for (const [what, h] of bad) {
    for (const [m, p, body] of USER_ROUTES) {
      const via = await new Browser().req(m, p, body, h);
      assertEquals(via.status, 401, `through the viewer, ${what}: ${m} ${p} -> ${via.status} ${via.text.slice(0, 100)}`);
      const d = await direct(WB, m, p, { "x-brain-key": DOOR, ...h }, body);
      assertEquals(d.status, 401, `direct with the door key, ${what}: ${m} ${p} -> ${d.status} ${d.text.slice(0, 100)}`);
    }
    const me = await new Browser().req("GET", "/workbench/auth/me", undefined, h);
    assertEquals([me.json.signed_in, me.json.subject_sub], [false, null], `who am I, ${what}`);
  }
  // nothing was written by any of them
  const n = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_document_listings WHERE title = 'a write without a valid token'`);
  assertEquals(n[0].n, 0);
  // the valid token on the same routes is not refused as unauthenticated
  const ok = new Browser();
  await ok.signIn("alice");
  assertEquals((await ok.req("GET", "/workbench/contract/documents")).status, 200);
} });

Deno.test({ name: "C4 admin is read from the token on every request: removed from the group = not an admin, and an impersonation ends (recorded)", ...opts, fn: async () => {
  const ad = new Browser();
  await ad.signIn("admin");
  assertEquals((await ad.req("GET", "/workbench/auth/me")).json.admin, true);
  // dave has been seen signed in (the impersonation target must have been)
  const dv = new Browser();
  await dv.signIn("dave");
  assertEquals((await dv.req("GET", "/workbench/auth/me")).status, 200);
  const reason = `group-removal check ${crypto.randomUUID().slice(0, 6)}`;
  const go = await ad.req("POST", "/workbench/auth/impersonate", { sub: sub("dave"), reason });
  assertEquals(go.status, 200, go.text);
  assertEquals((await ad.req("GET", "/workbench/auth/me")).json.subject_sub, sub("dave"));
  // the operator removes the admin from research-admins in Authentik: the outpost's next token says so
  await ad.signIn("admin", { groups: ["lab-users"] });
  const me = await ad.req("GET", "/workbench/auth/me");
  assertEquals([me.json.admin, me.json.subject_sub, me.json.impersonating], [false, sub("admin"), null], "the very next request");
  assertEquals((await ad.req("GET", "/workbench/auth/users")).status, 403);
  assertEquals((await ad.req("GET", "/workbench/auth/audit")).status, 403);
  assertEquals((await ad.req("POST", "/workbench/auth/impersonate", { sub: sub("dave"), reason: "trying again after removal" })).status, 403);
  const ended = await sql<{ reason: string }>(`SELECT reason FROM public.admin_audit WHERE actor_sub = $1 AND subject_sub = $2 AND action = 'impersonate.end' ORDER BY id DESC LIMIT 1`, [sub("admin"), sub("dave")]);
  assertEquals(ended[0]?.reason, "no longer in the admin group");
  assert(!(await ad.req("GET", "/workbench/contract/documents?limit=500")).text.includes(sub("dave")), "nothing of dave's");
  // back in the group: admin again, NOT impersonating (the ended impersonation does not come back)
  await ad.signIn("admin");
  const back = await ad.req("GET", "/workbench/auth/me");
  assertEquals([back.json.admin, back.json.impersonating], [true, null]);
} });

Deno.test({ name: "C4 the identity header cannot bypass sign-in: through the viewer, direct with the door key, or beside a token", ...opts, fn: async () => {
  const H = E("IDENTITY_TEST_SUB_HEADER") || "X-Test-Sub";
  const anon = new Browser();
  assertEquals((await anon.req("GET", "/workbench/contract/documents", undefined, { [H]: sub("alice") })).status, 401, "through the viewer");
  assertEquals((await direct(WB, "GET", "/workbench/contract/documents", { "x-brain-key": DOOR, [H]: sub("alice") })).status, 401, "direct, door key");
  assertEquals((await direct(WB, "GET", "/workbench/documents/folders", { "x-brain-key": DOOR, [H]: sub("alice") })).status, 401);
  const b = new Browser();
  await b.signIn("bob");
  const me = await b.req("GET", "/workbench/auth/me", undefined, { [H]: sub("alice"), "x-authentik-uid": sub("alice") });
  assertEquals(me.json.subject_sub, sub("bob"), "a token plus the header is still the token's user");
  const meDirect = await direct(WB, "GET", "/workbench/workspace/whoami", { "x-brain-key": DOOR, ...b.auth(), [H]: sub("alice") });
  assertEquals(meDirect.json.subject_sub, sub("bob"));
  // a forged key never reaches anything
  assertEquals((await direct(WB, "GET", "/workbench/auth/me", { "x-brain-key": "forged-forged-forged" })).status, 401);
} });

Deno.test({ name: "service key: WORKBENCH_KEY is service:internal - shared knowledge yes, a user front end no", ...opts, fn: async () => {
  const me = await direct(WB, "GET", "/workbench/auth/me", { "x-brain-key": INTERNAL });
  assertEquals([me.json.kind, me.json.subject_sub], ["service", "service:internal"]);
  assertEquals((await direct(WB, "GET", "/workbench/contract/search?q=fixture", { "x-brain-key": INTERNAL })).status, 200);
  assertEquals((await direct(WB, "GET", "/workbench/documents/folders", { "x-brain-key": INTERNAL })).status, 403);
  assertEquals((await direct(WB, "POST", "/workbench/auth/impersonate", { "x-brain-key": INTERNAL }, { sub: sub("alice"), reason: "a service tries" })).status, 403);
  // round 4 (tester F2): a percent-encoded path is the same route - a service never reaches a user's front end
  for (const p of ["/workbench/%64ocuments/folders", "/workbench/%2564ocuments/folders", "/workbench/documents%2Ffolders", "/workbench/%61uth/audit", "/workbench/%61uth/users", "/workbench/%77orkspace/whoami", "/workbench//documents/folders"]) {
    const r = await direct(WB, "GET", p, { "x-brain-key": INTERNAL });
    assert(r.status !== 200, `service ${p} -> ${r.status} ${r.text.slice(0, 80)}`);
    const a = await direct(WB, "GET", p, { "x-brain-key": DOOR });
    assert(a.status !== 200, `anonymous ${p} -> ${a.status}`);
  }
  assertEquals((await direct(WB, "GET", "/workbench/%64ocuments/folders", { "x-brain-key": INTERNAL })).status, 403);
  const w = await direct(WB, "POST", "/workbench/%64ocuments", { "x-brain-key": INTERNAL }, { title: "a service wrote this" });
  assertEquals(w.status, 403, `a service writing through an encoded path: ${w.text.slice(0, 100)}`);
} });

// ── C1: two users, each their own front-end context (the basics) ─────────────────────────────
const marker = `IdentitySecret${crypto.randomUUID().slice(0, 8)}`;
let alicePath = "";

// rw-identity2 (review r-identity B1): the seam judged a path decoded up to 4 times with ".." resolved,
// the router one decoded once (keeping %2F) - so these reached the notes and repin handlers with no
// session. Every spelling that decoding could reshape is now refused (400) before any decision, through
// the viewer and direct with the door key; a service key gets no further.
// (a single %2e%2e is not here: fetch resolves it before sending, as every WHATWG client does.)
const B1_SPELLINGS: [string, string][] = [
  ["GET", "/workbench/notes/%252e%252e/health/foo.md"], ["PUT", "/workbench/notes/%252e%252e/health/foo.md"],
  ["DELETE", "/workbench/notes/%252e%252e/health/foo.md"], ["POST", "/workbench/notes/%252e%252e/health/foo.md/restore"],
  ["POST", "/workbench/notes/%252e%252e/health/foo.md/recover"], ["GET", "/workbench/notes/%252E%252E/health/foo.md"],
  ["GET", "/workbench/notes/%25252e%25252e/health/foo.md"], ["GET", "/workbench/notes/x/..%2F..%2Fhealth/foo.md"],
  ["GET", "/workbench/notes/x/..%2f..%2fhealth/foo.md"], ["PUT", "/workbench/notes/x/..%2F..%2Fhealth/foo.md"],
  ["GET", "/workbench/notes/x/..%5C..%5Chealth/foo.md"], ["GET", "/workbench/notes/x/..%255c..%255chealth/foo.md"],
  ["GET", "/workbench/notes/x/%252e%252e%252f%252e%252e%252fhealth/foo.md"],
  ["GET", "/workbench/notes/x/..;p/..;p/health/foo.md"], ["GET", "/workbench/notes/x%252fy.md"],
  ["POST", "/workbench/documents/references/%252e%252e%252f%252e%252e%252fhealth/repin"],
  ["POST", "/workbench/documents/references/..%2F..%2Fhealth/repin"],
  ["DELETE", "/workbench/documents/references/%252e%252e%252f%252e%252e%252fhealth"],
];
Deno.test({ name: "B1 a spelling the router reads differently from the seam never reaches a handler: 400, no data, no write", ...opts, fn: async () => {
  const anon = new Browser();
  const body = { content: `B1 anonymous write ${marker}` };
  for (const [m, p] of B1_SPELLINGS) {
    const via = await anon.req(m, p, ["PUT", "POST"].includes(m) ? body : undefined);
    assertEquals(via.status, 400, `through the viewer ${m} ${p}: ${via.status} ${via.text.slice(0, 120)}`);
    const d = await direct(WB, m, p, { "x-brain-key": DOOR }, ["PUT", "POST"].includes(m) ? body : undefined);
    assertEquals(d.status, 400, `direct, door key ${m} ${p}: ${d.status} ${d.text.slice(0, 120)}`);
    const s = await direct(WB, m, p, { "x-brain-key": INTERNAL }, ["PUT", "POST"].includes(m) ? body : undefined);
    assertEquals(s.status, 400, `direct, service key ${m} ${p}: ${s.status} ${s.text.slice(0, 120)}`);
    for (const r of [via.text, d.text, s.text]) assert(!r.includes(marker) && !/"(content|notePath|path)"\s*:/.test(r), `${m} ${p} answered with data: ${r.slice(0, 160)}`);
  }
  // the mirror: a service key past USER_ONLY through a reshaping spelling of a documents :id route
  for (const p of ["/workbench/health/..%2F..%2Fdocuments/references/x/repin", "/workbench/notes/%252e%252e/..%2Fdocuments/folders",
    "/workbench/contract/%252e%252e/documents/folders"]) {
    const s = await direct(WB, p.endsWith("repin") ? "POST" : "GET", p, { "x-brain-key": INTERNAL });
    assertEquals(s.status, 400, `service ${p}: ${s.status} ${s.text.slice(0, 120)}`);
  }
  // the canonical spellings still answer as before: no session = 401, health open
  assertEquals((await direct(WB, "GET", "/workbench/notes/a.md", { "x-brain-key": DOOR })).status, 401);
  assertEquals((await direct(WB, "GET", "/workbench/health", { "x-brain-key": DOOR })).status, 200);
  // a signed-in user is refused the same spellings: they are not a route for anyone
  const alice = new Browser();
  await alice.signIn("alice");
  for (const p of ["/workbench/notes/%2525252e%2525252e/health/foo.md", "/workbench/notes/x/..%2F..%2Fhealth/foo.md"]) {
    assertEquals((await alice.req("GET", p)).status, 400, `signed in, ${p}`);
  }
} });


// rw-identity3 (review r-identity2 B1b): RAW request targets, direct to the workbench with the door key
// (no token, and with alice's token) and with the service key - every one is the SEAM's 400 ("not a
// canonical path") before any decision: never a handler's answer (its own 400/404), never data.
const B1B_RAW: [string, string][] = [
  ["GET", "/workbench/notes/%2e%2e/health"], ["GET", "/workbench/notes/%2E%2E/health/x"], ["GET", "/workbench/notes/.%2e/health"],
  ["GET", "/workbench/notes/%2e./health"], ["GET", "/workbench/notes/../health"], ["GET", "/workbench/notes/./../health"],
  ["GET", "/workbench/notes/./a.md"], ["GET", "/workbench/notes/a//../../../health"], ["GET", "/workbench/notes/;/../../health"],
  ["GET", "/workbench/notes/a;b.md"], ["GET", "/workbench/notes/x\\..\\..\\health"], ["PUT", "/workbench/notes/%2e%2e/health/b1b.md"],
  ["DELETE", "/workbench/notes/../health/b1b.md"], ["POST", "/workbench/notes/.%2e/health/b1b.md/restore"],
  ["GET", "/workbench/notes/%2e%2e/auth/audit"], ["POST", "/workbench/documents/references/%2e%2e/%2e%2e/health/repin"],
  ["GET", "/workbench/%2e%2e/workbench/health"], ["GET", "/workbench/.%2e/workbench/notes/a.md"], ["GET", "/workbench/../workbench/health"],
  ["GET", "/workbench/./health"], ["GET", "/workbench/./documents/folders"], ["GET", "/workbench//health"], ["GET", "/workbench/;/../health"],
  ["GET", "/workbench/x\\..\\health"], ["GET", "/workbench/health/%2e%2e/documents/folders"], ["GET", "/workbench/health/../auth/audit"],
];
Deno.test({ name: "B1b a RAW request target (sent over a socket, not through fetch) is the seam's 400 before any decision, with and without keys and tokens", ...opts, fn: async () => {
  const tok = await mint(claimsOf("alice"));
  const fails: string[] = [];
  let total = 0;
  for (const [m, t] of B1B_RAW) {
    for (const [label, base, h] of [["door, no token", WB, { "x-brain-key": DOOR }], ["door + alice", WB, { "x-brain-key": DOOR, [TOKEN]: tok }],
      ["service key", WB, { "x-brain-key": INTERNAL }], ["sign-in off, service key", WB_PLAIN, { "x-brain-key": INTERNAL }]] as const) {
      if (!base) continue;
      total++;
      const r = await rawDirect(base, m, t, h);
      if (r.status !== 400 || !/not a canonical path/.test(r.text)) fails.push(`${m} ${t} [${label}]: ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  // controls, raw too: the canonical spellings answer as the route they are
  assertEquals((await rawDirect(WB, "GET", "/workbench/notes/a.md", { "x-brain-key": DOOR })).status, 401);
  assertEquals((await rawDirect(WB, "GET", "/workbench/health", { "x-brain-key": DOOR })).status, 200);
  console.log(`B1b raw targets: ${total - fails.length}/${total} were the seam's 400`);
  assert(fails.length === 0, `${fails.length}/${total} raw targets were not the seam's 400:\n${fails.join("\n")}`);
} });

// rw-identity3 (F-b): forward-auth NOT configured, yet the request carries Authentik's headers - 503, never
// the default user; without them, today's single-user behaviour.
Deno.test({ name: "Fb with no WORKSPACE_FORWARD_AUTH_* a request carrying X-authentik-jwt or any X-authentik-* is refused 503, never served as the default user", ...opts, ignore: ignore || !WB_PLAIN, fn: async () => {
  const tok = await mint(claimsOf("bob"));
  const fails: string[] = [];
  for (const extra of [{ [TOKEN]: tok }, { "X-authentik-uid": sub("bob") || "ak-bob" }, { "X-Authentik-Username": "bob" }, { "x-authentik-groups": "admins" }] as Record<string, string>[]) {
    for (const p of ["/workbench/workspace/whoami", "/workbench/contract/documents", "/workbench/documents/folders", "/workbench/auth/me"]) {
      const r = await direct(WB_PLAIN, "GET", p, { "x-brain-key": INTERNAL, ...extra });
      if (r.status !== 503 || !/forward-auth is not configured/.test(r.text) || r.json.subject_sub !== undefined) fails.push(`${p} ${Object.keys(extra)[0]}: ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  assertEquals((await direct(WB_PLAIN, "GET", "/workbench/workspace/whoami", { "x-brain-key": INTERNAL })).json.subject_sub, E("IDENTITY_TEST_DEFAULT_SUB") || "operator", "no Authentik header: as before");
  assert(fails.length === 0, `${fails.length} requests with X-authentik-* were served while forward-auth is off:\n${fails.join("\n")}`);
} });

Deno.test({ name: "C1 two signed-in users: each sees only their own documents; shared knowledge alike", ...opts, fn: async () => {
  const a = new Browser();
  await a.signIn("alice");
  const bo = new Browser();
  await bo.signIn("bob");
  const made = await a.req("POST", "/workbench/documents", { title: marker });
  assertEquals(made.status, 201, made.text);
  alicePath = made.json.path;
  const listA = await a.req("GET", "/workbench/contract/documents?limit=500");
  assert(listA.text.includes(marker), "alice lists her document");
  const listB = await bo.req("GET", "/workbench/contract/documents?limit=500");
  assertEquals(listB.status, 200);
  assert(!listB.text.includes(marker) && !listB.text.includes(alicePath), "bob does not");
  assertEquals((await bo.req("GET", `/workbench/documents/file?path=${encodeURIComponent(alicePath)}`)).status, 404);
  const sa = await a.req("GET", "/workbench/contract/search?q=fixture");
  const sb = await bo.req("GET", "/workbench/contract/search?q=fixture");
  assertEquals([sa.status, sa.text], [sb.status, sb.text], "shared knowledge reads the same");
  const row = await sql<{ owner_sub: string; actor_sub: string }>(`SELECT owner_sub, actor_sub FROM public.user_document_listings WHERE path = $1`, [alicePath]);
  assertEquals([row[0].owner_sub, row[0].actor_sub], [sub("alice"), sub("alice")]);
} });

// ── C3: admin impersonation and the audit log ─────────────────────────────────────────────────
Deno.test({ name: "C3 a non-admin cannot impersonate (refused and recorded)", ...opts, fn: async () => {
  const bo = new Browser();
  await bo.signIn("bob");
  const r = await bo.req("POST", "/workbench/auth/impersonate", { sub: sub("alice"), reason: "I would like to look" });
  assertEquals(r.status, 403, r.text);
  assertEquals((await bo.req("GET", "/workbench/auth/audit")).status, 403);
  assertEquals((await bo.req("GET", "/workbench/auth/users")).status, 403);
  const me = await bo.req("GET", "/workbench/auth/me");
  assertEquals([me.json.subject_sub, me.json.impersonating], [sub("bob"), null]);
  const rows = await sql(`SELECT action FROM public.admin_audit WHERE actor_sub = $1 AND action = 'impersonate.refused'`, [sub("bob")]);
  assert(rows.length >= 3, `bob's three refused attempts are recorded (${rows.length})`);
} });

Deno.test({ name: "C3 an admin impersonates only after a reason; subject = the user, actor = the admin; every request audited; retrievable; append-only", ...opts, fn: async () => {
  assert(alicePath, "C1 ran first");
  const ad = new Browser();
  await ad.signIn("admin");
  const me0 = await ad.req("GET", "/workbench/auth/me");
  assertEquals([me0.json.admin, me0.json.subject_sub], [true, sub("admin")]);
  // the admin, as themself, does not see alice's document
  assert(!(await ad.req("GET", "/workbench/contract/documents?limit=500")).text.includes(marker));
  // round 4 (tester F3): visible characters only - zero-width and white space do not count; 8 at least
  for (const reason of [undefined, "", "   ", "ab", "\u200b\u200b\u200b\u200b", " \u200b\u2060\ufeff\u00ad ", "a\u200bb\u200bc\u200bd", "abcdefg", "........",
      // round 5 (tester attempt 2, F3b): only letters and digits count - tag characters, braille blanks,
      // variation selectors, combining marks, Hangul fillers, NBSP, U+FFFC do not
      "a" + "\u{E0061}".repeat(7), "ab" + "\u2800".repeat(6), "a" + "\u{E0100}".repeat(7), "a" + "\u0300".repeat(7),
      "\u3164".repeat(8), "a" + "\u{1BCA0}".repeat(7), "a" + "\ufffc".repeat(7), "\u00a0".repeat(8), "........a"]) {
    const r = await ad.req("POST", "/workbench/auth/impersonate", { sub: sub("alice"), ...(reason === undefined ? {} : { reason }) });
    assertEquals(r.status, 400, `reason ${JSON.stringify(reason)}: ${r.text}`);
  }
  assertEquals((await ad.req("GET", "/workbench/auth/me")).json.impersonating, null, "no reason, no switch");
  const reason = `support ticket ${crypto.randomUUID().slice(0, 6)}: alice cannot find her draft`;
  const before = ad.requests;
  const go = await ad.req("POST", "/workbench/auth/impersonate", { sub: sub("alice"), reason });
  assertEquals(go.status, 200, go.text);
  const sessionRef = (await sql<{ s: string }>(`SELECT session_ref AS s FROM public.admin_audit WHERE action = 'impersonate.start' AND reason = $1`, [reason]))[0]?.s;
  assert(sessionRef, "the switch is recorded with its reason");
  // during impersonation: the user's UI, written as the user by the admin
  const me = await ad.req("GET", "/workbench/auth/me");
  assertEquals([me.json.subject_sub, me.json.actor_sub, me.json.impersonating?.sub, me.json.impersonating?.reason], [sub("alice"), sub("admin"), sub("alice"), reason]);
  assert((await ad.req("GET", "/workbench/contract/documents?limit=500")).text.includes(marker), "the admin sees alice's documents");
  assertEquals((await ad.req("GET", `/workbench/documents/file?path=${encodeURIComponent(alicePath)}`)).status, 200);
  const made = await ad.req("POST", "/workbench/documents", { title: "written while impersonating" });
  assertEquals(made.status, 201, made.text);
  const row = await sql<{ owner_sub: string; actor_sub: string }>(`SELECT owner_sub, actor_sub FROM public.user_document_listings WHERE path = $1`, [made.json.path]);
  assertEquals([row[0].owner_sub, row[0].actor_sub], [sub("alice"), sub("admin")], "owner = the user, actor = the admin");
  assertEquals((await ad.req("POST", "/workbench/auth/impersonate", { sub: sub("bob"), reason: "nested attempt" })).status, 409);
  const end = await ad.req("POST", "/workbench/auth/impersonate/end", {});
  assertEquals(end.status, 200, end.text);
  const during = ad.requests - before - 1; // every request after the switch, including the end call (not the switch itself)
  const audited = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.admin_audit WHERE action = 'request' AND session_ref = $1`, [sessionRef]);
  assertEquals(audited[0].n, during, "every request made while impersonating is in admin_audit");
  const routes = await sql<{ route: string; method: string }>(`SELECT route, method FROM public.admin_audit WHERE action = 'request' AND session_ref = $1 ORDER BY id`, [sessionRef]);
  assert(routes.some((r) => r.method === "POST" && r.route === "/workbench/documents"), "with method and route");
  const me2 = await ad.req("GET", "/workbench/auth/me");
  assertEquals([me2.json.subject_sub, me2.json.impersonating], [sub("admin"), null]);
  // retrievable: the admin view, filtered
  const log = await ad.req("GET", `/workbench/auth/audit?subject=${encodeURIComponent(sub("alice"))}&limit=500`);
  assertEquals(log.status, 200, log.text);
  const acts = (log.json.entries as any[]).filter((e) => e.session_ref === sessionRef).map((e) => e.action);
  assert(acts.includes("impersonate.start") && acts.includes("impersonate.end") && acts.includes("request"), acts.join(","));
  const first = (log.json.entries as any[]).find((e) => e.action === "impersonate.start" && e.reason === reason);
  assertEquals([first.actor_sub, first.subject_sub], [sub("admin"), sub("alice")]);
  assert(first.at, "with the time");
  const read = await sql(`SELECT 1 FROM public.admin_audit WHERE action = 'audit.read' AND actor_sub = $1`, [sub("admin")]);
  assert(read.length >= 1, "reading the log is itself recorded");
  // append-only, for the workbench's role and for the superuser
  for (const as of ["app", "postgres"] as const) {
    for (const stmt of [`UPDATE public.admin_audit SET reason = 'rewritten' WHERE session_ref = '${sessionRef}'`, `DELETE FROM public.admin_audit WHERE session_ref = '${sessionRef}'`, `TRUNCATE public.admin_audit`]) {
      let refused = false;
      try { await sql(stmt, [], as); } catch { refused = true; }
      assert(refused, `${as}: ${stmt.split(" ")[0]} is refused`);
    }
  }
  assertEquals((await sql<{ r: string }>(`SELECT reason AS r FROM public.admin_audit WHERE action = 'impersonate.start' AND session_ref = $1`, [sessionRef]))[0].r, reason);
} });

// ── C2: the Open WebUI hand-off and service identities (the real research service) ────────────
async function submit(key: string, body: Record<string, unknown>) {
  const r = await fetch(`${RS}/research`, { method: "POST", headers: { "content-type": "application/json", "x-brain-key": key }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const owner = async (job: string) => (await sql<{ owner_sub: string; actor_sub: string }>(`SELECT owner_sub, actor_sub FROM public.research_prompts WHERE job_id = $1`, [job]))[0];

Deno.test({ name: "C2 research from Open WebUI by alice lands in alice's research UI, not bob's", ...opts, fn: async () => {
  const prompt = `OwuiPrompt${crypto.randomUUID().slice(0, 8)} what is the boiling point`;
  const r = await submit(K.owui, { query: prompt, origin: "owui", on_behalf_of: sub("alice"), callback: { chat_id: "chat-alice-1", message_id: "m-1" } });
  assertEquals(r.status, 202, JSON.stringify(r.json));
  const job = r.json.job_id;
  assertEquals(await owner(job), { owner_sub: sub("alice"), actor_sub: sub("alice") });
  const a = new Browser();
  await a.signIn("alice");
  const bo = new Browser();
  await bo.signIn("bob");
  const sa = await a.req("GET", `/workbench/contract/sessions/${job}`);
  assertEquals(sa.status, 200, sa.text);
  assertEquals([sa.json.query, sa.json.inlet_ref?.id], [prompt, "chat-alice-1"], "alice sees her prompt and the chat it came from");
  const sb = await bo.req("GET", `/workbench/contract/sessions/${job}`);
  assertEquals([sb.json.query, sb.json.inlet_ref], ["", null], "bob sees the shared job, not alice's prompt or chat");
  for (const p of ["/workbench/contract/jobs?kinds=research&limit=200", "/workbench/contract/timeline?limit=500", `/workbench/contract/sessions/${job}/stream`]) {
    const t = await bo.req("GET", p);
    assert(!t.text.includes(prompt.slice(0, 18)) && !t.text.includes("chat-alice-1"), `bob's ${p} carries nothing of alice's prompt`);
  }
  const ja = await a.req("GET", "/workbench/contract/jobs?kinds=research&limit=200");
  assert(ja.text.includes(prompt.slice(0, 18)), "alice's job list shows her prompt");
} });

Deno.test({ name: "C2 on_behalf_of from any key but Open WebUI's is refused; a spoofed or reserved subject is refused", ...opts, fn: async () => {
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs`))[0].n;
  for (const [name, key] of [["agent-org", K.ao], ["workspace", K.ws], ["shared key", K.shared]] as const) {
    const r = await submit(key, { query: "spoof attempt", on_behalf_of: sub("alice") });
    assertEquals(r.status, 403, `${name}: ${JSON.stringify(r.json)}`);
  }
  for (const bad of ["service:internal", "system:backfill", "", 42]) {
    const r = await submit(K.owui, { query: "spoof attempt", on_behalf_of: bad });
    if (bad === "") assertEquals(r.status, 202); // empty = none given
    else assertEquals(r.status, 400, `${JSON.stringify(bad)}: ${JSON.stringify(r.json)}`);
  }
  const after = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs`))[0].n;
  assertEquals(after, before + 1, "no refused request stored a job");
  assertEquals((await submit("forged-forged-forged-forged", { query: "x", on_behalf_of: sub("alice") })).status, 401);
} });

Deno.test({ name: "C2 agent-started research is recorded under a service identity (shared, never a user's)", ...opts, fn: async () => {
  const prompt = `AgentPrompt${crypto.randomUUID().slice(0, 8)}`;
  const r = await submit(K.ao, { query: prompt });
  assertEquals(r.status, 202);
  assertEquals(await owner(r.json.job_id), { owner_sub: "service:agent-org", actor_sub: "service:agent-org" });
  const o = await submit(K.owui, { query: `${prompt}-owui-no-user` });
  assertEquals((await owner(o.json.job_id)).owner_sub, "service:owui-tool");
  const a = new Browser();
  await a.signIn("alice");
  const bo = new Browser();
  await bo.signIn("bob");
  assertEquals((await a.req("GET", `/workbench/contract/sessions/${r.json.job_id}`)).json.query, prompt);
  assertEquals((await bo.req("GET", `/workbench/contract/sessions/${r.json.job_id}`)).json.query, prompt);
} });

Deno.test({ name: "C2 research queued from alice's own document (the workspace key) is alice's", ...opts, fn: async () => {
  const a = new Browser();
  await a.signIn("alice");
  const prompt = `WsPrompt${crypto.randomUUID().slice(0, 8)}`;
  const r = await a.req("POST", "/workbench/documents/research", { path: alicePath, query: prompt, kind: "research" });
  assertEquals(r.status, 202, r.text);
  assertEquals(await owner(r.json.job_id), { owner_sub: sub("alice"), actor_sub: sub("alice") });
} });

// C2b (coordinator 2026-10-29): the research service's own read routes are owner-scoped too - the
// list shows a caller only its user's (or its service's) jobs; a job's detail, stream, tree and events
// stay readable (research output is shared) but carry nothing of another user's original prompt, in
// any field (progress, result, error, event payloads). The prompt is seeded into every nested field.
async function rsGet(key: string, path: string, onBehalf?: string) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`${RS}${path}`, { headers: { "x-brain-key": key, ...(onBehalf ? { "x-on-behalf-of": onBehalf } : {}) }, signal: ctl.signal });
    let text = "";
    try { text = await r.text(); } catch { /* aborted stream: keep nothing more */ }
    return { status: r.status, text };
  } finally { clearTimeout(t); }
}

Deno.test({ name: "C2b the research service's job list, detail, stream, tree and events never show one user's prompt to another", ...opts, fn: async () => {
  const mark = `CrossUserPrompt${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const prompt = `${mark} how do tidal locks form`;
  const r = await submit(K.owui, { query: prompt, origin: "owui", on_behalf_of: sub("alice") });
  assertEquals(r.status, 202, JSON.stringify(r.json));
  const job = r.json.job_id as string;
  // the prompt in every nested field a read route returns; terminal, so the dispatcher leaves it alone
  await sql(`UPDATE public.research_jobs SET status = 'error', finished_at = now(),
               progress = jsonb_build_object('phase', 'plan', 'message', 'planning ' || $2::text),
               result = jsonb_build_object('query', $2::text, 'sources', jsonb_build_array(jsonb_build_object('title', 'about ' || $2::text))),
               error = 'failed while researching ' || $2::text
             WHERE id = $1::uuid`, [job, prompt]);
  await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload)
             VALUES ($1::uuid, $1::uuid, 's1', 'stage', 'due_process', jsonb_build_object('note', 'stage for ' || $2::text))`, [job, prompt]);
  const paths = [`/research/jobs?limit=50`, `/research/jobs/${job}`, `/research/jobs/${job}/stream`, `/research/jobs/${job}/tree`, `/research/jobs/${job}/events`];
  // the owner sees it all
  const own = await rsGet(K.owui, `/research/jobs/${job}`, sub("alice"));
  assertEquals(own.status, 200, own.text);
  assert(own.text.includes(mark), "alice reads her own prompt");
  assert((await rsGet(K.owui, `/research/jobs?limit=50`, sub("alice"))).text.includes(job), "alice's list has her job");
  // everyone else: bob through Open WebUI, the tool with no user, an agent, the shared key
  const others: [string, string, string | undefined][] = [["bob via owui", K.owui, sub("bob")], ["owui, no user", K.owui, undefined],
    ["agent-org", K.ao, undefined], ["shared key", K.shared, undefined]];
  for (const [who, key, obo] of others) {
    for (const p of paths) {
      const res = await rsGet(key, p, obo);
      assert(res.status < 500, `${who} ${p}: ${res.status}`);
      assert(!res.text.includes(mark), `${who} ${p} carries alice's prompt: ${res.text.slice(0, 300)}`);
    }
    assert(!(await rsGet(key, `/research/jobs?limit=50`, obo)).text.includes(job), `${who}'s list does not list alice's job`);
    const detail = await rsGet(key, `/research/jobs/${job}`, obo);
    assertEquals(detail.status, 200, `${who}: the job itself stays readable (shared research output)`);
  }
  // naming a user is Open WebUI's (and the workspace's, for reads) alone
  assertEquals((await rsGet(K.ao, `/research/jobs?limit=5`, sub("alice"))).status, 403);
  assertEquals((await rsGet(K.shared, `/research/jobs/${job}`, sub("alice"))).status, 403);
} });

// C2c (coordinator 2026-10-29; 07-MULTI-USER "all existing private content is ProfNovice's"): a job
// with no recorded owner (started before rw-identity) is WORKSPACE_DEFAULT_SUB's - its prompt (in the
// query, the error, a progress message) reaches that subject only, through the workbench and the
// research service alike. The lab's default subject is the lab user "prof".
Deno.test({ name: "C2c an ownerless pre-rw-identity job is the default subject's: nobody else sees its prompt", ...opts, fn: async () => {
  const mark = `OwnerlessPrompt${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const prompt = `${mark} a question asked before sign-in existed`;
  const [{ id }] = await sql<{ id: string }>(
    `INSERT INTO public.research_jobs (status, origin, query, caller, finished_at, error, progress)
     VALUES ('error', 'manual', $1, 'shared-key', now(), 'failed on ' || $1, jsonb_build_object('message', 'planning ' || $1))
     RETURNING id::text AS id`, [prompt]);
  const prof = new Browser();
  await prof.signIn("prof");
  assertEquals((await prof.req("GET", "/workbench/auth/me")).json.subject_sub, E("IDENTITY_TEST_DEFAULT_SUB"), "prof is the default subject");
  const ps = await prof.req("GET", `/workbench/contract/sessions/${id}`);
  assertEquals(ps.json.query, prompt, "the default subject reads the old prompt");
  assert((await rsGet(K.owui, `/research/jobs/${id}`, sub("prof"))).text.includes(mark), "and through Open WebUI");
  assert((await rsGet(K.owui, `/research/jobs?limit=50`, sub("prof"))).text.includes(id), "and lists it");
  for (const login of ["bob", "admin"]) {
    const b = new Browser();
    await b.signIn(login);
    for (const p of [`/workbench/contract/sessions/${id}`, "/workbench/contract/jobs?kinds=research&limit=200", "/workbench/contract/timeline?limit=500", `/workbench/contract/sessions/${id}/stream`]) {
      const r = await b.req("GET", p);
      assert(!r.text.includes(mark), `${login} ${p} carries the old prompt: ${r.text.slice(0, 300)}`);
    }
  }
  for (const [who, key, obo] of [["bob via owui", K.owui, sub("bob")], ["agent-org", K.ao, undefined], ["shared key", K.shared, undefined]] as const) {
    for (const p of [`/research/jobs?limit=50`, `/research/jobs/${id}`, `/research/jobs/${id}/tree`, `/research/jobs/${id}/events`]) {
      const r = await rsGet(key, p, obo);
      assert(!r.text.includes(mark), `${who} ${p} carries the old prompt: ${r.text.slice(0, 300)}`);
    }
  }
} });

// C2d (tester attempt 1, Case 7): ALLOW-LIST - a non-owner's view of a job carries only the shared
// research output (status, the grounded report, its claims and sources). Fragments of the prompt in
// any other field - the prefix before a comma (the failure notice's old subject), a title-cased copy,
// a JSON-escaped copy, a middle chunk, a lower-cased copy - never reach another user or an agent key.
Deno.test({ name: "C2d a non-owner reads only the shared fields: no fragment, case change, escape or middle chunk of the prompt", ...opts, fn: async () => {
  const tok = `Zq${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const prompt = `My lawyer ${tok} Smith, should I sign the settlement my ex offered on Friday?`;
  const r = await submit(K.owui, { query: prompt, origin: "owui", on_behalf_of: sub("alice"), callback: { chat_id: `chat-${tok}`, message_id: "m" } });
  assertEquals(r.status, 202, JSON.stringify(r.json));
  const job = r.json.job_id as string;
  const prefix = prompt.split(/[:,;]/)[0].trim();
  const title = prompt.replace(/\b\w/g, (c) => c.toUpperCase());
  const escaped = JSON.stringify({ q: prompt.replace(/ /g, "\n") });
  const mid = `the settlement ${tok} offered on Friday`;
  await sql(`UPDATE public.research_jobs SET status = 'done', finished_at = now(),
     progress = jsonb_build_object('phase', 'done', 'message', lower($2::text)),
     metrics = jsonb_build_object('note', $3::text),
     error = $4::text,
     result = jsonb_build_object('outcome', 'complete', 'report', $5::text, 'prose', '# No sources about ' || $2::text || ' were retrieved',
       'rendered', $3::text, 'needs', jsonb_build_array($3::text), 'followup_queries', jsonb_build_array($5::text), 'gaps', jsonb_build_array($5::text),
       'search_record', jsonb_build_object('queries', jsonb_build_array($4::text)), 'sources', jsonb_build_array(jsonb_build_object('title', $5::text)),
       'synthesis', 'Settlement offers are usually negotiable [Source 1].',
       'cited_sources', jsonb_build_array(jsonb_build_object('title', 'Settlement basics', 'url', 'https://example.org/settle')),
       'reuse_claims', jsonb_build_array(jsonb_build_object('id', 'c1', 'text', 'Offers can be countered.')))
     WHERE id = $1::uuid`, [job, prefix, title, escaped, mid]);
  await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload)
             VALUES ($1::uuid, $1::uuid, 's1', 'stage', 'due_process', jsonb_build_object('note', $2::text))`, [job, title]);
  const has = (t: string) => t.toLowerCase().includes(tok.toLowerCase());
  assert(has((await rsGet(K.owui, `/research/jobs/${job}`, sub("alice"))).text), "alice reads all of it");
  const reads = [`/research/jobs?limit=50`, `/research/jobs/${job}`, `/research/jobs/${job}/stream`, `/research/jobs/${job}/tree`, `/research/jobs/${job}/events`];
  for (const [who, key, obo] of [["bob via owui", K.owui, sub("bob")], ["owui, no user", K.owui, undefined], ["agent-org", K.ao, undefined],
      ["shared key", K.shared, undefined], ["workspace as bob", K.ws, sub("bob")]] as const) {
    for (const p of reads) {
      const res = await rsGet(key, p, obo);
      assert(!has(res.text), `${who} ${p} carries a fragment of alice's prompt: ${res.text.slice(0, 300)}`);
    }
    // the shared research output is still there
    const d = await rsGet(key, `/research/jobs/${job}`, obo);
    assertEquals(d.status, 200);
    assert(d.text.includes("Settlement basics") && d.text.includes("Offers can be countered") && d.text.includes("usually negotiable"),
      `${who}: the shared report, sources and claims are kept: ${d.text.slice(0, 300)}`);
  }
  const bo = new Browser();
  await bo.signIn("bob");
  for (const p of [`/workbench/contract/sessions/${job}`, `/workbench/contract/sessions/${job}/stream`, "/workbench/contract/jobs?kinds=research&limit=200", "/workbench/contract/timeline?limit=500"]) {
    const res = await bo.req("GET", p);
    assert(!has(res.text), `bob ${p} carries a fragment of alice's prompt: ${res.text.slice(0, 300)}`);
  }
} });

// C2e (tester F4): with sign-in on and WORKSPACE_DEFAULT_SUB blank, an ownerless job's prompt is read
// only by an admin who is not impersonating - and every such read is in admin_audit.
Deno.test({ name: "C2e default unset: ownerless prompts reach only a non-impersonating admin, and those reads are audited", ...opts, ignore: ignore || !WB_NODEF, fn: async () => {
  const mark = `NodefPrompt${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const [{ id }] = await sql<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, query, caller, finished_at)
     VALUES ('error', 'manual', $1, 'shared-key', now()) RETURNING id::text AS id`, [`${mark} an old question`]);
  const ad = new Browser();
  await ad.signIn("admin");
  const bo = new Browser();
  await bo.signIn("bob");
  const as = (b: Browser) => ({ "x-brain-key": DOOR, ...b.auth() });
  assert(!(await direct(WB_NODEF, "GET", `/workbench/contract/sessions/${id}`, as(bo))).text.includes(mark), "bob: nobody's prompt");
  const count = async () => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.admin_audit WHERE actor_sub = $1 AND reason LIKE '%ownerless%'`, [sub("admin")]))[0].n;
  const before = await count();
  const r = await direct(WB_NODEF, "GET", `/workbench/contract/sessions/${id}`, as(ad));
  assert(r.text.includes(mark), "the admin reads it");
  assertEquals(await count(), before + 1, "the read is recorded");
  const last = await sql<{ route: string }>(`SELECT route FROM public.admin_audit WHERE actor_sub = $1 AND reason LIKE '%ownerless%' ORDER BY id DESC LIMIT 1`, [sub("admin")]);
  assertEquals(last[0].route, `/workbench/contract/sessions/${id}`);
} });

// C2f (tester attempt 2, Case 7 / P10): the research service's WRITE routes act for the owner only -
// a steer or a cancel on another user's job is refused as if the job did not exist (404), changes
// nothing, and carries nothing of the prompt; the owner's steer and cancel work. A non-owner's events
// read no longer hands out the step ids a steer needs.
Deno.test({ name: "C2f a non-owner cannot steer or cancel another user's job; the refusal carries nothing; the owner can", ...opts, fn: async () => {
  const tok = `SteerVictim${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const prompt = `Find my neighbour ${tok} and their unpaid rent history`;
  const r = await submit(K.owui, { query: prompt, origin: "owui", on_behalf_of: sub("alice") });
  assertEquals(r.status, 202);
  const job = r.json.job_id as string;
  await sql(`UPDATE public.research_jobs SET status = 'done', finished_at = now(), result = '{"synthesis":"x","outcome":"complete"}'::jsonb WHERE id = $1::uuid`, [job]);
  await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind) VALUES ($1::uuid, $1::uuid, 's98', 'stage', 'due_process')`, [job]);
  const ev = await rsGet(K.ao, `/research/jobs/${job}/events`);
  assert(!ev.text.includes("s98"), `a non-owner's events read carries no step id: ${ev.text.slice(0, 200)}`);
  const kids = async () => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs WHERE parent_job_id = $1::uuid`, [job]))[0].n;
  const post = async (key: string, path: string, body: unknown, obo?: string) => {
    const x = await fetch(`${RS}${path}`, { method: "POST", headers: { "x-brain-key": key, "content-type": "application/json", ...(obo ? { "x-on-behalf-of": obo } : {}) }, body: JSON.stringify(body) });
    return { status: x.status, text: await x.text() };
  };
  for (const [who, key, obo] of [["agent-org", K.ao, undefined], ["shared key", K.shared, undefined], ["owui as bob", K.owui, sub("bob")],
      ["workspace as bob", K.ws, sub("bob")], ["owui, no user", K.owui, undefined]] as const) {
    const s = await post(key, `/research/jobs/${job}/steer`, { step_id: "s98", text: `${who} narrows it` }, obo);
    assertEquals(s.status, 404, `${who} steer: ${s.status} ${s.text.slice(0, 200)}`);
    assert(!s.text.toLowerCase().includes(tok.toLowerCase()), `${who} steer answer carries the prompt`);
    const c = await post(key, `/research/jobs/${job}/cancel`, { reason: "not mine" }, obo);
    assertEquals(c.status, 404, `${who} cancel: ${c.status} ${c.text.slice(0, 200)}`);
  }
  assertEquals(await kids(), 0, "no branch was written into alice's tree");
  // a queued job of alice's: a non-owner's cancel leaves it queued
  const q = await submit(K.owui, { query: `CancelVictim${tok} my tax letter`, origin: "owui", on_behalf_of: sub("alice") });
  await sql(`UPDATE public.research_jobs SET status = 'queued' WHERE id = $1::uuid`, [q.json.job_id]);
  assertEquals((await post(K.ao, `/research/jobs/${q.json.job_id}/cancel`, {})).status, 404);
  assertEquals((await sql<{ s: string }>(`SELECT status AS s FROM public.research_jobs WHERE id = $1::uuid`, [q.json.job_id]))[0].s, "queued");
  // the owner (through Open WebUI naming alice) steers and cancels
  const own = await post(K.owui, `/research/jobs/${job}/steer`, { step_id: "s98", text: "narrow it to the last year" }, sub("alice"));
  assertEquals(own.status, 201, own.text.slice(0, 200));
  assertEquals(await kids(), 1);
  const oc = await post(K.owui, `/research/jobs/${q.json.job_id}/cancel`, {}, sub("alice"));
  assert(oc.status === 200 || oc.status === 202, `${oc.status} ${oc.text.slice(0, 100)}`);
} });

// ── C5: no sign-in configured = exactly the P2b behaviour ─────────────────────────────────────
Deno.test({ name: "C5 a workbench with no WORKSPACE_FORWARD_AUTH_* behaves as before: one default identity, no sign-in", ...opts, ignore: ignore || !WB_PLAIN, fn: async () => {
  const h = { "x-brain-key": INTERNAL };
  const me = await direct(WB_PLAIN, "GET", "/workbench/auth/me", h);
  assertEquals([me.json.mode, me.json.signed_in, me.json.subject_sub, me.json.kind], ["default", true, E("IDENTITY_TEST_DEFAULT_SUB") || "operator", "default"]);
  const who = await direct(WB_PLAIN, "GET", "/workbench/workspace/whoami", h);
  assertEquals(who.json.subject_sub, E("IDENTITY_TEST_DEFAULT_SUB") || "operator");
  assertEquals((await direct(WB_PLAIN, "GET", "/workbench/contract/documents", h)).status, 200, "no token needed");
  assertEquals((await direct(WB_PLAIN, "GET", "/workbench/documents/folders", h)).status, 200, "WORKBENCH_KEY is the browser's door, as before");
  assertEquals(me.json.logout, null, "no sign-out link");
  // a token sent anyway changes nothing there (no forward-auth configured = the token is not read)
  const tok = await mint(claimsOf("bob"));
  // rw-identity3 (F-b, operator-agreed): a token sent anyway is REFUSED 503 - forward-auth is not
  // configured, so it is never served as the default user (was: ignored, served as the default)
  const w2 = await direct(WB_PLAIN, "GET", "/workbench/workspace/whoami", { ...h, [TOKEN]: tok });
  assertEquals(w2.status, 503, `a token while forward-auth is off: ${w2.status} ${w2.text.slice(0, 120)}`);
  assert(/forward-auth is not configured/.test(w2.text) && w2.json.subject_sub === undefined, w2.text.slice(0, 160));
  assertNotEquals((await direct(WB_PLAIN, "GET", "/workbench/contract/documents", h)).status, 401);
} });

// ── rw-identity-harden (the r-identity2 / r-identity3 follow-ups), against the real workbench ─────
// A raw request with a Host line of the test's choosing (fetch always sends the URL's own host).
async function rawHost(base: string, method: string, target: string, host: string, headers: Record<string, string>) {
  const u = new URL(base);
  const conn = await Deno.connect({ hostname: u.hostname, port: Number(u.port || 80) });
  const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  await conn.write(new TextEncoder().encode(`${method} ${target} HTTP/1.1\r\nHost: ${host}\r\n${h}Connection: close\r\n\r\n`));
  const buf = new Uint8Array(65536);
  let out = "";
  let n: number | null;
  try {
    while ((n = await conn.read(buf)) !== null) out += new TextDecoder().decode(buf.subarray(0, n));
  } catch { /* reset */ }
  conn.close();
  const i = out.indexOf("\r\n\r\n");
  return { status: Number(out.slice(9, 12)), text: i === -1 ? "" : out.slice(i + 4) };
}

Deno.test({ name: "Fg only the exact open routes skip identity: /workbench/health/<x> and /workbench/auth/me/<x> without a token are 401", ...opts, fn: async () => {
  const fails: string[] = [];
  for (const t of ["/workbench/health/x", "/workbench/health/", "/workbench/health/documents/folders", "/workbench/auth/me/", "/workbench/auth/me/x"]) {
    for (const m of ["GET", "POST"]) {
      const r = await rawDirect(WB, m, t, { "x-brain-key": DOOR });
      if (r.status !== 401) fails.push(`${m} ${t}: ${r.status} ${r.text.slice(0, 100)}`);
    }
  }
  assertEquals((await rawDirect(WB, "GET", "/workbench/health", { "x-brain-key": DOOR })).status, 200, "health stays open");
  assertEquals((await rawDirect(WB, "GET", "/workbench/auth/me", { "x-brain-key": DOOR })).status, 200, "who-am-I stays open");
  assert(fails.length === 0, `${fails.length} requests under an open route's prefix skipped the identity decision:\n${fails.join("\n")}`);
} });

Deno.test({ name: "Fh a Host that is not host[:port] is the seam's 400 before any decision, and no error body echoes the request", ...opts, fn: async () => {
  const tok = await mint(claimsOf("alice"));
  const own = new URL(WB).host;
  const fails: string[] = [];
  const hosts = [`${own}/workbench/notes`, `${own}?a=1`, `${own}#f`, `u@${own}`, `${own} x`, `${own}\tx`, "h:abc", "h:", "", `${own}%2f..`, "h?path=documents/x/a.md&"];
  for (const host of hosts) {
    for (const [label, base, h] of [["door, no token", WB, { "x-brain-key": DOOR }], ["door + alice", WB, { "x-brain-key": DOOR, [TOKEN]: tok }],
        ["sign-in off, service key", WB_PLAIN, { "x-brain-key": INTERNAL }]] as const) {
      if (!base) continue;
      const target = host.endsWith("/workbench/notes") ? "/a.md?q=probe-q" : "/workbench/notes/a.md?q=probe-q";
      const r = await rawHost(base, "GET", target, host, h);
      const leaks = ["probe-q", "Invalid URL", "TypeError", "    at ", "file:///", host.length > 2 ? host : ""].filter((s) => s && r.text.includes(s));
      // or the app's own 404 when the Host moved the router's path outside /workbench/* (no route, no seam:
      // a Host holding "/", or an empty Host on Deno 2.3.3, whose URL is then "http:///...")
      const outside = r.status === 404 && /^\{"error":"not found"\}$/.test(r.text.trim());
      if ((r.status !== 400 && !outside) || leaks.length) fails.push(`Host ${JSON.stringify(host)} [${label}]: ${r.status} ${r.text.slice(0, 140)}${leaks.length ? ` (echoes ${leaks.join(", ")})` : ""}`);
    }
  }
  // control: the workbench's own host is judged as before
  assertEquals((await rawHost(WB, "GET", "/workbench/notes/a.md", own, { "x-brain-key": DOOR })).status, 401);
  assert(fails.length === 0, `${fails.length} cases:\n${fails.join("\n")}`);
} });

Deno.test({ name: "Fc an impersonation past its expiry is ended and audited without any request from that admin", ...opts, fn: async () => {
  // boss (an admin) and uma have been seen signed in; then boss makes no request at all
  for (const login of ["boss", "uma"]) {
    const b = new Browser();
    await b.signIn(login);
    assertEquals((await b.req("GET", "/workbench/auth/me")).status, 200);
  }
  const ref = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  // the row /impersonate writes, but already past its expiry (started two hours ago, ended a minute ago)
  await sql(`INSERT INTO public.workspace_impersonation (admin_sub, target_sub, reason, ref, started_at, expires_at)
             VALUES ($1, $2, 'Fc sweeper check', $3, now() - interval '2 hours', now() - interval '1 minute')`, [sub("boss"), sub("uma"), ref]);
  let open = 1, ended: { actor_sub: string; subject_sub: string; reason: string }[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 100_000) {
    open = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.workspace_impersonation WHERE ref = $1`, [ref]))[0].n;
    ended = await sql(`SELECT actor_sub, subject_sub, reason FROM public.admin_audit WHERE action = 'impersonate.end' AND session_ref = $1`, [ref]);
    if (!open && ended.length) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`Fc: after ${Math.round((Date.now() - t0) / 1000)} s the expired impersonation is ${open ? "STILL OPEN" : "ended"}; end rows ${ended.length}`);
  assertEquals(open, 0, "the expired impersonation was not ended without a request from its admin");
  assertEquals(ended.length, 1, "its end is recorded once");
  assertEquals([ended[0].actor_sub, ended[0].subject_sub], [sub("boss"), sub("uma")]);
  assert(/^expired/.test(ended[0].reason), ended[0].reason);
} });

Deno.test({ name: "Fd ending an impersonation writes its audit row in the same transaction: a failed audit insert leaves it open, a failed end writes no audit row", ...opts, fn: async () => {
  // the store as built (a dynamic import: the RED run mounts this file over the base's tree)
  // deno-lint-ignore no-explicit-any
  const store = await import("./store.ts") as any;
  const { poolDb } = await import("../contracts/db.ts");
  type Db = ReturnType<typeof poolDb>;
  const p = new Pool({ hostname: E("CONTRACT_TEST_DB_HOST"), port: 5432, user: "ob_app_memory", password: E("IDENTITY_TEST_APP_PASSWORD"), database: "openbrain" }, 2, true);
  const db = poolDb(p);
  // a Db on which a matching statement RUNS and then fails: the write happened, the step after it did not
  const failing = (d: Db, when: RegExp): Db => ({
    query: async <T>(s: string, a?: unknown[]) => {
      const r = await d.query<T>(s, a);
      if (when.test(s)) throw new Error(`forced failure after ${s.trim().slice(0, 40)}`);
      return r;
    },
    tx: <T>(fn: (t: Db) => Promise<T>) => d.tx((t) => fn(failing(t, when))),
  });
  for (const login of ["admin", "carol"]) {
    const b = new Browser();
    await b.signIn(login);
    assertEquals((await b.req("GET", "/workbench/auth/me")).status, 200);
  }
  const admin = sub("admin"), target = sub("carol");
  const fresh = async () => {
    const ref = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await sql(`DELETE FROM public.workspace_impersonation WHERE admin_sub = $1`, [admin]); // set-up only
    await sql(`INSERT INTO public.workspace_impersonation (admin_sub, target_sub, reason, ref, expires_at) VALUES ($1, $2, 'Fd transaction check', $3, now() + interval '10 minutes')`, [admin, target, ref]);
    return ref;
  };
  const state = async (ref: string) => ({
    open: (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.workspace_impersonation WHERE ref = $1`, [ref]))[0].n,
    audited: (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.admin_audit WHERE action = 'impersonate.end' AND session_ref = $1`, [ref]))[0].n,
  });
  const fails: string[] = [];
  try {
    const cases: [string, Db, { open: number; audited: number }][] = [
      ["the audit insert fails", failing(db, /INSERT INTO public\.admin_audit/), { open: 1, audited: 0 }],
      ["the end (delete) fails", failing(db, /DELETE FROM public\.workspace_impersonation/), { open: 1, audited: 0 }],
      ["nothing fails", db, { open: 0, audited: 1 }],
    ];
    for (const [label, d, expect] of cases) {
      const ref = await fresh();
      let threw = false;
      try { await store.endImpersonation(d, admin, "Fd ended by the test"); } catch { threw = true; }
      const s = await state(ref);
      if (s.open !== expect.open || s.audited !== expect.audited || threw !== (label !== "nothing fails")) {
        fails.push(`${label}: open ${s.open}, end rows ${s.audited}, threw ${threw} (want open ${expect.open}, end rows ${expect.audited})`);
      }
    }
  } finally {
    await sql(`DELETE FROM public.workspace_impersonation WHERE admin_sub = $1`, [admin]);
    await p.end();
  }
  assert(fails.length === 0, `an impersonation's end and its audit row are not one transaction:\n${fails.join("\n")}`);
} });
