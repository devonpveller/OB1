// deno test --allow-all src/contracts/own_thoughts_test.ts - rwr-own-thoughts-search-api.
// "Library and my thoughts": a search over the caller's OWN saved thoughts, only theirs. Two identities, planted
// markers, a fake thoughts table that answers exactly what the SQL's own filter ($1 = the seam's subject) would.
// What it proves: B never sees A's thought (rows, snippets, errors, counts); a service, an on-behalf caller, an
// anonymous request and an impersonating admin get nothing; every hit says it is private; the query and the thought
// text never reach a log; the shared contract search has no thought rows.
// The real-database proof (planted rows in a real thoughts table, the real SQL) is own_thoughts_integration_test.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import type { Db } from "./db.ts";
import { identitySeam, seamDeps, type Identity } from "../middleware/identity.ts";
import { newApp } from "./routes/http.ts";

const SECRET = "lab-client-secret-0123456789abcdef0123456789abcdef";
const FA = {
  WORKSPACE_FORWARD_AUTH_ISSUER: "https://auth.example/application/o/research/",
  WORKSPACE_FORWARD_AUTH_CLIENT_ID: "research-proxy",
  WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: SECRET,
  WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DOOR_KEY: "door-key-0123456789",
  WORKSPACE_SERVICE_KEYS: "digest=service-key-0123456789",
};
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function token(sub: string, groups: string[] = ["users"]) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ iss: FA.WORKSPACE_FORWARD_AUTH_ISSUER, aud: "research-proxy", sub, exp: now + 300, iat: now, name: sub, email: `${sub}@example`, groups })}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}
const env = (m: Record<string, string>) => (k: string) => m[k];

const MARK_A = "PLANTED-A-7f3c9e";
const MARK_B = "PLANTED-B-51d0aa";
type Row = { id: number; user_id: string | null; content: string; created_at: string };
const ROWS: Row[] = [
  { id: 1, user_id: "alice", content: `Alice private idea about gardens ${MARK_A} and compost`, created_at: "2026-11-01T10:00:00.000Z" },
  { id: 2, user_id: "bob", content: `Bob private idea about gardens ${MARK_B}`, created_at: "2026-11-02T10:00:00.000Z" },
  { id: 3, user_id: null, content: "A shared thought about gardens (no owner)", created_at: "2026-11-03T10:00:00.000Z" },
];
// the fake of owner_private_thoughts_search(p_sub, p_q, p_limit): answers what the function does - nothing for an unusable
// subject, `user_id = p_sub` rows whose text holds the query (case-insensitive, no wildcards), newest first. Every call recorded.
const unusable = (sub: string) => !sub || /^(service|system|anonymous):/i.test(sub) || sub.toLowerCase() === "operator";
function fakeDb() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      const [sub, q, n] = args as [string, string, number];
      const needle = String(q).trim().toLowerCase();
      const rows = unusable(sub) || needle.length < 2 ? [] : ROWS.filter((r) => r.user_id !== null && r.user_id === sub && r.content.toLowerCase().includes(needle)).slice(0, Number(n));
      return Promise.resolve(rows.map((r) => ({
        thought_id: String(r.id), title: r.content.split(/\r?\n/)[0].slice(0, 120), snippet_src: r.content.slice(0, 600), created_at: r.created_at,
      })) as unknown as T[]);
    },
    tx: (fn) => fn(db),
  };
  return { db, calls };
}

