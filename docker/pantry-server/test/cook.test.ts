import { assert, assertEquals } from "@std/assert";
import { admin, adminExec, close, counts, FORCE_FAIL_FN, get, near, post, qty, seedItems, seedRecipe, test } from "./helpers.ts";

async function kitchen() {
  const ids = await seedItems([
    { name: "Rice", quantity: 1000, unit: "g" },
    { name: "Chicken breast", quantity: 800, unit: "g" },
    { name: "Onion", quantity: 6, unit: "count" },
    { name: "Peanuts", quantity: 200, unit: "g", allergens: ["peanut"] },
    { name: "Salt", kind: "staple", level: "plenty" },
  ]);
  const recipe = await seedRecipe({
    name: "Chicken rice", servings: 4,
    ingredients: [
      { pantry_item_id: ids["Rice"], name: "Rice", quantity: 400, unit: "g" },
      { name: "Chicken breast", quantity: 0.6, unit: "kg" },
      { name: "Onion", quantity: 2 },
      { name: "Salt", quantity: 1, unit: "tsp", staple: true },
    ],
  });
  return { ids, recipe };
}

test("cook: scaled deductions, ledger row per deduction summing to the change, staples untouched, event recorded", async () => {
  const { ids, recipe } = await kitchen();
  const r = await post("/cook", { recipe_id: recipe, servings: 2 });
  assertEquals(r.status, 201);
  const by = Object.fromEntries(r.json.deductions.map((d: { name: string }) => [d.name, d]));
  assertEquals(by["Rice"].delta, -200);
  assertEquals(by["Rice"].before, 1000);
  assertEquals(by["Rice"].after, 800);
  assertEquals(by["Chicken breast"].delta, -300); // 0.6 kg x 0.5, converted kg -> g
  assertEquals(by["Onion"].delta, -1);
  assertEquals(r.json.deductions.length, 3); // salt is a staple
  assertEquals(r.json.shortfalls, []);
  assertEquals(await qty("Rice"), 800);
  assertEquals((await admin(`SELECT level FROM pantry_items WHERE name='Salt'`))[0].level, "plenty");
  const led = await admin(`SELECT item_id, sum(delta)::float8 AS s, count(*)::int AS n FROM pantry_adjustments WHERE cook_event_id=$1 GROUP BY item_id`, [r.json.cook_event_id]);
  assertEquals(led.length, 3);
  for (const l of led) assertEquals(l.n, 1);
  assertEquals(led.find((l) => l.item_id === ids["Rice"])!.s, -200);
  const ev = (await admin(`SELECT recipe_revision, servings::float8 AS s, logged_after FROM pantry_cook_events WHERE id=$1`, [r.json.cook_event_id]))[0];
  assertEquals(ev, { recipe_revision: 1, s: 2, logged_after: false });
});

test("cook: no servings -> household portions (2 adults + 1 child = 2.5) and guest portions are added", async () => {
  const { recipe } = await kitchen();
  const a = await post("/cook", { recipe_id: recipe });
  near(a.json.deductions.find((d: { name: string }) => d.name === "Rice").delta, -250); // 400 x 2.5/4
  await adminExec(`UPDATE pantry_items SET quantity = 1000 WHERE name='Rice'`);
  // with two real people (adult + child) = 1.5, plus guests 2 adults = 3.5
  await post("/people", { label: "A", role: "adult" });
  await post("/people", { label: "C", role: "child" });
  const b = await post("/cook", { recipe_id: recipe, guest_context: { adults: 2 } });
  near(b.json.deductions.find((d: { name: string }) => d.name === "Rice").delta, -350);
});

test("cook: ONE transaction - a failure after some deductions writes NOTHING (ledger trigger)", async () => {
  const { recipe } = await kitchen();
  const before = await counts();
  await adminExec(FORCE_FAIL_FN + `
    CREATE OR REPLACE FUNCTION t_boom2() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF (SELECT count(*) FROM pantry_adjustments WHERE reason='cook') >= 1 THEN RAISE EXCEPTION 'forced mid-transaction failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER t_force_fail_adj BEFORE INSERT ON pantry_adjustments FOR EACH ROW EXECUTE FUNCTION t_boom2();`);
  const r = await post("/cook", { recipe_id: recipe, servings: 4 });
  assertEquals(r.status, 500);
  assertEquals(r.json.error, "internal");
  await adminExec(`DROP TRIGGER t_force_fail_adj ON pantry_adjustments`);
  assertEquals(await counts(), before);
  assertEquals(await qty("Rice"), 1000);
  assertEquals(await qty("Onion"), 6);
});

