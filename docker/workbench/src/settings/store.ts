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
  // who can see the value (rwr-settings-shell, slot 550): only_you | on_server | admin_all; null = the row has no tag (a catalog-test failure)
  tag: "only_you" | "on_server" | "admin_all" | null;
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
// `gone` is the version a DELETED user key left behind (slot 490's tombstone): versions never go back, so a key with no
// row reports that, not 0 (0 = never stored)
export function keyOut(k: KeyRow, s: Stored | undefined, gone = 0) {
  return {
    key: k.key, tier: k.tier, type: k.type, section: k.section, position: k.position, label: k.label, help: k.help,
    default: k.default_value ?? null, env: k.env_name, read_by: k.read_by, validation: k.validation ?? {}, editable: k.editable, tag: k.tag ?? null,
    value: s ? s.value : null, is_default: !s, version: s?.version ?? gone, updated_at: s?.updated_at ?? null,
  };
}

const KEY_COLS = `key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store, tag`;

export async function keyRow(db: Db, key: string): Promise<KeyRow | null> {
  return (await db.query<KeyRow>(`SELECT ${KEY_COLS} FROM public.settings_keys WHERE key = $1`, [key]))[0] ?? null;
}

// rwr-settings-defaults (slot 730): the ceiling in force for a user key, as a number, for the keys that have one (a default may not
// exceed it). Only the number is sent - never the admin key behind it, its name or its label.
async function ceilings(db: Db): Promise<Map<string, { ceiling: number; ceiling_phrase: string }>> {
  const rows = await db.query<{ user_key: string; c: string | null; phrase: string }>(
    `SELECT user_key, public.settings_user_ceiling(user_key)::text AS c, phrase FROM public.settings_user_ceilings`,
  );
  return new Map(rows.filter((r) => r.c !== null && Number.isFinite(Number(r.c))).map((r) => [r.user_key, { ceiling: Number(r.c), ceiling_phrase: r.phrase }]));
}
const withCeiling = <T extends object>(row: T, key: string, cap: Map<string, { ceiling: number; ceiling_phrase: string }>) => (cap.has(key) ? { ...row, ...cap.get(key)! } : row);

// The caller's own user-tier settings (owner = the seam's subject; never anyone else's).
export async function userSettings(db: Db, owner: string) {
  const keys = await db.query<KeyRow>(`SELECT ${KEY_COLS} FROM public.settings_keys WHERE tier = 'user' ORDER BY section, position, key`);
  const rows = await db.query<Stored & { key: string }>(
    `SELECT key, value, version, updated_at::text AS updated_at, updated_by FROM public.user_settings WHERE owner_sub = $1`, [owner],
  );
  const by = new Map(rows.map((r) => [r.key, r]));
  const gone = new Map((await db.query<{ key: string; version: number }>(
    `SELECT key, version FROM public.user_setting_tombstones WHERE owner_sub = $1`, [owner],
  )).map((r) => [r.key, r.version]));
  const cap = await ceilings(db);
  return keys.map((k) => withCeiling(keyOut(k, by.get(k.key), gone.get(k.key) ?? 0), k.key, cap));
}

