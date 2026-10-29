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
} });

// ── C1: two users, each their own front-end context (the basics) ─────────────────────────────
const marker = `IdentitySecret${crypto.randomUUID().slice(0, 8)}`;
let alicePath = "";

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
  for (const reason of [undefined, "", "   ", "ab"]) {
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
