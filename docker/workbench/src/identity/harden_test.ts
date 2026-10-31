// deno test --allow-net --allow-env --allow-read src/identity/harden_test.ts - rw-identity-harden (the
// review r-identity2 / r-identity3 follow-ups F-g, F-h, F-i, the onError echo, constant-time keys, N2).
// Like raw_path_test.ts it serves the REAL seam (and the real owner scope) with Deno.serve and writes raw
// HTTP/1.1 over a TCP socket, so the request target and the Host header reach the app exactly as sent.
// Each case is written to FAIL on the rw-identity3 head (bc6d3a6): what it calls that does not exist
// there is looked up on the module and falls back to what that head does.
// The image build runs this file (the test stage's gate; loopback only).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import type { Context } from "hono";
import { getPath, getQueryParams, getQueryStrings } from "hono/utils/url";
import type { Db } from "../contracts/db.ts";
import { TOKEN_HEADER } from "./forward_auth.ts";
import * as seamMod from "../middleware/identity.ts";
import { identitySeam, rawTarget, seamDeps, seamPath } from "../middleware/identity.ts";
import { ownerScope } from "../middleware/owner-scope.ts";
import { documentPathsIn } from "../documents/ownership.ts";
import { keyKind, keyRing } from "./keys.ts";

const SECRET = "lab-client-secret-0123456789abcdef0123456789abcdef";
const DOOR = "door-key-0123456789";
const SVC = "internal-key-0123456789";
const FA = {
  WORKSPACE_FORWARD_AUTH_ISSUER: "https://auth.example/application/o/research/",
  WORKSPACE_FORWARD_AUTH_CLIENT_ID: "research-proxy",
  WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: SECRET,
  WORKSPACE_FORWARD_AUTH_ADMIN_GROUP: "research-admins",
  WORKBENCH_KEY: SVC,
  WORKSPACE_DOOR_KEY: DOOR,
};
const OFF = { WORKBENCH_KEY: SVC, WORKSPACE_DEFAULT_SUB: "ak-default" };
const opt = (name: string) => (seamMod as Record<string, unknown>)[name];

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function token(claims: Record<string, unknown> = {}, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
    iss: FA.WORKSPACE_FORWARD_AUTH_ISSUER, aud: "research-proxy", sub: "ak-sub-alice", exp: now + 300, iat: now, name: "Alice", groups: ["users"], ...claims,
  })}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}

// A stand-in for the identity store: the admin (ak-sub-admin) is impersonating bob; every admin_audit
// row the seam writes is kept, so a test can read the route it recorded.
const IMP = { target_sub: "ak-sub-bob", target_name: "Bob", reason: "support ticket 1234", ref: "abcdef123456", started_at: "2026-10-30 10:00", expires_at: "2099-01-01 00:00" };
function storeDb(audits: { action: unknown; route: unknown }[]): Db {
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      if (/INSERT INTO public\.admin_audit/.test(sql)) audits.push({ action: args[2], route: args[5] });
      if (/SELECT i\.target_sub/.test(sql)) return Promise.resolve([IMP] as T[]);
      return Promise.resolve([] as T[]);
    },
    tx: (fn) => fn(db),
  };
  return db;
}

// the error handler app.ts carries at bc6d3a6 (not importable there: app.ts wires the database), used
// only when src/middleware/errors.ts does not exist - so the RED run judges that head's behaviour
const BASE_ON_ERROR = (err: Error, c: Context) => c.json({ error: "internal", detail: String(err?.message || err) }, 500);
async function onErrorUnderTest(): Promise<(err: Error, c: Context) => Response> {
  try {
    const m = await import("../middleware/errors.ts") as Record<string, unknown>;
    if (typeof m.internalError === "function") return m.internalError as (err: Error, c: Context) => Response;
  } catch { /* the base has no errors.ts */ }
  return BASE_ON_ERROR;
}

