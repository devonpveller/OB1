// pantry-cook-confirm: cook PREVIEW (writes nothing) and the optional package size on a counted item.
import { assert, assertEquals } from "@std/assert";
import { admin, close, db, get, near, post, qty, seedItems, seedRecipe, test } from "./helpers.ts";

/** Every table a cook could touch, hashed. A preview must leave this byte-identical (and not advance a sequence). */
async function fingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const t of [
    "pantry_items", "pantry_adjustments", "pantry_cook_events", "pantry_explored", "pantry_settings", "pantry_people",
    "pantry_audits", "pantry_audit_lines", "pantry_audit_previews", "pantry_recipe_revisions", "pantry_evaluations",
    "pantry_exposures", "pantry_preferences", "pantry_taste_hypotheses", "meal_plans", "recipes", "shopping_lists",
  ]) {
    const r = await admin(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x`,
    );
    parts.push(`${t}:${r[0].n}:${r[0].h}`);
  }
  const seq = await admin(
    `SELECT string_agg(sequencename || '=' || coalesce(last_value::text, 'null'), ',' ORDER BY sequencename) AS s FROM pg_sequences WHERE schemaname='public'`,
  );
  parts.push("seq:" + seq[0].s);
  return parts.join("\n");
}

// deno-lint-ignore no-explicit-any
const by = (rows: { name: string }[], name: string): any => rows.find((r) => r.name === name)!;

// 1 gal = 128 fl_oz (the unit table has no gallon, so the household states the jug in fl_oz or litres).
const MILK = { name: "Milk", quantity: 1, unit: "count", pack_size: 128, pack_unit: "fl_oz" };

test("pack: Milk counted 1, pack 128 fl_oz (1 gal); a recipe's 1 cup deducts 1/16 and leaves 0.9375", async () => {
  const ids = await seedItems([MILK]);
  const rec = await seedRecipe({ name: "Mac", servings: 4, ingredients: [{ pantry_item_id: ids["Milk"], name: "Milk", quantity: 1, unit: "cup" }] });
  const r = await post("/cook", { recipe_id: rec, servings: 4 });
  assertEquals(r.status, 201);
  const m = by(r.json.deductions, "Milk");
  assertEquals([m.before, m.after, m.delta, m.unit], [1, 0.9375, -0.0625, "count"]);
  assertEquals(m.pack, { size: 128, unit: "fl_oz" });
  assertEquals(m.converted_from, [{ ingredient: "Milk", quantity: 1, unit: "cup" }]);
  assertEquals(await qty("Milk"), 0.9375);
  assertEquals(r.json.unconvertible, []);
  assertEquals((await admin(`SELECT delta::float8 AS d FROM pantry_adjustments WHERE cook_event_id=$1`, [r.json.cook_event_id]))[0].d, -0.0625);
});

test("pack: grams against a kg pack, ml against a fl_oz pack, tbsp against an ml pack all convert; scaling applies", async () => {
  const ids = await seedItems([
    { name: "Flour bag", quantity: 2, unit: "count", pack_size: 1, pack_unit: "kg" },
    { name: "Juice", quantity: 3, unit: "count", pack_size: 16, pack_unit: "fl_oz" },
    { name: "Vinegar bottle", quantity: 1, unit: "count", pack_size: 500, pack_unit: "ml" },
  ]);
  const rec = await seedRecipe({ name: "R", servings: 4, ingredients: [
    { pantry_item_id: ids["Flour bag"], name: "Flour bag", quantity: 250, unit: "g" },
    { pantry_item_id: ids["Juice"], name: "Juice", quantity: 100, unit: "ml" },
    { pantry_item_id: ids["Vinegar bottle"], name: "Vinegar bottle", quantity: 2, unit: "tbsp" },
  ] });
  const r = await post("/cook", { recipe_id: rec, servings: 2 }); // scale 0.5
  assertEquals(r.status, 201);
  near(by(r.json.deductions, "Flour bag").delta, -0.125); // 125 g of a 1000 g pack
  near(by(r.json.deductions, "Juice").delta, -0.1057, 1e-4); // 50 ml / (16 x 29.5735) ml
  near(by(r.json.deductions, "Vinegar bottle").delta, -0.0296, 1e-4); // 1 tbsp = 14.787 ml of 500 ml
  assertEquals(r.json.unconvertible, []);
});

test("pack: a recipe unit in a DIFFERENT dimension from the pack is unconvertible and never guessed; no pack = the old behaviour", async () => {
  const ids = await seedItems([MILK, { name: "Eggs", quantity: 12, unit: "count" }, { name: "Cream", quantity: 2, unit: "count" }]);
  const rec = await seedRecipe({ name: "R", servings: 4, ingredients: [
    { pantry_item_id: ids["Milk"], name: "Milk", quantity: 200, unit: "g" }, // mass vs a volume pack
    { pantry_item_id: ids["Eggs"], name: "Eggs", quantity: 3 }, // plain count: unchanged
    { pantry_item_id: ids["Cream"], name: "Cream", quantity: 1, unit: "cup" }, // no pack on file
  ] });
  const r = await post("/cook", { recipe_id: rec, servings: 4 });
  assertEquals(r.status, 201);
  assertEquals(r.json.deductions.map((d: { name: string }) => d.name), ["Eggs"]);
  const u = r.json.unconvertible;
  assertEquals(u.map((x: { name: string }) => x.name).sort(), ["Cream", "Milk"]);
  assert(by(u, "Cream").hint.includes("no package size"), "the hint tells the model to ask for the package size");
  assert(by(u, "Milk").hint.includes("never guess"));
  assertEquals(await qty("Milk"), 1);
  assertEquals(await qty("Cream"), 2);
  assertEquals(await qty("Eggs"), 9);
});

test("pack: staples are never quantity-deducted, even with a mass/volume line (re-verified)", async () => {
  const ids = await seedItems([{ name: "Dried thyme", kind: "staple", level: "plenty" }, MILK]);
  const rec = await seedRecipe({ name: "R", servings: 4, ingredients: [
    { pantry_item_id: ids["Dried thyme"], name: "Dried thyme", quantity: 1, unit: "tsp" },
    { pantry_item_id: ids["Milk"], name: "Milk", quantity: 1, unit: "cup" },
  ] });
  const r = await post("/cook", { recipe_id: rec, servings: 4 });
  assertEquals(r.json.deductions.map((d: { name: string }) => d.name), ["Milk"]);
  assertEquals((await admin(`SELECT level FROM pantry_items WHERE name='Dried thyme'`))[0].level, "plenty");
});

test("preview: same body as the real cook, and NOTHING is written (every table + every sequence identical)", async () => {
  const ids = await seedItems([MILK, { name: "Rice", quantity: 100, unit: "g" }, { name: "Salt", kind: "staple", level: "plenty" }]);
  const rec = await seedRecipe({ name: "Milk rice", servings: 4, cuisine: "Thai", tags: ["technique:simmer"], ingredients: [
    { pantry_item_id: ids["Milk"], name: "Milk", quantity: 1, unit: "cup" },
    { pantry_item_id: ids["Rice"], name: "Rice", quantity: 400, unit: "g" }, // short: only 100
    { name: "Leeks", quantity: 2, unit: "count" }, // unmatched
    { pantry_item_id: ids["Salt"], name: "Salt", quantity: 1, unit: "tsp", staple: true },
  ] });
  const plan = await post("/plan", { date: "2026-10-06", recipe_id: rec, servings: 4 });
  const before = await fingerprint();
  const p = await post("/cook", { recipe_id: rec, servings: 4, meal_plan_id: plan.json.plan.id, preview: true });
  assertEquals(p.status, 200);
  assertEquals(await fingerprint(), before, "a preview changed something");
  assertEquals(p.json.preview, true);
  assertEquals(p.json.cook_event_id, null);
  assertEquals((await admin(`SELECT status FROM meal_plans`))[0].status, "planned");

  const real = await post("/cook", { recipe_id: rec, servings: 4, meal_plan_id: plan.json.plan.id });
  assertEquals(real.status, 201);
  assertEquals(real.json.preview, false);
  for (const k of ["deductions", "shortfalls", "unconvertible", "unmatched", "explored_new", "servings"]) {
    assertEquals(p.json[k], real.json[k], `preview ${k} differs from the real cook`);
  }
  assertEquals(p.json.shortfalls[0].name, "Rice");
  assertEquals(p.json.explored_new.cuisines, ["thai"]);
  assertEquals(await qty("Milk"), 0.9375);
});

test("preview: on a household that never had a settings row, a preview does not create one", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 100, unit: "g" }]);
  const rec = await seedRecipe({ name: "R", ingredients: [{ pantry_item_id: ids["Rice"], name: "Rice", quantity: 400, unit: "g" }] });
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_settings`))[0].n, 0);
  const p = await post("/cook", { recipe_id: rec, preview: true }); // no servings: household portions from the defaults
  assertEquals(p.status, 200);
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_settings`))[0].n, 0);
  assertEquals(p.json.servings, 2.5);
});

test("preview: allergen conflicts are a 409 in preview too, and nothing is written", async () => {
  const ids = await seedItems([{ name: "Peanuts", quantity: 200, unit: "g", allergens: ["peanut"] }]);
  const rec = await seedRecipe({ name: "Satay", ingredients: [{ pantry_item_id: ids["Peanuts"], name: "Peanuts", quantity: 100, unit: "g" }] });
  const before = await fingerprint();
  const g = await post("/cook", { recipe_id: rec, servings: 4, guest_context: { adults: 1, allergies: ["peanut"] }, preview: true });
  assertEquals(g.status, 409);
  assertEquals(g.json.error, "allergen_conflict");
  assertEquals(g.json.conflicts, [{ ingredient: "Peanuts", allergen: "peanut", who: "guest" }]);
  assertEquals(await fingerprint(), before);
});

test("preview: an already-cooked plan row is still a 409; a bad `preview` value is a 400; a real cook after a preview works once", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 1000, unit: "g" }]);
  const rec = await seedRecipe({ name: "R", ingredients: [{ pantry_item_id: ids["Rice"], name: "Rice", quantity: 400, unit: "g" }] });
  const plan = await post("/plan", { date: "2026-10-06", recipe_id: rec, servings: 4 });
  assertEquals((await post("/cook", { recipe_id: rec, servings: 4, preview: "yes" })).status, 400);
  assertEquals((await post("/cook", { recipe_id: rec, servings: 4, meal_plan_id: plan.json.plan.id, preview: true })).status, 200);
  assertEquals((await post("/cook", { recipe_id: rec, servings: 4, meal_plan_id: plan.json.plan.id })).status, 201);
  assertEquals((await post("/cook", { recipe_id: rec, servings: 4, meal_plan_id: plan.json.plan.id, preview: true })).json.error, "plan_cooked");
  assertEquals(await qty("Rice"), 600);
});

test("preview: the database itself refuses a write inside a preview transaction (read-only tripwire)", async () => {
  let refused = false;
  try {
    await db.tx(async (t) => {
      await t.q(`INSERT INTO pantry_settings (user_id) VALUES ('11111111-1111-1111-1111-111111111111')`);
    }, { readOnly: true });
  } catch {
    refused = true;
  }
  assert(refused, "a READ ONLY transaction accepted a write");
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_settings`))[0].n, 0);
});

