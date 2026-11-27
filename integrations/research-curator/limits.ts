/**
 * The admin's curator limits, read through the one settings function (rwr-settings-defaults, slot 730).
 *
 * An admin picks a preset in the workbench's Settings; the database stores the preset's values in the shared admin tier and
 * public.setting_get(NULL, key) (slot 400) answers them. A stored value inside its fixed range replaces the env value this service
 * has always used (SHORTLIST_K, NEW_THREAD_MIN_CONFIDENCE, MERGE_FLOOR_DISTANCE, CONFLICT_DISTANCE); NULL - nothing stored, a database
 * without slot 730, any error - keeps the env value. The ranges are the database's own (init-settings-defaults.sql); a value outside
 * them cannot be stored and is ignored here too. A refresh is cached for a few seconds so a burst of filings is one query.
 * Imports nothing, so `deno test` runs it from the OB1 root.
 */
interface QueryClient { queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> }

export interface CuratorLimits {
  shortlistK: number;
  newThreadMinConfidence: number;
  mergeFloorDistance: number;
  conflictDistance: number;
}

export const SPEC = {
  shortlistK: { key: "curator.shortlist_k", min: 2, max: 10, int: true },
  newThreadMinConfidence: { key: "curator.new_thread_min_confidence", min: 0.4, max: 0.8, int: false },
  mergeFloorDistance: { key: "curator.merge_floor_distance", min: 0.25, max: 0.6, int: false },
  conflictDistance: { key: "curator.conflict_distance", min: 0.1, max: 0.4, int: false },
} as const;
type Name = keyof typeof SPEC;
export const LIMIT_KEYS: readonly string[] = Object.values(SPEC).map((s) => s.key);

export function limitValue(name: Name, v: unknown): number | null {
  const s = SPEC[name];
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < s.min || n > s.max) return null;
  if (s.int && n !== Math.trunc(n)) return null;
  return n;
}

export function mergeLimits(env: CuratorLimits, stored: Record<string, unknown>): CuratorLimits {
  const out = { ...env };
  for (const name of Object.keys(SPEC) as Name[]) {
    const v = limitValue(name, stored[SPEC[name].key]);
    if (v !== null) out[name] = v;
  }
  return out;
}

export async function readStoredLimits(client: QueryClient): Promise<Record<string, unknown>> {
  try {
    const r = await client.queryObject<{ k: string; v: unknown }>(
      `SELECT k, public.setting_get(NULL, k) AS v FROM unnest($1::text[]) AS k`, [[...LIMIT_KEYS]],
    );
    return Object.fromEntries(r.rows.filter((x) => x.v !== null && x.v !== undefined).map((x) => [x.k, x.v]));
  } catch (e) {
    console.warn(`limits: setting_get unavailable (${(e as Error).message}); the env values are used`);
    return {};
  }
}

/** The limits in force: `get()` is the last read (the env values until the first refresh); `refresh(client)` re-reads at most every `ttlMs`. */
export function makeLimits(env: CuratorLimits, ttlMs = 5000) {
  let cur = env;
  let at = 0;
  return {
    get: (): CuratorLimits => cur,
    async refresh(client: QueryClient, now = Date.now()): Promise<CuratorLimits> {
      if (at !== 0 && now - at < ttlMs) return cur;
      at = now;
      cur = mergeLimits(env, await readStoredLimits(client));
      return cur;
    },
  };
}