// The app: the real seam (and, with `scope`, the real owner scope) in front of stub handlers shaped like
// the workbench's. A handler reached says what it saw: the router's path, the seam's path, the query as
// the handler parses it (c.req.queries()), the raw query Hono's parser starts from, and whether any of
// it names a document that is not the caller's. An app-level 404 ("not found") means the router's path
// is outside /workbench/* (the catch-all would match anything inside): the seam never ran (N10).
async function serve(env: Record<string, string>, o: { db?: Db | null; scope?: boolean } = {}) {
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(o.db ?? null, (k) => env[k])));
  if (o.scope) app.use("/workbench/*", ownerScope(o.db ?? storeDb([])));
  const reached = (name: string) => (c: Context) => {
    const queries = c.req.queries() as Record<string, string[]>;
    const values = Object.values(queries).flat();
    const foreign = values.some((v) => documentPathsIn(v).some((p) => p.split("/")[1] !== "ak-sub-bob"));
    // the raw query travels encoded: the owner scope's response walk would rewrite a document path in it
    return c.json({ reached: name, router: c.req.path, seam: seamPath(c), honoQ: encodeURIComponent(getQueryStrings(c.req.url)), queries, foreign });
  };
  const notes = new Hono();
  notes.all("/:p{.+}", reached("notes"));
  app.route("/workbench/notes", notes);
  app.all("/workbench/health", reached("health"));
  app.all("/workbench/health/*", reached("health"));
  app.all("/workbench/auth/me", reached("me"));
  app.all("/workbench/auth/me/*", reached("me"));
  app.get("/workbench/boom/url", (c) => { throw new Error(`could not read ${c.req.url}`); });
  app.get("/workbench/boom/parse", (c) => { new URL("http://" + (c.req.header("x-where") ?? "") + c.req.path); return c.json({}); });
  app.get("/workbench/boom/type", (c) => { (c as unknown as { nope: () => void }).nope(); return c.json({}); });
  app.all("/workbench/*", reached("any"));
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError(await onErrorUnderTest());
  const ac = new AbortController();
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} }, app.fetch);
  const port = (srv.addr as Deno.NetAddr).port;
  return {
    app,
    // `host` null = no Host line at all; a string is sent as the Host line, as is
    async raw(method: string, target: string, headers: Record<string, string>, host: string | null = "h") {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      const hostLine = host === null ? "" : `Host: ${host}\r\n`;
      await conn.write(new TextEncoder().encode(`${method} ${target} HTTP/1.1\r\n${hostLine}${h}Connection: close\r\n\r\n`));
      const buf = new Uint8Array(65536);
      const parts: number[] = [];
      let n: number | null;
      try {
        while ((n = await conn.read(buf)) !== null) parts.push(...buf.subarray(0, n));
      } catch { /* reset by the server's parser */ }
      conn.close();
      // bytes, not text, until the framing is undone (a chunk size counts bytes)
      const bytes = new Uint8Array(parts);
      let i = -1;
      for (let k = 0; k + 3 < bytes.length; k++) if (bytes[k] === 13 && bytes[k + 1] === 10 && bytes[k + 2] === 13 && bytes[k + 3] === 10) { i = k; break; }
      const head = new TextDecoder().decode(bytes.subarray(0, i === -1 ? bytes.length : i));
      const status = Number(head.slice(9, 12));
      let raw = i === -1 ? new Uint8Array() : bytes.subarray(i + 4);
      // a body the owner scope rewrote has no content-length: chunked
      if (/\r\ntransfer-encoding: *chunked/i.test(head)) {
        const out: number[] = [];
        let p = 0;
        for (;;) {
          let nl = p;
          while (nl + 1 < raw.length && !(raw[nl] === 13 && raw[nl + 1] === 10)) nl++;
          const size = parseInt(new TextDecoder().decode(raw.subarray(p, nl)), 16);
          if (!(size > 0)) break;
          out.push(...raw.subarray(nl + 2, nl + 2 + size));
          p = nl + 2 + size + 2;
        }
        raw = new Uint8Array(out);
      }
      const body = new TextDecoder().decode(raw);
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(body); } catch { /* not JSON */ }
      return { status, body, json };
    },
    async close() { ac.abort(); await srv.finished; },
  };
}

