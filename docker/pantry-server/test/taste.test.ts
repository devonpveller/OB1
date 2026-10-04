// pantry-taste: evaluations, preferences, hypotheses, explored map, guidance.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { admin, adminExec, close, FORCE_FAIL_FN, get, api, app, post, seedItems, seedRecipe, test, type J } from "./helpers.ts";

/** A kitchen: Ana (adult, shellfish allergy), Bo (adult), Cy (child); one recipe with cuisine, technique tags, ingredients. */
async function kitchen() {
  const ana = (await post("/people", { label: "Ana", role: "adult", allergies: ["Shellfish"] })).json;
  const bo = (await post("/people", { label: "Bo", role: "adult" })).json;
  const cy = (await post("/people", { label: "Cy", role: "child", birth_month: "2022-04" })).json;
  const ids = await seedItems([
    { name: "Rice", quantity: 2000, unit: "g" },
    { name: "Mushrooms", quantity: 500, unit: "g" },
    { name: "Shrimp", quantity: 400, unit: "g", allergens: ["shellfish"] },
    { name: "Lentils", quantity: 800, unit: "g" },
    { name: "Fennel", quantity: 3, unit: "count", expires_on: "2000-01-01" },
    { name: "Salt", kind: "staple", level: "plenty" },
  ]);
  const stirfry = await seedRecipe({
    name: "Mushroom stir-fry", theme: "weeknight", cuisine: "Chinese", tags: ["technique:Stir-Fry", "quick", "technique: wok"],
    ingredients: [
      { name: "Rice", quantity: 400, unit: "g" },
      { name: "Mushrooms", quantity: 200, unit: "g" },
      { name: "Salt", quantity: 1, unit: "tsp", staple: true },
    ],
  });
  return { ana, bo, cy, ids, stirfry };
}

async function cook(recipe: string, extra: J = {}) {
  const r = await post("/cook", { recipe_id: recipe, servings: 4, ...extra });
  assertEquals(r.status, 201, JSON.stringify(r.json));
  return r.json.cook_event_id as string;
}

async function tasteRows() {
  const r = await admin(`SELECT
    (SELECT count(*)::int FROM pantry_preferences) AS prefs,
    (SELECT count(*)::int FROM pantry_taste_hypotheses) AS hyps,
    (SELECT coalesce(sum(support + against),0)::int FROM pantry_taste_hypotheses) AS evidence,
    (SELECT count(*)::int FROM pantry_exposures) AS exposures,
    (SELECT count(*)::int FROM pantry_evaluations) AS evals,
    (SELECT count(*)::int FROM pantry_explored) AS explored, 0 AS explored_events`);
  return r[0];
}

/** The parts of /guidance that are LEARNED (D18): nothing a guest meal does may move these. */
function learned(g: J) {
  return {
    allergens_excluded: g.allergens_excluded, hard: g.hard, contextual: g.contextual, soft: g.soft,
    child_cooldowns: g.child_cooldowns, child_trends: g.child_trends, hypotheses: g.hypotheses,
    recent_evaluations: g.recent_evaluations,
  };
}

const guidance = async (body: J = {}) => (await post("/guidance", body)).json;

async function propose(p: J) {
  const r = await post("/preferences", { statements: [{ scope: "always", who: "adult", ...p }] });
  assertEquals(r.status, 201, JSON.stringify(r.json));
  return r.json.proposed[0];
}

// ------------------------------------------------------------------ routes

test("routes: every pantry-taste route is registered and needs the key", async () => {
  const got = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));
  for (const w of [
    "POST /evaluations", "POST /preferences", "POST /preferences/confirm", "GET /preferences", "POST /hypotheses",
    "POST /hypotheses/:id/evidence", "GET /hypotheses", "GET /explored", "POST /guidance",
  ]) assert(got.has(w), `route not registered: ${w}`);
  const uuid = "33333333-3333-3333-3333-333333333333";
  for (const [m, p] of [["POST", "/evaluations"], ["POST", "/preferences"], ["POST", "/preferences/confirm"], ["GET", "/preferences"],
    ["POST", "/hypotheses"], ["POST", `/hypotheses/${uuid}/evidence`], ["GET", "/hypotheses"], ["GET", "/explored"], ["POST", "/guidance"]]) {
    for (const key of [null, "wrong"]) {
      const r = await api(m, p, m === "GET" ? undefined : {}, key);
      assertEquals(r.status, 401, `${m} ${p}`);
    }
  }
});

