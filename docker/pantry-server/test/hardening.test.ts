// pantry-hardening: the DATABASE keeps taste data single-valued and exposures ordered.
//   - one evaluation per (cook, who): unique index ux_pantry_evaluations_cook_who
//   - one hypothesis per (user, lower(statement)): unique index + INSERT .. ON CONFLICT
//   - exposures order by (at, seq); ctid (physical position) is never the tie-break
// The "init applied twice on a 0c9976a DB with data / seeded duplicate fails loudly" cases need a
// second database and live in run-tests.ps1 section [2b].
import { assert, assertEquals } from "@std/assert";
import { admin, adminExec, close, get, post, seedItems, seedRecipe, test, USER_ID, type J } from "./helpers.ts";

async function kitchen() {
  const cy = (await post("/people", { label: "Cy", role: "child", birth_month: "2022-04" })).json;
  await seedItems([{ name: "Rice", quantity: 5000, unit: "g" }]);
  const recipe = await seedRecipe({ name: "Rice bowl", theme: "weeknight", ingredients: [{ name: "Rice", quantity: 100, unit: "g" }] });
  return { cy, recipe };
}
async function cook(recipe: string) {
  const r = await post("/cook", { recipe_id: recipe, servings: 4 });
  assertEquals(r.status, 201, JSON.stringify(r.json));
  return r.json.cook_event_id as string;
}

test("parallel identical evaluations: exactly one 201, the rest 409 already_evaluated with the winner's id, one row", async () => {
  const { recipe } = await kitchen();
  for (let round = 0; round < 3; round++) {
    const c = await cook(recipe);
    const rs = await Promise.all(Array.from({ length: 8 }, () => post("/evaluations", { cook_event_id: c, who: "adult", liked: true })));
    assertEquals(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
    assertEquals(rs.filter((r) => r.status === 409).length, 7, JSON.stringify(rs.map((r) => r.json)));
    const winner = rs.find((r) => r.status === 201)!.json.evaluation.id;
    for (const r of rs.filter((x) => x.status === 409)) {
      assertEquals(r.json.error, "already_evaluated");
      assertEquals(r.json.evaluation_id, winner);
    }
    assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_evaluations WHERE cook_event_id = $1`, [c]))[0].n, 1);
  }
});

test("the evaluations unique index is the guard on its own (no service lock involved)", async () => {
  const { recipe } = await kitchen();
  const c = await cook(recipe);
  await admin(`INSERT INTO pantry_evaluations (user_id, cook_event_id, who) VALUES ($1,$2,'adult')`, [USER_ID, c]);
  let code = "";
  try {
    await admin(`INSERT INTO pantry_evaluations (user_id, cook_event_id, who) VALUES ($1,$2,'adult')`, [USER_ID, c]);
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    code = (e as any)?.fields?.code ?? "";
  }
  assertEquals(code, "23505");
  await admin(`INSERT INTO pantry_evaluations (user_id, cook_event_id, who) VALUES ($1,$2,'child')`, [USER_ID, c]); // other who is fine
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_evaluations`))[0].n, 2);
});

