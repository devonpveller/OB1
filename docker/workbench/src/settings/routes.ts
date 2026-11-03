// /workbench/settings - the workspace Settings panel's back end (research-workbench rw-settings-store, plan 08 PD3).
//
//   GET    /                 my settings (the user tier, for the seam's subject only) and whether I am an admin
//   PUT    /:key {value, version?}   set one of mine (a registered, editable USER key; the registry validates)
//   DELETE /:key             mine back to the default (the service's env value / code default)
//   GET    /admin            admins only: the shared settings (the admin tier = public.contract_settings),
//                            research tuning among them, read-only
//   PUT    /admin/:key {value}   admins only: set a shared one (editable admin keys only)
//   DELETE /admin/:key       admins only: a shared one back to its default
//
// Every read and write of the user tier is the caller's subject (the identity seam): there is no route that
// names another owner, so one user's value is never readable or writable by another. A refused write
// changes nothing. The admin decision is the one the global contract store already uses
// (contracts/routes/system.ts settingsAdmin): a signed-in member of WORKSPACE_FORWARD_AUTH_ADMIN_GROUP, or -
// with sign-in not configured, the single-user mode as shipped - the default subject itself
// (WORKSPACE_DEFAULT_SUB); never a service and never another header user.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import { BadRequest } from "../contracts/logic/scope.ts";
import { NotFound } from "../contracts/repo/lifecycle.ts";
import { settingsAdmin } from "../contracts/routes/system.ts";
import { identityOf } from "../middleware/identity.ts";
import * as store from "./store.ts";

export interface SettingsDeps {
  db: Db;
  reg: RegistryReader;
  mountsRoot: string;
}

// a NUL (U+0000) in any string or key of a value
function holdsNul(v: unknown): boolean {
  if (typeof v === "string") return v.includes(String.fromCharCode(0));
  if (Array.isArray(v)) return v.some(holdsNul);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => holdsNul(k) || holdsNul(x));
  return false;
}

// The PUT body: {value, version?}. Returns the parsed body or a message.
export function parseWrite(b: unknown): { value: unknown; version: number | null } | string {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "send {\"value\": ...}";
  const o = b as Record<string, unknown>;
  if (!("value" in o) || o.value === null || o.value === undefined) return "send {\"value\": ...} (DELETE the setting to go back to the default)";
  // round 2 (review D1): a NUL anywhere in the value (a string, a key) is refused here - jsonb cannot hold it (a 500)
  if (holdsNul(o.value)) return "a value cannot hold a NUL character";
  let version: number | null = null;
  if (o.version !== undefined && o.version !== null) {
    if (!Number.isInteger(o.version) || (o.version as number) < 0) return "version must be a whole number";
    version = o.version as number;
  }
  return { value: o.value, version };
}

const KEY_RX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function settingsRouter(deps: SettingsDeps) {
  const r = new Hono();
  r.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });

  const refused = (c: Context, e: unknown) => {
    if (e instanceof store.SettingRefused) return c.json({ error: e.message }, e.status);
    if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
    if (e instanceof NotFound) return c.json({ error: e.message }, 404);
    throw e;
  };
  const known = async (c: Context): Promise<store.KeyRow | Response> => {
    const key = c.req.param("key") ?? "";
    if (!KEY_RX.test(key)) return c.json({ error: "not a setting key" }, 400);
    const k = await store.keyRow(deps.db, key);
    if (!k) return c.json({ error: `${key} is not a setting` }, 404);
    return k;
  };
  const adminOnly = async (c: Context) => {
    const who = await identityOf(c);
    return settingsAdmin(who) ? who : null;
  };
  const ADMIN_ONLY = { error: "only an admin may read or change the shared settings" };

  // ── the admin tier (registered before /:key; a key always holds a '.', so it is never "admin") ──
  r.get("/admin", async (c) => {
    if (!await adminOnly(c)) return c.json(ADMIN_ONLY, 403);
    return c.json({ settings: await store.adminSettings(deps.db, deps.reg, deps.mountsRoot) });
  });
  r.put("/admin/:key", async (c) => {
    const who = await adminOnly(c);
    if (!who) return c.json(ADMIN_ONLY, 403);
    const k = await known(c);
    if (k instanceof Response) return k;
    if (k.tier !== "admin") return c.json({ error: `${k.key} is a user setting: PUT /workbench/settings/${k.key}` }, 400);
    if (!k.editable) return c.json({ error: `${k.key} is read-only here` }, 409);
    const p = parseWrite(await c.req.json().catch(() => null));
    if (typeof p === "string") return c.json({ error: p }, 400);
    try {
      return c.json(await store.setAdminSetting(deps.db, deps.reg, deps.mountsRoot, who.actor, k, p.value));
    } catch (e) {
      return refused(c, e);
    }
  });
  r.delete("/admin/:key", async (c) => {
    if (!await adminOnly(c)) return c.json(ADMIN_ONLY, 403);
    const k = await known(c);
    if (k instanceof Response) return k;
    if (k.tier !== "admin") return c.json({ error: `${k.key} is a user setting` }, 400);
    if (!k.editable) return c.json({ error: `${k.key} is read-only here` }, 409);
    return c.json(await store.clearAdminSetting(deps.db, deps.reg, deps.mountsRoot, k));
  });

  // ── the user tier: always the caller's own ───────────────────────────────────────────────────
  r.get("/", async (c) => {
    const who = await identityOf(c);
    return c.json({ admin: settingsAdmin(who), settings: await store.userSettings(deps.db, who.sub) });
  });
  r.put("/:key", async (c) => {
    const who = await identityOf(c);
    const k = await known(c);
    if (k instanceof Response) return k;
    if (k.tier !== "user") return c.json({ error: `${k.key} is a shared setting: only an admin changes it (PUT /workbench/settings/admin/${k.key})` }, 403);
    if (!k.editable) return c.json({ error: `${k.key} is read-only here` }, 409);
    const p = parseWrite(await c.req.json().catch(() => null));
    if (typeof p === "string") return c.json({ error: p }, 400);
    try {
      return c.json(await store.setUserSetting(deps.db, who.sub, who.actor, k, p.value, p.version));
    } catch (e) {
      return refused(c, e);
    }
  });
  r.delete("/:key", async (c) => {
    const who = await identityOf(c);
    const k = await known(c);
    if (k instanceof Response) return k;
    if (k.tier !== "user") return c.json({ error: `${k.key} is a shared setting: only an admin changes it` }, 403);
    return c.json(await store.clearUserSetting(deps.db, who.sub, k));
  });
  return r;
}