test("guidance: documented top-level shape on an empty household", async () => {
  const g = await guidance();
  assertEquals(Object.keys(g).sort(), [
    "allergens_excluded", "child_cooldowns", "child_trends", "contextual", "hard", "hypotheses", "recent_evaluations",
    "soft", "untried", "use_soon",
  ]);
  assertEquals(Object.keys(g.untried).sort(), ["cuisines", "ingredients", "techniques"]);
  assertEquals(g.hard, []);
  assert(g.untried.cuisines.includes("thai") && g.untried.techniques.includes("braise"));
  assertEquals((await post("/guidance", { recipe_id: "nope" })).status, 400);
  assertEquals((await post("/guidance", { now: "yesterday-ish" })).status, 400);
});

// ------------------------------------------------------------------ explored map (inside /cook)

test("explored: /cook records cuisine, technique: tags and ingredients; untried excludes them; times count", async () => {
  const { stirfry } = await kitchen();
  assertEquals((await get("/explored")).json, { cuisines: [], techniques: [], ingredients: [] });
  const g0 = await guidance();
  assert(g0.untried.cuisines.includes("chinese"));
  assert(g0.untried.techniques.includes("stir-fry"));
  assert(g0.untried.ingredients.includes("Mushrooms"));

  const r = await post("/cook", { recipe_id: stirfry, servings: 4 });
  assertEquals(r.status, 201);
  assertEquals(r.json.explored_new.cuisines, ["chinese"]);
  const ex = (await get("/explored")).json;
  assertEquals(ex.cuisines.map((x: J) => [x.value, x.times]), [["chinese", 1]]);
  assertEquals(ex.techniques.map((x: J) => x.value).sort(), ["stir-fry", "wok"]); // prefix stripped, lower-cased, non-technique tag ignored
  assertEquals(ex.ingredients.map((x: J) => x.value).sort(), ["mushrooms", "rice", "salt"]);
  assert(!Number.isNaN(Date.parse(ex.cuisines[0].first_tried)));

  const g1 = await guidance();
  assert(!g1.untried.cuisines.includes("chinese"), "a cooked cuisine must not stay untried");
  assert(!g1.untried.techniques.includes("stir-fry"));
  assert(!g1.untried.ingredients.includes("Mushrooms") && !g1.untried.ingredients.includes("Rice"));
  assert(g1.untried.ingredients.includes("Lentils"), "an ingredient never cooked stays untried");
  assert(g1.untried.cuisines.includes("thai"));

  await cook(stirfry);
  const ex2 = (await get("/explored")).json;
  assertEquals(ex2.cuisines[0].times, 2);
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_explored`))[0].n, 6);
});

test("explored: rolls back WITH the cook (forced failure after the explored write, and before it)", async () => {
  const { stirfry } = await kitchen();
  const plan = await post("/plan", { date: "2026-10-06", recipe_id: stirfry, servings: 4 });
  const ledger0 = (await admin(`SELECT count(*)::int AS n FROM pantry_adjustments`))[0].n; // seeding wrote manual rows
  // (a) the LAST step (plan row update) fails after explored was written
  await adminExec(FORCE_FAIL_FN + `CREATE TRIGGER t_force_fail_plan BEFORE UPDATE ON meal_plans FOR EACH ROW EXECUTE FUNCTION t_boom();`);
  let r = await post("/cook", { recipe_id: stirfry, servings: 4, meal_plan_id: plan.json.plan.id });
  assertEquals(r.status, 500);
  await adminExec(`DROP TRIGGER t_force_fail_plan ON meal_plans`);
  let t = await tasteRows();
  assertEquals([t.explored, t.explored_events], [0, 0]);
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_cook_events`))[0].n, 0);
  // (b) the explored write itself fails -> no cook event, no deduction
  await adminExec(FORCE_FAIL_FN + `CREATE TRIGGER t_force_fail_explored BEFORE INSERT ON pantry_explored FOR EACH ROW EXECUTE FUNCTION t_boom();`);
  r = await post("/cook", { recipe_id: stirfry, servings: 4 });
  assertEquals(r.status, 500);
  await adminExec(`DROP TRIGGER t_force_fail_explored ON pantry_explored`);
  t = await tasteRows();
  assertEquals([t.explored, t.explored_events], [0, 0]);
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_cook_events`))[0].n, 0);
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_adjustments`))[0].n, ledger0);
  assertEquals((await get("/explored")).json.cuisines, []);
});

