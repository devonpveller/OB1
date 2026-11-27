// rwr-settings-defaults: the admin research limits' routes and the user ceiling over a FAKE database - who may reach the limits,
// that the only way in is a named preset, what is passed to the database (the seam's actor), what a refusal says, and what a
// non-admin is ever sent. The database's own rules (the ranges, the ceiling trigger, the append-only log, each preset's exact
// key values) are proven over a real database in settings_defaults_integration_test.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import { settingsRouter } from "./routes.ts";
import type { Identity } from "../middleware/identity.ts";

const ASK = { key: "research.ask_over_fetch", tier: "user", type: "integer", section: "research", position: 20, label: "Ask me", help: "", default_value: null, env_name: null, read_by: "app", validation: { min: 1, max: 200 }, editable: true, store: "settings", tag: "only_you" };
const DORM = { key: "refinery.dormancy_days", tier: "user", type: "integer", section: "refinery", position: 20, label: "Days", help: "", default_value: 14, env_name: null, read_by: "x", validation: { min: 1, max: 365 }, editable: true, store: "settings", tag: "on_server" };
const MAXF = { key: "research.max_fetch", tier: "admin", type: "integer", section: "research", position: 10, label: "ADMINONLY pages", help: "", default_value: 24, env_name: "MAX_FETCH", read_by: "x", validation: { min: 6, max: 60 }, editable: false, store: "settings", tag: "admin_all" };
const KEYS: Record<string, Record<string, unknown>> = { [ASK.key]: ASK, [DORM.key]: DORM, [MAXF.key]: MAXF };

type Seen = { sql: string; args: unknown[] };
function fakeDb(opts: { fail?: { code: string; message: string } } = {}) {
  const seen: Seen[] = [];
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      if (/settings_limits_apply|settings_limits_reset/.test(sql) && opts.fail) {
        return Promise.reject({ fields: { code: opts.fail.code, message: opts.fail.message } });
      }
      if (/FROM public\.settings_keys WHERE key = \$1/.test(sql)) return Promise.resolve(KEYS[String(args[0])] ? [KEYS[String(args[0])]] : []);
      if (/FROM public\.settings_keys WHERE tier = 'user'/.test(sql)) return Promise.resolve(Object.values(KEYS).filter((k) => k.tier === "user"));
      if (/FROM public\.settings_user_ceilings/.test(sql)) return Promise.resolve([{ user_key: ASK.key, c: "24", phrase: "the most pages one research run may read, set by an admin" }]);
      if (/FROM public\.settings_limit_groups g/.test(sql) && /settings_limits_current/.test(sql)) return Promise.resolve([{ grp: "run_size", label: "Run size", help: "", cur: "standard" }]);
      if (/FROM public\.settings_limit_presets/.test(sql)) return Promise.resolve([{ grp: "run_size", preset: "small", label: "Small", help: "" }, { grp: "run_size", preset: "standard", label: "Standard", help: "" }]);
      if (/FROM public\.settings_limit_preset_values v JOIN/.test(sql)) return Promise.resolve([{ grp: "run_size", preset: "small", key: MAXF.key, label: "Pages", value: 12 }]);
      if (/FROM public\.settings_limit_groups g\s+JOIN/.test(sql)) return Promise.resolve([{ grp: "run_size", key: MAXF.key, label: "Pages", value: 24, stored: false, lo: "6", hi: "60" }]);
      if (/FROM public\.settings_admin_audit/.test(sql)) return Promise.resolve([{ id: 7, at: "t", actor: "root", action: "set", key: MAXF.key, old_value: 24, new_value: 12, group: "run_size", preset: "small" }]);
      if (/user_setting_set/.test(sql)) {
        if (args[1] === ASK.key && Number(JSON.parse(String(args[2]))) > 24) {
          return Promise.reject({ fields: { code: "22023", message: "research.ask_over_fetch: must be at most 24 (the most pages one research run may read, set by an admin)" } });
        }
        return Promise.resolve([{}]);
      }
      if (/setting_problem/.test(sql)) return Promise.resolve([{ p: null }]);
      if (/FROM public\.user_setting_tombstones/.test(sql)) return Promise.resolve([]);
      if (/FROM public\.user_settings WHERE owner_sub = \$1 AND key = \$2/.test(sql)) return Promise.resolve([{ value: 20, version: 1, updated_at: "t", updated_by: "a" }]);
      return Promise.resolve([]);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  return { db, seen };
}

