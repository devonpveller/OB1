// deno test --allow-net --allow-env src/identity/raw_path_test.ts - rw-identity3 (review r-identity2 B1b).
// Every other identity test builds a WHATWG URL / Request first (app.request, fetch, curl), and WHATWG
// parsing already resolves "." / ".." / "%2e" segments and turns "\" into "/" - so a raw request target
// never reached the seam in a test. Hono routes the RAW target (hono/utils/url.ts getPath: the request
// URL from the first "/" after "://" to "?" or "#", decoded once with decodeURI). This file serves the
// real seam with Deno.serve and writes raw HTTP/1.1 request lines over a TCP socket (Deno.connect),
// so the bytes the router routes are exactly the bytes sent.
// The image build runs this file (the test stage's gate; loopback only).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { TOKEN_HEADER } from "./forward_auth.ts";
import { identitySeam, seamDeps } from "../middleware/identity.ts";

const SECRET = "lab-client-secret-0123456789abcdef0123456789abcdef";
const DOOR = "door-key-0123456789";
const SVC = "internal-key-0123456789";
const FA = {
  WORKSPACE_FORWARD_AUTH_ISSUER: "https://auth.example/application/o/research/",
  WORKSPACE_FORWARD_AUTH_CLIENT_ID: "research-proxy",
  WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: SECRET,
  WORKBENCH_KEY: SVC,
  WORKSPACE_DOOR_KEY: DOOR,
};
const OFF = { WORKBENCH_KEY: SVC, WORKSPACE_DEFAULT_SUB: "ak-default" };

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function token(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({
    iss: FA.WORKSPACE_FORWARD_AUTH_ISSUER, aud: "research-proxy", sub: "ak-sub-alice", exp: now + 300, iat: now, name: "Alice", groups: ["users"], ...claims,
  })}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}

// The app: the real seam in front of stub handlers shaped like the workbench's (notes' {.+} routes,
// health, documents) and a catch-all - so ANY request the seam lets through reaches a handler and says
// so, with the path the router matched (c.req.path) and the path the seam stored (if it stores one).
async function serve(env: Record<string, string>) {
  const mod = await import("../middleware/identity.ts") as Record<string, unknown>;
  const seamPath = typeof mod.seamPath === "function" ? mod.seamPath as (c: unknown) => string : null;
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(null, (k) => env[k])));
  const reached = (name: string) => (c: import("hono").Context) =>
    c.json({ reached: name, router: c.req.path, seam: seamPath ? seamPath(c) : null, param: c.req.param("p") ?? null });
  const notes = new Hono();
  notes.all("/:p{.+}", reached("notes"));
  app.route("/workbench/notes", notes);
  app.all("/workbench/health", reached("health"));
  app.all("/workbench/health/*", reached("health"));
  app.all("/workbench/documents/*", reached("documents"));
  app.all("/workbench/*", reached("any"));
  const ac = new AbortController();
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} }, app.fetch);
  const port = (srv.addr as Deno.NetAddr).port;
  return {
    async raw(method: string, target: string, headers: Record<string, string>) {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      await conn.write(new TextEncoder().encode(`${method} ${target} HTTP/1.1\r\nHost: h\r\n${h}Connection: close\r\n\r\n`));
      const buf = new Uint8Array(65536);
      let out = "";
      let n: number | null;
      while ((n = await conn.read(buf)) !== null) out += new TextDecoder().decode(buf.subarray(0, n));
      conn.close();
      const i = out.indexOf("\r\n\r\n");
      const status = Number(out.slice(9, 12));
      return { status, body: i === -1 ? "" : out.slice(i + 4) };
    },
    async close() { ac.abort(); await srv.finished; },
  };
}