test("explored: undoing a cook reverts exactly its contribution (decision: undo DOES revert explored)", async () => {
  const { stirfry, ids } = await kitchen();
  const lentilSoup = await seedRecipe({
    name: "Lentil soup", cuisine: "Chinese", tags: ["technique:simmer"],
    ingredients: [{ pantry_item_id: ids["Lentils"], name: "Lentils", quantity: 200, unit: "g" }, { name: "Rice", quantity: 100, unit: "g" }],
  });
  const c1 = await cook(stirfry, { cooked_at: "2026-09-01T18:00:00Z" });
  const c2 = await cook(lentilSoup, { cooked_at: "2026-09-10T18:00:00Z" });
  let ex = (await get("/explored")).json;
  assertEquals(ex.cuisines.map((x: J) => [x.value, x.times]), [["chinese", 2]]);
  assertEquals(new Date(ex.cuisines[0].first_tried).toISOString(), "2026-09-01T18:00:00.000Z");

  // undo the LATER cook: chinese stays (still cooked once), lentils/simmer go back to untried, rice drops to 1
  assertEquals((await post(`/cook/${c2}/correct`, { undo: true })).status, 200);
  ex = (await get("/explored")).json;
  assertEquals(ex.cuisines.map((x: J) => [x.value, x.times]), [["chinese", 1]]);
  assertEquals(ex.techniques.map((x: J) => x.value).sort(), ["stir-fry", "wok"]);
  assertEquals(ex.ingredients.map((x: J) => [x.value, x.times]).sort(), [["mushrooms", 1], ["rice", 1], ["salt", 1]]);
  let g = await guidance();
  assert(g.untried.techniques.includes("simmer") && g.untried.ingredients.includes("Lentils"));

  // undo the EARLIER cook as well: back to a blank map
  assertEquals((await post(`/cook/${c1}/correct`, { undo: true })).status, 200);
  assertEquals((await get("/explored")).json, { cuisines: [], techniques: [], ingredients: [] });
  assertEquals((await tasteRows()).explored_events, 0);
  g = await guidance();
  assert(g.untried.cuisines.includes("chinese"));

  // first_tried follows the surviving cook: cook A (Sept 1) then B (Sept 10); undo A -> first_tried = Sept 10
  const a = await cook(stirfry, { cooked_at: "2026-09-01T18:00:00Z" });
  await cook(stirfry, { cooked_at: "2026-09-10T18:00:00Z" });
  await post(`/cook/${a}/correct`, { undo: true });
  ex = (await get("/explored")).json;
  assertEquals(ex.cuisines[0].times, 1);
  assertEquals(new Date(ex.cuisines[0].first_tried).toISOString(), "2026-09-10T18:00:00.000Z");
});

test("explored: a correct (not undo) leaves the map alone; a refused cook (allergen 409) records nothing", async () => {
  const { ids, ana } = await kitchen();
  const paella = await seedRecipe({
    name: "Paella", cuisine: "Spanish", tags: ["technique:simmer"],
    ingredients: [{ pantry_item_id: ids["Rice"], name: "Rice", quantity: 300, unit: "g" }, { pantry_item_id: ids["Shrimp"], name: "Shrimp", quantity: 200, unit: "g" }],
  });
  const r = await post("/cook", { recipe_id: paella, servings: 4 });
  assertEquals(r.status, 409);
  assertEquals(r.json.conflicts[0].who, ana.label);
  const t = await tasteRows();
  assertEquals([t.explored, t.explored_events], [0, 0]);
});

// ------------------------------------------------------------------ evaluations

test("evaluation: stored with its fields, theme from the recipe; validation; unknown and undone cooks refused", async () => {
  const { stirfry, cy } = await kitchen();
  const c = await cook(stirfry);
  const r = await post("/evaluations", {
    cook_event_id: c, rating: 4, liked: true, why: "good heat", change: "less salt", who: "all",
    curiosity_q: "Try it with bok choy?", curiosity_a: "yes",
    exposures: [{ person_id: cy.id, subject: "Mushrooms", reaction: "tolerated" }, { subject: "wok hei", reaction: "liked" }],
  });
  assertEquals(r.status, 201);
  const e = r.json.evaluation;
  assertEquals([e.cook_event_id, e.rating, e.liked, e.why, e.change, e.who, e.curiosity_q, e.curiosity_a, e.theme, e.guest_meal],
    [c, 4, true, "good heat", "less salt", "all", "Try it with bok choy?", "yes", "weeknight", false]);
  assertEquals(r.json.exposures.length, 2);
  assertEquals(r.json.exposures[0].person_id, cy.id);
  assertEquals(r.json.exposures[1].person_id, null);

  assertEquals((await post("/evaluations", { cook_event_id: c, who: "all", rating: 6 })).status, 400);
  assertEquals((await post("/evaluations", { cook_event_id: c, who: "everyone" })).status, 400);
  assertEquals((await post("/evaluations", { cook_event_id: c })).status, 400); // who is required
  assertEquals((await post("/evaluations", { cook_event_id: c, who: "all", exposures: [{ subject: "x", reaction: "hated" }] })).status, 400);
  assertEquals((await post("/evaluations", { cook_event_id: "44444444-4444-4444-4444-444444444444", who: "all" })).status, 404);
  const before = await tasteRows();
  // an adult is not a valid exposure subject: nothing written (the evaluation row is rolled back too)
  const bo = (await get("/people")).json.people.find((p: J) => p.label === "Bo");
  assertEquals((await post("/evaluations", { cook_event_id: c, who: "all", exposures: [{ person_id: bo.id, subject: "x", reaction: "refused" }] })).status, 400);
  assertEquals(await tasteRows(), before);
  await post(`/cook/${c}/correct`, { undo: true });
  const u = await post("/evaluations", { cook_event_id: c, who: "all" });
  assertEquals(u.status, 409);
  assertEquals(u.json.error, "already_undone");
});