function app(db: Db) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    const sub = c.req.header("x-who") ?? "operator";
    const who: Identity = { sub, actor: c.req.header("x-actor") ?? sub, name: sub, key: sub, kind: (c.req.header("x-kind") ?? "default") as Identity["kind"], admin: c.req.header("x-admin") === "1", impersonating: null };
    c.set("identity" as never, who as never);
    await next();
  });
  a.route("/s", settingsRouter({ db, reg: {} as RegistryReader, mountsRoot: "/mounts" }));
  return a;
}
const NONADMIN = { "x-who": "bob", "x-kind": "header" };
const ADMIN = { "x-who": "root", "x-kind": "user", "x-admin": "1" };
const send = (a: Hono, method: string, path: string, body?: unknown, h: Record<string, string> = {}) =>
  a.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...h } });

Deno.test("L1: every limits route answers a non-admin exactly as /admin/<anything> does, and touches nothing", async () => {
  const { db, seen } = fakeDb();
  const a = app(db);
  const paths: [string, string, unknown?][] = [
    ["GET", "/s/admin/limits"], ["GET", "/s/admin/limits/log"], ["PUT", "/s/admin/limits/run_size", { preset: "large" }],
    ["DELETE", "/s/admin/limits/run_size"], ["PUT", "/s/admin/limits/nope", { preset: "x" }], ["GET", "/s/admin/limits/log?limit=5"],
  ];
  const ref = await send(a, "DELETE", "/s/admin/whatever.x", undefined, NONADMIN); // an admin door that exists today
  for (const [m, p, b] of paths) {
    const r = await send(a, m, p, b, NONADMIN);
    assertEquals(r.status, 403, `${m} ${p}`);
    assertEquals(await r.text(), await ref.clone().text(), `${m} ${p}: the same words as any other admin door`);
  }
  // a service and an anonymous caller are no admin either
  assertEquals((await send(a, "GET", "/s/admin/limits", undefined, { "x-who": "svc", "x-kind": "service" })).status, 403);
  assertEquals(seen.length, 0, "no statement ran for a non-admin");
});

Deno.test("L2: the admin reads the groups; presets carry their values; the preset in force is named", async () => {
  const { db } = fakeDb();
  const r = await send(app(db), "GET", "/s/admin/limits", undefined, ADMIN);
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.groups[0].group, "run_size");
  assertEquals(j.groups[0].current, "standard");
  assertEquals(j.groups[0].presets.map((p: { preset: string }) => p.preset), ["small", "standard"]);
  assertEquals(j.groups[0].values[0], { key: "research.max_fetch", label: "Pages", value: 24, is_default: true, min: 6, max: 60 });
});

Deno.test("L3: a preset is the only way in - the body is {preset} and nothing else; raw numbers are refused", async () => {
  const { db, seen } = fakeDb();
  const a = app(db);
  for (const body of [{ preset: "small", values: { "research.max_fetch": 999 } }, { "research.max_fetch": 999 }, { preset: 5 }, { preset: "Small!" }, [], "small", null, {}]) {
    const r = await send(a, "PUT", "/s/admin/limits/run_size", body, ADMIN);
    assertEquals(r.status, 400, JSON.stringify(body));
  }
  // the per-key admin door stays closed to a limit
  assertEquals((await send(a, "PUT", "/s/admin/research.max_fetch", { value: 30 }, ADMIN)).status, 409);
  assertEquals(seen.some((x) => /settings_limits_apply|INSERT INTO public\.contract_settings/.test(x.sql)), false);
});

Deno.test("L4: applying a preset passes the seam's actor, the group and the preset - never a number; the answer is the group", async () => {
  const { db, seen } = fakeDb();
  const r = await send(app(db), "PUT", "/s/admin/limits/run_size", { preset: "small" }, { ...ADMIN, "x-actor": "root-actor" });
  assertEquals(r.status, 200);
  const call = seen.find((x) => /settings_limits_apply/.test(x.sql))!;
  assertEquals(call.args, ["root-actor", "run_size", "small"]);
  assertEquals((await r.json()).group, "run_size");
});