// raw targets the router reads differently from a WHATWG URL (or that a later decode could reshape):
// encoded dots in every case mix, literal ./.., //, ";" and "\" - in the middle of a route and at its start
const NON_CANONICAL: [string, string][] = [
  ["GET", "/workbench/notes/%2e%2e/health"], ["GET", "/workbench/notes/%2E%2E/health/x"],
  ["GET", "/workbench/notes/.%2e/health"], ["GET", "/workbench/notes/%2e./health"],
  ["GET", "/workbench/notes/%2E./health"], ["GET", "/workbench/notes/.%2E/health"],
  ["GET", "/workbench/notes/../health"], ["GET", "/workbench/notes/./../health"],
  ["GET", "/workbench/notes/./a.md"], ["GET", "/workbench/notes/a//../../../health"],
  ["GET", "/workbench/notes//a.md"], ["GET", "/workbench/notes/;/../../health"],
  ["GET", "/workbench/notes/a;b.md"], ["GET", "/workbench/notes/x\\..\\..\\health"],
  ["GET", "/workbench/notes/a\\b.md"], ["PUT", "/workbench/notes/%2e%2e/health"],
  ["DELETE", "/workbench/notes/../health"], ["POST", "/workbench/notes/.%2e/health/restore"],
  ["GET", "/workbench/notes/%2e%2e/auth/x"], ["GET", "/workbench/notes/%2e%2e/%2e%2e/workbench/auth/me"],
  // at the start of the /workbench routes
  ["GET", "/workbench/%2e%2e/workbench/health"], ["GET", "/workbench/%2E%2E/workbench/notes/a.md"],
  ["GET", "/workbench/.%2e/workbench/health"], ["GET", "/workbench/%2e./workbench/health"],
  ["GET", "/workbench/../workbench/health"], ["GET", "/workbench/./health"],
  ["GET", "/workbench/./notes/a.md"], ["GET", "/workbench//health"],
  ["GET", "/workbench/;/../health"], ["GET", "/workbench/x\\..\\health"],
  ["POST", "/workbench/health/%2e%2e/documents/references/x/repin"], ["POST", "/workbench/health/../documents/folders"],
  ["GET", "/workbench/x//../../health"], ["GET", "/workbench/notes;x/a.md"], ["GET", "/workbench/health;/x"],
];

// GREEN: every raw non-canonical target is 400 before any decision - with the door key and no token,
// with a valid token, with a service key, with no key at all, and with sign-in not configured. A
// handler running, or any other status, FAILS.
Deno.test("raw targets (B1b): every non-canonical request target is 400 before any decision, with and without keys and tokens", async () => {
  const tok = await token();
  const adm = await token({ groups: ["research-admins"] });
  const on = await serve({ ...FA, WORKSPACE_FORWARD_AUTH_ADMIN_GROUP: "research-admins" });
  const off = await serve(OFF);
  const fails: string[] = [];
  let total = 0;
  try {
    // controls: the canonical spellings are judged as the route they are
    assertEquals((await on.raw("GET", "/workbench/notes/a.md", { "x-brain-key": DOOR })).status, 401, "control: no token = sign in first");
    assertEquals((await on.raw("GET", "/workbench/health", { "x-brain-key": DOOR })).status, 200, "control: health stays open");
    assertEquals((await on.raw("GET", "/workbench/notes/a.md", { "x-brain-key": DOOR, [TOKEN_HEADER]: tok })).status, 200, "control: signed in");
    assertEquals((await on.raw("GET", "/workbench/documents/folders", { "x-brain-key": SVC })).status, 403, "control: a service has no user front end");
    assertEquals((await off.raw("GET", "/workbench/notes/a.md", { "x-brain-key": SVC })).status, 200, "control: sign-in off");
    const who: [string, typeof on, Record<string, string>][] = [
      ["door, no token", on, { "x-brain-key": DOOR }],
      ["door + token", on, { "x-brain-key": DOOR, [TOKEN_HEADER]: tok }],
      ["door + admin token", on, { "x-brain-key": DOOR, [TOKEN_HEADER]: adm }],
      ["service key", on, { "x-brain-key": SVC }],
      ["no key", on, {}],
      ["sign-in off, service key", off, { "x-brain-key": SVC }],
      ["sign-in off, no key", off, {}],
    ];
    for (const [m, t] of NON_CANONICAL) {
      for (const [label, srv, h] of who) {
        total++;
        const r = await srv.raw(m, t, h);
        // the seam's 400 names the rule; Deno's own parser may refuse a target first (empty body) - either is 400
        if (r.status !== 400 || r.body.includes("reached")) fails.push(`${m} ${t} [${label}]: ${r.status} ${r.body.slice(0, 140)}`);
      }
    }
  } finally {
    await on.close();
    await off.close();
  }
  console.log(`raw non-canonical targets: ${total - fails.length}/${total} answered 400 before any decision`);
  assert(fails.length === 0, `${fails.length}/${total} raw targets were not 400 before any decision:\n${fails.join("\n")}`);
});

