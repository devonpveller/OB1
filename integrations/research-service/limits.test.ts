// rwr-settings-defaults: the research service reads the admin's limits through the one settings function; env stays the fallback.
// deno test --allow-env limits.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { LIMIT_KEYS, limitValue, mergeLimits, readStoredLimits, runLimits, storedCeilings, type RunLimits } from "./limits.ts";

const ENV: RunLimits = {
  SEARCH_K: 8, CONFIDENCE_FLOOR: 0.5, MAX_FETCH: 24, MAX_FETCH_TIMEOUTS: 20, MAX_WALL_MS: 180000, MAX_WALL_MS_OWUI: 180000,
  KB_SOURCES_K: 6, REUSE_MAX_DISTANCE: 0.55, MAX_ROUNDS: 3, RELEVANT_TARGET: 8,
};
const fake = (rows: Record<string, unknown> | Error) => ({
  queryObject: <T>(_sql: string, args?: unknown[]) => {
    if (rows instanceof Error) return Promise.reject(rows);
    assertEquals(args, [[...LIMIT_KEYS]]);
    return Promise.resolve({ rows: Object.entries(rows).map(([k, v]) => ({ k, v })) as unknown as T[] });
  },
});

Deno.test("nothing stored: every limit is the env value", async () => {
  assertEquals(await runLimits(fake({}), ENV, false), ENV);
});

Deno.test("a stored value replaces the env value, key by key; the others keep theirs", async () => {
  const got = await runLimits(fake({ "research.max_fetch": 12, "research.confidence_floor": 0.65, "research.max_rounds": 2 }), ENV, false);
  assertEquals([got.MAX_FETCH, got.CONFIDENCE_FLOOR, got.MAX_ROUNDS], [12, 0.65, 2]);
  assertEquals([got.SEARCH_K, got.MAX_WALL_MS, got.RELEVANT_TARGET, got.KB_SOURCES_K], [8, 180000, 8, 6]);
});

Deno.test("a stored value outside its range, not whole, or not a number is ignored: a bad row can never raise a ceiling", () => {
  for (const [k, bad] of [["MAX_FETCH", 161], ["MAX_FETCH", 5], ["MAX_FETCH", 24.5], ["MAX_FETCH", "30"], ["MAX_FETCH", null], ["MAX_FETCH", NaN],
    ["CONFIDENCE_FLOOR", 0.29], ["CONFIDENCE_FLOOR", 0.81], ["MAX_ROUNDS", 6], ["MAX_ROUNDS", 0], ["MAX_WALL_MS", 599999.5], ["KB_SOURCES_K", -1]] as const) {
    assertEquals(limitValue(k, bad), null, `${k}=${bad}`);
  }
  assertEquals(limitValue("MAX_FETCH", 160), 160);
  assertEquals(limitValue("MAX_FETCH", 6), 6);
  assertEquals(limitValue("KB_SOURCES_K", 0), 0);
  assertEquals(limitValue("MAX_FETCH_TIMEOUTS", 0), 0);
  assertEquals(limitValue("CONFIDENCE_FLOOR", 0.3), 0.3);
  const got = mergeLimits(ENV, { "research.max_fetch": 5000, "research.max_rounds": "9" }, false);
  assertEquals([got.MAX_FETCH, got.MAX_ROUNDS], [24, 3]);
});

Deno.test("the interactive wall time follows the shared one unless its own variable was set", () => {
  assertEquals(mergeLimits(ENV, { "research.max_wall_ms": 120000 }, false).MAX_WALL_MS_OWUI, 120000);
  assertEquals(mergeLimits({ ...ENV, MAX_WALL_MS_OWUI: 900000 }, { "research.max_wall_ms": 120000 }, true).MAX_WALL_MS_OWUI, 900000);
});

Deno.test("a database without the function, or any error: the env values (never throws)", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assertEquals(await readStoredLimits(fake(new Error("function public.setting_get does not exist"))), {});
    assertEquals(await runLimits(fake(new Error("down")), ENV, false), ENV);
  } finally { console.warn = warn; }
});

Deno.test("the start door's ceilings take the stored pages, rounds and wall time, else the env ones", async () => {
  const env = { rounds: 3, max_fetch: 24, wall_ms: 180000 };
  assertEquals(await storedCeilings(fake({ "research.max_fetch": 12, "research.max_rounds": 2, "research.max_wall_ms": 120000 }), env), { rounds: 2, max_fetch: 12, wall_ms: 120000 });
  assertEquals(await storedCeilings(fake({}), env), env);
  assertEquals(await storedCeilings(fake({ "research.max_fetch": 999 }), env), env);
});

Deno.test("the keys read are the nine research keys the admin presets write (and no curator key)", () => {
  assertEquals([...LIMIT_KEYS].sort(), ["research.confidence_floor", "research.kb_sources_k", "research.max_fetch", "research.max_fetch_timeouts", "research.max_rounds",
    "research.max_wall_ms", "research.relevant_target", "research.reuse_max_distance", "research.search_k"]);
  assert(LIMIT_KEYS.every((k) => k.startsWith("research.")));
});