test("cook: failure at the LAST step (plan row update) also rolls back every deduction, ledger row and the event", async () => {
  const { recipe } = await kitchen();
  const plan = await post("/plan", { date: "2026-10-06", recipe_id: recipe, servings: 4 });
  const before = await counts();
  await adminExec(FORCE_FAIL_FN + `CREATE TRIGGER t_force_fail_plan BEFORE UPDATE ON meal_plans FOR EACH ROW EXECUTE FUNCTION t_boom();`);
  const r = await post("/cook", { recipe_id: recipe, servings: 4, meal_plan_id: plan.json.plan.id });
  assertEquals(r.status, 500);
  await adminExec(`DROP TRIGGER t_force_fail_plan ON meal_plans`);
  assertEquals(await counts(), before);
  assertEquals((await admin(`SELECT status FROM meal_plans`))[0].status, "planned");
  assertEquals(await qty("Chicken breast"), 800);
});

test("cook: allergen 409 for a household member AND for guest_context, nothing written", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 1000, unit: "g" }, { name: "Peanuts", quantity: 200, unit: "g", allergens: ["peanut"] }]);
  const recipe = await seedRecipe({ name: "Satay rice", ingredients: [
    { pantry_item_id: ids["Rice"], name: "Rice", quantity: 200, unit: "g" },
    { pantry_item_id: ids["Peanuts"], name: "Peanuts", quantity: 100, unit: "g" },
  ] });
  const before = await counts();
  // guest first: nobody in the household is allergic
  const g = await post("/cook", { recipe_id: recipe, servings: 4, guest_context: { adults: 1, allergies: ["PEANUT"] } });
  assertEquals(g.status, 409);
  assertEquals(g.json.error, "allergen_conflict");
  assertEquals(g.json.conflicts, [{ ingredient: "Peanuts", allergen: "peanut", who: "guest" }]);
  assertEquals(await counts(), before);
  // inactive member: ignored
  const p = await post("/people", { label: "Gran", role: "adult", allergies: ["peanut"], active: false });
  assertEquals((await post("/cook", { recipe_id: recipe, servings: 4, guest_context: { allergies: ["shellfish"] } })).status, 201);
  await adminExec(`UPDATE pantry_items SET quantity = 1000 WHERE name='Rice'; UPDATE pantry_items SET quantity=200 WHERE name='Peanuts'`);
  // active household member
  await post("/people", { id: p.json.id, label: "Gran", role: "adult", allergies: ["peanut"], active: true });
  const mid = await counts();
  const h = await post("/cook", { recipe_id: recipe, servings: 4 });
  assertEquals(h.status, 409);
  assertEquals(h.json.conflicts, [{ ingredient: "Peanuts", allergen: "peanut", who: "Gran" }]);
  assertEquals(await counts(), { ...mid });
  assertEquals(await qty("Peanuts"), 200);
});

test("cook: shortfall floors stock at 0 and is reported; unconvertible and unmatched lines are returned, not written", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 100, unit: "g" }, { name: "Onion", quantity: 3, unit: "count" }]);
  const recipe = await seedRecipe({ name: "R", ingredients: [
    { pantry_item_id: ids["Rice"], name: "Rice", quantity: 400, unit: "g" },
    { pantry_item_id: ids["Onion"], name: "Onion", quantity: 200, unit: "g" },
    { name: "Leeks", quantity: 2, unit: "count" },
  ] });
  const r = await post("/cook", { recipe_id: recipe, servings: 4 });
  assertEquals(r.status, 201);
  assertEquals(r.json.deductions, [{ item_id: ids["Rice"], name: "Rice", before: 100, after: 0, delta: -100, unit: "g" }]);
  assertEquals(r.json.shortfalls, [{ name: "Rice", item_id: ids["Rice"], needed: 400, available: 100, unit: "g" }]);
  assertEquals(r.json.unconvertible.length, 1);
  assertEquals(r.json.unconvertible[0].name, "Onion");
  assertEquals(r.json.unmatched[0].name, "Leeks");
  assertEquals(await qty("Onion"), 3);
  assertEquals(await qty("Rice"), 0);
});