test("recent_evaluations: for the recipe, else the theme; shows the family's evaluation text", async () => {
  const { stirfry, ids } = await kitchen();
  const other = await seedRecipe({ name: "Lentil bowl", theme: "meatless", ingredients: [{ pantry_item_id: ids["Lentils"], name: "Lentils", quantity: 100, unit: "g" }] });
  const c1 = await cook(stirfry);
  const c2 = await cook(other);
  await post("/evaluations", { cook_event_id: c1, who: "adult", liked: true, why: "great" });
  await post("/evaluations", { cook_event_id: c2, who: "adult", liked: false, why: "dry" });
  assertEquals((await guidance()).recent_evaluations.length, 2);
  const th = (await guidance({ theme: "Weeknight" })).recent_evaluations;
  assertEquals(th.map((x: J) => x.why), ["great"]);
  assertEquals(th[0].recipe_name, "Mushroom stir-fry");
  const rc = (await guidance({ recipe_id: other })).recent_evaluations;
  assertEquals(rc.map((x: J) => x.why), ["dry"]);
});

// ------------------------------------------------------------------ preferences

test("preferences: unconfirmed is invisible to guidance; confirmed appears under its strength with subject/context/reason intact", async () => {
  await kitchen();
  const hard = await propose({ statement: "never cilantro", strength: "hard", subject: "cilantro" });
  const ctx = await propose({
    statement: "mushrooms were slimy in the stir-fry", strength: "contextual", subject: "mushrooms",
    context: "stir-fried", reason: "slimy texture when wet-cooked", scope: "theme",
  });
  const soft = await propose({ statement: "a bit bland", strength: "soft", subject: "seasoning" });
  for (const p of [hard, ctx, soft]) assertEquals([p.confirmed, p.active], [false, true]);
  let g = await guidance();
  assertEquals([g.hard.length, g.contextual.length, g.soft.length], [0, 0, 0]);
  // visible through GET /preferences with confirmed=false, not as confirmed
  assertEquals((await get("/preferences?active=true&confirmed=false")).json.preferences.length, 3);
  assertEquals((await get("/preferences?confirmed=true")).json.preferences.length, 0);

  // confirm hard + contextual only
  const c = await post("/preferences/confirm", { ids: [hard.id, ctx.id] });
  assertEquals(c.status, 200);
  assertEquals(c.json.confirmed.length, 2);
  g = await guidance();
  assertEquals(g.hard.map((p: J) => p.subject), ["cilantro"]);
  assertEquals(g.soft, [], "the unconfirmed soft preference stays invisible");
  assertEquals(g.contextual.length, 1);
  const cx = g.contextual[0];
  assertEquals([cx.subject, cx.context, cx.reason, cx.statement, cx.scope, cx.who, cx.strength],
    ["mushrooms", "stir-fried", "slimy texture when wet-cooked", "mushrooms were slimy in the stir-fry", "theme", "adult", "contextual"]);
  assertEquals(cx.confirmed, true);
  // a contextual dislike never makes the ingredient hard
  assert(!g.hard.some((p: J) => p.subject === "mushrooms"));
  assert(g.untried.ingredients.includes("Mushrooms"), "contextual is not an exclusion of the ingredient");
});