// ── F-g: only the EXACT open routes skip identity ───────────────────────────────────────────────
Deno.test("F-g: /workbench/health/<x> and /workbench/auth/me/<x> go through the full identity decision (no token with sign-in on = 401)", async () => {
  const on = await serve(FA);
  const fails: string[] = [];
  try {
    assertEquals((await on.raw("GET", "/workbench/health", { "x-brain-key": DOOR })).status, 200, "control: health is open");
    assertEquals((await on.raw("GET", "/workbench/auth/me", { "x-brain-key": DOOR })).status, 200, "control: who-am-I is open");
    assertEquals((await on.raw("GET", "/workbench/notes/a.md", { "x-brain-key": DOOR })).status, 401, "control: sign in first");
    for (const t of ["/workbench/health/x", "/workbench/health/", "/workbench/health/a/b", "/workbench/health/documents/folders", "/workbench/health/x?y=1",
        "/workbench/auth/me/", "/workbench/auth/me/x", "/workbench/auth/me/impersonate", "/workbench/healthz", "/workbench/auth/mex"]) {
      for (const m of ["GET", "POST", "HEAD", "OPTIONS"]) {
        const r = await on.raw(m, t, { "x-brain-key": DOOR });
        if (r.status !== 401) fails.push(`${m} ${t}: ${r.status} ${r.body.slice(0, 100)}`);
      }
    }
  } finally {
    await on.close();
  }
  assert(fails.length === 0, `${fails.length} requests under an open route's prefix skipped the identity decision:\n${fails.join("\n")}`);
});

// Hosts the seam must refuse: '/', '?', '#', '@', white space, a port that is not a number, an empty
// value, two Host lines (Deno joins them with ", "), an encoded '/'
const BAD_HOSTS: [string, string][] = [
  ["h/workbench/notes", "/a.md"], ["h?a=1", "/workbench/notes/a.md"], ["h#f", "/workbench/notes/a.md"], ["u@h", "/workbench/notes/a.md"],
  ["h x", "/workbench/notes/a.md"], ["h\tx", "/workbench/notes/a.md"], ["h:abc", "/workbench/notes/a.md"], ["h:", "/workbench/notes/a.md"],
  ["h:80x", "/workbench/notes/a.md"], ["", "/workbench/notes/a.md"], ["h\r\nHost: g", "/workbench/notes/a.md"], ["h%2f..", "/workbench/notes/a.md"],
  ["h?path=documents/ak-sub-carol/a.md&", "/workbench/notes/a.md"], ["h/workbench/health?", "/x"], ["h/workbench", "/auth/me"],
];
const GOOD_HOSTS = ["h", "h:8000", "openbrain-workbench:8000", "127.0.0.1:8814", "[::1]:8", "rwid-ab12cd-wb:8000", "h.example"];

Deno.test("F-g: a Host that is not host[:port] is refused with 400 before any decision", async () => {
  const on = await serve(FA);
  const off = await serve(OFF);
  const tok = await token();
  const fails: string[] = [];
  let total = 0;
  try {
    const who: [string, typeof on, Record<string, string>][] = [
      ["door, no token (else 401)", on, { "x-brain-key": DOOR }],
      ["door + token (else 200)", on, { "x-brain-key": DOOR, [TOKEN_HEADER]: tok }],
      ["service key (else 200)", on, { "x-brain-key": SVC }],
      ["sign-in off (else 200)", off, { "x-brain-key": SVC }],
      ["sign-in off + X-authentik-uid (else 503)", off, { "x-brain-key": SVC, "x-authentik-uid": "bob" }],
    ];
    for (const [host, target] of BAD_HOSTS) {
      for (const [label, srv, h] of who) {
        total++;
        const r = await srv.raw("GET", target, h, host);
        // a Host line Deno's own parser refuses is 400 from Deno (empty body) - either way 400, never a handler
        // or the Host moved the router's path outside /workbench/*: no route, no seam (the app's own 404)
        const outside = r.status === 404 && r.json.error === "not found";
        if ((r.status !== 400 && !outside) || r.json.reached) fails.push(`Host ${JSON.stringify(host)} ${target} [${label}]: ${r.status} ${r.body.slice(0, 120)}`);
      }
    }
    // absolute-form: the authority the router slices from is the target's, not the Host line's
    for (const t of ["http://u@h/workbench/notes/a.md", "http://h:abc/workbench/notes/a.md", "http://h?x=/workbench/notes/a.md"]) {
      total++;
      const r = await on.raw("GET", t, { "x-brain-key": DOOR, [TOKEN_HEADER]: tok });
      if ((r.status !== 400 && !(r.status === 404 && r.json.error === "not found")) || r.json.reached) fails.push(`absolute-form ${t}: ${r.status} ${r.body.slice(0, 120)}`);
    }
    // controls: a well-formed Host (and none, as HTTP/1.0 may) is judged as before
    for (const host of [...GOOD_HOSTS, null]) {
      const r = await on.raw("GET", "/workbench/notes/a.md", { "x-brain-key": DOOR, [TOKEN_HEADER]: tok }, host);
      if (r.status !== 200 || !r.json.reached) fails.push(`control Host ${JSON.stringify(host)}: ${r.status} ${r.body.slice(0, 120)}`);
      const n = await on.raw("GET", "/workbench/notes/a.md", { "x-brain-key": DOOR }, host);
      if (n.status !== 401) fails.push(`control Host ${JSON.stringify(host)}, no token: ${n.status}`);
    }
  } finally {
    await on.close();
    await off.close();
  }
  console.log(`odd Host values: ${total - fails.length}/${total} refused 400 before any decision (controls included in the failures list)`);
  assert(fails.length === 0, `${fails.length} cases:\n${fails.join("\n")}`);
});