test("undo restores every item exactly; a second undo is 409; correct adjusts to the actual quantity", async () => {
  const { recipe } = await kitchen();
  const snap = async () => (await admin(`SELECT name, quantity::float8 AS q FROM pantry_items ORDER BY name`));
  const start = await snap();
  const c = await post("/cook", { recipe_id: recipe, servings: 3 });
  const id = c.json.cook_event_id;
  const rice = c.json.deductions.find((d: { name: string }) => d.name === "Rice");
  // actual use was 500 g, not 300 g
  const fix = await post(`/cook/${id}/correct`, { adjustments: [{ item_id: rice.item_id, actual_used: 0.5, unit: "kg" }] });
  assertEquals(fix.status, 200);
  assertEquals(fix.json.deductions[0].delta, -200);
  assertEquals(await qty("Rice"), 500);
  const bad = await post(`/cook/${id}/correct`, { adjustments: [{ item_id: rice.item_id, actual_used: 5, unit: "ml" }] });
  assertEquals(bad.json.unconvertible.length, 1);
  assertEquals(await qty("Rice"), 500);

  const u = await post(`/cook/${id}/correct`, { undo: true });
  assertEquals(u.status, 200);
  assertEquals(await snap(), start);
  const sum = await admin(`SELECT coalesce(sum(delta),0)::float8 AS s FROM pantry_adjustments WHERE cook_event_id=$1`, [id]);
  assertEquals(sum[0].s, 0);
  assert((await admin(`SELECT undone_at FROM pantry_cook_events WHERE id=$1`, [id]))[0].undone_at);
  const again = await post(`/cook/${id}/correct`, { undo: true });
  assertEquals(again.status, 409);
  assertEquals(again.json.error, "already_undone");
  assertEquals(await snap(), start);
  assertEquals((await post(`/cook/${id}/correct`, { adjustments: [] })).status, 400);
  assertEquals((await post(`/cook/44444444-4444-4444-4444-444444444444/correct`, { undo: true })).status, 404);
});

test("cook of a planned row marks it cooked; undo puts it back to planned; logged_after is recorded", async () => {
  const { recipe } = await kitchen();
  const p = await post("/plan", { date: "2026-10-06", recipe_id: recipe, servings: 4 });
  const c = await post("/cook", { recipe_id: recipe, meal_plan_id: p.json.plan.id });
  assertEquals(c.status, 201);
  assertEquals((await admin(`SELECT status FROM meal_plans`))[0].status, "cooked");
  assertEquals((await post("/cook", { recipe_id: recipe, meal_plan_id: p.json.plan.id })).status, 409);
  assertEquals((await post(`/plan/${p.json.plan.id}/status`, { status: "skipped" })).status, 409);
  await post(`/cook/${c.json.cook_event_id}/correct`, { undo: true });
  assertEquals((await admin(`SELECT status FROM meal_plans`))[0].status, "planned");
  const l = await post("/cook", { recipe_id: recipe, servings: 1, logged_after: true, cooked_at: "2026-10-01T18:00:00Z" });
  const ev = (await admin(`SELECT logged_after, cooked_at FROM pantry_cook_events WHERE id=$1`, [l.json.cook_event_id]))[0];
  assertEquals(ev.logged_after, true);
  assertEquals(new Date(ev.cooked_at).toISOString(), "2026-10-01T18:00:00.000Z");
});

