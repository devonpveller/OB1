// rw-settings-store: the Settings routes over a fake database - what each route reads and writes, for whom,
// and what it refuses. The database's own guard (setting_problem, the trigger) is proven over a real
// database in settings_integration_test.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import { parseWrite, settingsRouter } from "./routes.ts";
import { identityConfig, type Identity } from "../middleware/identity.ts";
import { settingsAdmin } from "../contracts/routes/system.ts";

const KEYS: Record<string, Record<string, unknown>> = {
  "refinery.dormancy_days": { key: "refinery.dormancy_days", tier: "user", type: "integer", editable: true, store: "settings", default_value: 14, validation: { min: 1, max: 365 } },
  "digest.send_time": { key: "digest.send_time", tier: "user", type: "time", editable: false, store: "settings", default_value: "05:00", validation: {} },
  "research.max_fetch": { key: "research.max_fetch", tier: "admin", type: "integer", editable: false, store: "settings", default_value: 24, validation: {} },
  "test.shared_flag": { key: "test.shared_flag", tier: "admin", type: "boolean", editable: true, store: "settings", default_value: false, validation: {} },
};

function fakeDb() {
  const seen: { sql: string; args: unknown[] }[] = [];
  const rows = new Map<string, unknown>(); // owner|key -> value
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      if (/FROM public\.settings_keys WHERE key = \$1/.test(sql)) return Promise.resolve(KEYS[String(args[0])] ? [KEYS[String(args[0])]] : []);
      if (/FROM public\.settings_keys WHERE tier = 'user'/.test(sql)) return Promise.resolve(Object.values(KEYS).filter((k) => k.tier === "user"));
      if (/FROM public\.settings_keys WHERE tier = 'admin'/.test(sql)) return Promise.resolve(Object.values(KEYS).filter((k) => k.tier === "admin"));
      if (/setting_problem/.test(sql)) {
        const v = JSON.parse(String(args[args.length - 1]));
        return Promise.resolve([{ p: typeof v === "number" && v > 365 ? "must be at most 365" : null }]);
      }
      if (/DELETE FROM public\.user_settings/.test(sql)) {
        rows.delete(`${args[0]}|${args[1]}`);
        return Promise.resolve([]);
      }
      if (/user_setting_set/.test(sql)) {
        rows.set(`${args[0]}|${args[1]}`, JSON.parse(String(args[2])));
        return Promise.resolve([{}]);
      }
      if (/FROM public\.user_settings WHERE owner_sub = \$1 AND key = \$2/.test(sql)) {
        const v = rows.get(`${args[0]}|${args[1]}`);
        return Promise.resolve(v === undefined ? [] : [{ value: v, version: 1, updated_at: "t", updated_by: args[0] }]);
      }
      if (/FROM public\.user_settings WHERE owner_sub = \$1/.test(sql)) {
        return Promise.resolve([...rows].filter(([k]) => k.startsWith(`${args[0]}|`)).map(([k, v]) => ({ key: k.split("|")[1], value: v, version: 1, updated_at: "t", updated_by: null })));
      }
      if (/INSERT INTO public\.contract_settings/.test(sql)) {
        rows.set(`admin|${args[0]}`, JSON.parse(String(args[1])));
        return Promise.resolve([]);
      }
      if (/FROM public\.contract_settings WHERE key = \$1/.test(sql)) {
        const v = rows.get(`admin|${args[0]}`);
        return Promise.resolve(v === undefined ? [] : [{ value: v, version: 1, updated_at: "t", updated_by: null }]);
      }
      return Promise.resolve([]);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  return { db, seen, rows };
}

