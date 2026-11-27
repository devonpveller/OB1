// deno test src/contracts/routes/system_settings_door_test.ts - rwr-settings-shell (tester attempt 1, case 1): the contract's
// settings reads (GET /workbench/contract/settings and /{key}) at the server's HTTP door, with the REAL identity seam in front
// and no database: a non-admin person never receives an admin-tier key or its value; one key read of an admin key answers
// byte for byte as a key that does not exist; an admin and every service caller (the podcast writer reads
// podcast.archive_destination here with its service key) keep full access. Single-user mode and header mode as well.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import type { Db } from "../db.ts";
import type { RegistryReader } from "../registry.ts";
import { identitySeam, seamDeps } from "../../middleware/identity.ts";
import { TOKEN_HEADER } from "../../identity/forward_auth.ts";
import { newApp, type ContractDeps } from "./http.ts";
import { registerSystem } from "./system.ts";

const env = (m: Record<string, string>) => (k: string) => m[k];
const SECRET = "lab-client-secret-0123456789abcdef0123456789abcdef";
const FA = {
  WORKSPACE_FORWARD_AUTH_ISSUER: "https://auth.example/application/o/research/",
  WORKSPACE_FORWARD_AUTH_CLIENT_ID: "research-proxy",
  WORKSPACE_FORWARD_AUTH_CLIENT_SECRET: SECRET,
  WORKSPACE_FORWARD_AUTH_ADMIN_GROUP: "research-admins",
  WORKBENCH_KEY: "internal-key-0123456789",
  WORKSPACE_DOOR_KEY: "door-key-0123456789",
  WORKSPACE_SERVICE_KEYS: "podcast=podcast-key-0123456789;research=research-key-0123456789;digest=digest-key-0123456789;curator=curator-key-0123456789;mcp=mcp-key-012345678901",
};
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function token(claims: Record<string, unknown>) {
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}
const now = () => Math.floor(Date.now() / 1000);
const person = (sub: string, groups: string[]) => token({
  iss: FA.WORKSPACE_FORWARD_AUTH_ISSUER, aud: "research-proxy", sub, exp: now() + 300, iat: now(), name: sub, groups,
});

// The settings registry holds the admin key (podcast.archive_destination) and, to prove the filter is by tier, one user-tier key.
const ENTRIES: Record<string, unknown>[] = [
  { registry: "settings", key: "podcast.archive_destination", version: 1, label: "x", definition: { type: "destination", default: { mount: "podcast-archive" } }, retired_at: null, superseded_by: null },
  { registry: "settings", key: "ui.sample", version: 1, label: "x", definition: { type: "json", default: { v: 1 } }, retired_at: null, superseded_by: null },
];
const reg = {
  entries: (r: string) => Promise.resolve(ENTRIES.filter((e) => e.registry === r)),
  entry: (r: string, k: string) => Promise.resolve(ENTRIES.find((e) => e.registry === r && e.key === k)),
} as unknown as RegistryReader;
function fakeDb(tiers: Record<string, string> | "missing"): Db {
  return {
    query: (sql: string) => {
      if (/FROM public\.settings_keys WHERE tier = 'user'/.test(sql)) {
        if (tiers === "missing") return Promise.reject(new Error('relation "public.settings_keys" does not exist'));
        return Promise.resolve(Object.entries(tiers).filter(([, t]) => t === "user").map(([key]) => ({ key })));
      }
      if (/FROM public\.contract_registries WHERE name/.test(sql)) return Promise.resolve([{ name: "settings", version: 1, owner: "P0", description: "the configuration store keys" }]);
      if (/FROM public\.contract_registries r/.test(sql)) {
        return Promise.resolve([{ name: "settings", version: 1, owner: "P0", description: "the configuration store keys", entries: ENTRIES.length }]);
      }
      return Promise.resolve([]); // contract_settings: nothing stored, every key reads its default
    },
  } as unknown as Db;
}
const TIERS = { "podcast.archive_destination": "admin", "ui.sample": "user" };

