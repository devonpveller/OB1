// deno test src/identity/identity_integration_test.ts - rw-identity end to end, with REAL sessions: a
// browser (this test: a cookie jar, redirects followed by hand) signs in through the viewer's
// /workbench forwarder against a lab OpenID provider (contract-test/stub-oidc.ts, over TLS), with two
// users and an admin. Clauses (the anchor's acceptance):
//   C4 session security: PKCE S256 + state + nonce checked, Secure/HttpOnly/SameSite cookies, logout
//      ends the session; the identity header cannot stand in for a sign-in
//   C1 isolation with real sessions (the basics; the route-wide sweep is isolation_sweep_test.ts)
//   C3 admin impersonation: a reason first; the switch and every request in admin_audit; retrievable;
//      append-only; a non-admin cannot impersonate
//   C2 the Open WebUI hand-off: on_behalf_of accepted from Open WebUI's key only; agent research under
//      a service identity
//   C5 no sign-in configured = exactly the P2b behaviour (a second workbench on the same database)
// SKIPPED unless IDENTITY_TEST_VIEWER is set: contract-test/run-identity-tests.ps1 runs it in its
// disposable lab. Never point it at a live stack (it signs users in and writes audit rows).
import { assert, assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const E = (k: string) => Deno.env.get(k) ?? "";
const VIEWER = E("IDENTITY_TEST_VIEWER").replace(/\/+$/, "");
const WB = E("IDENTITY_TEST_WB").replace(/\/+$/, "");
const WB_PLAIN = E("IDENTITY_TEST_WB_PLAIN").replace(/\/+$/, "");
const WB_NODEF = E("IDENTITY_TEST_WB_NODEF").replace(/\/+$/, ""); // sign-in on, WORKSPACE_DEFAULT_SUB blank
const STUB = E("IDENTITY_TEST_STUB").replace(/\/+$/, "");
const RS = E("IDENTITY_TEST_RESEARCH").replace(/\/+$/, "");
const DOOR = E("IDENTITY_TEST_DOOR_KEY");
const INTERNAL = E("IDENTITY_TEST_INTERNAL_KEY");
const K = { owui: E("IDENTITY_TEST_OWUI_KEY"), ao: E("IDENTITY_TEST_AO_KEY"), ws: E("IDENTITY_TEST_WS_KEY"), shared: INTERNAL };
const USERS = (E("IDENTITY_TEST_USERS") ? JSON.parse(E("IDENTITY_TEST_USERS")) : []) as { login: string; sub: string; name: string; groups: string[] }[];
const sub = (login: string) => USERS.find((u) => u.login === login)?.sub ?? "";
const ignore = !VIEWER;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };

function pool(user: string, password: string) {
  return new Pool({ hostname: E("CONTRACT_TEST_DB_HOST"), port: 5432, database: "openbrain", user, password }, 1, true);
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

// ── a browser: a cookie jar, redirects by hand, the viewer's Origin on every write ───────────────
class Browser {
  jar = new Map<string, string>();
  raw: Record<string, string> = {};
  requests = 0;
  constructor(readonly base = VIEWER) {}
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  take(r: Response) {
    for (const sc of r.headers.getSetCookie()) {
      const nv = sc.split(";")[0];
      const i = nv.indexOf("=");
      const n = nv.slice(0, i).trim();
      const v = nv.slice(i + 1).trim();
      this.raw[n] = sc;
      if (/max-age=0/i.test(sc) || !v) this.jar.delete(n);
      else this.jar.set(n, v);
    }
  }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const url = path.startsWith("http") ? path : this.base + path;
    const h: Record<string, string> = { ...headers };
    if (url.startsWith(this.base) && this.jar.size && !("cookie" in h)) h.cookie = this.cookie();
    if (!["GET", "HEAD"].includes(method)) {
      h.origin ??= this.base;
      if (body !== undefined) h["content-type"] ??= "application/json";
    }
    if (url.startsWith(this.base)) this.requests++;
    const r = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    this.take(r);
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, location: r.headers.get("location") ?? "", setCookie: r.headers.getSetCookie() };
  }
  // the provider's sign-in page answers for `login` (the lab provider takes login_hint)
  async signIn(login: string) {
    const start = await this.req("GET", "/workbench/auth/login?return_to=/workspace/");
    assertEquals(start.status, 302, start.text);
    const authz = new URL(start.location);
    authz.searchParams.set("login_hint", login);
    const at = await fetch(authz, { redirect: "manual" });
    await at.body?.cancel();
    const callback = at.headers.get("location") ?? "";
    const done = await this.req("GET", callback);
    return { start, authz, callback, done };
  }
}