// ── F-h / F-i: owner-scope and the audit route read the path and query exactly as the handler does ──
// The r-identity3 review's fuzz corpus (journal/evidence/rw-identity/review-r-identity3/
// raw-path-host-fuzz-probe.ts: its path alphabet and its Host shapes), extended with query strings that
// name the caller's and another user's documents. Seeded, so a run is repeatable.
function prng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PATH_ALPHABET = ["/", ".", "%", "2", "e", "E", "5", "c", "f", "F", "?", "#", ";", "\\", "a", "%2e", "%25", "%2f", "%5c", "..", "%3b", "%3f", "%23", ":", "@", "%00", "%c0%ae", "%e2%80%ae", "+", "~", "%zz"];
const QUERY_ALPHABET = ["path=", "documents/ak-sub-carol/x.md", "documents/ak-sub-bob/y.md", "&", "=", "+", "%2B", "%26", "%3D", "%3F", "?", "#", "a", "q=",
  "%2e%2e", "../", "documents%2Fak-sub-carol%2Fz.md", "%zz", "%", ";", "ref=", "documents/.trash/l.md", " "];
const FUZZ_HOSTS = ["h", "h:80", "[::1]:8", "h?x=", "h#", "h/x", "", "u@h", "h:abc", "h?path=documents/ak-sub-carol/a.md&", "h x"];
function fuzzTarget(rnd: () => number) {
  let s = "/workbench/";
  const len = 1 + Math.floor(rnd() * 10);
  for (let j = 0; j < len; j++) s += PATH_ALPHABET[Math.floor(rnd() * PATH_ALPHABET.length)];
  if (rnd() < 0.7) {
    s += "?";
    const ql = 1 + Math.floor(rnd() * 6);
    for (let j = 0; j < ql; j++) s += QUERY_ALPHABET[Math.floor(rnd() * QUERY_ALPHABET.length)];
  }
  return s;
}
// what the seam refuses before any decision (bc6d3a6: only a non-canonical path)
function seamRefuses(url: string, host: string): boolean {
  const bad = opt("badHost") as ((url: string, host: string | undefined) => boolean) | undefined;
  const canonical = opt("canonicalPath") as (raw: string) => string | null;
  return (bad ? bad(url, host) : false) || canonical(rawTarget(url).path) === null;
}

