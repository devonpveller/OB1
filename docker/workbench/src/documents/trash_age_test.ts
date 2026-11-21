// deno test src/documents/trash_age_test.ts - the trash's keep-for-30-days rule (rwr-docs-lifecycle-api, Q9)
// and the explicit confirm the irreversible routes need. Pure: the clock is injected.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { confirmed, earlier, expired, TRASH_KEEP_DAYS } from "./trash_age.ts";

const DAY = 86_400_000;
const now = new Date("2026-12-31T00:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

Deno.test("the keep window is 30 days (Q9)", () => assertEquals(TRASH_KEEP_DAYS, 30));

Deno.test("29 days ago survives, 31 days ago is removed, exactly 30 survives (more than 30 days)", () => {
  assertEquals(expired(ago(29), now), false);
  assertEquals(expired(ago(31), now), true);
  assertEquals(expired(ago(30), now), false);
  assertEquals(expired(new Date(ago(30).getTime() - 1), now), true);
});

Deno.test("an unknown trash date is never removed (fails safe)", () => {
  assertEquals(expired(null, now), false);
  assertEquals(expired(new Date("not a date"), now), false);
});

Deno.test("the clock is the injected one: the same trash date, a later now", () => {
  const t = ago(29);
  assertEquals(expired(t, now), false);
  assertEquals(expired(t, new Date(now.getTime() + 2 * DAY)), true);
});

Deno.test("earlier() picks the older known date, ignores the unknown", () => {
  assertEquals(earlier(ago(40), ago(2))?.getTime(), ago(40).getTime());
  assertEquals(earlier(null, ago(2))?.getTime(), ago(2).getTime());
  assertEquals(earlier(null, null), null);
});

Deno.test("confirm must be the boolean true - nothing else counts", () => {
  assert(confirmed({ confirm: true }));
  for (const v of [undefined, false, "true", "yes", 1, "delete forever", null, {}, []]) {
    assertEquals(confirmed({ confirm: v }), false, String(v));
  }
  assertEquals(confirmed({}), false);
});