const stubLog = async () => (await (await fetch(`${STUB}/__log`)).json()).events as Record<string, any>[];
const stubMode = async (m: Record<string, unknown>) => await (await fetch(`${STUB}/__mode`, { method: "POST", body: JSON.stringify(m) })).body?.cancel();
const direct = async (base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
};

// ── C4: session security ──────────────────────────────────────────────────────────────────────
Deno.test({ name: "C4 sign-in: code flow with PKCE S256, state and nonce; the cookies' attributes; who am I", ...opts, fn: async () => {
  const b = new Browser();
  const s = await b.signIn("alice");
  const q = Object.fromEntries(s.authz.searchParams);
  assertEquals([q.response_type, q.code_challenge_method], ["code", "S256"]);
  assert(q.code_challenge && q.state && q.nonce, "challenge, state and nonce are sent");
  assertMatch(b.raw["__Host-ob-ws-login"] ?? "", /Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Lax/, "the sign-in binding is cleared at the callback");
  assertEquals(s.done.status, 302, s.done.text);
  assertEquals(s.done.location, "/workspace/");
  assertMatch(b.raw["__Host-ob-ws-session"] ?? "", /^__Host-ob-ws-session=[A-Za-z0-9_-]{40,}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
  const log = await stubLog();
  const tok = log.filter((e) => e.type === "token").at(-1)!;
  assertEquals(tok.pkce, "ok", "the provider verified S256(code_verifier) == code_challenge");
  const me = await b.req("GET", "/workbench/auth/me");
  assertEquals([me.json.mode, me.json.signed_in, me.json.subject_sub, me.json.actor_sub, me.json.admin], ["oidc", true, sub("alice"), sub("alice"), false]);
  // the token is never stored: only its SHA-256
  const rows = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.workspace_sessions WHERE id_hash = $1`, [b.jar.get("__Host-ob-ws-session")]);
  assertEquals(rows[0].n, 0, "the cookie's token is not a stored value");
} });

Deno.test({ name: "C4 state: tampered, replayed, or from another browser - refused, no session", ...opts, fn: async () => {
  const b = new Browser();
  const start = await b.req("GET", "/workbench/auth/login");
  const authz = new URL(start.location);
  authz.searchParams.set("login_hint", "alice");
  const at = await fetch(authz, { redirect: "manual" });
  await at.body?.cancel();
  const cb = new URL(at.headers.get("location")!);
  // another browser (no binding cookie) with the right state
  const other = new Browser();
  const stolen = await other.req("GET", cb.toString());
  assertEquals(stolen.status, 400, stolen.text);
  assert(!other.jar.has("__Host-ob-ws-session"));
  // the state was consumed by that attempt: the right browser cannot replay it either
  const replay = await b.req("GET", cb.toString());
  assertEquals(replay.status, 400, replay.text);
  // a tampered state on a fresh sign-in
  const b2 = new Browser();
  const s2 = await b2.req("GET", "/workbench/auth/login");
  const a2 = new URL(s2.location);
  a2.searchParams.set("login_hint", "alice");
  const at2 = await fetch(a2, { redirect: "manual" });
  await at2.body?.cancel();
  const cb2 = new URL(at2.headers.get("location")!);
  cb2.searchParams.set("state", cb2.searchParams.get("state")! + "x");
  const tampered = await b2.req("GET", cb2.toString());
  assertEquals(tampered.status, 400, tampered.text);
  assert(!b2.jar.has("__Host-ob-ws-session"));
  assertEquals((await b2.req("GET", "/workbench/contract/documents")).status, 401);
} });

Deno.test({ name: "C4 nonce: an ID token with another sign-in's nonce is refused", ...opts, fn: async () => {
  await stubMode({ wrong_nonce: true });
  const b = new Browser();
  const s = await b.signIn("alice");
  assertEquals(s.done.status, 400, s.done.text);
  assertMatch(s.done.text, /nonce/);
  assert(!b.jar.has("__Host-ob-ws-session"));
} });

Deno.test({ name: "C4 logout ends the session (server-side): the old cookie is dead", ...opts, fn: async () => {
  const b = new Browser();
  await b.signIn("bob");
  const token = b.jar.get("__Host-ob-ws-session")!;
  assertEquals((await b.req("GET", "/workbench/contract/documents")).status, 200);
  const out = await b.req("POST", "/workbench/auth/logout", {});
  assertEquals(out.status, 200, out.text);
  assertMatch(b.raw["__Host-ob-ws-session"], /Max-Age=0/);
  assert(String(out.json.end_session ?? "").startsWith(STUB), "the provider's end-session URL is offered");
  // the same token replayed (a copied cookie) no longer signs anyone in
  const replay = await new Browser().req("GET", "/workbench/contract/documents", undefined, { cookie: `__Host-ob-ws-session=${token}` });
  assertEquals(replay.status, 401);
  const me = await new Browser().req("GET", "/workbench/auth/me", undefined, { cookie: `__Host-ob-ws-session=${token}` });
  assertEquals(me.json.signed_in, false);
} });

Deno.test({ name: "C4 the identity header cannot bypass sign-in: through the viewer, direct with the door key, or beside a session", ...opts, fn: async () => {
  const H = E("IDENTITY_TEST_SUB_HEADER") || "X-Test-Sub";
  const anon = new Browser();
  assertEquals((await anon.req("GET", "/workbench/contract/documents", undefined, { [H]: sub("alice") })).status, 401, "through the viewer");
  assertEquals((await direct(WB, "GET", "/workbench/contract/documents", { "x-brain-key": DOOR, [H]: sub("alice") })).status, 401, "direct, door key");
  assertEquals((await direct(WB, "GET", "/workbench/documents/folders", { "x-brain-key": DOOR, [H]: sub("alice") })).status, 401);
  const b = new Browser();
  await b.signIn("bob");
  const me = await b.req("GET", "/workbench/auth/me", undefined, { [H]: sub("alice") });
  assertEquals(me.json.subject_sub, sub("bob"), "a session plus the header is still the session's user");
  const meDirect = await direct(WB, "GET", "/workbench/workspace/whoami", { "x-brain-key": DOOR, cookie: b.cookie(), [H]: sub("alice") });
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
  const as = (b: Browser) => ({ "x-brain-key": DOOR, cookie: b.cookie() });
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
Deno.test({ name: "C5 a workbench with no WORKSPACE_OIDC_* behaves as before: one default identity, no sign-in", ...opts, ignore: ignore || !WB_PLAIN, fn: async () => {
  const h = { "x-brain-key": INTERNAL };
  const me = await direct(WB_PLAIN, "GET", "/workbench/auth/me", h);
  assertEquals([me.json.mode, me.json.signed_in, me.json.subject_sub, me.json.kind], ["default", true, E("IDENTITY_TEST_DEFAULT_SUB") || "operator", "default"]);
  const who = await direct(WB_PLAIN, "GET", "/workbench/workspace/whoami", h);
  assertEquals(who.json.subject_sub, E("IDENTITY_TEST_DEFAULT_SUB") || "operator");
  assertEquals((await direct(WB_PLAIN, "GET", "/workbench/contract/documents", h)).status, 200, "no cookie needed");
  assertEquals((await direct(WB_PLAIN, "GET", "/workbench/documents/folders", h)).status, 200, "WORKBENCH_KEY is the browser's door, as before");
  assertEquals((await direct(WB_PLAIN, "GET", "/workbench/auth/login", h)).status, 404, "no sign-in to start");
  assertNotEquals((await direct(WB_PLAIN, "GET", "/workbench/contract/documents", h)).status, 401);
} });