test("preferences: nothing is promoted to hard without a hard statement; contextual needs context or reason; evidence checked", async () => {
  const { stirfry } = await kitchen();
  assertEquals((await post("/preferences", { statements: [{ statement: "x", strength: "contextual", subject: "x", scope: "always", who: "adult" }] })).status, 400);
  assertEquals((await post("/preferences", { statements: [{ statement: "x", strength: "never", subject: "x", scope: "always", who: "adult" }] })).status, 400);
  assertEquals((await post("/preferences", { statements: [] })).status, 400);
  assertEquals((await post("/preferences", { statements: [{ statement: "x", strength: "soft", subject: "x", scope: "always", who: "adult", evidence: ["44444444-4444-4444-4444-444444444444"] }] })).status, 400);
  assertEquals((await get("/preferences")).json.preferences.length, 0, "a refused batch writes nothing");

  const c = await cook(stirfry);
  const ev = (await post("/evaluations", { cook_event_id: c, who: "adult", liked: false, why: "meh" })).json.evaluation;
  const soft = await propose({ statement: "dislike heavy salt", strength: "soft", subject: "salt", evidence: [ev.id] });
  assertEquals(soft.evidence, [ev.id]);
  // an edit cannot promote soft -> hard, nor contextual -> hard
  const bad = await post("/preferences/confirm", { ids: [soft.id], edits: { [soft.id]: { strength: "hard" } } });
  assertEquals(bad.status, 400);
  assertEquals((await get("/preferences")).json.preferences[0].confirmed, false);
  // demotion / other edits are fine and are what comes back out
  const ok = await post("/preferences/confirm", { ids: [soft.id], edits: { [soft.id]: { statement: "dislike very salty food", reason: "sodium", context: "sauces" } } });
  assertEquals(ok.status, 200);
  assertEquals([ok.json.confirmed[0].statement, ok.json.confirmed[0].strength, ok.json.confirmed[0].reason, ok.json.confirmed[0].context],
    ["dislike very salty food", "soft", "sodium", "sauces"]);
  assertEquals((await guidance()).hard, []);
  // an edit on an id that was not confirmed in this call is refused
  assertEquals((await post("/preferences/confirm", { ids: [soft.id], edits: { "44444444-4444-4444-4444-444444444444": {} } })).status, 400);
  // a stated child hard is hard (allergy-like) and stays tagged who=child
  const ch = await propose({ statement: "Cy never eats raw tomato", strength: "hard", subject: "raw tomato", who: "child" });
  await post("/preferences/confirm", { ids: [ch.id] });
  assertEquals((await guidance()).hard.map((p: J) => [p.subject, p.who]), [["raw tomato", "child"]]);
});

test("preferences: reject deactivates (never visible), a rejected one cannot be confirmed, unknown id is 404, who filter works", async () => {
  await kitchen();
  const a = await propose({ statement: "no olives", strength: "hard", subject: "olives" });
  const b = await propose({ statement: "dislike dill", strength: "soft", subject: "dill", who: "all" });
  const r = await post("/preferences/confirm", { ids: [b.id], reject: [a.id] });
  assertEquals(r.status, 200);
  assertEquals([r.json.confirmed.length, r.json.rejected.length], [1, 1]);
  assertEquals((await guidance()).hard, []);
  assertEquals((await get("/preferences?active=true")).json.preferences.map((p: J) => p.subject), ["dill"]);
  assertEquals((await get("/preferences?active=false")).json.preferences.map((p: J) => p.subject), ["olives"]);
  assertEquals((await get("/preferences?who=all")).json.preferences.map((p: J) => p.subject), ["dill"]);
  assertEquals((await post("/preferences/confirm", { ids: [a.id] })).status, 409);
  assertEquals((await post("/preferences/confirm", { ids: ["44444444-4444-4444-4444-444444444444"] })).status, 404);
  assertEquals((await post("/preferences/confirm", { ids: [a.id], reject: [a.id] })).status, 400);
  assertEquals((await post("/preferences/confirm", {})).status, 400);
});

test("hard exclusions are never offered as untried", async () => {
  await kitchen();
  const h = await propose({ statement: "never lentils", strength: "hard", subject: "Lentils" });
  assert((await guidance()).untried.ingredients.includes("Lentils"), "unconfirmed hard does not exclude");
  await post("/preferences/confirm", { ids: [h.id] });
  assert(!(await guidance()).untried.ingredients.includes("Lentils"));
});

// ------------------------------------------------------------------ allergens + guests