export async function userSetting(db: Db, owner: string, k: KeyRow) {
  const s = (await db.query<Stored>(
    `SELECT value, version, updated_at::text AS updated_at, updated_by FROM public.user_settings WHERE owner_sub = $1 AND key = $2`, [owner, k.key],
  ))[0];
  const gone = s ? 0 : (await db.query<{ version: number }>(
    `SELECT version FROM public.user_setting_tombstones WHERE owner_sub = $1 AND key = $2`, [owner, k.key],
  ))[0]?.version ?? 0;
  return withCeiling(keyOut(k, s, gone), k.key, await ceilings(db));
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

// DELETE: back to the default. `version`, when given, must be the key's current one (a stale Unlock is refused, 409);
// the delete is itself a new version (user_setting_clear), so the number never goes back.
export async function clearUserSetting(db: Db, owner: string, k: KeyRow, version: number | null = null) {
  try {
    await db.query(`SELECT public.user_setting_clear($1, $2, $3)`, [owner, k.key, version]);
  } catch (e) {
    if (pgCode(e) === "40001") throw new SettingRefused(409, pgMessage(e));
    throw e;
  }
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

// the removal is logged with who made it (slot 730: admin_setting_clear sets the actor the audit trigger records)
export async function clearAdminSetting(db: Db, reg: RegistryReader, mountsRoot: string, actor: string, k: KeyRow) {
  await db.query(`SELECT public.admin_setting_clear($1, $2)`, [actor, k.key]);
  return await adminSetting(db, reg, mountsRoot, k);
}

// ── the admin research limits: presets inside fixed ranges, never raw numbers (rwr-settings-defaults, slot 730) ──────────
export interface LimitValue { key: string; label: string; value: unknown; is_default: boolean; min: number | null; max: number | null }
export interface LimitPreset { preset: string; label: string; help: string; values: { key: string; label: string; value: unknown }[] }
export interface LimitGroup {
  group: string; label: string; help: string;
  current: string; // the preset the values in force match, or "custom" (a value no preset names); nothing is rewritten to make it match
  presets: LimitPreset[]; values: LimitValue[];
}

export async function limitGroups(db: Db): Promise<LimitGroup[]> {
  const groups = await db.query<{ grp: string; label: string; help: string; cur: string }>(
    `SELECT g.grp, g.label, g.help, public.settings_limits_current(g.grp) AS cur FROM public.settings_limit_groups g ORDER BY g.position, g.grp`);
  const presets = await db.query<{ grp: string; preset: string; label: string; help: string }>(
    `SELECT grp, preset, label, help FROM public.settings_limit_presets ORDER BY grp, position, preset`);
  const pv = await db.query<{ grp: string; preset: string; key: string; label: string; value: unknown }>(
    `SELECT v.grp, v.preset, v.key, k.label, v.value FROM public.settings_limit_preset_values v JOIN public.settings_keys k ON k.key = v.key
      ORDER BY v.grp, v.preset, k.position, v.key`);
  const live = await db.query<{ grp: string; key: string; label: string; value: unknown; stored: boolean; lo: string | null; hi: string | null }>(
    `SELECT DISTINCT g.grp, k.key, k.label, k.position, COALESCE(c.value, k.default_value) AS value, (c.key IS NOT NULL) AS stored,
            k.validation->>'min' AS lo, k.validation->>'max' AS hi
       FROM public.settings_limit_groups g
       JOIN public.settings_limit_preset_values v ON v.grp = g.grp
       JOIN public.settings_keys k ON k.key = v.key
       LEFT JOIN public.contract_settings c ON c.key = k.key
      ORDER BY g.grp, k.position, k.key`);
  return groups.map((g) => ({
    group: g.grp, label: g.label, help: g.help, current: g.cur,
    presets: presets.filter((p) => p.grp === g.grp).map((p) => ({
      preset: p.preset, label: p.label, help: p.help,
      values: pv.filter((v) => v.grp === g.grp && v.preset === p.preset).map((v) => ({ key: v.key, label: v.label, value: v.value })),
    })),
    values: live.filter((l) => l.grp === g.grp).map((l) => ({
      key: l.key, label: l.label, value: l.value, is_default: !l.stored, min: l.lo === null ? null : Number(l.lo), max: l.hi === null ? null : Number(l.hi),
    })),
  }));
}

// Apply a named preset to its group (the database writes exactly the preset's keys, each re-judged against its range, in one
// transaction, and logs every change with the actor). An unknown group or preset is a 404; a value out of range a 400.
export async function applyLimitPreset(db: Db, actor: string, grp: string, preset: string): Promise<LimitGroup> {
  try {
    await db.query(`SELECT public.settings_limits_apply($1, $2, $3)`, [actor, grp, preset]);
  } catch (e) {
    const code = pgCode(e);
    if (code === "P0002") throw new SettingRefused(404, pgMessage(e));
    if (code === "22023") throw new SettingRefused(400, pgMessage(e));
    throw e;
  }
  return (await limitGroups(db)).find((g) => g.group === grp)!;
}

// Take a group's stored values away: the services use their own env values again.
export async function resetLimitGroup(db: Db, actor: string, grp: string): Promise<LimitGroup> {
  try {
    await db.query(`SELECT public.settings_limits_reset($1, $2)`, [actor, grp]);
  } catch (e) {
    if (pgCode(e) === "P0002") throw new SettingRefused(404, pgMessage(e));
    throw e;
  }
  return (await limitGroups(db)).find((g) => g.group === grp)!;
}

export interface AuditLine { id: number; at: string; actor: string; action: string; key: string; old_value: unknown; new_value: unknown; group: string | null; preset: string | null }
// The admin log, newest first (admins only: the route decides). `before` pages by id.
export async function limitsLog(db: Db, limit: number, before: number | null): Promise<AuditLine[]> {
  return await db.query<AuditLine>(
    `SELECT id::int AS id, at::text AS at, actor, action, key, old_value, new_value, grp AS "group", preset
       FROM public.settings_admin_audit WHERE ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $1`, [limit, before]);
}
