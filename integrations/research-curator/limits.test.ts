// rwr-settings-defaults: the curator reads the admin's limits through the one settings function; env stays the fallback.
// deno test --allow-env limits.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { type CuratorLimits, LIMIT_KEYS, limitValue, makeLimits, mergeLimits } from "./limits.ts";

const ENV: CuratorLimits = { shortlistK: 5, newThreadMinConfidence: 0.6, mergeFloorDistance: 0.45, conflictDistance: 0.25 };
let calls = 0;
const fake = (rows: Record<string, unknown> | Error) => ({
  queryObject: <T>(_s: string, args?: unknown[]) => {
    calls++;
    if (rows instanceof Error) return Promise.reject(rows);
    assertEquals(args, [[...LIMIT_KEYS]]);
    return Promise.resolve({ rows: Object.entries(rows).map(([k, v]) => ({ k, v })) as unknown as T[] });
  },
});

Deno.test("nothing stored: the env values; a stored value replaces its own key only", async () => {
  assertEquals(await makeLimits(ENV).refresh(fake({})), ENV);
  assertEquals(await makeLimits(ENV).refresh(fake({ "curator.shortlist_k": 8, "curator.conflict_distance": 0.32 })), { ...ENV, shortlistK: 8, conflictDistance: 0.32 });
});

Deno.test("a value outside its range, a fraction for a whole-number limit, or a non-number is ignored", () => {
  assertEquals(limitValue("shortlistK", 11), null);
  assertEquals(limitValue("shortlistK", 1), null);
  assertEquals(limitValue("shortlistK", 4.5), null);
  assertEquals(limitValue("newThreadMinConfidence", 0.39), null);
  assertEquals(limitValue("newThreadMinConfidence", "0.7" as unknown), null);
  assertEquals(limitValue("mergeFloorDistance", 0.6), 0.6);
  assertEquals(limitValue("conflictDistance", 0.1), 0.1);
  assertEquals(mergeLimits(ENV, { "curator.shortlist_k": 99, "curator.merge_floor_distance": null }), ENV);
});

Deno.test("an error keeps the env values and never throws; a refresh inside the ttl is not another query", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assertEquals(await makeLimits(ENV).refresh(fake(new Error("function setting_get does not exist"))), ENV);
  } finally { console.warn = warn; }
  calls = 0;
  const l = makeLimits(ENV, 5000);
  await l.refresh(fake({ "curator.shortlist_k": 8 }), 1000);
  await l.refresh(fake({ "curator.shortlist_k": 3 }), 2000);
  assertEquals([calls, l.get().shortlistK], [1, 8]);
  await l.refresh(fake({ "curator.shortlist_k": 3 }), 7000);
  assertEquals([calls, l.get().shortlistK], [2, 3]);
});

Deno.test("the keys read are the four curator keys the admin presets write", () => {
  assertEquals([...LIMIT_KEYS].sort(), ["curator.conflict_distance", "curator.merge_floor_distance", "curator.new_thread_min_confidence", "curator.shortlist_k"]);
});