test("pack on /pantry/adjust: set on create and update, shown by GET /pantry, cleared with nulls; invalid values write nothing", async () => {
  const c = await post("/pantry/adjust", { reason: "manual", items: [{ create: true, name: "Milk", quantity: 1, unit: "count", pack_size: 1, pack_unit: "gal" }] });
  assertEquals(c.status, 400); // gal is not a known unit: the service never guesses
  const ids = await seedItems([{ name: "Milk", quantity: 1, unit: "count", pack_size: 3.785, pack_unit: "L" }, { name: "Rice", quantity: 1000, unit: "g" }, { name: "Salt", kind: "staple", level: "plenty" }]);
  const items = (await get("/pantry")).json.items;
  const m = items.find((i: { name: string }) => i.name === "Milk");
  assertEquals([m.pack_size, m.pack_unit], [3.785, "l"]);
  const rice = items.find((i: { name: string }) => i.name === "Rice");
  assertEquals([rice.pack_size, rice.pack_unit], [null, null]);
  const before = await fingerprint();
  for (const bad of [
    { id: ids["Milk"], pack_size: 0, pack_unit: "l" },
    { id: ids["Milk"], pack_size: 2 }, // one-sided
    { id: ids["Milk"], pack_size: 2, pack_unit: "count" }, // a count is not a size
    { id: ids["Milk"], pack_size: 2, pack_unit: "gallon" },
    { id: ids["Rice"], pack_size: 1, pack_unit: "kg" }, // not a 'count' item
    { id: ids["Salt"], pack_size: 1, pack_unit: "kg" }, // a staple
  ]) {
    const r = await post("/pantry/adjust", { reason: "manual", items: [bad] });
    assertEquals(r.status, 400, JSON.stringify(bad));
  }
  assertEquals(await fingerprint(), before);
  const u = await post("/pantry/adjust", { reason: "manual", items: [{ id: ids["Milk"], pack_size: 64, pack_unit: "fl_oz" }] });
  assertEquals(u.status, 200);
  assertEquals([u.json.applied[0].pack_size, u.json.applied[0].pack_unit, u.json.applied[0].after], [64, "fl_oz", 1]);
  const x = await post("/pantry/adjust", { reason: "manual", items: [{ id: ids["Milk"], pack_size: null, pack_unit: null }] });
  assertEquals([x.json.applied[0].pack_size, x.json.applied[0].pack_unit], [null, null]);
});