Deno.test("L5: an unknown preset or group is a 404; an out-of-range value the database refuses is a 400 with its words", async () => {
  const a404 = app(fakeDb({ fail: { code: "P0002", message: "there is no preset huge in run_size" } }).db);
  const r = await send(a404, "PUT", "/s/admin/limits/run_size", { preset: "huge" }, ADMIN);
  assertEquals(r.status, 404);
  const a400 = app(fakeDb({ fail: { code: "22023", message: "research.max_fetch: must be at most 60" } }).db);
  const r2 = await send(a400, "PUT", "/s/admin/limits/run_size", { preset: "small" }, ADMIN);
  assertEquals(r2.status, 400);
  assertEquals((await r2.json()).error, "research.max_fetch: must be at most 60");
  assertEquals((await send(a404, "DELETE", "/s/admin/limits/run_size", undefined, ADMIN)).status, 404);
  assertEquals((await send(app(fakeDb().db), "PUT", "/s/admin/limits/Run-Size", { preset: "small" }, ADMIN)).status, 404);
});

Deno.test("L6: reset passes the actor; the log is read newest first with a bounded page", async () => {
  const { db, seen } = fakeDb();
  const a = app(db);
  assertEquals((await send(a, "DELETE", "/s/admin/limits/run_size", undefined, ADMIN)).status, 200);
  assertEquals(seen.find((x) => /settings_limits_reset/.test(x.sql))!.args, ["root", "run_size"]);
  const r = await send(a, "GET", "/s/admin/limits/log?limit=500&before=9", undefined, ADMIN);
  assertEquals(r.status, 200);
  const q = seen.filter((x) => /settings_admin_audit/.test(x.sql)).pop()!;
  assertEquals(q.args, [200, 9]);
  assertEquals((await r.json()).log[0].actor, "root");
  assertEquals((await send(a, "GET", "/s/admin/limits/log?limit=abc", undefined, ADMIN)).status, 400);
  assertEquals((await send(a, "GET", "/s/admin/limits/log?before=-1", undefined, ADMIN)).status, 400);
});

Deno.test("L7: the user list carries the ceiling NUMBER of a ceilinged key and nothing about the admin key behind it", async () => {
  const { db } = fakeDb();
  const a = app(db);
  const r = await send(a, "GET", "/s", undefined, NONADMIN);
  const text = await r.text();
  const j = JSON.parse(text);
  assertEquals(j.settings.find((s: { key: string }) => s.key === ASK.key).ceiling, 24);
  assertEquals(j.settings.find((s: { key: string }) => s.key === ASK.key).ceiling_phrase, "the most pages one research run may read, set by an admin");
  assertEquals("ceiling" in j.settings.find((s: { key: string }) => s.key === DORM.key), false);
  for (const leak of ["research.max_fetch", "MAX_FETCH", "ADMINONLY", "max_fetch"]) assert(!text.includes(leak), `a non-admin's list names ${leak}`);
});

Deno.test("L8: a default above the ceiling is refused with the ceiling named (400); a default at it is saved; the admin key is a 404 to a non-admin", async () => {
  const { db } = fakeDb();
  const a = app(db);
  const over = await send(a, "PUT", "/s/research.ask_over_fetch", { value: 25 }, NONADMIN);
  assertEquals(over.status, 400);
  const msg = (await over.json()).error as string;
  assert(msg.includes("at most 24"), msg);
  assert(!msg.includes("research.max_fetch"), "the refusal does not name the admin key");
  assertEquals((await send(a, "PUT", "/s/research.ask_over_fetch", { value: 24 }, NONADMIN)).status, 200);
  const hidden = await send(a, "PUT", "/s/research.max_fetch", { value: 30 }, NONADMIN);
  const none = await send(a, "PUT", "/s/research.no_such", { value: 30 }, NONADMIN);
  assertEquals(hidden.status, 404);
  assertEquals((await hidden.json()).error, "research.max_fetch is not a setting");
  assertEquals((await none.json()).error, "research.no_such is not a setting");
});
