/**
 * The admin's research limits, read through the one settings function (rwr-settings-defaults, slot 730).
 *
 * An admin picks a preset in the workbench's Settings; the database stores the preset's key values in the shared admin tier and
 * public.setting_get(NULL, key) (slot 400) answers them. This module reads those values for a run: a stored value (inside its fixed
 * range, a whole number where the limit is one) replaces the env value this service has always used; NULL - nothing stored, a database
 * without slot 730, any error - keeps the env value (the compose default), so nothing changes until an admin chooses.
 *
 * The ranges below are the database's own (init-settings-defaults.sql); a stored value outside them cannot exist (a trigger refuses
 * it) and is ignored here too, so a bad row can never raise a ceiling. Pure except readStoredLimits / runLimits / storedCeilings,
 * which only SELECT.
 */
import type { Budget } from "./depth.ts";

interface QueryClient { queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> }

export interface RunLimits {
  SEARCH_K: number;
  CONFIDENCE_FLOOR: number;
  MAX_FETCH: number;
  MAX_FETCH_TIMEOUTS: number;
  MAX_WALL_MS: number;
  MAX_WALL_MS_OWUI: number;
  KB_SOURCES_K: number;
  REUSE_MAX_DISTANCE: number;
  MAX_ROUNDS: number;
  RELEVANT_TARGET: number;
}

/** limit -> its settings key, its fixed range and whether it is a whole number */
const SPEC = {
  SEARCH_K: { key: "research.search_k", min: 3, max: 16, int: true },
  CONFIDENCE_FLOOR: { key: "research.confidence_floor", min: 0.3, max: 0.8, int: false },
  MAX_FETCH: { key: "research.max_fetch", min: 6, max: 60, int: true },
  MAX_FETCH_TIMEOUTS: { key: "research.max_fetch_timeouts", min: 0, max: 40, int: true },
  MAX_WALL_MS: { key: "research.max_wall_ms", min: 60000, max: 600000, int: true },
  KB_SOURCES_K: { key: "research.kb_sources_k", min: 0, max: 12, int: true },
  REUSE_MAX_DISTANCE: { key: "research.reuse_max_distance", min: 0.3, max: 0.7, int: false },
  MAX_ROUNDS: { key: "research.max_rounds", min: 1, max: 5, int: true },
  RELEVANT_TARGET: { key: "research.relevant_target", min: 3, max: 16, int: true },
} as const;
type Name = keyof typeof SPEC;
export const LIMIT_KEYS: readonly string[] = Object.values(SPEC).map((s) => s.key);

/** A stored value as a limit, or null when it is not one this service may use (not a number, outside the range, not whole). */
export function limitValue(name: Name, v: unknown): number | null {
  const s = SPEC[name];
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < s.min || n > s.max) return null;
  if (s.int && n !== Math.trunc(n)) return null;
  return n;
}

/** The env limits with every stored value laid over them. `owuiExplicit`: MAX_WALL_MS_OWUI was set in the environment, so it stays. */
export function mergeLimits(env: RunLimits, stored: Record<string, unknown>, owuiExplicit: boolean): RunLimits {
  const out: RunLimits = { ...env };
  for (const name of Object.keys(SPEC) as Name[]) {
    const v = limitValue(name, stored[SPEC[name].key]);
    if (v !== null) out[name] = v;
  }
  // the interactive path follows the shared wall time unless its own variable was set
  if (!owuiExplicit) out.MAX_WALL_MS_OWUI = out.MAX_WALL_MS;
  return out;
}

/** The admin's stored values by key (only the research limits), through the one function. Never throws: {} keeps the env values. */
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

export async function runLimits(client: QueryClient, env: RunLimits, owuiExplicit: boolean): Promise<RunLimits> {
  return mergeLimits(env, await readStoredLimits(client), owuiExplicit);
}

/** The start door's ceilings (rounds, pages, wall time): the env ones with the admin's stored values laid over them. */
export async function storedCeilings(client: QueryClient, env: Budget): Promise<Budget> {
  const s = await readStoredLimits(client);
  return {
    rounds: limitValue("MAX_ROUNDS", s[SPEC.MAX_ROUNDS.key]) ?? env.rounds,
    max_fetch: limitValue("MAX_FETCH", s[SPEC.MAX_FETCH.key]) ?? env.max_fetch,
    wall_ms: limitValue("MAX_WALL_MS", s[SPEC.MAX_WALL_MS.key]) ?? env.wall_ms,
  };
}
