/** Tests for the recall floor + recency blend, and for the SHAPE the recall SQL uses.
 *
 * Run: deno test agent-memory-ranking.test.ts
 *
 * The pure half is cheap. The half that matters is the second group: the formula being
 * right is worth nothing if `performRecall` still puts a computed expression in its
 * ORDER BY, or applies the floor in TypeScript where a second door could skip it.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ageInDays,
  blendScore,
  DEFAULT_RECALL_TUNING,
  ENV_HALF_LIFE_DAYS,
  ENV_MIN_SIMILARITY,
  ENV_RECENCY_WEIGHT,
  overfetchLimit,
  RECALL_MIN_SIMILARITY_DEFAULT,
  RECALL_OVERFETCH,
  RECALL_RECENCY_WEIGHT_DEFAULT,
  readRecallTuning,
  rerankByBlend,
} from "./agent-memory-ranking.ts";
import { performRecall, RECALL_MAX_LIMIT, type AgentMemoryDeps } from "./agent-memory.ts";

// ── the numbers are declared uncalibrated, and that is asserted ──────────────
Deno.test("the floor and the recency weight ship UNSET, not inherited and not invented", () => {
  // Upstream's 0.7 was tuned for a different embedding model; adopting it would make recall
  // return nothing against bge-m3 while every test still passed. Picking a low number to
  // make a demo look good is the same mistake facing the other way. Both stay unset until
  // there is a corpus to measure against.
  assertEquals(RECALL_MIN_SIMILARITY_DEFAULT, null);
  assertEquals(RECALL_RECENCY_WEIGHT_DEFAULT, 0);
  assertEquals(DEFAULT_RECALL_TUNING.minSimilarity, null);
});

Deno.test("tuning comes from the environment, so calibration is config not code", () => {
  const env: Record<string, string> = {
    [ENV_MIN_SIMILARITY]: "0.45",
    [ENV_RECENCY_WEIGHT]: "0.3",
    [ENV_HALF_LIFE_DAYS]: "14",
  };
  const t = readRecallTuning((k) => env[k]);
  assertEquals(t.minSimilarity, 0.45);
  assertEquals(t.recencyWeight, 0.3);
  assertEquals(t.halfLifeDays, 14);
});

Deno.test("a getter that THROWS falls back too - a tuning read cannot fail a recall", () => {
  // Not hypothetical. The offline harness runs `deno test` with no --allow-env, so
  // Deno.env.get raises NotCapable; before this guard every recall that was not handed an
  // explicit tuning threw instead of recalling, and a local run WITH the flag saw none of
  // it. Reading an optional knob must never fail the operation the knob only tunes.
  const t = readRecallTuning(() => {
    throw new Error('Requires env access to "AGENT_MEMORY_RECALL_MIN_SIMILARITY"');
  });
  assertEquals(t.minSimilarity, null);
  assertEquals(t.recencyWeight, 0);
  assertEquals(t.halfLifeDays, DEFAULT_RECALL_TUNING.halfLifeDays);
});

Deno.test("a malformed tuning value falls back to the SHIPPED behaviour, never stricter", () => {
  // A typo must not silently hide memories that would otherwise be returned. The fallback
  // direction is the one that fails towards visibility.
  const env: Record<string, string> = {
    [ENV_MIN_SIMILARITY]: "very-relevant-please",
    [ENV_RECENCY_WEIGHT]: "-3",
    [ENV_HALF_LIFE_DAYS]: "0",
  };
  const t = readRecallTuning((k) => env[k]);
  assertEquals(t.minSimilarity, null, "a typo'd floor must not become a floor");
  assertEquals(t.recencyWeight, 0);
  assert(t.halfLifeDays > 0);
});

// ── the blend ────────────────────────────────────────────────────────────────
Deno.test("weight 0 is pure similarity, byte-for-byte the ordering that shipped", () => {
  const rows = [
    { id: "a", similarity: 0.9, created_at: "2020-01-01T00:00:00Z" },
    { id: "b", similarity: 0.5, created_at: "2026-08-30T00:00:00Z" },
  ];
  const out = rerankByBlend(rows, DEFAULT_RECALL_TUNING, Date.parse("2026-08-30T00:00:00Z"));
  assertEquals(out.map((r) => r.id), ["a", "b"], "an ancient better match still wins at w=0");
});

Deno.test("with weight on, a fresher near-match overtakes a stale better one", () => {
  // The whole point of the blend, and the assertion that proves it is wired: the ORDER
  // CHANGES. A test that only checked 'no crash' would pass on a no-op implementation.
  const now = Date.parse("2026-08-30T00:00:00Z");
  const rows = [
    { id: "stale", similarity: 0.80, created_at: "2024-08-30T00:00:00Z" },
    { id: "fresh", similarity: 0.70, created_at: "2026-08-29T00:00:00Z" },
  ];
  assertEquals(rerankByBlend(rows, DEFAULT_RECALL_TUNING, now).map((r) => r.id),
    ["stale", "fresh"]);
  const tuned = { minSimilarity: null, recencyWeight: 0.5, halfLifeDays: 30 };
  assertEquals(rerankByBlend(rows, tuned, now).map((r) => r.id), ["fresh", "stale"]);
});

Deno.test("the blend is the upstream formula, checked against hand-computed values", () => {
  const t = { minSimilarity: null, recencyWeight: 0.5, halfLifeDays: 30 };
  assertEquals(blendScore(1, 0, t), 1);                      // perfect + brand new
  assertEquals(blendScore(0, 0, t), 0.5);                    // irrelevant + brand new
  const aged = blendScore(0.6, 30, t);
  assert(Math.abs(aged - (0.6 * 0.5 + Math.exp(-1) * 0.5)) < 1e-12);
});

Deno.test("a negative cosine or a future timestamp cannot game the score", () => {
  const t = { minSimilarity: null, recencyWeight: 0.5, halfLifeDays: 30 };
  assertEquals(blendScore(-0.9, 0, t), 0.5, "a negative cosine clamps to 0, not below");
  assertEquals(ageInDays("2999-01-01T00:00:00Z", Date.now()), 0, "the future is not negative age");
  assertEquals(ageInDays(undefined, Date.now()), 0, "unknown age is fresh, never ancient");
});

Deno.test("re-ranking is STABLE, so equal scores keep the index scan's order", () => {
  const rows = [{ id: "a", similarity: 0.5 }, { id: "b", similarity: 0.5 },
    { id: "c", similarity: 0.5 }];
  assertEquals(rerankByBlend(rows, DEFAULT_RECALL_TUNING, Date.now()).map((r) => r.id),
    ["a", "b", "c"]);
});

Deno.test("the candidate set is bounded, so overfetch cannot drain the store", () => {
  assertEquals(overfetchLimit(8, RECALL_MAX_LIMIT), 8 * RECALL_OVERFETCH);
  assertEquals(overfetchLimit(9999, RECALL_MAX_LIMIT), RECALL_MAX_LIMIT * RECALL_OVERFETCH);
});

// ── the shape performRecall actually executes ───────────────────────────────
function recallDeps(rows: Array<Record<string, unknown>>, tuning?: unknown) {
  const seen: string[] = [];
  const params: unknown[][] = [];
  const deps = {
    recallTuning: tuning,
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (sql: string, args?: unknown[]) => {
            seen.push(sql);
            params.push(args ?? []);
            if (sql.includes("FROM agent_memories am")) return Promise.resolve({ rows });
            if (sql.includes("agent_memory_recall_traces")) {
              return Promise.resolve({ rows: [{ id: "trace-1" }] });
            }
            return Promise.resolve({ rows: [] });
          },
          release: () => {},
        }),
    },
    getEmbedding: () => Promise.resolve([0.1, 0.2]),
    authed: () => true,
  } as unknown as AgentMemoryDeps;
  return { deps, seen, params };
}

function row(id: string, similarity: number, created_at: string) {
  return {
    id, summary: id, content: id, memory_type: "lesson", visibility: "workspace",
    review_status: "evidence_only", can_use_as_evidence: true,
    can_use_as_instruction: false, requires_user_confirmation: true,
    similarity, created_at,
  };
}

Deno.test("SEAM: the index scan orders by RAW DISTANCE, never by a computed score", async () => {
  // The upstream trap. A computed ORDER BY cannot use the HNSW index, so it seq-scans the
  // table - the cost grows with the corpus, which is the direction this plane grows.
  const { deps, seen } = recallDeps([row("a", 0.9, "2026-08-01T00:00:00Z")],
    { minSimilarity: null, recencyWeight: 0.5, halfLifeDays: 30 });
  await performRecall(deps, { workspace_id: "ws1", query: "q" });
  const sql = seen.find((s) => s.includes("FROM agent_memories am"))!;
  const order = sql.slice(sql.indexOf("ORDER BY"));
  assert(order.includes("t.embedding <=> $1::vector"), "the scan must order by the operator");
  assert(!/ORDER BY[^)]*exp\(/i.test(sql), "no decay expression may reach the ORDER BY");
  assert(!/ORDER BY[^)]*similarity\s*\*/i.test(sql), "no blend may reach the ORDER BY");
});