test("allergens_excluded: active household allergies plus guest_context.allergies, each with who; inactive ignored; nothing stored", async () => {
  const { ana } = await kitchen();
  await post("/people", { label: "Gran", role: "adult", allergies: ["peanut"], active: false });
  let g = await guidance();
  assertEquals(g.allergens_excluded, [{ allergen: "shellfish", who: ana.label }]);
  const before = await tasteRows();
  const snap = JSON.stringify((await get("/people")).json) + JSON.stringify((await get("/preferences")).json);
  g = await guidance({ guest_context: { adults: 2, allergies: ["Sesame", "SHELLFISH"], avoid: ["Lentils"] } });
  assertEquals(g.allergens_excluded, [
    { allergen: "shellfish", who: "Ana" }, { allergen: "sesame", who: "guest" }, { allergen: "shellfish", who: "guest" },
  ]);
  assertEquals(g.avoid_excluded, ["lentils"]);
  assert(!g.untried.ingredients.includes("Lentils") && !g.untried.ingredients.includes("Shrimp"));
  // the guest's allergy changed no stored row and is gone on the next call
  assertEquals(await tasteRows(), before);
  assertEquals(JSON.stringify((await get("/people")).json) + JSON.stringify((await get("/preferences")).json), snap);
  assertEquals((await guidance()).allergens_excluded, [{ allergen: "shellfish", who: "Ana" }]);
  assertEquals((await post("/guidance", { guest_context: { allergies: "peanut" } })).status, 400);
});

test("guest mode is never learned: guest cook + evaluation + exposures leave preferences/hypotheses/exposures and guidance untouched", async () => {
  const { stirfry, cy } = await kitchen();
  // some real history so 'identical' means something
  const c0 = await cook(stirfry);
  const e0 = (await post("/evaluations", { cook_event_id: c0, who: "all", liked: true, why: "good" })).json.evaluation;
  const p = await propose({ statement: "dislike dill", strength: "soft", subject: "dill" });
  await post("/preferences/confirm", { ids: [p.id] });
  const h = (await post("/hypotheses", { statement: "likes umami" })).json;
  await post(`/hypotheses/${h.id}/evidence`, { supports: true, evaluation_id: e0.id });
  await post("/evaluations", { cook_event_id: c0, who: "child", exposures: [{ person_id: cy.id, subject: "mushrooms", reaction: "refused", at: new Date().toISOString() }] });

  const beforeG = await guidance();
  const before = await tasteRows();

  // the guest meal: a NEW cuisine, so explored legitimately changes
  const curry = await seedRecipe({ name: "Guest curry", cuisine: "Indian", tags: ["technique:braise"], ingredients: [{ name: "Lentils", quantity: 200, unit: "g" }] });
  const gc = await cook(curry, { guest_context: { adults: 2, allergies: ["sesame"], diet: ["vegetarian"], note: "loves coriander, hates mushrooms" } });
  const ev = await post("/evaluations", {
    cook_event_id: gc, who: "all", liked: false, why: "the guest hated it", curiosity_a: "guest says no mushrooms",
    exposures: [{ person_id: cy.id, subject: "lentils", reaction: "refused" }],
  });
  assertEquals(ev.status, 201);
  assertEquals(ev.json.evaluation.guest_meal, true);
  assertEquals(ev.json.exposures, []);
  assertEquals(ev.json.exposures_skipped, { count: 1, reason: "guest_meal" });
  // a guest-meal evaluation cannot be hypothesis evidence
  const he = await post(`/hypotheses/${h.id}/evidence`, { supports: false, evaluation_id: ev.json.evaluation.id });
  assertEquals(he.status, 400);
  assertEquals(he.json.reason, "guest_meal");

  const after = await tasteRows();
  assertEquals(after.prefs, before.prefs);
  assertEquals(after.hyps, before.hyps);
  assertEquals(after.evidence, before.evidence);
  assertEquals(after.exposures, before.exposures);
  assertEquals(after.evals, before.evals + 1, "the family's evaluation of the meal IS recorded");
  // explored IS updated: trying a dish is a fact
  const afterG = await guidance();
  assertEquals(JSON.stringify(learned(afterG)), JSON.stringify(learned(beforeG)));
  assertEquals((await get("/explored")).json.cuisines.map((x: J) => x.value).sort(), ["chinese", "indian"]);
  assert(!afterG.untried.cuisines.includes("indian") && !afterG.untried.techniques.includes("braise"));
  // and the same guidance with the guest's constraints repeated learns nothing either
  await guidance({ guest_context: { allergies: ["sesame"] } });
  assertEquals(JSON.stringify(learned(await guidance())), JSON.stringify(learned(beforeG)));
});

// ------------------------------------------------------------------ child cooldown + trends