test("pack on /audit: a row sets/changes a pack (a field change), a new item carries it, a pack on a non-count item is unconvertible", async () => {
  const ids = await seedItems([{ name: "Milk", quantity: 1, unit: "count" }, { name: "Rice", quantity: 500, unit: "g" }]);
  const p = await post("/audit/preview", { source: "csv", rows: [
    { id: ids["Milk"], name: "Milk", quantity: 1, unit: "count", pack_size: 128, pack_unit: "fl_oz" },
    { id: ids["Rice"], name: "Rice", quantity: 500, unit: "g", pack_size: 1, pack_unit: "kg" },
    { name: "Juice", quantity: 2, unit: "count", pack_size: 1, pack_unit: "l" },
  ] });
  assertEquals(p.status, 200);
  assertEquals(p.json.changed.map((c: { name: string; fields?: string[] }) => [c.name, c.fields]), [["Milk", ["pack"]]]);
  assertEquals(p.json.new.map((n: { name: string; pack_size: number }) => [n.name, n.pack_size]), [["Juice", 1]]);
  assertEquals(p.json.unconvertible.map((u: { name: string; reason: string }) => [u.name, u.reason]), [["Rice", "pack_on_non_count_item"]]);
  assertEquals((await admin(`SELECT pack_size FROM pantry_items WHERE name='Milk'`))[0].pack_size, null); // preview wrote nothing
  const c = await post("/audit/commit", { preview_id: p.json.preview_id });
  assertEquals(c.status, 201);
  const rows = await admin(`SELECT name, pack_size::float8 AS s, pack_unit FROM pantry_items ORDER BY name`);
  assertEquals(rows.map((r) => [r.name, r.s, r.pack_unit]), [["Juice", 1, "l"], ["Milk", 128, "fl_oz"], ["Rice", null, null]]);
  const p2 = await post("/audit/preview", { source: "csv", rows: [{ id: ids["Milk"], name: "Milk", quantity: 1, unit: "count", pack_size: 128, pack_unit: "fl_oz" }] });
  assertEquals(p2.json.changed, []); // a re-preview of the same sheet shows no pack change any more
});