function door(e: Record<string, string>, tiers: Record<string, string> | "missing" = TIERS) {
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(null, env(e))));
  const c = newApp();
  registerSystem(c, { db: fakeDb(tiers), registry: reg, mountsRoot: "/mounts-none" } as unknown as ContractDeps);
  app.route("/", c);
  return (path: string, h: Record<string, string> = {}) => app.request(path, { headers: h });
}
const LIST = "/workbench/contract/settings";
const ONE = (k: string) => `/workbench/contract/settings/${k}`;
const ADMIN_KEY = "podcast.archive_destination";
const keysOf = async (r: Response) => { const j = await r.json(); if (!j.settings) throw new Error("status " + r.status + " " + JSON.stringify(j)); return (j.settings as { key: string }[]).map((s) => s.key); };

Deno.test("sign-in on: a non-admin person gets no admin key in the list, and an admin key read answers as an unknown key, byte for byte", async () => {
  const call = door(FA);
  const h = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-alice", ["users"]) };
  const list = await call(LIST, h);
  assertEquals(list.status, 200);
  const body = await list.text();
  assertEquals(JSON.parse(body).settings.map((s: { key: string }) => s.key), ["ui.sample"], "only the user-tier key");
  assert(!body.includes(ADMIN_KEY) && !body.includes("podcast-archive"), "no admin key, label or value anywhere in the body");
  const hidden = await call(ONE(ADMIN_KEY), h);
  const unknown = await call(ONE("no.such_key"), h);
  assertEquals(hidden.status, 404);
  assertEquals(unknown.status, 404);
  assertEquals((await hidden.text()).replace(ADMIN_KEY, "K"), (await unknown.text()).replace("no.such_key", "K"), "the same words for a hidden key and a missing one");
  assertEquals((await call(ONE("ui.sample"), h)).status, 200, "a user-tier key is still readable");
});

Deno.test("sign-in on: an admin person reads every key, the admin key with its value", async () => {
  const call = door(FA);
  const h = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-root", ["users", "research-admins"]) };
  assertEquals((await keysOf(await call(LIST, h))).sort(), [ADMIN_KEY, "ui.sample"]);
  const one = await call(ONE(ADMIN_KEY), h);
  assertEquals(one.status, 200);
  assertEquals((await one.json()).value, { mount: "podcast-archive" });
});

Deno.test("sign-in on: every service caller keeps reading the admin key (the podcast writer's own read, and the other services' keys)", async () => {
  const call = door(FA);
  for (const key of [FA.WORKBENCH_KEY, "podcast-key-0123456789", "research-key-0123456789", "digest-key-0123456789", "curator-key-0123456789", "mcp-key-012345678901"]) {
    const h = { "x-brain-key": key };
    assertEquals((await keysOf(await call(LIST, h))).sort(), [ADMIN_KEY, "ui.sample"], key);
    const one = await call(ONE(ADMIN_KEY), h);
    assertEquals(one.status, 200, key);
    assertEquals((await one.json()).resolved.via, "mount:podcast-archive", `${key}: the writer reads where to write`);
  }
});

Deno.test("sign-in on: a person with no valid token is refused before any handler (nothing to filter)", async () => {
  const call = door(FA);
  assertEquals((await call(LIST, { "x-brain-key": FA.WORKSPACE_DOOR_KEY })).status, 401);
  assertEquals((await call(ONE(ADMIN_KEY), { "x-brain-key": FA.WORKSPACE_DOOR_KEY })).status, 401);
});