test("reservations: two planned dinners sharing an item reduce `available` for the second; skipped releases it", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 500, unit: "g" }, { name: "Chicken breast", quantity: 800, unit: "g" }]);
  const r = await seedRecipe({ name: "R", ingredients: [
    { pantry_item_id: ids["Rice"], name: "Rice", quantity: 300, unit: "g" },
    { pantry_item_id: ids["Chicken breast"], name: "Chicken breast", quantity: 400, unit: "g" },
  ] });
  const mon = await post("/plan", { date: "2026-10-05", recipe_id: r, servings: 4 });
  assertEquals(mon.status, 201);
  assertEquals(mon.json.plan.status, "planned");
  assertEquals(mon.json.shortfalls, []);
  const monRice = mon.json.reservations.find((x: { name: string }) => x.name === "Rice");
  assertEquals([monRice.reserved, monRice.available_before], [300, 500]);
  const tue = await post("/plan", { date: "2026-10-06", recipe_id: r, servings: 4 });
  const tueRice = tue.json.reservations.find((x: { name: string }) => x.name === "Rice");
  assertEquals([tueRice.reserved, tueRice.available_before], [300, 200]);
  assertEquals(tue.json.shortfalls, [{ name: "Rice", item_id: ids["Rice"], needed: 300, available: 200, unit: "g" }]);

  const p = (await get("/pantry")).json.items.find((i: { name: string }) => i.name === "Rice");
  assertEquals([p.quantity, p.reserved, p.available], [500, 600, -100]);
  const view = (await admin(`SELECT reserved::float8 AS r, available::float8 AS a FROM pantry_available WHERE name='Rice'`))[0];
  assertEquals(view, { r: 600, a: -100 }); // the SQL view agrees with the service

  const week = await get("/plan?week_start=2026-10-05");
  assertEquals(week.json.plans.length, 2);
  assertEquals(week.json.plans[0].shortfalls_now, []);
  assertEquals(week.json.plans[1].shortfalls_now.length, 1);
  assertEquals((await get("/plan?date=2026-10-06")).json.plans.length, 1);

  const sk = await post(`/plan/${tue.json.plan.id}/status`, { status: "skipped" });
  assertEquals(sk.status, 200);
  assertEquals(sk.json.status, "skipped");
  const p2 = (await get("/pantry")).json.items.find((i: { name: string }) => i.name === "Rice");
  assertEquals([p2.reserved, p2.available], [300, 200]); // the reservation was released
  assertEquals((await get("/plan?date=2026-10-06")).json.plans[0].shortfalls_now, []);
  await post(`/plan/${tue.json.plan.id}/status`, { status: "planned" });
  assertEquals((await get("/pantry")).json.items.find((i: { name: string }) => i.name === "Rice").reserved, 600);
  assertEquals((await post(`/plan/${tue.json.plan.id}/status`, { status: "cooked" })).status, 400);
  assertEquals((await post(`/plan/44444444-4444-4444-4444-444444444444/status`, { status: "skipped" })).status, 404);
});

test("plan: exactly one of recipe_id/custom_meal/leftovers_of; custom and leftovers reserve nothing; guest servings", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 1000, unit: "g" }]);
  const r = await seedRecipe({ name: "R", ingredients: [{ pantry_item_id: ids["Rice"], name: "Rice", quantity: 400, unit: "g" }] });
  assertEquals((await post("/plan", { date: "2026-10-06" })).status, 400);
  assertEquals((await post("/plan", { date: "2026-10-06", recipe_id: r, custom_meal: "x" })).status, 400);
  assertEquals((await post("/plan", { date: "nope", custom_meal: "x" })).status, 400);
  assertEquals((await post("/plan", { date: "2026-10-06", recipe_id: "44444444-4444-4444-4444-444444444444" })).status, 404);
  const a = await post("/plan", { date: "2026-10-06", recipe_id: r, guest_context: { adults: 1 } });
  assertEquals(a.json.plan.servings, 3.5); // 2.5 household default + 1 guest adult
  assertEquals(a.json.reservations[0].reserved, 350);
  const c = await post("/plan", { date: "2026-10-07", custom_meal: "Eating out" });
  assertEquals(c.json.reservations, []);
  const l = await post("/plan", { date: "2026-10-08", leftovers_of: a.json.plan.id });
  assertEquals(l.json.reservations, []);
  assertEquals((await get("/pantry")).json.items[0].reserved, 350);
});