test("child cooldown: refused at T lists the subject until T + child_cooldown_days, exact boundary on both sides", async () => {
  const { stirfry, cy } = await kitchen();
  const c = await cook(stirfry);
  const T = "2026-03-01T12:00:00.000Z";
  const r = await post("/evaluations", { cook_event_id: c, who: "child", exposures: [{ person_id: cy.id, subject: "Mushrooms", reaction: "refused", at: T }] });
  assertEquals(r.status, 201);
  assertEquals((await get("/settings")).json.child_cooldown_days, 7);

  const at = async (now: string) => (await guidance({ now })).child_cooldowns;
  assertEquals(await at("2026-03-01T12:00:00.000Z"), [{ subject: "Mushrooms", until: "2026-03-08T12:00:00.000Z" }]);
  assertEquals(await at("2026-03-08T11:59:59.000Z"), [{ subject: "Mushrooms", until: "2026-03-08T12:00:00.000Z" }], "one second before the end: still listed");
  assertEquals(await at("2026-03-08T12:00:00.000Z"), [], "exactly T + 7 days: no longer listed");
  assertEquals(await at("2026-03-08T12:00:01.000Z"), []);
  assertEquals(await at("2026-03-10T12:00:00.000Z"), []);
  // the day-granularity traps: 6 days 23 h and 7 days 1 h
  assertEquals((await at("2026-03-08T11:00:00.000Z")).length, 1);
  assertEquals((await at("2026-03-08T13:00:00.000Z")).length, 0);

  // the setting is honoured, not a constant
  await post("/people", { id: cy.id, label: "Cy", role: "child" }); // unrelated write
  await api("PUT", "/settings", { child_cooldown_days: 3 });
  assertEquals(await at("2026-03-04T11:59:59.000Z"), [{ subject: "Mushrooms", until: "2026-03-04T12:00:00.000Z" }]);
  assertEquals(await at("2026-03-04T12:00:00.000Z"), []);
  await api("PUT", "/settings", { child_cooldown_days: 7 });

  // a later 'tolerated' (re-exposure) ends the cooldown early; a later 'refused' restarts it
  await post("/evaluations", { cook_event_id: c, who: "child", exposures: [{ person_id: cy.id, subject: "mushrooms", reaction: "tolerated", at: "2026-03-05T12:00:00Z" }] });
  assertEquals(await at("2026-03-06T00:00:00.000Z"), []);
  await post("/evaluations", { cook_event_id: c, who: "child", exposures: [{ person_id: cy.id, subject: "MUSHROOMS", reaction: "refused", at: "2026-03-20T00:00:00Z" }] });
  assertEquals((await at("2026-03-26T23:59:59.000Z")).length, 1);
  assertEquals((await at("2026-03-27T00:00:00.000Z")).length, 0);
});

test("child_trends counts refused/tolerated/liked per subject; adult lists are untouched by child exposures", async () => {
  const { stirfry, cy } = await kitchen();
  const hard = await propose({ statement: "never cilantro", strength: "hard", subject: "cilantro" });
  const ctx = await propose({ statement: "no mushrooms stir-fried", strength: "contextual", subject: "mushrooms", context: "stir-fried", reason: "slimy" });
  const soft = await propose({ statement: "milder please", strength: "soft", subject: "spice" });
  await post("/preferences/confirm", { ids: [hard.id, ctx.id, soft.id] });
  const adultBefore = (({ hard, contextual, soft }) => JSON.stringify({ hard, contextual, soft }))(await guidance());

  const c = await cook(stirfry);
  const base = Date.UTC(2026, 2, 1);
  const x = (reaction: string, day: number, subject = "mushrooms") => ({ person_id: cy.id, subject, reaction, at: new Date(base + day * 86_400_000).toISOString() });
  await post("/evaluations", { cook_event_id: c, who: "child", exposures: [x("refused", 0), x("refused", 8), x("tolerated", 16), x("liked", 24), x("tolerated", 25), x("refused", 0, "rice")] });
  const g = await guidance({ now: new Date(base + 26 * 86_400_000).toISOString() });
  const tr = Object.fromEntries(g.child_trends.map((t: J) => [t.subject, t]));
  assertEquals(tr["mushrooms"].exposures, { refused: 2, tolerated: 2, liked: 1 });
  assertEquals(tr["mushrooms"].last_reaction, "tolerated");
  assertEquals(new Date(tr["mushrooms"].last_at).toISOString(), new Date(base + 25 * 86_400_000).toISOString());
  assertEquals(tr["rice"].exposures, { refused: 1, tolerated: 0, liked: 0 });
  assertEquals(g.child_cooldowns, [], "latest mushrooms exposure is tolerated; rice's cooldown ended days ago");
  assertEquals((({ hard, contextual, soft }) => JSON.stringify({ hard, contextual, soft }))(g), adultBefore);
  // a child 'hard'/contextual preference list is not created by exposures
  assertEquals((await get("/preferences")).json.preferences.length, 3);
});