Deno.test("F-h/F-i (strings): over 200,000 fuzzed URLs the seam's path and audited query are Hono's own, or the seam refuses", () => {
  const rnd = prng(20261030);
  let n = 0, accepted = 0;
  const diffs: string[] = [];
  for (let i = 0; i < 200_000; i++) {
    const host = FUZZ_HOSTS[i % FUZZ_HOSTS.length];
    const url = `http://${host}${fuzzTarget(rnd)}`;
    n++;
    if (seamRefuses(url, host)) continue;
    accepted++;
    const canonical = (opt("canonicalPath") as (raw: string) => string)(rawTarget(url).path);
    const routerPath = getPath({ url } as Request);
    // the audit route is the seam's path + its query; Hono's query parser starts from getQueryStrings
    const auditedQuery = rawTarget(url).query;
    if (canonical !== routerPath || auditedQuery !== getQueryStrings(url)) {
      if (diffs.length < 12) diffs.push(`${JSON.stringify(url)}: seam ${canonical} router ${routerPath}; audited ${JSON.stringify(auditedQuery)} hono ${JSON.stringify(getQueryStrings(url))}`);
      else diffs.push("");
    }
  }
  console.log(`fuzz: ${n} urls, ${accepted} accepted by the seam, ${diffs.length} differences (path or query)`);
  assert(diffs.length === 0, `${diffs.length} differences between what the seam judges/records and what Hono routes/parses:\n${diffs.filter(Boolean).join("\n")}`);
});

Deno.test("F-h/F-i (raw sockets): owner-scope and the audit route read the path and query as the handler does; no error body echoes", async () => {
  const audits: { action: unknown; route: unknown }[] = [];
  const db = storeDb(audits);
  const srv = await serve(FA, { db, scope: true });
  const adm = await token({ sub: "ak-sub-admin", groups: ["research-admins"] });
  const rnd = prng(4711);
  const diffs: string[] = [];
  const echoes: string[] = [];
  const tally: Record<string, number> = {};
  let n = 0;
  try {
    for (let i = 0; i < 2_400; i++) {
      const host = FUZZ_HOSTS[i % FUZZ_HOSTS.length];
      const target = fuzzTarget(rnd);
      const url = `http://${host}${target}`;
      audits.length = 0;
      n++;
      const r = await srv.raw("GET", target, { "x-brain-key": DOOR, [TOKEN_HEADER]: adm }, host);
      const kind = r.json.reached ? "handler" : r.status === 404 && r.json.error === "no such document" ? "owner-scope 404" : `${r.status}`;
      tally[kind] = (tally[kind] ?? 0) + 1;
      if (r.status >= 400) {
        // an error body names no part of the request (its URL, target or Host), no exception text, no stack
        const leaks = [target.length > 12 ? target : "", host.length > 2 ? host : "", "Invalid URL", "TypeError", "Error:", "    at ", "file:///", ".ts:"]
          .filter((s) => s && r.body.includes(s));
        if (leaks.length) echoes.push(`${r.status} ${JSON.stringify(url)}: echoes ${leaks.map((s) => JSON.stringify(s)).join(", ")}`);
      }
      if (r.json.reached) {
        const route = audits.find((a) => a.action === "request")?.route;
        if (r.json.seam !== r.json.router) diffs.push(`path ${JSON.stringify(url)}: seam ${r.json.seam} router ${r.json.router}`);
        const honoQ = decodeURIComponent(String(r.json.honoQ));
        if (route !== `${r.json.router}${honoQ}`) diffs.push(`audit ${JSON.stringify(url)}: recorded ${JSON.stringify(route)}, the handler's ${JSON.stringify(`${r.json.router}${honoQ}`)}`);
        if (r.json.foreign) diffs.push(`owner-scope ${JSON.stringify(url)}: the handler reads another user's document in its query, owner-scope let it through`);
      } else if (kind === "owner-scope 404") {
        // what the handler would have read: Hono's own parse of the same URL
        const values = Object.values((getQueryParams(url) ?? {}) as Record<string, string[]>).flat();
        const p = getPath({ url } as Request);
        let dp = p;
        try { dp = decodeURIComponent(p); } catch { /* raw */ }
        const named = [dp, ...values].some((v) => documentPathsIn(v).some((d) => d.split("/")[1] !== "ak-sub-bob"));
        if (!named) diffs.push(`owner-scope ${JSON.stringify(url)}: refused 404, but the handler's parse names no other user's document`);
      } else if (r.status === 404 && r.json.error === "not found" && !getPath({ url } as Request).startsWith("/workbench/")) {
        // the Host moved the router's path outside /workbench/*: no route, the seam never ran (N10)
      } else if (r.status !== 400) {
        diffs.push(`${r.status} ${JSON.stringify(url)}: neither the seam's 400, owner-scope's 404 nor a handler (${r.body.slice(0, 120)})`);
      }
    }
  } finally {
    await srv.close();
  }
  console.log(`raw fuzz: ${n} requests ${JSON.stringify(tally)}; ${diffs.length} differences; ${echoes.length} echoing error bodies`);
  assert(diffs.length === 0 && echoes.length === 0, `${diffs.length} differences, ${echoes.length} echoes:\n${[...diffs.slice(0, 15), ...echoes.slice(0, 15)].join("\n")}`);
});