test("parallel identical hypotheses (case/whitespace variants) create exactly one row; the response names it", async () => {
  const variants = ["likes wok dishes", "Likes Wok Dishes", "  LIKES WOK DISHES  ", "likes wok dishes "];
  for (let round = 0; round < 3; round++) {
    const stmt = (i: number) => variants[i % variants.length].replace(/wok/i, "wok" + round);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => post("/hypotheses", { statement: stmt(i) })));
    assertEquals(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
    assertEquals(rs.filter((r) => r.status === 200).length, 7);
    const win = rs.find((r) => r.status === 201)!.json;
    assertEquals(win.duplicate, false);
    for (const r of rs.filter((x) => x.status === 200)) {
      assertEquals(r.json.duplicate, true);
      assertEquals(r.json.id, win.id);
    }
  }
  assertEquals((await get("/hypotheses")).json.hypotheses.length, 3);
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_taste_hypotheses`))[0].n, 3);
});

test("exposure ties across calls: the later-RECORDED wins even when its ctid is lower (slot reuse after VACUUM)", async () => {
  const { cy, recipe } = await kitchen();
  await admin(
    `INSERT INTO pantry_exposures (user_id, subject, reaction, at) SELECT $1, 'filler-' || g, 'liked', now() FROM generate_series(1,4) g`,
    [USER_ID],
  );
  // free ONE low slot (3rd filler), record A into it; free an even lower slot (1st filler), record B into that
  await admin(`DELETE FROM pantry_exposures WHERE subject = 'filler-3'`);
  await adminExec(`VACUUM pantry_exposures`);
  const at = new Date().toISOString();
  const c1 = await cook(recipe);
  const a = await post("/evaluations", { cook_event_id: c1, who: "all", exposures: [{ person_id: cy.id, subject: "Mushrooms", reaction: "refused", at }] });
  assertEquals(a.status, 201, JSON.stringify(a.json));
  await admin(`DELETE FROM pantry_exposures WHERE subject = 'filler-1'`);
  await adminExec(`VACUUM pantry_exposures`);
  const c2 = await cook(recipe);
  const b = await post("/evaluations", { cook_event_id: c2, who: "child", exposures: [{ person_id: cy.id, subject: "Mushrooms", reaction: "tolerated", at }] });
  assertEquals(b.status, 201, JSON.stringify(b.json));
  const rows = await admin(`SELECT reaction, ctid::text AS c FROM pantry_exposures WHERE subject = 'Mushrooms'`);
  const A = rows.find((r: J) => r.reaction === "refused")!, B = rows.find((r: J) => r.reaction === "tolerated")!;
  const pos = (s: string) => parseInt(s.split(",")[1], 10);
  assert(pos(B.c) < pos(A.c), `precondition: later row must sit physically earlier (A ${A.c}, B ${B.c})`);
  const g = (await post("/guidance", {})).json;
  assertEquals(g.child_cooldowns, [], "tolerated was recorded later, so it is the latest exposure: no cooldown");
  const sq = await admin(`SELECT reaction, seq::int AS seq FROM pantry_exposures WHERE subject = 'Mushrooms'`);
  assert(sq.find((r: J) => r.reaction === "tolerated")!.seq > sq.find((r: J) => r.reaction === "refused")!.seq, "seq is insertion order");
  // and the other direction: refused recorded later wins
  const c3 = await cook(recipe), c4 = await cook(recipe);
  const at2 = new Date().toISOString();
  await post("/evaluations", { cook_event_id: c3, who: "all", exposures: [{ person_id: cy.id, subject: "Beets", reaction: "tolerated", at: at2 }] });
  await post("/evaluations", { cook_event_id: c4, who: "child", exposures: [{ person_id: cy.id, subject: "Beets", reaction: "refused", at: at2 }] });
  assertEquals((await post("/guidance", {})).json.child_cooldowns.map((x: J) => x.subject), ["Beets"]);
});

test("pantry_exposures.seq: identity column, ob_pantry inserts without a sequence grant, API shape unchanged", async () => {
  const { cy, recipe } = await kitchen();
  const c = await cook(recipe);
  const r = await post("/evaluations", { cook_event_id: c, who: "child", exposures: [{ person_id: cy.id, subject: "x", reaction: "liked" }, { person_id: cy.id, subject: "y", reaction: "liked" }] });
  assertEquals(r.status, 201);
  assertEquals(Object.keys(r.json.exposures[0]).includes("seq"), false, "response shape unchanged");
  const s = await admin(`SELECT seq::int AS s FROM pantry_exposures ORDER BY seq`);
  assertEquals(s.length, 2);
  assert(s[1].s > s[0].s);
  const col = await admin(`SELECT is_identity, identity_generation FROM information_schema.columns WHERE table_name='pantry_exposures' AND column_name='seq'`);
  assertEquals([col[0].is_identity, col[0].identity_generation], ["YES", "ALWAYS"]);
});

test("a unique violation raised INSIDE a transaction is the generic 409 conflict, not a 500 (pgCode reads e.cause)", async () => {
  await adminExec(`CREATE OR REPLACE FUNCTION t_dupe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced duplicate' USING ERRCODE = '23505'; END $$;
    DROP TRIGGER IF EXISTS t_force_unique ON pantry_items;
    CREATE TRIGGER t_force_unique BEFORE INSERT ON pantry_items FOR EACH ROW EXECUTE FUNCTION t_dupe();`);
  try {
    const r = await post("/pantry/adjust", { reason: "manual", items: [{ create: true, name: "Rice", quantity: 5, unit: "g" }] });
    assertEquals(r.status, 409, JSON.stringify(r.json));
    assertEquals(r.json.error, "conflict");
    assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_items`))[0].n, 0, "nothing written");
  } finally {
    await adminExec(`DROP TRIGGER IF EXISTS t_force_unique ON pantry_items`);
  }
});

Deno.test({ name: "zz close pools (hardening)", sanitizeOps: false, sanitizeResources: false, fn: close });