Deno.test("SEAM: it is TWO PHASE - the scan overfetches, the caller gets `limit`", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`m${i}`, 0.9 - i / 100, "2026-08-01T00:00:00Z"));
  const { deps, seen } = recallDeps(rows);
  const out = await performRecall(deps, { workspace_id: "ws1", query: "q", limit: 3 });
  const sql = seen.find((s) => s.includes("FROM agent_memories am"))!;
  assert(sql.includes(`LIMIT ${overfetchLimit(3, RECALL_MAX_LIMIT)}`),
    "the scan must take a candidate set, not just the answer");
  assertEquals(out.items.length, 3, "the caller must still get exactly what it asked for");
});

Deno.test("SEAM: the clamp survives the overfetch - one call cannot drain the corpus", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => row(`m${i}`, 0.5, "2026-08-01T00:00:00Z"));
  const { deps, seen } = recallDeps(rows);
  const out = await performRecall(deps, { workspace_id: "ws1", query: "q", limit: 9999 });
  assertEquals(out.items.length, RECALL_MAX_LIMIT);
  const sql = seen.find((s) => s.includes("FROM agent_memories am"))!;
  assert(sql.includes(`LIMIT ${RECALL_MAX_LIMIT * RECALL_OVERFETCH}`));
});

Deno.test("SEAM: the floor lives in the SQL, so no door can opt out of it", async () => {
  // In the client it would be a per-caller policy decision made in the wrong place: a
  // second door could simply not send it. In the SQL every caller gets it.
  const { deps, seen, params } = recallDeps([row("a", 0.9, "2026-08-01T00:00:00Z")],
    { minSimilarity: 0.42, recencyWeight: 0, halfLifeDays: 30 });
  await performRecall(deps, { workspace_id: "ws1", query: "q" });
  const sql = seen.find((s) => s.includes("FROM agent_memories am"))!;
  assert(/similarity\s*>=\s*\$\d+/.test(sql), "the floor must be a SQL predicate");
  assert(!sql.includes("0.42"), "…and a PARAMETER, never interpolated");
  const p = params.find((x) => x.length > 1)!;
  assert(p.includes(0.42), "the floor value must be bound");
});