test("pack: /cook/{id}/correct converts a corrected amount through the pack too", async () => {
  const ids = await seedItems([MILK]);
  const rec = await seedRecipe({ name: "Mac", servings: 4, ingredients: [{ pantry_item_id: ids["Milk"], name: "Milk", quantity: 1, unit: "cup" }] });
  const c = await post("/cook", { recipe_id: rec, servings: 4 });
  const fix = await post(`/cook/${c.json.cook_event_id}/correct`, { adjustments: [{ item_id: ids["Milk"], actual_used: 2, unit: "cup" }] });
  assertEquals(fix.status, 200);
  assertEquals(fix.json.unconvertible, []);
  assertEquals(await qty("Milk"), 0.875); // 2 of 16 cups used
});

test("pack: planned dinners reserve through the pack, and the SQL view agrees with the service", async () => {
  const ids = await seedItems([MILK]);
  const rec = await seedRecipe({ name: "Mac", servings: 4, ingredients: [{ pantry_item_id: ids["Milk"], name: "Milk", quantity: 1, unit: "cup" }] });
  const pl = await post("/plan", { date: "2026-10-06", recipe_id: rec, servings: 4 });
  assertEquals(pl.status, 201);
  assertEquals(pl.json.reservations[0].reserved, 0.0625);
  assertEquals(pl.json.unconvertible, []);
  const view = (await admin(`SELECT reserved::float8 AS r, available::float8 AS a FROM pantry_available WHERE name='Milk'`))[0];
  near(view.r, 0.0625);
  near(view.a, 0.9375);
  const it = (await get("/pantry")).json.items.find((i: { name: string }) => i.name === "Milk");
  assertEquals([it.reserved, it.available], [0.0625, 0.9375]);
});

Deno.test({ name: "zz close pools", sanitizeOps: false, sanitizeResources: false, fn: close });