Deno.test("onError: a 500 carries no request URL, exception message or stack", async () => {
  const srv = await serve(FA);
  const tok = await token();
  const fails: string[] = [];
  try {
    for (const [t, extra] of [["/workbench/boom/url?secret=s3cr3t-q", {}], ["/workbench/boom/parse", { "x-where": "h x" }], ["/workbench/boom/type", {}]] as const) {
      const r = await srv.raw("GET", t, { "x-brain-key": DOOR, [TOKEN_HEADER]: tok, ...extra }, "h");
      const leaks = ["/workbench/boom", "s3cr3t-q", "http://h", "could not read", "Invalid URL", "nope", "is not a function", "    at ", ".ts:"].filter((s) => r.body.includes(s));
      if (r.status !== 500 || leaks.length) fails.push(`${t}: ${r.status} ${r.body.slice(0, 160)} (echoes ${leaks.join(", ")})`);
    }
  } finally {
    await srv.close();
  }
  assert(fails.length === 0, `${fails.length} error bodies echo the request or the exception:\n${fails.join("\n")}`);
});

// ── keys: one constant-time compare ─────────────────────────────────────────────────────────────
Deno.test("keys: every key comparison goes through one constant-time compare (no === / == on key material)", async () => {
  const root = new URL("../", import.meta.url);
  const files: URL[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) await walk(new URL(`${e.name}/`, dir));
      else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") && e.name !== "credentials_oracle.ts") files.push(new URL(e.name, dir));
    }
  };
  await walk(root);
  const CMP = String.raw`(?:===|!==|==|!=)`;
  // key material by name: the door key, WORKBENCH_KEY, the service keys, the OpenAlex API key
  const NAMES = String.raw`(?:ring\.(?:door|internal)|door|internal|openalexKey|workbenchKey|get\("api_key"\))`;
  const anywhere = new RegExp(String.raw`\b${NAMES}\s*${CMP}|${CMP}\s*(?:cfg\.|config\.)?${NAMES}\b`);
  // in the files that hold presented keys: the key itself, and a Map lookup by key (a hash, not constant time)
  const keyFiles = /[\\/](identity[\\/]keys|middleware[\\/]auth)\.ts$/;
  const local = new RegExp(String.raw`\b(?:key|k)\s*${CMP}|${CMP}\s*(?:key|k)\b|services\.(?:get|has)\(`);
  const hits: string[] = [];
  for (const u of files) {
    const f = u.href;
    const lines = (await Deno.readTextFile(u)).split("\n");
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, "");
      if (anywhere.test(code) || (keyFiles.test(f) && local.test(code))) hits.push(`${f.split("/src/")[1]}:${i + 1}: ${l.trim()}`);
    });
  }
  const keysSrc = await Deno.readTextFile(new URL("./keys.ts", import.meta.url));
  if (!/timingSafeEqual\(/.test(keysSrc)) hits.push("identity/keys.ts: no timingSafeEqual - the one constant-time compare is missing");
  assert(hits.length === 0, `${hits.length} timing-unsafe key comparisons:\n${hits.join("\n")}`);
  // and the key ring still answers as before
  const ring = keyRing((k) => ({ WORKBENCH_KEY: SVC, WORKSPACE_DOOR_KEY: DOOR, WORKSPACE_SERVICE_KEYS: "mcp=service-key-0123456789;wiki=service-key-abcdefghij" } as Record<string, string>)[k], true);
  assertEquals(keyKind(DOOR, ring, true), { kind: "door" });
  assertEquals(keyKind(SVC, ring, true), { kind: "service", name: "internal" });
  assertEquals(keyKind(SVC, ring, false), { kind: "door" });
  assertEquals(keyKind("service-key-abcdefghij", ring, true), { kind: "service", name: "wiki" });
  assertEquals(keyKind("service-key-0123456789", ring, true), { kind: "service", name: "mcp" });
  for (const wrong of ["", "x", DOOR + "x", DOOR.slice(0, -1), SVC.toUpperCase(), "service-key-012345678", " " + DOOR]) assertEquals(keyKind(wrong, ring, true), null, JSON.stringify(wrong));
});