Deno.test("SEAM: with no floor configured there is no floor predicate at all", async () => {
  const { deps, seen } = recallDeps([row("a", 0.9, "2026-08-01T00:00:00Z")]);
  await performRecall(deps, { workspace_id: "ws1", query: "q" });
  const sql = seen.find((s) => s.includes("FROM agent_memories am"))!;
  assert(!/similarity\s*>=/.test(sql), "an unset floor must not become a floor");
});

Deno.test("SEAM: the blend actually reorders what the caller receives", async () => {
  // The end-to-end version of the pure test above. It fails on a no-op implementation that
  // computes the score and returns the rows in scan order anyway.
  const rows = [row("stale", 0.80, "2024-08-30T00:00:00Z"),
    row("fresh", 0.70, new Date().toISOString())];
  const off = recallDeps(rows);
  assertEquals((await performRecall(off.deps, { workspace_id: "ws1", query: "q" }))
    .items.map((i) => i.memory_id), ["stale", "fresh"]);
  const on = recallDeps(rows, { minSimilarity: null, recencyWeight: 0.5, halfLifeDays: 30 });
  assertEquals((await performRecall(on.deps, { workspace_id: "ws1", query: "q" }))
    .items.map((i) => i.memory_id), ["fresh", "stale"]);
});

Deno.test("the trace records the tuning that produced the result", async () => {
  // Otherwise 'why did that recall return that' is unanswerable after a config change: the
  // trace would record the query and the rows and omit the thing that ranked them.
  const { deps, params } = recallDeps([row("a", 0.9, "2026-08-01T00:00:00Z")],
    { minSimilarity: 0.3, recencyWeight: 0.25, halfLifeDays: 7 });
  await performRecall(deps, { workspace_id: "ws1", query: "q" });
  const payloads = params.flat().filter((p) => typeof p === "string" && p.startsWith("{"));
  const merged = payloads.join(" ");
  assert(merged.includes("0.3") && merged.includes("0.25") && merged.includes("7"),
    "the recall trace must carry the tuning it ran under");
});