test("exposures from an undone cook stop counting", async () => {
  const { stirfry, cy } = await kitchen();
  const c = await cook(stirfry);
  await post("/evaluations", { cook_event_id: c, who: "child", exposures: [{ person_id: cy.id, subject: "mushrooms", reaction: "refused" }] });
  assertEquals((await guidance()).child_cooldowns.length, 1);
  await post(`/cook/${c}/correct`, { undo: true });
  const g = await guidance();
  assertEquals([g.child_cooldowns, g.child_trends, g.recent_evaluations], [[], [], []]);
});

// ------------------------------------------------------------------ hypotheses

test("hypotheses: support/against counted once per evidence call (+1, never +2), last_tested set, refused calls change nothing", async () => {
  const { stirfry } = await kitchen();
  const h = await post("/hypotheses", { statement: "likes bright, acidic dishes" });
  assertEquals(h.status, 201);
  assertEquals([h.json.support, h.json.against, h.json.last_tested], [0, 0, null]);
  assertEquals((await post("/hypotheses", { statement: "LIKES bright, acidic dishes" })).status, 200, "same statement is the same hypothesis");
  assertEquals((await get("/hypotheses")).json.hypotheses.length, 1);

  const evs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await cook(stirfry);
    evs.push((await post("/evaluations", { cook_event_id: c, who: "all", liked: true })).json.evaluation.id);
  }
  const r1 = await post(`/hypotheses/${h.json.id}/evidence`, { supports: true, evaluation_id: evs[0] });
  assertEquals(r1.status, 200);
  assertEquals([r1.json.support, r1.json.against], [1, 0]);
  assert(r1.json.last_tested && !Number.isNaN(Date.parse(r1.json.last_tested)));
  const r2 = await post(`/hypotheses/${h.json.id}/evidence`, { supports: false, evaluation_id: evs[1] });
  assertEquals([r2.json.support, r2.json.against], [1, 1]);
  const r3 = await post(`/hypotheses/${h.json.id}/evidence`, { supports: true, evaluation_id: evs[2] });
  assertEquals([r3.json.support, r3.json.against], [2, 1]);
  // exactly ONE increment per call: a refused call (bad body, unknown evaluation) changes nothing
  assertEquals((await post(`/hypotheses/${h.json.id}/evidence`, { supports: true })).status, 400);
  assertEquals((await post(`/hypotheses/${h.json.id}/evidence`, { supports: true, evaluation_id: "44444444-4444-4444-4444-444444444444" })).status, 404);
  const g = (await get("/hypotheses")).json.hypotheses[0];
  assertEquals([g.support, g.against], [2, 1]);
  assertEquals((await guidance()).hypotheses.map((x: J) => [x.statement, x.support, x.against]), [["likes bright, acidic dishes", 2, 1]]);
  // errors
  assertEquals((await post(`/hypotheses/${h.json.id}/evidence`, { supports: "yes", evaluation_id: evs[0] })).status, 400);
  assertEquals((await post(`/hypotheses/${h.json.id}/evidence`, { supports: true, evaluation_id: "44444444-4444-4444-4444-444444444444" })).status, 404);
  assertEquals((await post(`/hypotheses/44444444-4444-4444-4444-444444444444/evidence`, { supports: true, evaluation_id: evs[0] })).status, 404);
  assertEquals((await post("/hypotheses", { statement: "  " })).status, 400);
});

// ------------------------------------------------------------------ guidance extras

test("guidance: use_soon lists expiring stock; untried ingredients drop tried and allergen-bearing items", async () => {
  await kitchen();
  const g = await guidance();
  assertEquals(g.use_soon.map((u: J) => u.name), ["Fennel"]);
  assertEquals(g.use_soon[0].quantity, 3);
  assert(g.untried.ingredients.includes("Lentils"));
  assert(!g.untried.ingredients.includes("Shrimp"), "Ana is allergic to shellfish: never offered as something to try");
});

test("guidance never writes: calling it repeatedly (with and without a guest) leaves every taste table as it was", async () => {
  const { stirfry } = await kitchen();
  await cook(stirfry);
  const before = await tasteRows();
  for (const body of [{}, { theme: "x" }, { guest_context: { adults: 3, allergies: ["egg"], avoid: ["rice"] } }]) await guidance(body);
  assertEquals(await tasteRows(), before);
  assertNotEquals(before.explored, 0);
});

Deno.test({ name: "zz close pools", sanitizeOps: false, sanitizeResources: false, fn: close });