test("shopping list: only the NET shortfall plus staples at low/out; nothing double counted or ignored", async () => {
  const ids = await seedItems([
    { name: "Rice", quantity: 500, unit: "g" }, { name: "Chicken breast", quantity: 800, unit: "g" },
    { name: "Salt", kind: "staple", level: "plenty" }, { name: "Soy sauce", kind: "staple", level: "low" },
    { name: "Oil", kind: "staple", level: "out" },
  ]);
  const r = await seedRecipe({ name: "R", ingredients: [
    { pantry_item_id: ids["Rice"], name: "Rice", quantity: 300, unit: "g" },
    { pantry_item_id: ids["Chicken breast"], name: "Chicken breast", quantity: 400, unit: "g" },
    { name: "Leeks", quantity: 2, unit: "count" },
  ] });
  await post("/plan", { date: "2026-10-05", recipe_id: r, servings: 4 });
  const tue = await post("/plan", { date: "2026-10-06", recipe_id: r, servings: 4 });
  await post("/plan", { date: "2026-10-20", recipe_id: r, servings: 4 }); // another week: not on this list
  const l = await post("/shopping-list", { week_start: "2026-10-05" });
  assertEquals(l.status, 201);
  const by = Object.fromEntries(l.json.items.map((i: { name: string }) => [i.name, i]));
  assertEquals(Object.keys(by).sort(), ["Leeks", "Oil", "Rice", "Soy sauce"]);
  assertEquals(by["Rice"].quantity, 100); // 600 reserved over two nights - 500 on hand
  assertEquals(by["Rice"].reason, "shortfall");
  assertEquals(by["Rice"].for_plans, [tue.json.plan.id]);
  assertEquals(by["Rice"].unit, "g");
  assertEquals(by["Leeks"].quantity, 4); // never in the pantry: needed in full, both nights
  assertEquals(by["Leeks"].pantry_item_id, null);
  assertEquals(by["Soy sauce"].reason, "staple_low");
  assertEquals(l.json.carried_over, []);
  const row = (await admin(`SELECT items, week_start::text AS ws FROM shopping_lists WHERE id=$1`, [l.json.list_id]))[0];
  assertEquals(row.ws, "2026-10-05");
  assertEquals(row.items.length, 4);
  assert(row.items.every((i: { purchased: boolean }) => i.purchased === false)); // upstream shape kept
});

