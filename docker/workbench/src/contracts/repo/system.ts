// Notifications (D13 item 7), the configuration store (D6 item 5), the registries (D18).
import type { Db } from "../db.ts";
import type { RegistryReader } from "../registry.ts";
import { Conflict, NotFound } from "./lifecycle.ts";

export interface NotificationInput {
  class: string;
  subject: string;
  slug?: string | null;
  entity?: string | null;
  origin?: string | null;
  error?: string | null;
}

// The producer API, in-process. Producers in other containers call the same SQL function
// (public.post_research_notification) - there is no HTTP write path: the research service
// posts nothing to Mattermost, Telegram or the status pipe, and nothing posts to the front end
// except through the database.
export async function postNotification(db: Db, n: NotificationInput) {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM public.post_research_notification($1, $2, $3, $4, $5, $6)`,
    [n.class, n.subject, n.slug ?? null, n.entity ?? null, n.origin ?? null, n.error ?? null],
  );
  return rows[0];
}

export async function notifications(db: Db, cls: string | null, since: string | null, limit: number) {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, class, subject, slug, entity, origin, error, first_seen, last_seen, count
       FROM public.research_notifications
      WHERE ($1::text IS NULL OR class = $1) AND ($2::timestamptz IS NULL OR last_seen >= $2)
      ORDER BY last_seen DESC LIMIT $3`,
    [cls, since, limit],
  );
  return { notifications: rows };
}

// Settings. A default is DECLARED in the settings registry entry (definition.default), never
// written in code: {"mount": <name>} resolves to <mountsRoot>/<name>, the bind mount compose
// provides. A stored value replaces it; reading after a write returns the new value.
type Destination = { mount?: string; path?: string };

function resolveDestination(v: Destination, mountsRoot: string): { path: string | null; via: string } {
  if (typeof v.mount === "string") return { path: `${mountsRoot.replace(/\/+$/, "")}/${v.mount}`, via: `mount:${v.mount}` };
  if (typeof v.path === "string") return { path: v.path, via: "path" };
  return { path: null, via: "unresolvable" };
}

async function isDir(p: string | null): Promise<boolean> {
  if (!p) return false;
  try {
    return (await Deno.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

export function validateDestination(v: unknown): Destination {
  const o = (v ?? {}) as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1) throw new Conflict("a destination is exactly one of {\"mount\": <name>} or {\"path\": <absolute dir>}");
  if (keys[0] === "mount" && typeof o.mount === "string" && /^[a-z0-9][a-z0-9-]*$/.test(o.mount)) return { mount: o.mount };
  if (keys[0] === "path" && typeof o.path === "string" && o.path.startsWith("/") && !o.path.includes("..")) return { path: o.path };
  throw new Conflict("a destination is exactly one of {\"mount\": <name>} or {\"path\": <absolute dir>}");
}

async function settingOut(key: string, def: Record<string, unknown>, stored: StoredSetting | undefined, mountsRoot: string) {
  const value = (stored?.value ?? def.default ?? {}) as Destination;
  const r = def.type === "destination" ? resolveDestination(value, mountsRoot) : { path: null, via: "value" };
  return {
    key, value, is_default: !stored, version: stored?.version ?? 0,
    updated_at: stored?.updated_at ?? null, updated_by: stored?.updated_by ?? null,
    resolved: { path: r.path, reachable: await isDir(r.path), via: r.via },
  };
}

interface StoredSetting {
  key: string;
  value: Record<string, unknown>;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

export async function settings(db: Db, reg: RegistryReader, mountsRoot: string) {
  const entries = await reg.entries("settings");
  const stored = new Map((await db.query<StoredSetting>(`SELECT * FROM public.contract_settings`)).map((s) => [s.key, s]));
  const out = [];
  for (const e of entries) out.push(await settingOut(e.key, e.definition, stored.get(e.key), mountsRoot));
  return { settings: out };
}

export async function setting(db: Db, reg: RegistryReader, key: string, mountsRoot: string) {
  const e = await reg.entry("settings", key);
  if (!e) throw new NotFound(`'${key}' is not a key of the settings registry`);
  const stored = (await db.query<StoredSetting>(`SELECT * FROM public.contract_settings WHERE key = $1`, [key]))[0];
  return await settingOut(key, e.definition, stored, mountsRoot);
}

export async function writeSetting(db: Db, reg: RegistryReader, key: string, value: unknown, by: string | null, mountsRoot: string) {
  const e = await reg.entry("settings", key);
  if (!e) throw new NotFound(`'${key}' is not a key of the settings registry`);
  const v = e.definition.type === "destination" ? validateDestination(value) : value;
  await db.query(
    `INSERT INTO public.contract_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = public.contract_settings.version + 1,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(v), by],
  );
  return await setting(db, reg, key, mountsRoot);
}

export async function registries(db: Db) {
  const rows = await db.query<{ name: string; version: number; owner: string; description: string; entries: number }>(
    `SELECT r.name, r.version, r.owner, r.description,
            (SELECT count(*) FROM public.contract_registry_view v WHERE v.registry = r.name)::int AS entries
       FROM public.contract_registries r ORDER BY r.name`,
  );
  return { registries: rows };
}

export async function registry(db: Db, reg: RegistryReader, name: string) {
  const r = (await db.query<{ name: string; version: number; owner: string; description: string }>(
    `SELECT name, version, owner, description FROM public.contract_registries WHERE name = $1`, [name],
  ))[0];
  if (!r) return null;
  const entries = (await reg.entries(name)).map(({ registry: _r, ...e }) => e);
  return { ...r, entries };
}