async function build(e: Record<string, string> = FA) {
  const { registerOwnThoughts } = await import("./routes/own_thoughts.ts");
  const { ownThoughtsConfig } = await import("../identity/own_thoughts.ts");
  const { db, calls } = fakeDb();
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(null, env(e))));
  const contract = newApp();
  registerOwnThoughts(contract, { db, ownThoughtsCfg: ownThoughtsConfig(env(e)) } as never);
  app.route("/", contract);
  return { app, calls };
}
const PATH = "/workbench/contract/own-thoughts/search";
async function get(app: Hono, q: string, headers: Record<string, string>) {
  const r = await app.request(`http://h${PATH}?q=${encodeURIComponent(q)}`, { headers });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
const as = async (sub: string) => ({ "x-brain-key": FA.WORKSPACE_DOOR_KEY, "x-authentik-jwt": await token(sub) });

Deno.test("the owner finds their own thought, marked private to you", async () => {
  const { app } = await build();
  const r = await get(app, "gardens", await as("alice"));
  assertEquals(r.status, 200, r.text);
  const body = JSON.parse(r.text);
  assertEquals(body.private, true);
  assertEquals(body.results.length, 1);
  const h = body.results[0];
  assertEquals(h.kind, "thought");
  assertEquals(h.id, "1");
  assertEquals(h.private, true);
  assertEquals(h.marker, "private to you");
  assert(h.snippet.includes("<<HL>>gardens<</HL>>"), h.snippet);
  assertEquals(h.title, "Alice private idea about gardens PLANTED-A-7f3c9e and compost");
  assertEquals(h.state, "current");
  assertEquals(h.lifecycle, null);
  assertEquals(h.date, "2026-11-01T10:00:00.000Z");
  assert(r.headers.get("cache-control")?.includes("no-store"));
});

Deno.test("two identities: B never gets A's thought - no row, snippet, count or error names it", async () => {
  const { app } = await build();
  for (const q of ["gardens", MARK_A, "compost", "Alice"]) {
    const r = await get(app, q, await as("bob"));
    assertEquals(r.status, 200, r.text);
    const b = JSON.parse(r.text);
    // the caller's own query comes back to them (as on the shared search); nothing else may carry A's words
    const seen = JSON.stringify({ ...b, query: "" });
    assert(!seen.includes(MARK_A) && !seen.includes("Alice") && !seen.includes("compost"), `B saw A for q=${q}: ${r.text}`);
    assert(!("count" in b) && !("total" in b), "no count or total on any answer");
  }
  // B's search for something only A has is the same empty answer as a search for nothing at all
  const only = await get(app, MARK_A, await as("bob"));
  const none = await get(app, "zzz-nothing-matches-zzz", await as("bob"));
  assertEquals(JSON.parse(only.text), { ...JSON.parse(none.text), query: MARK_A });
  // B's own
  const mine = JSON.parse((await get(app, MARK_B, await as("bob"))).text);
  assertEquals(mine.results.map((h: { id: string }) => h.id), ["2"]);
});

Deno.test("an unowned (shared) thought is nobody's own: not returned to anyone", async () => {
  const { app } = await build();
  for (const who of ["alice", "bob"]) {
    const b = JSON.parse((await get(app, "no owner", await as(who))).text);
    assertEquals(b.results, []);
  }
});

Deno.test("the subject comes from the seam only: sub/owner/user_id/user parameters and an x-on-behalf-of header change nothing", async () => {
  const { app, calls } = await build();
  const h = await as("bob");
  for (const extra of ["&sub=alice", "&owner=alice", "&user_id=alice", "&owner_sub=alice", "&user=alice"]) {
    const r = await app.request(`http://h${PATH}?q=${MARK_A}${extra}`, { headers: h });
    assertEquals(JSON.parse(await r.text()).results, []);
  }
  const r2 = await app.request(`http://h${PATH}?q=gardens&sub=alice`, { headers: { ...h, "x-on-behalf-of": "alice" } });
  assertEquals(r2.status, 403); // the seam refuses a client-sent x-on-behalf-of outside the intake's add
  assert(!(await r2.text()).includes(MARK_A));
  for (const c of calls) assertEquals(c.args[0], "bob");
});

Deno.test("a service identity is refused with an error, returns nothing and causes no query", async () => {
  const { app, calls } = await build();
  const r = await get(app, "gardens", { "x-brain-key": "service-key-0123456789" });
  assertEquals(r.status, 403);
  assert(JSON.parse(r.text).error);
  assert(!r.text.includes(MARK_A) && !r.text.includes("results"));
  assertEquals(calls.length, 0);
});

Deno.test("no sign-in (anonymous) is refused before the route; no query", async () => {
  const { app, calls } = await build();
  const r = await get(app, "gardens", { "x-brain-key": FA.WORKSPACE_DOOR_KEY });
  assertEquals(r.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("who may use it: persons acting as themselves, by slot 480's rule (service, on-behalf, anonymous, impersonating or non-owner admin, header identity, a blank default: no)", async () => {
  const { ownThoughtsEligible } = await import("../identity/own_thoughts.ts");
  const base = { sub: "alice", actor: "alice", name: "Alice", key: "alice", admin: false, impersonating: null } as const;
  const id = (o: Partial<Identity>): Identity => ({ ...base, kind: "user", ...o } as Identity);
  const on = { signIn: true, defaultSub: "" }, off = { signIn: false, defaultSub: "alice" };
  // sign-in on: a signed-in user acting as themselves, nobody else
  assertEquals(ownThoughtsEligible(id({}), on), true);
  assertEquals(ownThoughtsEligible(id({ kind: "default" }), on), false);
  assertEquals(ownThoughtsEligible(id({ kind: "header" }), on), false);
  // sign-in off: the ONE default identity with a set default subject; a header identity never
  assertEquals(ownThoughtsEligible(id({ kind: "default" }), off), true);
  assertEquals(ownThoughtsEligible(id({ kind: "default" }), { signIn: false, defaultSub: "" }), false);
  assertEquals(ownThoughtsEligible(id({ kind: "default", sub: "operator", actor: "operator" }), { signIn: false, defaultSub: "" }), false);
  assertEquals(ownThoughtsEligible(id({ kind: "default", sub: "bob", actor: "bob" }), off), false);
  assertEquals(ownThoughtsEligible(id({ kind: "header" }), off), false);
  for (const cfg of [on, off]) {
    assertEquals(ownThoughtsEligible(undefined, cfg), false);
    assertEquals(ownThoughtsEligible(id({ kind: "service", sub: "service:digest", actor: "service:digest" }), cfg), false);
    assertEquals(ownThoughtsEligible(id({ kind: "on-behalf", actor: "service:mcp" }), cfg), false);
    assertEquals(ownThoughtsEligible(id({ kind: "anonymous" }), cfg), false);
    assertEquals(ownThoughtsEligible(id({ kind: undefined }), cfg), false);
    // an admin who is not the owner (and one impersonating the owner) gets nothing either
    assertEquals(ownThoughtsEligible(id({ admin: true, actor: "root", impersonating: { reason: "support", since: "2026-11-20T00:00:00Z" } }), cfg), false);
    assertEquals(ownThoughtsEligible(id({ actor: "root" }), cfg), false);
    assertEquals(ownThoughtsEligible(id({ sub: "", actor: "" }), cfg), false);
  }
});

Deno.test("sign-in off: the default identity (WORKSPACE_DEFAULT_SUB set) finds its own; blank default or a header identity: empty and no query", async () => {
  const set = { WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_DEFAULT_SUB: "alice" };
  const a = await build(set);
  const r = await get(a.app, "gardens", { "x-brain-key": set.WORKBENCH_KEY });
  assertEquals(r.status, 200, r.text);
  assertEquals(JSON.parse(r.text).results.map((h: { id: string }) => h.id), ["1"]);
  const blank = await build({ WORKBENCH_KEY: "internal-key-0123456789" });
  const r2 = await get(blank.app, "gardens", { "x-brain-key": "internal-key-0123456789" });
  assertEquals(JSON.parse(r2.text).results, []);
  assertEquals(blank.calls.length, 0);
  const hdr = await build({ ...set, WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" });
  const r3 = await get(hdr.app, "gardens", { "x-brain-key": set.WORKBENCH_KEY, "x-test-sub": "alice" });
  assertEquals(JSON.parse(r3.text).results, []);
  assertEquals(hdr.calls.length, 0);
});

Deno.test("a non-owner admin (an admin token, another subject's thoughts): nothing - the filter is the admin's own subject", async () => {
  const { app, calls } = await build();
  const admin = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, "x-authentik-jwt": await token("root", ["users", "admins"]) };
  const r = await get(app, "gardens", admin);
  assert(!r.text.includes(MARK_A) && !r.text.includes(MARK_B), r.text);
  for (const c of calls) assertEquals(c.args[0], "root");
});

Deno.test("the handler mounted without the seam is refused (no identity), never served as a default", async () => {
  const { registerOwnThoughts } = await import("./routes/own_thoughts.ts");
  const { db, calls } = fakeDb();
  const contract = newApp();
  registerOwnThoughts(contract, { db, ownThoughtsCfg: { signIn: false, defaultSub: "alice" } } as never);
  const r = await contract.request(`http://h${PATH}?q=gardens`);
  assertEquals(r.status, 403);
  assertEquals(calls.length, 0);
});

Deno.test("the query and the thought text never reach a log", async () => {
  const { app } = await build();
  const lines: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(keep) as (keyof typeof keep)[]) console[k] = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await get(app, MARK_A, await as("alice"));
    await get(app, MARK_A, await as("bob"));
    await get(app, MARK_A, { "x-brain-key": "service-key-0123456789" });
  } finally {
    Object.assign(console, keep);
  }
  assert(!lines.join("\n").includes(MARK_A), lines.join("\n"));
  assert(!lines.join("\n").includes("compost"));
});

Deno.test("a wildcard character in the query is just text; the minimum is two characters; the limit is capped", async () => {
  const { app, calls } = await build();
  const h = await as("alice");
  const all = JSON.parse((await get(app, "%%", h)).text);
  assertEquals(all.results, [], "% is not a wildcard");
  assertEquals(calls[0].args[1], "%%"); // raw: the database function compares text, it has no wildcards
  const one = await get(app, "a", h);
  assertEquals(one.status, 400);
  const r = await app.request(`http://h${PATH}?q=gardens&limit=9999`, { headers: h });
  assertEquals(r.status, 200);
  for (const c of calls) assert(Number(c.args[2]) <= 50);
});

Deno.test("a thought's own text carrying the highlight markers cannot forge one", async () => {
  const { app } = await build();
  ROWS.push({ id: 9, user_id: "alice", content: "mine <<HL>>forged<</HL>> marker text zebra", created_at: "2026-11-04T00:00:00.000Z" });
  try {
    const b = JSON.parse((await get(app, "zebra", await as("alice"))).text);
    assertEquals(b.results[0].snippet.split("<<HL>>").length - 1, 1);
    assert(!b.results[0].snippet.includes("forged<</HL>>"));
  } finally {
    ROWS.pop();
  }
});

Deno.test("the shared contract search has no thought rows (source: it reads pages, claims, sources, held sources only)", async () => {
  const src = await Deno.readTextFile(new URL("./repo/knowledge.ts", import.meta.url));
  const fn = src.slice(src.indexOf("export async function search("), src.indexOf("async function searchPages"));
  assert(fn.length > 200 && !/thoughts/i.test(fn), "knowledge.ts search() must not read thoughts");
  const shared = await Deno.readTextFile(new URL("./schemas/knowledge.ts", import.meta.url));
  assert(!/own[-_]thought/i.test(shared));
});

Deno.test("no shared surface reads the own-thoughts repo (only its route)", async () => {
  const offenders: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) await walk(new URL(e.name + "/", dir), rel + e.name + "/");
      else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") && (await Deno.readTextFile(new URL(e.name, dir))).includes("repo/own_thoughts")) offenders.push(rel + e.name);
    }
  }
  await walk(new URL("../", import.meta.url), "");
  assertEquals(offenders, ["contracts/routes/own_thoughts.ts"]);
});
