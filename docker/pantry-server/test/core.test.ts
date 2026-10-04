import { assert, assertEquals } from "@std/assert";
import { admin, api, app, close, db, get, near, post, qty, seedItems, seedRecipe, test, counts, USER_ID, OTHER_USER } from "./helpers.ts";
import { CANON, convert, unitDim } from "../src/units.ts";
import { createApp } from "../src/app.ts";

const PANTRY_TABLES = [
  "pantry_items", "pantry_people", "pantry_adjustments", "pantry_cook_events", "pantry_recipe_revisions",
  "pantry_evaluations", "pantry_preferences", "pantry_taste_hypotheses", "pantry_explored", "pantry_settings",
  "pantry_audits", "pantry_audit_lines", "pantry_exposures", "pantry_audit_previews",
];

test("schema: every PLAN section 5 table exists with user_id UUID NOT NULL; view and upstream ALTERs present", async () => {
  const t = await admin(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'pantry\\_%' AND table_type='BASE TABLE'`);
  const have = new Set(t.map((r) => r.table_name));
  for (const n of PANTRY_TABLES) assert(have.has(n), `missing table ${n}`);
  for (const n of PANTRY_TABLES) {
    // pantry_audit_lines carries user_id too
    const c = await admin(`SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name=$1 AND column_name='user_id'`, [n]);
    assertEquals(c.length, 1, `${n} has no user_id`);
    assertEquals(c[0].is_nullable, "NO", `${n}.user_id nullable`);
    assertEquals(c[0].data_type, "uuid");
  }
  const v = await admin(`SELECT 1 FROM information_schema.views WHERE table_name='pantry_available'`);
  assertEquals(v.length, 1);
  const rc = await admin(`SELECT column_name FROM information_schema.columns WHERE table_name='recipes'`);
  for (const c of ["theme", "current_revision", "draft", "source", "rotation"]) assert(rc.some((r) => r.column_name === c), `recipes.${c}`);
  const mp = await admin(`SELECT column_name FROM information_schema.columns WHERE table_name='meal_plans'`);
  for (const c of ["status", "leftovers_of", "cook_event_id", "guest_context", "plan_date", "servings_exact"]) assert(mp.some((r) => r.column_name === c), `meal_plans.${c}`);
});

test("idempotent re-apply leaves exactly one of each policy / role / view (runner applied the file twice)", async () => {
  const p = await admin(`SELECT count(*)::int AS n FROM pg_policies WHERE policyname='pantry_service_all'`);
  assertEquals(p[0].n, 3);
  const r = await admin(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname='ob_pantry'`);
  assertEquals(r[0].n, 1);
  const ct = await admin(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='meal_plans' AND column_name='plan_date'`);
  assertEquals(ct[0].n, 1);
});

test("auth: every registered route (and an unknown one) is 401 without or with a wrong key; /health is open", async () => {
  const uuid = "33333333-3333-3333-3333-333333333333";
  const routes = app.routes.filter((r) => r.method !== "ALL" && !(r.method === "GET" && r.path === "/health"));
  assert(routes.length >= 19, `expected the pantry-core route set, found ${routes.length}`);
  const want = [
    "GET /settings", "PUT /settings", "GET /people", "POST /people", "GET /pantry", "POST /pantry/adjust",
    "POST /recipes", "GET /recipes", "GET /recipes/:id", "POST /cook", "POST /cook/:id/correct", "POST /plan",
    "GET /plan", "POST /plan/:id/status", "POST /shopping-list", "POST /restock", "POST /audit/preview",
    "POST /audit/commit", "GET /accuracy",
  ];
  const got = new Set(routes.map((r) => `${r.method} ${r.path}`));
  for (const w of want) assert(got.has(w), `route not registered: ${w}`);
  for (const r of [...routes, { method: "GET", path: "/no/such/route" }]) {
    const path = r.path.replace(":id", uuid);
    for (const key of [null, "wrong-key", ""]) {
      const res = await api(r.method, path, r.method === "GET" ? undefined : {}, key);
      assertEquals(res.status, 401, `${r.method} ${path} key=${key}`);
      assertEquals(res.json, { error: "unauthorized" });
    }
  }
  const h = await api("GET", "/health", undefined, null);
  assertEquals(h.status, 200);
  assertEquals(h.json, { ok: true, db: true });
});

test("health is 503 db:false when the database is unreachable", async () => {
  const dead = createApp({
    db: { q: () => Promise.reject(new Error("down")), tx: () => Promise.reject(new Error("down")), ping: () => Promise.resolve(false), end: () => Promise.resolve() },
    userId: USER_ID, apiKey: "k",
  });
  const r = await dead.request("/health");
  assertEquals(r.status, 503);
  assertEquals(await r.json(), { ok: false, db: false });
});

test("settings: defaults, PUT merges, validation", async () => {
  const s = await get("/settings");
  assertEquals(s.json, { portions: { adult: 1, child: 0.5 }, child_cooldown_days: 7, week_start_day: "monday", use_soon_days: 5 });
  const u = await api("PUT", "/settings", { portions: { child: 0.6 }, use_soon_days: 3 });
  assertEquals(u.status, 200);
  assertEquals(u.json.portions, { adult: 1, child: 0.6 });
  assertEquals(u.json.use_soon_days, 3);
  assertEquals(u.json.child_cooldown_days, 7);
  assertEquals((await api("PUT", "/settings", { week_start_day: "someday" })).status, 400);
  assertEquals((await api("PUT", "/settings", { use_soon_days: -1 })).json.error, "invalid");
});

test("people: upsert by id, allergies, validation, only this household", async () => {
  const a = await post("/people", { label: "Dad", role: "adult", allergies: ["peanut"] });
  assertEquals(a.status, 201);
  const id = a.json.id;
  const u = await post("/people", { id, label: "Dad", role: "adult", allergies: ["peanut", "sesame"] });
  assertEquals(u.status, 200);
  assertEquals(u.json.allergies, ["peanut", "sesame"]);
  const kid = await post("/people", { label: "Kid", role: "child", birth_month: "2022-04" });
  assertEquals(kid.status, 201);
  assert(typeof kid.json.age_years === "number");
  assertEquals((await post("/people", { label: "x", role: "pet" })).status, 400);
  assertEquals((await post("/people", { label: "x", role: "adult", birth_month: "2022-13" })).status, 400);
  await admin(`INSERT INTO pantry_people (user_id,label,role) VALUES ($1,'Stranger','adult')`, [OTHER_USER]);
  const l = await get("/people");
  assertEquals(l.json.people.length, 2);
  assert(l.json.people.every((p: { label: string }) => p.label !== "Stranger"));
});

test("pantry adjust: create ONLY with create:true; unit conversion in dimension; cross-dimension returned, not written", async () => {
  const miss = await post("/pantry/adjust", { reason: "manual", items: [{ name: "Quinoa", quantity: 500, unit: "g" }] });
  assertEquals(miss.status, 200);
  assertEquals(miss.json.created, []);
  assertEquals(miss.json.unmatched[0].name, "Quinoa");
  assertEquals((await counts()).items, 0);

  const made = await post("/pantry/adjust", { reason: "manual", items: [
    { name: "Rice", create: true, quantity: 1.5, unit: "kg", category: "grains" },
    { name: "Onion", create: true, quantity: 6, unit: "each" },
    { name: "Olive oil", create: true, quantity: 0.5, unit: "l" },
    { name: "Salt", create: true, kind: "staple", level: "plenty" },
  ] });
  assertEquals(made.json.created.length, 4);
  assertEquals(await qty("Rice"), 1500);
  assertEquals(await qty("Olive oil"), 500);
  const rice = made.json.created.find((c: { name: string }) => c.name === "Rice");
  assertEquals(rice.unit, "g");

  const conv = await post("/pantry/adjust", { reason: "manual", items: [{ name: "rice", quantity: 2, unit: "lb" }] });
  near(conv.json.applied[0].after, 907.1847, 1e-4);
  const d = await post("/pantry/adjust", { reason: "correct", items: [{ name: "RICE", delta: -0.5, unit: "kg" }] });
  near(d.json.applied[0].after, 407.1847, 1e-4);

  const before = await counts();
  const x = await post("/pantry/adjust", { reason: "manual", items: [
    { name: "Rice", delta: 100, unit: "ml" },
    { name: "Onion", quantity: 100, unit: "g" },
  ] });
  assertEquals(x.json.unconvertible.length, 2);
  assertEquals(x.json.applied, []);
  const after = await counts();
  assertEquals(after.ledger, before.ledger);
  assertEquals(after.total_qty, before.total_qty);

  const lv = await post("/pantry/adjust", { reason: "manual", items: [{ name: "Salt", level: "low" }] });
  assertEquals(lv.json.applied[0].before, "plenty");
  assertEquals(lv.json.applied[0].after, "low");
  assertEquals((await post("/pantry/adjust", { reason: "manual", items: [{ name: "Salt", quantity: 5, unit: "g" }] })).status, 400);
  assertEquals((await post("/pantry/adjust", { reason: "manual", items: [{ name: "Rice", level: "low" }] })).status, 400);
  assertEquals((await post("/pantry/adjust", { reason: "bogus", items: [{ name: "Rice" }] })).status, 400);
  assertEquals((await post("/pantry/adjust", { reason: "manual", items: [{ name: "Rice", quantity: 1, delta: 1 }] })).status, 400);
});

test("pantry adjust: every quantity change has a ledger row and is all-or-nothing on invalid input", async () => {
  await seedItems([{ name: "Rice", quantity: 1000, unit: "g" }]);
  const r = await post("/pantry/adjust", { reason: "manual", items: [{ name: "Rice", delta: -250, unit: "g" }] });
  const rows = await admin(`SELECT delta::float8 AS d, quantity_before::float8 AS b, quantity_after::float8 AS a, reason FROM pantry_adjustments ORDER BY at`);
  assertEquals(rows.length, 2); // seed + this
  assertEquals(rows[1].d, -250);
  assertEquals(rows[1].reason, "manual");
  assertEquals(r.json.applied[0].after, 750);
  const bad = await post("/pantry/adjust", { reason: "manual", items: [{ name: "Rice", delta: -50, unit: "g" }, { name: "X", create: true, quantity: 1 }] });
  assertEquals(bad.status, 400); // new counted item without unit -> whole request refused
  assertEquals(await qty("Rice"), 750);
});

test("matching: exact name, alias, id; never fuzzy (a near miss returns candidates and writes nothing)", async () => {
  const ids = await seedItems([{ name: "Chickpeas", quantity: 400, unit: "g", aliases: ["garbanzo"] }, { name: "Chicken breast", quantity: 500, unit: "g" }]);
  const a = await post("/pantry/adjust", { reason: "manual", items: [{ name: "GARBANZO", delta: 100, unit: "g" }, { id: ids["Chicken breast"], delta: -100, unit: "g" }] });
  assertEquals(a.json.applied.length, 2);
  assertEquals(await qty("Chickpeas"), 500);
  const f = await post("/pantry/adjust", { reason: "manual", items: [{ name: "chick", delta: 1, unit: "g" }] });
  assertEquals(f.json.applied, []);
  assertEquals(f.json.unmatched[0].name, "chick");
  const names = f.json.unmatched[0].candidates.map((c: { name: string }) => c.name).sort();
  assertEquals(names, ["Chicken breast", "Chickpeas"]);
  assertEquals(await qty("Chickpeas"), 500);
  const ok = await post("/pantry/adjust", { reason: "manual", items: [{ name: "chickpea", delta: 1, unit: "g" }] });
  assertEquals(ok.json.applied, []); // singular is NOT silently accepted
  assertEquals(ok.json.unmatched[0].candidates[0].name, "Chickpeas");
});

test("GET /pantry: shape, filters, use_soon, reserved/available, other users invisible", async () => {
  const soon = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  await seedItems([
    { name: "Milk", quantity: 1000, unit: "ml", category: "dairy", expires_on: soon, allergens: ["milk"] },
    { name: "Flour", quantity: 2, unit: "kg", category: "baking", expires_on: later },
    { name: "Salt", kind: "staple", level: "plenty" },
  ]);
  await admin(`INSERT INTO pantry_items (user_id,name,kind,quantity,unit) VALUES ($1,'Secret','counted',5,'g')`, [OTHER_USER]);
  const all = await get("/pantry");
  assertEquals(all.json.items.length, 3);
  const milk = all.json.items.find((i: { name: string }) => i.name === "Milk");
  for (const k of ["id", "name", "aliases", "category", "kind", "quantity", "unit", "level", "location", "expires_on", "allergens", "may_contain", "reserved", "available", "use_soon"]) assert(k in milk, `missing ${k}`);
  assertEquals(milk.use_soon, true);
  assertEquals(milk.reserved, 0);
  assertEquals(milk.available, 1000);
  assertEquals(milk.allergens, ["milk"]);
  const flour = all.json.items.find((i: { name: string }) => i.name === "Flour");
  assertEquals(flour.quantity, 2000);
  assertEquals(flour.use_soon, false);
  assertEquals((await get("/pantry?use_soon=true")).json.items.map((i: { name: string }) => i.name), ["Milk"]);
  assertEquals((await get("/pantry?category=baking")).json.items.length, 1);
  assertEquals((await get("/pantry?q=sal")).json.items[0].name, "Salt");
  const salt = all.json.items.find((i: { name: string }) => i.name === "Salt");
  assertEquals(salt.available, null);
});

test("recipes: bind to pantry ids, report unmatched, NEW revision on id, GET shapes, allergen_conflicts", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 1000, unit: "g" }, { name: "Peanuts", quantity: 100, unit: "g", allergens: ["peanut"] }]);
  await post("/people", { label: "Mum", role: "adult", allergies: ["Peanut"] });
  const r = await post("/recipes", {
    name: "Rice bowl", theme: "bowls", cuisine: "asian", servings: 4, source: "generated",
    ingredients: [
      { name: "rice", quantity: 300, unit: "g" },
      { pantry_item_id: ids["Peanuts"], name: "Peanuts", quantity: 50, unit: "g" },
      { name: "Leeks", quantity: 2, unit: "count" },
    ],
    instructions: ["boil", "eat"], tags: ["quick"],
  });
  assertEquals(r.status, 201);
  assertEquals(r.json.revision.revision, 1);
  assertEquals(r.json.recipe.ingredients[0].pantry_item_id, ids["Rice"]);
  assertEquals(r.json.unmatched.map((u: { name: string }) => u.name), ["Leeks"]);
  assertEquals(r.json.allergen_conflicts, [{ ingredient: "Peanuts", allergen: "peanut", who: "Mum" }]);
  const id = r.json.recipe.id;
  const v2 = await post("/recipes", { id, name: "Rice bowl", servings: 4, source: "generated", reason: "no peanuts", ingredients: [{ name: "Rice", quantity: 250, unit: "g" }], instructions: ["boil"] });
  assertEquals(v2.status, 200);
  assertEquals(v2.json.revision.revision, 2);
  assertEquals(v2.json.allergen_conflicts, []);
  const g = await get(`/recipes/${id}`);
  assertEquals(g.json.recipe.current_revision, 2);
  assertEquals(g.json.revisions.length, 2);
  assertEquals(g.json.revision.reason, "no peanuts");
  const revs = await admin(`SELECT revision, jsonb_array_length(ingredients)::int AS n FROM pantry_recipe_revisions WHERE recipe_id=$1 ORDER BY revision`, [id]);
  assertEquals(revs.map((x) => x.n), [3, 1]); // revision 1 kept as written
  assertEquals((await get("/recipes?theme=bowls")).json.recipes.length, 1);
  assertEquals((await get("/recipes?source=household")).json.recipes.length, 0);
  assertEquals((await get("/recipes?q=bowl")).json.recipes.length, 1);
  assertEquals((await post("/recipes", { name: "x", servings: 4, source: "other", ingredients: [] })).status, 400);
  assertEquals((await post("/recipes", { name: "x", servings: 0, source: "household", ingredients: [] })).status, 400);
  assertEquals((await post("/recipes", { id: "44444444-4444-4444-4444-444444444444", name: "x", servings: 4, source: "household", ingredients: [] })).status, 404);
  assertEquals((await get(`/recipes/44444444-4444-4444-4444-444444444444`)).status, 404);
});

test("units: conversion never crosses a dimension; units.ts agrees with the SQL helpers", async () => {
  assertEquals(convert(1, "kg", "g"), 1000);
  assertEquals(convert(1, "g", "ml"), null);
  assertEquals(convert(1, "count", "g"), null);
  assertEquals(convert(1, "cup", "l"), 0.2366);
  assertEquals(convert(1, "pinch", "g"), null);
  assertEquals(unitDim("fl_oz"), "volume");
  for (const u of ["g", "kg", "mg", "oz", "lb", "ml", "l", "tsp", "tbsp", "cup", "fl_oz", "count", "each", "pc", "pinch"]) {
    const row = (await admin(`SELECT pantry_unit_dim($1) AS dim, pantry_unit_factor($1)::float8 AS f`, [u]))[0];
    assertEquals(row.dim, unitDim(u), u);
    const dim = unitDim(u);
    if (dim) near(row.f, convert(1, u, CANON[dim])!, 1e-3);
    else assertEquals(row.f, null);
  }
});

test("service role: not superuser, no BYPASSRLS, cannot read thoughts or anything outside its grants", async () => {
  const me = (await db.q<{ u: string; s: boolean; b: boolean }>(`SELECT current_user AS u, rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`))[0];
  assertEquals(me.u, "ob_pantry");
  assertEquals(me.s, false);
  assertEquals(me.b, false);
  let denied = "";
  try {
    await db.q(`SELECT count(*) FROM thoughts`);
  } catch (e) {
    denied = String((e as Error).message);
  }
  assert(/permission denied/i.test(denied), "thoughts must be unreadable, got: " + denied);
  for (const stmt of [`INSERT INTO thoughts (content) VALUES ('x')`, `CREATE TABLE public.zz (a int)`, `SELECT * FROM household_items`]) {
    let err = "";
    try {
      await db.q(stmt);
    } catch (e) {
      err = String((e as Error).message);
    }
    assert(/permission denied/i.test(err), `${stmt} must be denied, got: ${err}`);
  }
  const granted = await admin(`SELECT DISTINCT table_name FROM information_schema.role_table_grants WHERE grantee = 'ob_pantry'`);
  const allowed = new Set([...PANTRY_TABLES, "pantry_available", "recipes", "meal_plans", "shopping_lists"]);
  for (const g of granted) assert(allowed.has(g.table_name), `unexpected grant on ${g.table_name}`);
  const mem = await admin(`SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'ob_pantry'`);
  assertEquals(mem[0].n, 0);
  // and it CAN do its job on the RLS-protected upstream tables
  await seedRecipe({ name: "ok", ingredients: [] });
});

test("everything the service writes carries the household user_id", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 1000, unit: "g" }]);
  const rid = await seedRecipe({ name: "R", ingredients: [{ pantry_item_id: ids["Rice"], name: "Rice", quantity: 100, unit: "g" }] });
  await post("/cook", { recipe_id: rid, servings: 4 });
  await post("/plan", { date: "2026-10-06", recipe_id: rid });
  for (const tbl of ["pantry_items", "pantry_adjustments", "pantry_cook_events", "pantry_recipe_revisions", "pantry_settings", "recipes", "meal_plans"]) {
    const r = await admin(`SELECT count(*)::int AS n FROM ${tbl} WHERE user_id <> $1`, [USER_ID]);
    assertEquals(r[0].n, 0, tbl);
    const t = await admin(`SELECT count(*)::int AS n FROM ${tbl}`);
    assert(t[0].n > 0, `${tbl} empty`);
  }
});

Deno.test({ name: "zz close pools", sanitizeOps: false, sanitizeResources: false, fn: close });
