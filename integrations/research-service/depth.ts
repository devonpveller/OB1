/**
 * Depth presets for a run started from the workbench (rwr-research-start-api): quick | standard | deep, each a
 * budget in TODAY's three research limits (rounds, source fetches, wall time). The effective budget is
 * min(preset, the admin ceiling) per limit - a preset can only ever LOWER a limit, never raise it. The ceilings
 * are the engine's own (MAX_ROUNDS / MAX_FETCH / MAX_WALL_MS from the service's environment, the same values
 * harness.ts reads; compose: RESEARCH_MAX_*), and the engine clamps a job's contract.budget against them again
 * at run time (contract.ts clampCeiling), so a wrong number here still cannot exceed a ceiling.
 * Pure: no I/O.
 */
export type DepthName = "quick" | "standard" | "deep";
export interface Budget { rounds: number; max_fetch: number; wall_ms: number }

/** deep asks for (at least) today's compose ceilings, so on the shipped settings deep = the full limits. */
export const DEPTHS: Record<DepthName, Budget> = {
  quick: { rounds: 1, max_fetch: 12, wall_ms: 300_000 },
  standard: { rounds: 2, max_fetch: 40, wall_ms: 600_000 },
  deep: { rounds: 3, max_fetch: 80, wall_ms: 900_000 },
};

export const DEPTH_NAMES: ReadonlySet<string> = new Set(Object.keys(DEPTHS));

export function resolveDepth(name: DepthName, ceilings: Budget): { name: DepthName; budget: Budget } {
  const p = DEPTHS[name];
  return {
    name,
    budget: {
      rounds: Math.max(1, Math.min(p.rounds, ceilings.rounds)),
      max_fetch: Math.max(1, Math.min(p.max_fetch, ceilings.max_fetch)),
      wall_ms: Math.max(1, Math.min(p.wall_ms, ceilings.wall_ms)),
    },
  };
}

/** The engine's ceilings from the environment, with harness.ts's own defaults (MAX_ROUNDS 3, MAX_FETCH 24,
 *  MAX_WALL_MS 180000). A missing or junk value reads as the default, as parseInt-with-default does there. */
export function runCeilings(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): Budget {
  const n = (k: string, d: number) => {
    const v = parseInt(get(k) ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return { rounds: n("MAX_ROUNDS", 3), max_fetch: n("MAX_FETCH", 24), wall_ms: n("MAX_WALL_MS", 180_000) };
}