// The seam's path IS the router's path: for a table of raw canonical targets, the path the seam stored
// (seamPath) equals c.req.path, the path Hono matched - byte for byte.
Deno.test("raw targets (B1b): the seam's path equals the path the Hono router matches", async () => {
  const srv = await serve({ ...FA });
  const tok = await token();
  const fails: string[] = [];
  const table = [
    "/workbench/notes/a.md", "/workbench/notes/my%20note.md", "/workbench/notes/caf%C3%A9.md", "/workbench/%64ocuments/folders",
    "/workbench/notes/a%26b.md", "/workbench/notes/a%3Fb.md", "/workbench/notes/a%23b.md", "/workbench/documents/folders/",
    "/workbench/contract/chunks/abc:3/context", "/workbench/contract/settings/podcast.archive", "/workbench/notes/a..b.md",
    "/workbench/notes/x.md?p=../../health&q=%2e%2e", "/workbench/notes/x.md?", "/workbench/health?x=%2e%2e/..",
    "http://other.example/workbench/notes/abs.md", "/workbench/NOTES/a.md", "/workbench/notes/%41.md",
  ];
  try {
    for (const t of table) {
      const r = await srv.raw("GET", t, { "x-brain-key": DOOR, [TOKEN_HEADER]: tok });
      let j: { router?: string; seam?: string | null } = {};
      try { j = JSON.parse(r.body); } catch { /* not a handler's answer */ }
      if (r.status !== 200 || !j.router || j.seam !== j.router) fails.push(`${t}: ${r.status} router=${j.router} seam=${j.seam} ${j.router ? "" : r.body.slice(0, 120)}`);
    }
  } finally {
    await srv.close();
  }
  console.log(`seam path == router path: ${table.length - fails.length}/${table.length}`);
  assert(fails.length === 0, `${fails.length}/${table.length} targets where the seam's path is not the router's:\n${fails.join("\n")}`);
});

// F-b (review r-identity2): sign-in NOT configured, yet the request carries Authentik's headers - an
// edge doing forward-auth in front of a workbench that would serve every user as WORKSPACE_DEFAULT_SUB.
// Refused 503 "forward-auth is not configured", never served as the default user.
Deno.test("F-b: with forward-auth not configured, a request carrying X-authentik-* is refused 503, never served as the default user", async () => {
  const off = await serve(OFF);
  const tok = await token();
  const fails: string[] = [];
  const cases: Record<string, string>[] = [
    { [TOKEN_HEADER]: tok }, { [TOKEN_HEADER]: "x" }, { "X-authentik-uid": "ak-sub-bob" }, { "X-Authentik-Username": "bob" },
    { "x-authentik-groups": "research-admins" }, { "X-AUTHENTIK-EMAIL": "bob@example" }, { "x-authentik-meta-jwks": "https://evil.example/jwks" },
  ];
  try {
    for (const h of cases) {
      for (const [label, key] of [["service key", { "x-brain-key": SVC }], ["no key", {}]] as const) {
        for (const p of ["/workbench/notes/a.md", "/workbench/documents/folders", "/workbench/auth/me"]) {
          const r = await off.raw("GET", p, { ...key, ...h });
          if (r.status !== 503 || !/forward-auth is not configured/.test(r.body) || r.body.includes("reached")) {
            fails.push(`${p} [${label}] ${Object.keys(h)[0]}: ${r.status} ${r.body.slice(0, 140)}`);
          }
        }
      }
    }
    // without any Authentik header, sign-in off is exactly today's single-user behaviour
    const plain = await off.raw("GET", "/workbench/notes/a.md", { "x-brain-key": SVC });
    assertEquals(plain.status, 200, "no Authentik header: served as before");
  } finally {
    await off.close();
  }
  assert(fails.length === 0, `${fails.length} requests carrying X-authentik-* were not refused 503 while forward-auth is off:\n${fails.join("\n")}`);
  // with forward-auth configured the headers are the edge's normal traffic (the token is verified)
  const on = await serve({ ...FA });
  try {
    assertEquals((await on.raw("GET", "/workbench/notes/a.md", { "x-brain-key": DOOR, [TOKEN_HEADER]: tok, "x-authentik-uid": "ak-sub-alice" })).status, 200);
  } finally {
    await on.close();
  }
});
