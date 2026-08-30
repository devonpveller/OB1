/**
 * agent-memory-ranking - the similarity floor and the recency blend (memory-plane PLAN §3).
 *
 * Pure. No SQL, no clock of its own, no environment reads outside `readRecallTuning` - so
 * every ordering decision here is testable without a database, which is the half that
 * actually goes wrong.
 *
 * TWO THINGS THIS MODULE EXISTS TO GET RIGHT, both named in PLAN §3 and §6:
 *
 * 1. THE EXECUTION SHAPE. Upstream's `recency-boosted-match-thoughts` puts the blended
 *    score in the ORDER BY. A computed ORDER BY cannot use the HNSW index, so it seq-scans
 *    the whole table and then sorts - the cost grows with the corpus, which is exactly the
 *    direction this plane is meant to grow. We take the formula and NOT the shape: the
 *    index scan picks a bounded candidate set by raw distance (`overfetchLimit`), and the
 *    blend re-ranks that set in memory, where it is free.
 *
 * 2. THE NUMBERS ARE NOT INHERITED, AND NOT INVENTED EITHER. Upstream's 0.7 floor was tuned
 *    for text-embedding-3-small; bge-m3 puts related items around 0.4-0.6, so adopting 0.7
 *    would make recall return nothing while every test still passed - "returned nothing" is
 *    the failure that looks exactly like success. The opposite move is no better: picking a
 *    low number because it makes a demo look good is a measurement nobody took.
 *
 *    So the floor is a NAMED, CONFIGURABLE value that is UNSET by default, and the recency
 *    weight defaults to 0 (pure similarity, i.e. the ordering that shipped). The mechanism
 *    is live and proved; the tuning is explicitly outstanding, and what it is waiting for is
 *    a corpus big enough to measure against - see
 *    ai-stack `documentation/notes/agent-memory-recall-threshold.md` for the calibration
 *    procedure. Turning either knob on is a config change, not a code change.
 */

/** How many candidates the index scan takes per requested item, before re-ranking.
 *  4x: enough that recency can genuinely change the answer, small enough that the
 *  in-memory sort stays trivial and one call still cannot drain the store. */
export const RECALL_OVERFETCH = 4;

/** UNCALIBRATED - no floor. See the module docstring; this is deliberate, not a TODO. */
export const RECALL_MIN_SIMILARITY_DEFAULT: number | null = null;

/** UNCALIBRATED - 0 means pure similarity, the ordering that shipped before the blend. */
export const RECALL_RECENCY_WEIGHT_DEFAULT = 0;

/** Only meaningful when the weight is non-zero. 30d is a starting point, not a measurement. */
export const RECALL_HALF_LIFE_DAYS_DEFAULT = 30;

export const ENV_MIN_SIMILARITY = "AGENT_MEMORY_RECALL_MIN_SIMILARITY";
export const ENV_RECENCY_WEIGHT = "AGENT_MEMORY_RECALL_RECENCY_WEIGHT";
export const ENV_HALF_LIFE_DAYS = "AGENT_MEMORY_RECALL_HALF_LIFE_DAYS";

export interface RecallTuning {
  /** Raw-cosine floor, applied in SQL. `null` = no floor. */
  minSimilarity: number | null;
  /** 0..1. 0 = similarity only; 1 = recency only. */
  recencyWeight: number;
  /** Days at which the recency term has decayed to 0.5. Always > 0. */
  halfLifeDays: number;
}

export const DEFAULT_RECALL_TUNING: RecallTuning = {
  minSimilarity: RECALL_MIN_SIMILARITY_DEFAULT,
  recencyWeight: RECALL_RECENCY_WEIGHT_DEFAULT,
  halfLifeDays: RECALL_HALF_LIFE_DAYS_DEFAULT,
};

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Read the tuning from the environment, falling back to the uncalibrated defaults.
 *
 * A malformed value falls back rather than throwing: this runs on the read path of a
 * best-effort enrichment, and a typo'd env var must not take recall down. It CANNOT fall
 * back to something stricter than the default, so a typo can never silently hide memories
 * that would otherwise have been returned - the failure direction is towards the shipped
 * behaviour, not towards a quieter one.
 *
 * A THROWING GETTER FALLS BACK THE SAME WAY, and that is not hypothetical: the offline
 * harness runs `deno test` with no `--allow-env`, so `Deno.env.get` raises NotCapable and
 * every recall that had not been handed an explicit tuning threw instead of recalling. A
 * developer running the same suite locally WITH the flag sees none of it. Reading an
 * optional knob must never be able to fail the operation the knob only tunes.
 */
export function readRecallTuning(
  get: (key: string) => string | undefined,
): RecallTuning {
  let minRaw: number | null, weightRaw: number | null, halfRaw: number | null;
  try {
    minRaw = num(get(ENV_MIN_SIMILARITY));
    weightRaw = num(get(ENV_RECENCY_WEIGHT));
    halfRaw = num(get(ENV_HALF_LIFE_DAYS));
  } catch {
    return { ...DEFAULT_RECALL_TUNING };
  }
  return {
    minSimilarity: minRaw === null ? RECALL_MIN_SIMILARITY_DEFAULT : clamp(minRaw, -1, 1),
    recencyWeight: weightRaw === null ? RECALL_RECENCY_WEIGHT_DEFAULT : clamp(weightRaw, 0, 1),
    halfLifeDays: halfRaw === null || halfRaw <= 0
      ? RECALL_HALF_LIFE_DAYS_DEFAULT
      : halfRaw,
  };
}

/** How many rows the index scan should fetch to give the blend something to re-rank. */
export function overfetchLimit(limit: number, max: number): number {
  return Math.min(Math.max(1, limit) * RECALL_OVERFETCH, max * RECALL_OVERFETCH);
}

/**
 * `sim*(1-w) + exp(-age/half_life)*w`, the upstream formula, with both terms clamped to
 * 0..1 so the blend cannot be gamed by a negative cosine or a future timestamp.
 */
export function blendScore(
  similarity: number,
  ageDays: number,
  tuning: RecallTuning = DEFAULT_RECALL_TUNING,
): number {
  const sim = clamp(Number.isFinite(similarity) ? similarity : 0, 0, 1);
  const w = clamp(tuning.recencyWeight, 0, 1);
  if (w === 0) return sim;
  const age = Math.max(0, Number.isFinite(ageDays) ? ageDays : 0);
  const recency = Math.exp(-age / Math.max(tuning.halfLifeDays, 1e-9));
  return sim * (1 - w) + recency * w;
}

export function ageInDays(createdAt: unknown, nowMs: number): number {
  const t = createdAt instanceof Date
    ? createdAt.getTime()
    : typeof createdAt === "string" || typeof createdAt === "number"
    ? new Date(createdAt).getTime()
    : NaN;
  if (!Number.isFinite(t)) return 0; // unknown age is treated as fresh, never as ancient
  return Math.max(0, (nowMs - t) / 86_400_000);
}

/**
 * Re-rank a candidate set by the blend, highest first. STABLE: equal scores keep the order
 * the index scan produced, so with `recencyWeight = 0` the output is byte-for-byte the
 * distance ordering that shipped before this module existed.
 */
export function rerankByBlend<T extends { similarity?: unknown; created_at?: unknown }>(
  rows: T[],
  tuning: RecallTuning,
  nowMs: number,
): T[] {
  return rows
    .map((row, i) => ({
      row,
      i,
      score: blendScore(Number(row.similarity), ageInDays(row.created_at, nowMs), tuning),
    }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((x) => x.row);
}