test("restock: except + substitution + actual pack size update exactly those items; unbought carries over; affected_plans only changed rows", async () => {
  const ids = await seedItems([
    { name: "Rice", quantity: 100, unit: "g" }, { name: "Chicken breast", quantity: 100, unit: "g" },
    { name: "Chicken thighs", quantity: 0, unit: "g" }, { name: "Onion", quantity: 0, unit: "count" },
    { name: "Pasta", quantity: 1000, unit: "g" },
  ]);
  const mon = await seedRecipe({ name: "Mon", ingredients: [
    { pantry_item_id: ids["Rice"], name: "Rice", quantity: 300, unit: "g" },
    { pantry_item_id: ids["Chicken breast"], name: "Chicken breast", quantity: 400, unit: "g" },
    { pantry_item_id: ids["Onion"], name: "Onion", quantity: 2 },
  ] });
  const tue = await seedRecipe({ name: "Tue", ingredients: [{ pantry_item_id: ids["Pasta"], name: "Pasta", quantity: 200, unit: "g" }] });
  const pm = await post("/plan", { date: "2026-10-05", recipe_id: mon, servings: 4 });
  await post("/plan", { date: "2026-10-06", recipe_id: tue, servings: 4 });
  const list = await post("/shopping-list", { week_start: "2026-10-05" });
  const q = Object.fromEntries(list.json.items.map((i: { name: string; quantity: number }) => [i.name, i.quantity]));
  assertEquals(q, { "Rice": 200, "Chicken breast": 300, "Onion": 2 });

  const r = await post("/restock", {
    list_id: list.json.list_id, bought: "all", except: ["Onion"],
    substitutions: [{ for: "Chicken breast", name: "Chicken thighs", quantity: 500, unit: "g" }],
    actual: [{ name: "Rice", quantity: 1, unit: "kg" }],
  });
  assertEquals(r.status, 200);
  const rs = Object.fromEntries(r.json.restocked.map((x: { name: string }) => [x.name, x]));
  assertEquals(Object.keys(rs).sort(), ["Chicken thighs", "Rice"]);
  assertEquals(rs["Rice"].delta, 1000); // the pack actually bought, not the 200 listed
  assertEquals(rs["Chicken thighs"].delta, 500);
  assertEquals(rs["Chicken thighs"].substitution_for, "Chicken breast");
  assertEquals(await qty("Rice"), 1100);
  assertEquals(await qty("Chicken thighs"), 500);
  assertEquals(await qty("Chicken breast"), 100);
  assertEquals(await qty("Onion"), 0);
  assertEquals(await qty("Pasta"), 1000);
  assertEquals(r.json.carried_over.map((c: { name: string }) => c.name), ["Onion"]);
  assertEquals(r.json.affected_plans.length, 1);
  assertEquals(r.json.affected_plans[0].plan_id, pm.json.plan.id);
  assertEquals(r.json.affected_plans[0].shortfalls_before.map((s: { name: string }) => s.name).sort(), ["Chicken breast", "Onion", "Rice"]);
  assertEquals(r.json.affected_plans[0].shortfalls_after.map((s: { name: string }) => s.name).sort(), ["Chicken breast", "Onion"]);
  const led = await admin(`SELECT reason, count(*)::int AS n FROM pantry_adjustments WHERE shopping_list_id=$1 GROUP BY reason`, [list.json.list_id]);
  assertEquals(led, [{ reason: "restock", n: 2 }]);

  // restocking again must not double count what was already bought
  const again = await post("/restock", { list_id: list.json.list_id, bought: ["Rice"] });
  assertEquals(again.json.restocked, []);
  assertEquals(again.json.unmatched[0].reason, "not_on_list");
  assertEquals(await qty("Rice"), 1100);

  // the next list carries the unbought onion, once
  const next = await post("/shopping-list", { week_start: "2026-10-05" });
  assertEquals(next.json.carried_over.map((c: { name: string }) => c.name), ["Onion"]);
  const onion = next.json.items.find((i: { name: string }) => i.name === "Onion");
  assertEquals(onion.carried_over, true);
  assertEquals(onion.quantity, 2);
  const third = await post("/shopping-list", { week_start: "2026-10-05" });
  // still unbought, so it chains from the latest list only - never again from the first one
  assertEquals(third.json.carried_over.map((c: { from_list: string }) => c.from_list), [next.json.list_id]);
  const old = await post("/restock", { list_id: list.json.list_id, bought: "all" });
  assertEquals(old.json.restocked, []); // the carried line is no longer buyable on the old list
  assertEquals((await post("/restock", { list_id: "44444444-4444-4444-4444-444444444444", bought: "all" })).status, 404);
});

test("restock: unconvertible and unmatched purchase lines are returned, not written; staples go back to plenty", async () => {
  const ids = await seedItems([{ name: "Flour", quantity: 0, unit: "g" }, { name: "Soy sauce", kind: "staple", level: "low" }]);
  const rcp = await seedRecipe({ name: "R", ingredients: [{ pantry_item_id: ids["Flour"], name: "Flour", quantity: 400, unit: "g" }, { name: "Leeks", quantity: 1, unit: "count" }] });
  await post("/plan", { date: "2026-10-05", recipe_id: rcp, servings: 4 });
  const list = await post("/shopping-list", { week_start: "2026-10-05" });
  const r = await post("/restock", { list_id: list.json.list_id, bought: "all", actual: [{ name: "Flour", quantity: 3, unit: "ml" }] });
  assertEquals(r.json.unconvertible.length, 1);
  assertEquals(r.json.unmatched.some((u: { name: string; reason: string }) => u.name === "Leeks" && u.reason === "no_pantry_item"), true);
  assertEquals(await qty("Flour"), 0);
  assertEquals((await admin(`SELECT level FROM pantry_items WHERE name='Soy sauce'`))[0].level, "plenty");
  assertEquals(r.json.restocked.map((x: { name: string }) => x.name), ["Soy sauce"]);
});

Deno.test({ name: "zz close pools", sanitizeOps: false, sanitizeResources: false, fn: close });