// ── N2: refusals do not flood the log ───────────────────────────────────────────────────────────
Deno.test("N2: 10,000 refused requests in a minute give a bounded number of log lines per reason, the first logged, with a count", async () => {
  const lines: string[] = [];
  const keep = { warn: console.warn, error: console.error, log: console.log };
  const grab = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const on = new Hono();
  on.use("/workbench/*", identitySeam(seamDeps(null, (k) => (FA as Record<string, string>)[k])));
  on.all("/workbench/*", (c) => c.json({ reached: true }));
  const off = new Hono();
  off.use("/workbench/*", identitySeam(seamDeps(null, (k) => (OFF as Record<string, string>)[k])));
  off.all("/workbench/*", (c) => c.json({ reached: true }));
  const forged = await token({}, "not-the-secret-0123456789abcdef0123456789");
  const expired = await token({ exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 });
  const kinds: [string, RegExp, () => Response | Promise<Response>][] = [
    ["forged signature", /signature/i, () => on.request("http://h/workbench/notes/a.md", { headers: { "x-brain-key": DOOR, [TOKEN_HEADER]: forged } })],
    ["expired", /exp/i, () => on.request("http://h/workbench/notes/a.md", { headers: { "x-brain-key": DOOR, [TOKEN_HEADER]: expired } })],
    ["X-authentik-* while off", /forward-auth is not configured/i, () => off.request("http://h/workbench/notes/a.md", { headers: { "x-brain-key": SVC, "x-authentik-uid": "bob" } })],
  ];
  const per = [4000, 3000, 3000];
  const t0 = Date.now();
  console.warn = grab; console.error = grab; console.log = grab;
  try {
    for (let k = 0; k < kinds.length; k++) {
      for (let i = 0; i < per[k]; i++) {
        const r = await kinds[k][2]();
        if (r.status !== (k === 2 ? 503 : 401)) throw new Error(`${kinds[k][0]}: ${r.status}`);
      }
    }
    const flush = opt("flushRefusalLog") as (() => void) | undefined;
    flush?.();
  } finally {
    Object.assign(console, keep);
  }
  const secs = (Date.now() - t0) / 1000;
  const total = per.reduce((a, b) => a + b, 0);
  console.log(`N2: ${total} refused requests in ${secs.toFixed(1)} s gave ${lines.length} log lines`);
  assert(secs < 60, "the 10,000 requests ran inside one minute");
  const fails: string[] = [];
  for (let k = 0; k < kinds.length; k++) {
    const mine = lines.filter((l) => kinds[k][1].test(l));
    // bounded: the first line and at most a few counted summaries per minute
    if (mine.length > 4) fails.push(`${kinds[k][0]}: ${mine.length} lines for ${per[k]} refusals (a flood)`);
    if (!mine.length) fails.push(`${kinds[k][0]}: not logged at all (a silent drop)`);
    // the first is logged as itself; the rest are counted, so nothing is dropped silently
    const counted = mine.reduce((a, l) => a + Number((/(\d+) more\b/.exec(l) ?? [0, 1])[1]), 0);
    if (mine.length && counted !== per[k]) fails.push(`${kinds[k][0]}: the lines account for ${counted} of ${per[k]} refusals`);
  }
  assert(fails.length === 0, fails.join("\n") + `\nfirst lines: ${lines.slice(0, 3).join(" | ")}`);
});