Deno.test("header mode (no sign-in): a header user is a person, not an admin: no admin key; the default subject is the operator and sees all", async () => {
  const E = { WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" };
  const call = door(E);
  const k = { "x-brain-key": E.WORKBENCH_KEY };
  assertEquals(await keysOf(await call(LIST, { ...k, "x-test-sub": "bob" })), ["ui.sample"]);
  assertEquals((await call(ONE(ADMIN_KEY), { ...k, "x-test-sub": "bob" })).status, 404);
  assertEquals((await keysOf(await call(LIST, k))).sort(), [ADMIN_KEY, "ui.sample"], "the default subject (the single-user operator)");
  assertEquals((await call(ONE(ADMIN_KEY), k)).status, 200);
});

Deno.test("fail closed: a registry key settings_keys does not know, or no settings_keys table, is never shown to a person; a service still reads", async () => {
  const h = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-alice", ["users"]) };
  const unknownTier = door(FA, { "ui.sample": "user" }); // podcast.archive_destination missing from the table
  assertEquals(await keysOf(await unknownTier(LIST, h)), ["ui.sample"]);
  assertEquals((await unknownTier(ONE(ADMIN_KEY), h)).status, 404);
  const noTable = door(FA, "missing");
  assertEquals(await keysOf(await noTable(LIST, h)), []);
  assertEquals((await noTable(ONE("ui.sample"), h)).status, 404);
  assertEquals((await keysOf(await noTable(LIST, { "x-brain-key": FA.WORKBENCH_KEY }))).sort(), [ADMIN_KEY, "ui.sample"]);
});

// rw-settings-registry-tier: the registry route (and the contract_registry MCP tool, which calls exactly this route) is the
// same door. A person who is not an admin gets no admin-tier entry: not its key, its label, its default mount, anywhere in the body.
const REG = "/workbench/contract/registries/settings";
const regKeys = async (r: Response) => { const j = await r.json(); if (!j.entries) throw new Error("status " + r.status + " " + JSON.stringify(j)); return (j.entries as { key: string }[]).map((e) => e.key); };
const ADMIN_LABEL = ENTRIES[0].label + "";

Deno.test("registry/settings: a non-admin person sees only the user-tier entries; no admin key, default mount or definition anywhere in the body", async () => {
  const call = door(FA);
  const h = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-alice", ["users"]) };
  const r = await call(REG, h);
  assertEquals(r.status, 200);
  const body = await r.text();
  assertEquals(JSON.parse(body).entries.map((e: { key: string }) => e.key), ["ui.sample"]);
  for (const leak of [ADMIN_KEY, "podcast-archive", "destination", "archive"]) assert(!body.includes(leak), `'${leak}' leaked: ${body}`);
  assert(ADMIN_LABEL.length > 0);
  // the summary list counts only what this person may see
  const sum = await (await call("/workbench/contract/registries", h)).json();
  assertEquals(sum.registries.find((x: { name: string }) => x.name === "settings").entries, 1);
});

Deno.test("registry/settings: an admin person and every service caller still see every entry", async () => {
  const call = door(FA);
  const admin = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-root", ["users", "research-admins"]) };
  assertEquals((await regKeys(await call(REG, admin))).sort(), [ADMIN_KEY, "ui.sample"]);
  for (const key of [FA.WORKBENCH_KEY, "podcast-key-0123456789", "mcp-key-012345678901"]) {
    assertEquals((await regKeys(await call(REG, { "x-brain-key": key }))).sort(), [ADMIN_KEY, "ui.sample"], key);
  }
  const sum = await (await call("/workbench/contract/registries", { "x-brain-key": FA.WORKBENCH_KEY })).json();
  assertEquals(sum.registries.find((x: { name: string }) => x.name === "settings").entries, 2);
});

Deno.test("registry/settings: header mode person sees no admin entry, the default subject sees all; fail closed with no settings_keys table", async () => {
  const E = { WORKBENCH_KEY: "internal-key-0123456789", WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" };
  const call = door(E);
  const k = { "x-brain-key": E.WORKBENCH_KEY };
  assertEquals(await regKeys(await call(REG, { ...k, "x-test-sub": "bob" })), ["ui.sample"]);
  assertEquals((await regKeys(await call(REG, k))).sort(), [ADMIN_KEY, "ui.sample"]);
  const h = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-alice", ["users"]) };
  assertEquals(await regKeys(await door(FA, "missing")(REG, h)), []);
});

// rw-settings-registry-tier attempt 1: a user-tier entry that NAMES an admin key (superseded_by, label, definition) must not carry the
// name to a person; the per-identity answers say so to caches; an entry settings_keys does not know is hidden (the M2 case).
Deno.test("registry/settings: a visible entry's reference to an admin key is blanked for a person (superseded_by, label, nested definition), kept for an admin and a service", async () => {
  const planted = { registry: "settings", key: "ui.planted", version: 2, label: `replaces ${ADMIN_KEY}`,
    definition: { type: "json", note: { deep: [`see ${ADMIN_KEY}`, "fine"] }, [ADMIN_KEY]: 1 }, retired_at: null, superseded_by: ADMIN_KEY };
  ENTRIES.push(planted);
  try {
    const call = door(FA, { ...TIERS, "ui.planted": "user" });
    const p = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-alice", ["users"]) };
    const r = await call(REG, p);
    const body = await r.text();
    assert(!body.includes(ADMIN_KEY) && !body.includes("podcast"), `an admin key name reached a person: ${body}`);
    const mine = JSON.parse(body).entries.find((e: { key: string }) => e.key === "ui.planted");
    assertEquals([mine.superseded_by, mine.label], [null, ""]);
    assert(mine.definition.note.deep[1] === "fine", "unrelated fields stay");
    for (const h of [{ "x-brain-key": FA.WORKBENCH_KEY }, { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-root", ["research-admins"]) }]) {
      const full = await (await call(REG, h as Record<string, string>)).text();
      assert(full.includes(ADMIN_KEY), "admin and service see the reference");
    }
  } finally {
    ENTRIES.pop();
  }
});

Deno.test("registry answers carry Cache-Control: private and a Vary on the identity headers", async () => {
  const call = door(FA);
  const h = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-alice", ["users"]) };
  for (const path of [REG, "/workbench/contract/registries"]) {
    const r = await call(path, h);
    await r.text();
    assertEquals(r.headers.get("cache-control"), "private", path);
    const vary = (r.headers.get("vary") ?? "").toLowerCase();
    for (const n of ["x-brain-key", "cookie", "authorization", "x-authentik-jwt"]) assert(vary.includes(n), `${path}: Vary lacks ${n}: ${vary}`);
  }
});

Deno.test("registry/settings: an entry settings_keys does not know is hidden from a person (fail closed), shown to a service", async () => {
  const h = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-alice", ["users"]) };
  const call = door(FA, { "ui.sample": "user" }); // the admin key is missing from the table
  assertEquals(await regKeys(await call(REG, h)), ["ui.sample"]);
  assertEquals((await regKeys(await call(REG, { "x-brain-key": FA.WORKBENCH_KEY }))).sort(), [ADMIN_KEY, "ui.sample"]);
  const orphan = door(FA, {}); // no key known at all
  assertEquals(await regKeys(await orphan(REG, h)), []);
});

// rwr-settings-defaults (tester attempt 2, Case 6): the audit's "who" is the request's identity, never a field of the body. A body that
// names another person in `by` must not reach admin_setting_write as the actor.
Deno.test("PUT /settings/{key}: the actor passed to the logging writer is the admin's own identity, whatever `by` says", async () => {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db = { query: (sql: string, args: unknown[] = []) => { seen.push({ sql, args }); return Promise.resolve([]); } } as unknown as Db;
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(null, env(FA))));
  const c = newApp();
  registerSystem(c, { db, registry: reg, mountsRoot: "/mounts-none" } as unknown as ContractDeps);
  app.route("/", c);
  const h = { "x-brain-key": FA.WORKSPACE_DOOR_KEY, [TOKEN_HEADER]: await person("ak-root", ["users", "research-admins"]), "content-type": "application/json" };
  for (const body of [{ value: { v: 2 }, by: "u-someone-else" }, { value: { v: 2 } }, { value: { v: 2 }, by: "" }]) {
    seen.length = 0;
    const r = await app.request(ONE("ui.sample"), { method: "PUT", headers: h, body: JSON.stringify(body) });
    assertEquals(r.status, 200, JSON.stringify(body));
    const w = seen.find((x) => /admin_setting_write/.test(x.sql));
    assert(w, "the write went through the logging writer");
    assertEquals(w!.args[0], "ak-root", `actor for ${JSON.stringify(body)}`);
  }
});