// the router with a fixed identity per request (the seam's job in the app): header X-Who = sub, X-Kind, X-Admin
function app(db: Db) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    const sub = c.req.header("x-who") ?? "operator";
    const who: Identity = { sub, actor: sub, name: sub, key: sub, kind: (c.req.header("x-kind") ?? "default") as Identity["kind"], admin: c.req.header("x-admin") === "1", impersonating: null };
    c.set("identity" as never, who as never);
    await next();
  });
  a.route("/s", settingsRouter({ db, reg: {} as RegistryReader, mountsRoot: "/mounts" }));
  return a;
}
const put = (a: Hono, path: string, body: unknown, h: Record<string, string> = {}) =>
  a.request(path, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", ...h } });

Deno.test("parseWrite: a value is required; version is optional and whole", () => {
  assertEquals(typeof parseWrite(null), "string");
  assertEquals(typeof parseWrite({}), "string");
  assertEquals(typeof parseWrite({ value: null }), "string");
  assertEquals(typeof parseWrite({ value: 3, version: 1.5 }), "string");
  assertEquals(parseWrite({ value: 3 }), { value: 3, version: null });
  // round 2 (review D1): a NUL in a string or a key is a 400 with a reason, never a 500 from jsonb
  assert(String(parseWrite({ value: "a\u0000b" })).includes("NUL"));
  assert(String(parseWrite({ value: { "k\u0000": 1 } })).includes("NUL"));
  assertEquals(parseWrite({ value: "a\\u0000b" }), { value: "a\\u0000b", version: null }); // the six characters, not a NUL
  assertEquals(parseWrite({ value: false, version: 0 }), { value: false, version: 0 });
});

Deno.test("S-U1: two users' values for the same key are each their own; neither route names another owner", async () => {
  const { db, seen } = fakeDb();
  const a = app(db);
  assertEquals((await put(a, "/s/refinery.dormancy_days", { value: 3 }, { "x-who": "alice" })).status, 200);
  assertEquals((await put(a, "/s/refinery.dormancy_days", { value: 30 }, { "x-who": "bob" })).status, 200);
  const al = await (await a.request("/s", { headers: { "x-who": "alice" } })).json();
  const bo = await (await a.request("/s", { headers: { "x-who": "bob" } })).json();
  assertEquals(al.settings.find((s: { key: string }) => s.key === "refinery.dormancy_days").value, 3);
  assertEquals(bo.settings.find((s: { key: string }) => s.key === "refinery.dormancy_days").value, 30);
  // every user-tier statement was scoped to the request's own subject
  for (const q of seen.filter((x) => /user_setting|user_settings/.test(x.sql))) assert(q.args[0] === "alice" || q.args[0] === "bob", q.sql);
  // a body naming another owner is ignored: the owner is the seam's subject
  await put(a, "/s/refinery.dormancy_days", { value: 7, owner_sub: "bob" }, { "x-who": "alice" });
  const bo2 = await (await a.request("/s", { headers: { "x-who": "bob" } })).json();
  assertEquals(bo2.settings.find((s: { key: string }) => s.key === "refinery.dormancy_days").value, 30);
});

Deno.test("S-U2: a non-admin's PUT of an admin key is refused (both doors) and nothing is written", async () => {
  const { db, seen } = fakeDb();
  const a = app(db);
  const h = { "x-who": "bob", "x-kind": "header" }; // a header user that is not the default subject: not an admin
  assertEquals((await put(a, "/s/admin/test.shared_flag", { value: true }, h)).status, 403);
  assertEquals((await put(a, "/s/test.shared_flag", { value: true }, h)).status, 403);
  assertEquals((await a.request("/s/admin", { headers: h })).status, 403);
  assertEquals((await a.request("/s/admin/test.shared_flag", { method: "DELETE", headers: h })).status, 403);
  assertEquals(seen.some((x) => /contract_settings|user_setting_set/.test(x.sql) && /INSERT|DELETE|user_setting_set/.test(x.sql)), false);
  // the GET says so: no Admin section for this user
  assertEquals((await (await a.request("/s", { headers: h })).json()).admin, false);
});

Deno.test("S-U3: the admin writes an editable admin key; a read-only key is refused for everyone", async () => {
  const { db, rows } = fakeDb();
  const a = app(db);
  const adm = { "x-who": "root", "x-kind": "user", "x-admin": "1" };
  assertEquals((await put(a, "/s/admin/test.shared_flag", { value: true }, adm)).status, 200);
  assertEquals(rows.get("admin|test.shared_flag"), true);
  assertEquals((await put(a, "/s/admin/research.max_fetch", { value: 99 }, adm)).status, 409);
  assertEquals((await put(a, "/s/digest.send_time", { value: "06:00" }, adm)).status, 409);
  assertEquals((await put(a, "/s/admin/refinery.dormancy_days", { value: 5 }, adm)).status, 400); // a user key is not written as shared
  assertEquals((await (await a.request("/s", { headers: adm })).json()).admin, true);
});

Deno.test("S-U4: a value failing the registry's validation is refused (400) and not written; an unknown key is 404", async () => {
  const { db, rows } = fakeDb();
  const a = app(db);
  const r = await put(a, "/s/refinery.dormancy_days", { value: 400 }, { "x-who": "alice" });
  assertEquals(r.status, 400);
  assert(String((await r.json()).error).includes("at most 365"));
  assertEquals(rows.size, 0);
  assertEquals((await put(a, "/s/nope.nothing", { value: 1 })).status, 404);
  assertEquals((await put(a, "/s/BAD KEY", { value: 1 })).status, 400);
});

Deno.test("S-U5: DELETE puts my value back to the default (the service's env value / code default)", async () => {
  const { db } = fakeDb();
  const a = app(db);
  await put(a, "/s/refinery.dormancy_days", { value: 3 }, { "x-who": "alice" });
  const d = await (await a.request("/s/refinery.dormancy_days", { method: "DELETE", headers: { "x-who": "alice" } })).json();
  assertEquals([d.value, d.is_default, d.default], [null, true, 14]);
});

Deno.test("settingsAdmin: with sign-in off the default subject is the admin (single-user mode); a header user, a service are not", () => {
  const cfg = identityConfig(() => undefined); // nothing configured: sign-in off, default subject "operator"
  const id = (o: Partial<Identity>): Identity => ({ sub: "operator", actor: "operator", name: "", key: "", kind: "default", admin: false, impersonating: null, ...o });
  assertEquals(settingsAdmin(id({}), cfg), true);
  assertEquals(settingsAdmin(id({ sub: "bob", kind: "header" }), cfg), false);
  assertEquals(settingsAdmin(id({ sub: "service:digest", kind: "service" }), cfg), false);
});

Deno.test("settingsAdmin (400-A4): in header mode a header equal to WORKSPACE_DEFAULT_SUB is a header user, not the admin; no header is still the default subject", async () => {
  const env: Record<string, string> = { WORKSPACE_IDENTITY_HEADER: "X-Test-Sub", WORKSPACE_DEFAULT_SUB: "owner-sub" };
  const cfg = identityConfig((k: string) => env[k]);
  const { resolveIdentity } = await import("../middleware/identity.ts");
  const named = await resolveIdentity((n) => (n.toLowerCase() === "x-test-sub" ? "owner-sub" : undefined), cfg);
  assertEquals([named.kind, named.sub], ["header", "owner-sub"]);
  assertEquals(settingsAdmin(named, cfg), false);
  const other = await resolveIdentity((n) => (n.toLowerCase() === "x-test-sub" ? "bob" : undefined), cfg);
  assertEquals(settingsAdmin(other, cfg), false);
  const none = await resolveIdentity(() => undefined, cfg);
  assertEquals([none.kind, none.sub], ["default", "owner-sub"]);
  assertEquals(settingsAdmin(none, cfg), true);
});
