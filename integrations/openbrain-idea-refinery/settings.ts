// rw-settings-store (plan 08 PD3): the refinery reads an idea OWNER's settings through the database's one
// read function, public.setting_get(owner, key) (init-settings.sql, slot 400). NULL - no stored value, no
// owner, or a database without slot 400 yet - means the env value / code default this service has always
// used, so nothing changes until a value is stored. A stored value is read on every pass (the next run).

export type SqlRows = <T>(text: string, args?: unknown[]) => Promise<T[]>;

let warned = false;

/** The owner's stored value for `key`, or null (the caller keeps its env value). Never throws. */
export async function ownerSetting(sql: SqlRows, owner: string | null | undefined, key: string): Promise<unknown> {
  if (!owner) return null;
  try {
    const r = await sql<{ v: unknown }>(`SELECT public.setting_get($1, $2) AS v`, [owner, key]);
    return r[0]?.v ?? null;
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`settings: setting_get unavailable (${(e as Error).message}); the env values are used`);
    }
    return null;
  }
}

/** A stored number inside [min, max], else the fallback. */
export function settingNumber(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** A stored boolean, else the fallback. */
export function settingBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

// The dormancy pass, per owner: a researched idea with no engagement goes dormant after its OWNER's
// refinery.dormancy_days (the env IDEA_DORMANCY_DAYS when the owner stored none). Falls back to the
// pre-settings statement (one horizon for all) on a database without setting_get (slot 400 not applied).
export const AGE_PER_OWNER =
  `UPDATE ideas SET status='dormant', dormant_at=now()
    WHERE status='researched' AND engaged_at IS NULL
      AND updated_at < now() - make_interval(days => COALESCE((public.setting_get(owner_sub, 'refinery.dormancy_days') #>> '{}')::int, $1))
    RETURNING id`;
export const AGE_ONE_HORIZON =
  `UPDATE ideas SET status='dormant', dormant_at=now()
    WHERE status='researched' AND engaged_at IS NULL
      AND updated_at < now() - make_interval(days => $1)
    RETURNING id`;
