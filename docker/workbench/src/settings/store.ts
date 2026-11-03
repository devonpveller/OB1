// The settings store (research-workbench rw-settings-store, plan 08 PD3) over init-settings.sql (slot 400).
// The registry (public.settings_keys) declares every key: user tier (one value per owner_sub, in
// public.user_settings) or admin tier (one shared value, in the existing global store
// public.contract_settings). Services read a setting through the database's public.setting_get(owner, key)
// and keep their env value / code default when it answers NULL; this file is the workbench's side - what
// the Settings panel lists and writes, always for the identity seam's subject.
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import * as sys from "../contracts/repo/system.ts";

export interface KeyRow {
  key: string;
  tier: "user" | "admin";
  type: string;
  section: string;
  position: number;
  label: string;
  help: string;
  default_value: unknown;
  env_name: string | null;
  read_by: string;
  validation: Record<string, unknown>;
  editable: boolean;
  store: "settings" | "contract";
}

interface Stored {
  value: unknown;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

// What the panel shows for one key. `value` is the stored value or null; `is_default` says the service is
// using its env value / code default (the workbench cannot see another container's env, so `default` is the
// code default and `env` names the variable that may override it there).
export function keyOut(k: KeyRow, s: Stored | undefined) {
  return {
    key: k.key, tier: k.tier, type: k.type, section: k.section, position: k.position, label: k.label, help: k.help,
    default: k.default_value ?? null, env: k.env_name, read_by: k.read_by, validation: k.validation ?? {}, editable: k.editable,
    value: s ? s.value : null, is_default: !s, version: s?.version ?? 0, updated_at: s?.updated_at ?? null,
  };
}

const KEY_COLS = `key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store`;

export async function keyRow(db: Db, key: string): Promise<KeyRow | null> {
  return (await db.query<KeyRow>(`SELECT ${KEY_COLS} FROM public.settings_keys WHERE key = $1`, [key]))[0] ?? null;
}

// The caller's own user-tier settings (owner = the seam's subject; never anyone else's).
export async function userSettings(db: Db, owner: string) {
  const keys = await db.query<KeyRow>(`SELECT ${KEY_COLS} FROM public.settings_keys WHERE tier = 'user' ORDER BY section, position, key`);
  const rows = await db.query<Stored & { key: string }>(
    `SELECT key, value, version, updated_at::text AS updated_at, updated_by FROM public.user_settings WHERE owner_sub = $1`, [owner],
  );
  const by = new Map(rows.map((r) => [r.key, r]));
  return keys.map((k) => keyOut(k, by.get(k.key)));
}

export async function userSetting(db: Db, owner: string, k: KeyRow) {
  const s = (await db.query<Stored>(
    `SELECT value, version, updated_at::text AS updated_at, updated_by FROM public.user_settings WHERE owner_sub = $1 AND key = $2`, [owner, k.key],
  ))[0];
  return keyOut(k, s);
}

export class SettingRefused extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

const pgCode = (e: unknown) => (e as { fields?: { code?: string } })?.fields?.code ?? "";
const pgMessage = (e: unknown) => String((e as { fields?: { message?: string } })?.fields?.message ?? (e as Error).message);

// Writes one of the owner's user settings through the database's own guard (user_setting_set + the trigger).
export async function setUserSetting(db: Db, owner: string, actor: string, k: KeyRow, value: unknown, version: number | null) {
  const why = (await db.query<{ p: string | null }>(`SELECT public.setting_problem($1, $2, $3::jsonb) AS p`, [owner, k.key, JSON.stringify(value)]))[0].p;
  if (why) throw new SettingRefused(400, `${k.key}: ${why}`);
  try {
    await db.query(`SELECT public.user_setting_set($1, $2, $3::jsonb, $4, $5)`, [owner, k.key, JSON.stringify(value), actor, version]);
  } catch (e) {
    const code = pgCode(e);
    if (code === "22023") throw new SettingRefused(400, pgMessage(e));
    if (code === "40001") throw new SettingRefused(409, pgMessage(e));
    if (code === "42501") throw new SettingRefused(403, pgMessage(e));
    if (code === "P0002") throw new SettingRefused(404, pgMessage(e));
    throw e;
  }
  return await userSetting(db, owner, k);
}

export async function clearUserSetting(db: Db, owner: string, k: KeyRow) {
  await db.query(`DELETE FROM public.user_settings WHERE owner_sub = $1 AND key = $2`, [owner, k.key]);
  return await userSetting(db, owner, k);
}

// ── the admin tier (public.contract_settings) ────────────────────────────────────────────────────
export async function adminSetting(db: Db, reg: RegistryReader, mountsRoot: string, k: KeyRow) {
  if (k.store === "contract") {
    // the slot-230 setting: its own reader (the destination resolves and says whether it is reachable)
    const s = await sys.setting(db, reg, k.key, mountsRoot);
    return { ...keyOut(k, s.is_default ? undefined : { value: s.value, version: s.version, updated_at: String(s.updated_at), updated_by: s.updated_by }), resolved: s.resolved };
  }
  const s = (await db.query<Stored>(
    `SELECT value, version, updated_at::text AS updated_at, updated_by FROM public.contract_settings WHERE key = $1`, [k.key],
  ))[0];
  return keyOut(k, s);
}

export async function adminSettings(db: Db, reg: RegistryReader, mountsRoot: string) {
  const keys = await db.query<KeyRow>(`SELECT ${KEY_COLS} FROM public.settings_keys WHERE tier = 'admin' ORDER BY section, position, key`);
  const out = [];
  for (const k of keys) out.push(await adminSetting(db, reg, mountsRoot, k));
  return out;
}

export async function setAdminSetting(db: Db, reg: RegistryReader, mountsRoot: string, actor: string, k: KeyRow, value: unknown) {
  if (k.store === "contract") {
    // the contract store's own validation (a destination is a named mount or a path inside one)
    await sys.writeSetting(db, reg, k.key, value, actor, mountsRoot);
    return await adminSetting(db, reg, mountsRoot, k);
  }
  const why = (await db.query<{ p: string | null }>(`SELECT public.setting_problem(NULL, $1, $2::jsonb) AS p`, [k.key, JSON.stringify(value)]))[0].p;
  if (why) throw new SettingRefused(400, `${k.key}: ${why}`);
  await db.query(
    `INSERT INTO public.contract_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = public.contract_settings.version + 1,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [k.key, JSON.stringify(value), actor],
  );
  return await adminSetting(db, reg, mountsRoot, k);
}

export async function clearAdminSetting(db: Db, reg: RegistryReader, mountsRoot: string, k: KeyRow) {
  await db.query(`DELETE FROM public.contract_settings WHERE key = $1`, [k.key]);
  return await adminSetting(db, reg, mountsRoot, k);
}
