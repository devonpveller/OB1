// deno test src/documents/isolation_sweep_test.ts - the route-wide isolation sweep (rw-p2b-workspace
// round 2, tester attempt 1 F1-F6: leaks hide in routes and nested fields nobody listed by hand).
//
// User B plants unique markers in everything per-user: a document's title and body, its idea text,
// the original research prompt, its refinery id and the document's path (a listing-failure
// notification, a reference into a shared source, a held source in the refinery, a committed
// revision). Then, as user A, EVERY route the app registers (enumerated from the router itself:
// src/app.ts, no hand list) is called with B's ids and paths wherever it can take one - every path
// parameter, the usual query and body fields - directly on the workbench AND through the viewer's
// /workbench forwarder (the edge's one port). Every full response body (and its Location) is
// searched for every marker; only a REFUSAL may echo its own literal input (round 3). Then every read
// route bare, harvesting the ids A can really discover (B's job id from A's own job list); every
// parameterised read route filled with each real id alone; every real id's event stream read for N
// events with a timeout. Zero hits; shared knowledge still answers both users alike; B's document is
// unchanged afterwards. The lab runs it with the response walk on AND off (WORKSPACE_RESPONSE_WALK).
//
// rw-identity: REAL SIGN-INS. With SWEEP_USER_A / SWEEP_USER_B set (lab login names, SWEEP_USERS their
// subjects and groups) the two users are signed in the way Authentik forward-auth signs them in
// (rw-identity2): every call carries the outpost's token, X-authentik-jwt, minted by a lab signer
// standing in for Authentik's outpost (HS256 with the lab proxy provider's client secret,
// SWEEP_FA_SECRET; iss SWEEP_FA_ISSUER, aud SWEEP_FA_CLIENT_ID) - A's on every call, B's on B's plants -
// instead of the identity header. Every call of A's ALSO sends the identity header naming B and B's
// unsigned X-authentik-uid / -username (both must be ignored once sign-in is configured); the end
// checks A is still signed in as A. SWEEP_USER_B_SUB is B's subject (a marker).
// SKIPPED unless SWEEP_BASE is set. contract-test/run-workspace-tests.ps1 runs it LAST in its
// disposable lab (it calls mutating routes with B's ids). Never point it at a live stack.
// Environment: SWEEP_BASE (the workbench), SWEEP_VIEWER (the viewer), DOCS_TEST_KEY, DOCS_TEST_VAULT,
// CONTRACT_TEST_DB_HOST/_USER/_PASSWORD (superuser: the fault trigger), plus the workbench's own DB_*
// / WIKI_GIT_DIR so src/app.ts can be imported to read its route table (it is never served here).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("SWEEP_BASE") ?? "").replace(/\/+$/, "");
const VIEWER = (Deno.env.get("SWEEP_VIEWER") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const VAULT = Deno.env.get("DOCS_TEST_VAULT") ?? "/vault";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !VIEWER || !HOST;
const OIDC_A = Deno.env.get("SWEEP_USER_A") ?? "";
const OIDC_B = Deno.env.get("SWEEP_USER_B") ?? "";
const OIDC = !!(OIDC_A && OIDC_B);
// A's identity on every call (sign-in mode: A's token, plus the header and B's bare X-authentik-* - ignored)
let AS_A: Record<string, string> = {};

// rw-identity2: the lab signer (Authentik's outpost token shape; WebCrypto, HS256 with the lab secret)
const SWEEP_USERS = JSON.parse(Deno.env.get("SWEEP_USERS") || "[]") as { login: string; sub: string; name: string; groups: string[] }[];
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encJ = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
async function signIn(login: string): Promise<Record<string, string>> {
  const u = SWEEP_USERS.find((x) => x.login === login);
  assert(u, `lab user ${login} (SWEEP_USERS)`);
  const t = Math.floor(Date.now() / 1000);
  const claims = { iss: Deno.env.get("SWEEP_FA_ISSUER"), aud: Deno.env.get("SWEEP_FA_CLIENT_ID"), sub: u.sub, iat: t, exp: t + 7200, name: u.name, preferred_username: login, groups: u.groups };
  const data = `${encJ({ alg: "HS256", typ: "JWT" })}.${encJ(claims)}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("SWEEP_FA_SECRET") ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))));
  return { "x-authentik-jwt": `${data}.${sig}` };
}
const FX_ACTIVE = "11111111-1111-4111-8111-111111111111";

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const pool = new Pool({
    hostname: HOST!, port: 5432, database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 1, true);
  const c = await pool.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
    await pool.end();
  }
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, events = 3) {
  // bounded: a stream (SSE) or a hung route must not stall the sweep; its partial body is still searched.
  // An event stream is read until `events` events (or its end event) have arrived, or 5 s have passed.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let r: Response;
  try {
    r = await fetch(base + path, {
    method, redirect: "manual", signal: ctl.signal,
    // through the viewer the request carries the viewer's own Origin, as the workspace page's would
    // (the forwarder refuses a write without it: the CSRF / DNS-rebinding guard)
    headers: { "content-type": "application/json", "x-brain-key": KEY, ...(base === VIEWER ? { origin: VIEWER } : {}), ...AS_A, ...headers },
    body: body === undefined || method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  } catch {
    clearTimeout(timer);
    return { status: 0, json: {} as Record<string, any>, text: "", location: "", sse: 0 };
  }
  const isSse = (r.headers.get("content-type") ?? "").includes("text/event-stream");
  const sseTimer = isSse ? setTimeout(() => ctl.abort(), 5000) : undefined;
  const count = (t: string) => (t.match(/\n\n/g) ?? []).length;
  let text = "";
  if (method !== "HEAD") {
    const reader = r.body?.getReader();
    const dec = new TextDecoder();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        if (isSse && (count(text) >= events || text.includes("event: end"))) { ctl.abort(); break; }
      }
    } catch { /* aborted mid-stream: keep what arrived */ }
  }
  clearTimeout(timer);
  if (sseTimer !== undefined) clearTimeout(sseTimer);
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, location: r.headers.get("location") ?? "", sse: isSse ? count(text) : 0 };
}

const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

Deno.test({ name: "isolation sweep: as user A, every route the app registers shows nothing of user B's private context", ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const B: Record<string, string> = OIDC ? await signIn(OIDC_B) : { [SUB_HEADER]: `sweep-bee-${rnd()}` };
  const bSub = OIDC ? (Deno.env.get("SWEEP_USER_B_SUB") ?? "") : B[SUB_HEADER];
  if (OIDC) {
    assert(bSub, "SWEEP_USER_B_SUB names B's subject");
    AS_A = { ...(await signIn(OIDC_A)), [SUB_HEADER]: bSub, "x-authentik-uid": bSub, "x-authentik-username": OIDC_B };
  }
  // an admin's own views list users and the audit log by design (whom to impersonate; what admins did):
  // there, and only there, B's subject is expected - nothing else of B's
  const aIsAdmin = OIDC && (await call(VIEWER, "GET", "/workbench/auth/me")).json.admin === true;
  const ADMIN_VIEW = /^(GET|HEAD) \/workbench\/auth\/(users|audit)[ ?]/;
  const M = {
    title: `TitleSecret${rnd()}X`, body: `BodySecret${rnd()}`, idea: `IdeaSecret${rnd()}`, prompt: `PromptSecret${rnd()}`,
  };
  const wb = (m: string, p: string, b?: unknown, h: Record<string, string> = {}) => call(BASE, m, p, b, h);
  // ── B plants ─────────────────────────────────────────────────────────────────────────────────
  const made = await wb("POST", "/workbench/documents", { title: M.title }, B);
  assertEquals(made.status, 201, made.text);
  const bPath: string = made.json.path;
  const f = await wb("GET", `/workbench/documents/file?path=${encodeURIComponent(bPath)}`, undefined, B);
  const put = await wb("PUT", `/workbench/documents/file?path=${encodeURIComponent(bPath)}&commit=1`,
    { content: `${f.json.content}\n${M.body} cites [[source:${FX_ACTIVE}|the shared source]].\n`, if_match: f.json.hash }, B);
  assert(put.status === 200 || put.status === 207, put.text);
  const prop = await wb("POST", "/workbench/documents/property", { path: bPath, key: "idea", value: M.idea }, B);
  assert(prop.status < 300, prop.text);
  const start = await wb("POST", "/workbench/documents/refinery/start", { path: bPath }, B);
  assert(start.status < 300, start.text);
  const st = await wb("GET", `/workbench/documents/state?path=${encodeURIComponent(bPath)}`, undefined, B);
  const bRefinery: string = st.json.refinery?.id;
  assert(bRefinery, `B's refinery: ${st.text}`);
  const research = await wb("POST", "/workbench/documents/research", { path: bPath, query: M.prompt, kind: "research" }, B);
  assertEquals(research.status, 202, research.text);
  const bJob: string = research.json.job_id;
  const held = await wb("POST", "/workbench/documents/user-sources", { refinery_id: bRefinery, title: "sweep held source", content: "shared held text for the sweep" }, B);
  assert(held.status < 300, held.text);
  const bHeld: string = held.json.source_id ?? held.json.id ?? held.json.held?.id ?? "";
  // a listing that cannot be updated: B's notification (entity document:<B path>)
  await sql(`CREATE OR REPLACE FUNCTION public.p2b_sweep_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sweep fault'; END $$`);
  await sql(`CREATE TRIGGER p2b_sweep_fault BEFORE INSERT OR UPDATE ON public.user_document_listings FOR EACH ROW EXECUTE FUNCTION public.p2b_sweep_fault()`);
  try {
    const f2 = await wb("GET", `/workbench/documents/file?path=${encodeURIComponent(bPath)}`, undefined, B);
    const faulted = await wb("PUT", `/workbench/documents/file?path=${encodeURIComponent(bPath)}`, { content: `${f2.json.content}\nmore ${M.body}\n`, if_match: f2.json.hash }, B);
    assertEquals(faulted.status, 207, faulted.text);
  } finally {
    await sql(`DROP TRIGGER IF EXISTS p2b_sweep_fault ON public.user_document_listings`);
    await sql(`DROP FUNCTION IF EXISTS public.p2b_sweep_fault()`);
  }
  // a reference row held by B's document (for the holder check below)
  const bRef = await wb("POST", "/workbench/documents/references", { path: bPath, source_id: FX_ACTIVE, exact: "", form: "chip" }, B);
  const bRefId: string = bRef.json.record?.id ?? "";
  // the reconcile repairs B's listing when B's workspace next connects; B's file as it now stands
  await wb("GET", `/workbench/contract/documents`, undefined, B);
  const before = await Deno.readTextFile(`${VAULT}/${bPath}`);
  // a NON-.md attachment in B's documents/<key>/ (integration onto P1c: with Quartz's ignorePatterns
  // gone, "documents" in QUARTZ_IGNORED_ROOTS is what keeps the viewer from serving it)
  const bDir = bPath.slice(0, bPath.lastIndexOf("/"));
  const attachSecret = `AttachSecret${rnd()}`;
  const attachName = `attach-${rnd()}.txt`;
  const attachPng = attachName.replace(/\.txt$/, ".png");
  await Deno.writeTextFile(`${VAULT}/${bDir}/${attachName}`, `${attachSecret}\n`);
  await Deno.writeFile(`${VAULT}/${bDir}/${attachPng}`, new TextEncoder().encode(`\x89PNG ${attachSecret}`));
  const markers: Record<string, string> = { ...M, path: bPath, refinery: bRefinery, sub: bSub, attach: attachSecret };
  const doorName = (d: string) => d === BASE ? "workbench" : "viewer";
  const hits: string[] = [];
  let calls = 0;
  // Round 3 (tester attempt 2: the sweep excused every echo, and its bare pass never resolved an id):
  // a marker in a response is a LEAK unless the response is a REFUSAL (status >= 400, or no answer)
  // and the marker is part of the literal input of that request. A 2xx excuses nothing.
  const judge = (label: string, sent: string, res: Awaited<ReturnType<typeof call>>) => {
    const out = res.text + "\n" + res.location;
    // the forwarder's own guard refusing the sweep would hide the route behind it: never acceptable here
    if (/accepted only from the viewer's own origin|not one the viewer answers for|cross-site write refused|referer is not the viewer/.test(res.text)) {
      hits.push(`HIT guard-masked ${label} -> ${res.status}`);
    }
    const refusal = res.status === 0 || res.status >= 400;
    for (const [name, m] of Object.entries(markers)) {
      if (!m || !out.includes(m)) continue;
      if (name === "sub" && aIsAdmin && ADMIN_VIEW.test(label)) continue;
      if (refusal && (sent.includes(m) || sent.includes(encodeURIComponent(m)))) continue; // a refusal echoing its own input
      hits.push(`HIT ${name} ${label} -> ${res.status}${res.sse ? ` (${res.sse} events)` : ""}`);
    }
  };

  // ── the route table, from the router ─────────────────────────────────────────────────────────
  // a computed specifier: the build gate type-checks this file without the runtime /recipes mount
  const { app } = await import(new URL("../app.ts", import.meta.url).href);
  const seen = new Set<string>();
  const routes = (app.routes as { method: string; path: string }[])
    .filter((r) => !r.path.endsWith("*") && r.method !== "ALL")
    .filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
  assert(routes.length > 50, `the router lists ${routes.length} routes`);
  const fill = (path: string, v: string) =>
    path.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, _n, re) => (re && re.includes(".")) ? v : encodeURIComponent(v));
  const reads = routes.filter((x) => ["GET", "HEAD"].includes(x.method));

  // 1. TEMPLATED: B's ids and paths in every parameter, query and body field (the request gate)
  const ids = [bPath, bRefinery, bJob, bHeld, bRefId].filter(Boolean);
  const query = (v: string) => new URLSearchParams({
    path: bPath, ref: bPath, from: bPath, id: v, idea_id: bRefinery, refinery_id: bRefinery, job_id: bJob,
    source_id: bHeld || v, kind: "user_document", holder_kind: "user_document", format: "md", limit: "500", q: "fixture",
  }).toString();
  const body = (v: string) => ({
    path: bPath, ref: bPath, from: bPath, to: bPath, id: v, refinery_id: bRefinery, idea_id: bRefinery, job_id: bJob,
    source_id: bHeld || v, holder: { kind: "user_document", ref: bPath }, holder_kind: "user_document", holder_ref: bPath,
    title: "sweep", content: "sweep",
  });
  for (const r of routes) {
    const values = r.path.includes(":") ? ids : [bRefinery];
    for (const v of values) {
      const url = `${fill(r.path, v)}?${query(v)}`;
      const reqBody = body(v);
      // GET-like through both doors; a mutating call once, through the viewer (the edge's door)
      const doors = ["GET", "HEAD"].includes(r.method) ? [BASE, VIEWER] : [VIEWER];
      for (const door of doors) {
        calls++;
        judge(`${r.method} ${r.path} templated (${doorName(door)})`, url + JSON.stringify(reqBody), await call(door, r.method, url, reqBody));
      }
    }
  }

  // 2. BARE: every read route with no parameter, nothing of B's in the request; every id the answers
  // carry is HARVESTED - the ids user A can really discover (job ids from A's own lists, ids in shared lists)
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const harvested = new Set<string>();
  const bareUrls = [
    ...reads.filter((x) => !x.path.includes(":")).map((x) => ({ m: x.method, url: `${x.path}?limit=500&q=fixture` })),
    ...["research", "held", "compile", "import"].map((k) => ({ m: "GET", url: `/workbench/contract/jobs?kinds=${k}&limit=200` })),
  ];
  for (const { m, url } of bareUrls) {
    for (const door of [BASE, VIEWER]) {
      calls++;
      const res = await call(door, m, url);
      judge(`${m} ${url} bare (${doorName(door)})`, url, res);
      for (const x of (res.text + res.location).matchAll(UUID)) harvested.add(x[0].toLowerCase());
    }
  }
  // job ids are shared knowledge: A's own job list names B's job (the harvest is not vacuous)
  assert(harvested.has(bJob.toLowerCase()), "user A's job list names B's job id (job ids are shared)");

  // 3. ID-ONLY: every read route with a path parameter, filled with each REAL id (harvested, plus B's
  // own ids handed to A directly) and nothing else of B's in the request
  const named = (v: string) =>
    v === bJob ? "<B job>" : v === bHeld ? "<B held>" : v === bRefId ? "<B ref>" : v === bRefinery ? "<B refinery>" : v;
  const realIds = [...new Set([bJob, bHeld, bRefId, bRefinery, FX_ACTIVE, ...harvested].filter(Boolean).map((x) => x.toLowerCase()))]
    .slice(0, 40);
  for (const r of reads.filter((x) => x.path.includes(":"))) {
    for (const v of realIds) {
      const url = `${fill(r.path, v)}?limit=500`;
      for (const door of [BASE, VIEWER]) {
        calls++;
        judge(`${r.method} ${r.path} id=${named(v)} (${doorName(door)})`, url, await call(door, r.method, url));
      }
    }
  }

  // 4. STREAMS: every real id streamed as A on both doors, reading N events with a timeout
  let streamed = 0;
  for (const v of realIds) {
    for (const door of [BASE, VIEWER]) {
      calls++;
      const url = `/workbench/contract/sessions/${v}/stream`;
      const res = await call(door, "GET", url, undefined, {}, 3);
      if (res.sse) streamed++;
      judge(`GET /workbench/contract/sessions/:id/stream id=${named(v)} (${doorName(door)})`, url, res);
    }
  }
  assert(streamed >= 2, `B's job streamed to A on both doors (${streamed} streams read)`);

  // what a marker cannot show: WHICH references B's document holds (reference rows are shared
  // knowledge; the holder -> references mapping of a user document is its owner's). A asks for it.
  for (const door of [BASE, VIEWER]) {
    calls++;
    const res = await call(door, "GET", `/workbench/contract/holders/user_document/references?ref=${encodeURIComponent(bPath)}`);
    if (res.status === 200) hits.push(`HIT holder-references GET /workbench/contract/holders/:kind/references?ref=<B path> (${doorName(door)}) -> 200${bRefId && res.text.includes(bRefId) ? " (lists B's reference)" : ""}`);
  }
  // content-type variants on the request gate: a refusal (400/404/415), never a 500
  for (const ct of ["application/vnd.p2b+json", "application/json-patch+json", "text/plain"]) {
    for (const door of [BASE, VIEWER]) {
      calls++;
      const res = await call(door, "POST", "/workbench/contract/diff-check", { holder: { kind: "user_document", ref: bPath } }, { "content-type": ct });
      if (res.status >= 500 || res.status < 400) hits.push(`HIT content-type ${ct} POST /workbench/contract/diff-check (${doorName(door)}) -> ${res.status} (want 400/404/415)`);
    }
  }
  // B's non-.md attachments, asked for by user A: through the viewer (its vault file path and the
  // slug forms) and through the forwarder (the documents file/state routes)
  let attachCalls = 0;
  for (const name of [attachName, attachPng]) {
    const rel = `${bDir}/${name}`;
    for (const url of [`/${rel}`, `/${rel.split("/").map(encodeURIComponent).join("/")}`, `/${rel.toLowerCase()}`, `/content/../${rel}`, `/static/../${rel}`]) {
      calls++; attachCalls++;
      const res = await call(VIEWER, "GET", url);
      judge(`GET <B attachment ${name}> (viewer file)`, url, res);
      if (res.status >= 200 && res.status < 300 && res.text.includes(attachSecret)) hits.push(`HIT attachment-served ${url} (viewer) -> ${res.status}`);
    }
    for (const url of [`/workbench/documents/file?path=${encodeURIComponent(rel)}`, `/workbench/documents/state?path=${encodeURIComponent(rel)}`,
      `/workbench/contract/documents/file?path=${encodeURIComponent(rel)}`]) {
      for (const door of [BASE, VIEWER]) {
        calls++; attachCalls++;
        judge(`GET <B attachment ${name}> ${url.split("?")[0]} (${doorName(door)})`, url, await call(door, "GET", url));
      }
    }
  }
  console.log(`sweep: ${attachCalls} attachment calls (B's non-.md files under documents/<key>/)`);
  console.log(`sweep: ${routes.length} routes, ${calls} calls, ${harvested.size} ids harvested, ${streamed} streams read, ${hits.length} hits`);
  for (const h of [...new Set(hits)]) console.log(`  ${h}`);
  // shared knowledge answers both users alike
  // (the fixture source may have been changed by A's mutating calls - shared, so alike for both)
  for (const p of [`/workbench/contract/sources/${FX_ACTIVE}`, `/workbench/contract/search?q=fixture`, `/workbench/contract/sources?limit=50`]) {
    const a = await wb("GET", p);
    const b = await wb("GET", p, undefined, B);
    assertEquals(a.status, b.status, `${p}: ${a.status} ${b.status}`);
    assertEquals(a.text, b.text, `${p}: shared knowledge reads the same for both users`);
  }
  assertEquals((await wb("GET", `/workbench/contract/search?q=fixture`)).status, 200, "shared search answers");
  // B's document is B's: unchanged by A's calls, and B still reads it
  assertEquals(await Deno.readTextFile(`${VAULT}/${bPath}`), before, "user A's calls left B's document unchanged");
  assertEquals((await wb("GET", `/workbench/documents/file?path=${encodeURIComponent(bPath)}`, undefined, B)).status, 200);
  await Deno.remove(`${VAULT}/${bDir}/${attachName}`).catch(() => {});
  await Deno.remove(`${VAULT}/${bDir}/${attachPng}`).catch(() => {});
  if (OIDC) {
    // the sweep's calls were made as a signed-in A (A's token), never as a refused anonymous caller
    const me = await call(VIEWER, "GET", "/workbench/auth/me");
    assertEquals([me.json.signed_in, me.json.subject_sub === bSub], [true, false], `A is still signed in as A: ${me.text}`);
    console.log(`sweep: real sessions (forward-auth tokens; A=${OIDC_A}${me.json.admin ? ", an admin not impersonating" : ""}, B=${OIDC_B}); every call of A's also sent ${SUB_HEADER} and X-authentik-uid: <B's subject>`);
  }
  assertEquals([...new Set(hits)], [], "no response to user A carries anything of user B's private context");
} });
