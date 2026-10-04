import { assert, assertEquals } from "@std/assert";
import { admin, adminExec, close, counts, get, near, post, qty, seedItems, seedRecipe, test } from "./helpers.ts";

async function sheetItems() {
  return await seedItems([
    { name: "Rice", quantity: 1000, unit: "g", category: "grains" },
    { name: "Flour", quantity: 500, unit: "g" },
    { name: "Salt", kind: "staple", level: "plenty" },
    { name: "Sugar", quantity: 300, unit: "g" },
    { name: "Chickpeas", quantity: 400, unit: "g" },
    { name: "Oats", quantity: 300, unit: "g" },
  ]);
}

const previewBody = (ids: Record<string, string>) => ({
  source: "csv", file_name: "pantry.csv",
  rows: [
    { id: ids["Rice"], name: "Rice", quantity: 900, unit: "g" },
    { name: "flour", quantity: 0.5, unit: "kg" },
    { name: "Salt", level: "low" },
    { name: "Pasta", quantity: 200, unit: "g" },
    { name: "chickpea", quantity: 100, unit: "g" },
    { name: "Oats", quantity: 2, unit: "count" },
  ],
});

test("audit preview writes NOTHING to the pantry and classifies every row", async () => {
  const ids = await sheetItems();
  const before = await counts();
  const p = await post("/audit/preview", previewBody(ids));
  assertEquals(p.status, 200);
  assertEquals(await counts(), before);
  assertEquals((await admin(`SELECT count(*)::int AS n FROM pantry_audit_previews`))[0].n, 1);
  assert(p.json.preview_id);
  assertEquals(p.json.changed.map((c: { name: string }) => c.name).sort(), ["Rice", "Salt"]);
  const rice = p.json.changed.find((c: { name: string }) => c.name === "Rice");
  assertEquals(rice, { id: ids["Rice"], name: "Rice", expected: 1000, actual: 900, delta: -100, unit: "g" });
  const salt = p.json.changed.find((c: { name: string }) => c.name === "Salt");
  assertEquals([salt.expected, salt.actual], ["plenty", "low"]);
  assertEquals(p.json.new.map((n: { name: string }) => n.name), ["Pasta"]);
  assertEquals(p.json.missing.map((m: { name: string }) => m.name).sort(), ["Chickpeas", "Sugar"]);
  assertEquals(p.json.unmatched.length, 1);
  assertEquals(p.json.unmatched[0].name, "chickpea");
  assertEquals(p.json.unmatched[0].candidates[0].name, "Chickpeas");
  assertEquals(p.json.unconvertible.length, 1);
  assertEquals(p.json.unconvertible[0].name, "Oats");
  assertEquals((await get("/pantry")).json.items.length, 6); // no Pasta yet
});

test("audit commit: audit + lines with expected/actual/delta; missing is KEPT unless decided; unmatched/unconvertible not written", async () => {
  const ids = await sheetItems();
  const p = await post("/audit/preview", previewBody(ids));
  const c = await post("/audit/commit", { preview_id: p.json.preview_id });
  assertEquals(c.status, 201);
  assertEquals(c.json.items_changed, 3); // Rice, Salt, Pasta
  assertEquals(c.json.items_checked, 6); // Rice, Flour, Salt + Pasta + Sugar, Chickpeas missing + Oats? (Oats row was unconvertible)
  assertEquals(await qty("Rice"), 900);
  assertEquals(await qty("Sugar"), 300); // missing from the sheet: kept, not zeroed
  assertEquals(await qty("Chickpeas"), 400);
  assertEquals(await qty("Oats"), 300);
  assertEquals(await qty("Pasta"), 200);
  assertEquals((await admin(`SELECT level FROM pantry_items WHERE name='Salt'`))[0].level, "low");
  const line = (await admin(`SELECT expected::float8 AS e, actual::float8 AS a, delta::float8 AS d, unit FROM pantry_audit_lines WHERE audit_id=$1 AND item_id=$2`, [c.json.audit_id, ids["Rice"]]))[0];
  assertEquals(line, { e: 1000, a: 900, d: -100, unit: "g" });
  const flourLine = (await admin(`SELECT delta::float8 AS d FROM pantry_audit_lines WHERE audit_id=$1 AND item_id=$2`, [c.json.audit_id, ids["Flour"]]))[0];
  assertEquals(flourLine.d, 0); // checked and right: still evidence for the accuracy report
  const led = await admin(`SELECT reason, count(*)::int AS n FROM pantry_adjustments WHERE audit_id=$1 GROUP BY reason`, [c.json.audit_id]);
  assertEquals(led, [{ reason: "audit", n: 3 }]);
  const a = (await admin(`SELECT source, file_name, items_checked, items_changed FROM pantry_audits WHERE id=$1`, [c.json.audit_id]))[0];
  assertEquals(a, { source: "csv", file_name: "pantry.csv", items_checked: 6, items_changed: 3 });
  // a preview is single-use
  assertEquals((await post("/audit/commit", { preview_id: p.json.preview_id })).status, 409);
});

test("audit commit: explicit zero / remove for missing rows, exclude, expired and unknown previews", async () => {
  const ids = await sheetItems();
  const rows = [{ id: ids["Rice"], name: "Rice", quantity: 900, unit: "g" }];
  const p = await post("/audit/preview", { source: "chat", rows });
  assertEquals(p.json.missing.length, 5);
  const c = await post("/audit/commit", { preview_id: p.json.preview_id, missing: { [ids["Sugar"]]: "zero", [ids["Oats"]]: "remove", [ids["Salt"]]: "zero" }, exclude: [ids["Rice"]] });
  assertEquals(c.status, 201);
  assertEquals(await qty("Rice"), 1000); // excluded
  assertEquals(await qty("Sugar"), 0);
  assertEquals(await qty("Flour"), 500); // no decision -> kept
  assertEquals((await admin(`SELECT level FROM pantry_items WHERE name='Salt'`))[0].level, "out");
  assertEquals((await get("/pantry")).json.items.some((i: { name: string }) => i.name === "Oats"), false);
  const sl = (await admin(`SELECT expected::float8 AS e, actual::float8 AS a, delta::float8 AS d FROM pantry_audit_lines WHERE audit_id=$1 AND item_id=$2`, [c.json.audit_id, ids["Sugar"]]))[0];
  assertEquals(sl, { e: 300, a: 0, d: -300 });

  const p2 = await post("/audit/preview", { source: "csv", rows });
  await adminExec(`UPDATE pantry_audit_previews SET expires_at = now() - interval '1 hour' WHERE id = '${p2.json.preview_id}'`);
  const exp = await post("/audit/commit", { preview_id: p2.json.preview_id });
  assertEquals(exp.status, 410);
  assertEquals(exp.json.error, "preview_expired");
  assertEquals((await post("/audit/commit", { preview_id: "44444444-4444-4444-4444-444444444444" })).status, 404);
  const p3 = await post("/audit/preview", { source: "csv", rows });
  assertEquals((await post("/audit/commit", { preview_id: p3.json.preview_id, missing: { [ids["Rice"]]: "zero" } })).status, 400); // not a missing item
  assertEquals((await post("/audit/preview", { source: "photo", rows })).status, 400);
});

test("audit: new:true forces a new item where only a similar name exists; unknown id and duplicate rows are returned", async () => {
  const ids = await sheetItems();
  const p = await post("/audit/preview", { source: "chat", rows: [
    { name: "chickpea", quantity: 5, unit: "g", new: true },
    { id: "55555555-5555-5555-5555-555555555555", name: "Ghost", quantity: 1, unit: "g" },
    { id: ids["Rice"], quantity: 1000, unit: "g" },
    { name: "rice", quantity: 1000, unit: "g" },
  ] });
  assertEquals(p.json.new.map((n: { name: string }) => n.name), ["chickpea"]);
  assertEquals(p.json.unmatched.map((u: { reason: string }) => u.reason).sort(), ["duplicate_row", "unknown_id"]);
});

test("accuracy: the four gap kinds from seeded cooks and audits", async () => {
  const ids = await seedItems([
    { name: "Olive oil", quantity: 1000, unit: "ml" }, { name: "Rice", quantity: 2000, unit: "g" }, { name: "Flour", quantity: 500, unit: "g" },
  ]);
  const chili = await seedRecipe({ name: "Chili", ingredients: [
    { pantry_item_id: ids["Olive oil"], name: "Olive oil", quantity: 50, unit: "ml" },
    { pantry_item_id: ids["Rice"], name: "Rice", quantity: 100, unit: "g" },
  ] });
  await post("/cook", { recipe_id: chili, servings: 4 });
  await post("/cook", { recipe_id: chili, servings: 4, logged_after: true });
  const audit = async (o: number, r: number, f: number) => {
    const p = await post("/audit/preview", { source: "csv", rows: [
      { id: ids["Olive oil"], name: "Olive oil", quantity: o, unit: "ml" },
      { id: ids["Rice"], name: "Rice", quantity: r, unit: "g" },
      { id: ids["Flour"], name: "Flour", quantity: f, unit: "g" },
    ] });
    const c = await post("/audit/commit", { preview_id: p.json.preview_id });
    assertEquals(c.status, 201);
  };
  await audit(800, 1700, 600); // expected 900 / 1800 / 500
  await audit(650, 1500, 700); // expected 800 / 1700 / 600
  const a = await get("/accuracy");
  assertEquals(a.status, 200);
  assertEquals(a.json.audits, 2);
  const it = Object.fromEntries(a.json.items.map((i: { name: string }) => [i.name, i]));
  assertEquals(it["Olive oil"].audits, 2);
  assertEquals(it["Olive oil"].mean_delta, -125);
  assertEquals(it["Olive oil"].direction, "under");
  near(it["Olive oil"].mean_delta_pct, -14.93, 0.01);
  assertEquals(it["Flour"].direction, "over");
  assertEquals(it["Flour"].mean_delta, 100);
  const kinds = (k: string) => a.json.gaps.filter((g: { kind: string }) => g.kind === k);
  assertEquals(kinds("consistent_drift").map((g: { evidence: { name: string } }) => g.evidence.name).sort(), ["Flour", "Olive oil", "Rice"]);
  assertEquals(kinds("logged_after")[0].evidence, { count: 1, total_cooks: 2, share: 0.5 });
  assertEquals(kinds("never_restocked").map((g: { evidence: { name: string } }) => g.evidence.name).sort(), ["Olive oil", "Rice"]);
  const ru = kinds("recipe_understates");
  assertEquals(ru.map((g: { evidence: { name: string } }) => g.evidence.name).sort(), ["Olive oil", "Rice"]);
  assertEquals(ru[0].evidence.recipes[0].name, "Chili");

  // a real restock removes the item from never_restocked
  await adminExec(`INSERT INTO pantry_adjustments (user_id,item_id,delta,reason) SELECT user_id,id,100,'restock' FROM pantry_items WHERE name='Olive oil'`);
  const b = await get("/accuracy");
  assertEquals(b.json.gaps.filter((g: { kind: string }) => g.kind === "never_restocked").map((g: { evidence: { name: string } }) => g.evidence.name), ["Rice"]);
  // a window with nothing in it reports nothing
  const none = await get("/accuracy?since=2999-01-01");
  assertEquals(none.json.audits, 0);
  assertEquals(none.json.gaps, []);
  assertEquals((await get("/accuracy?since=garbage")).status, 400);
});

test("accuracy: no audits -> no items, no drift gaps (a single audit is not a pattern)", async () => {
  const ids = await seedItems([{ name: "Rice", quantity: 1000, unit: "g" }]);
  assertEquals((await get("/accuracy")).json, { audits: 0, items: [], gaps: [] });
  const p = await post("/audit/preview", { source: "csv", rows: [{ id: ids["Rice"], name: "Rice", quantity: 900, unit: "g" }] });
  await post("/audit/commit", { preview_id: p.json.preview_id });
  const a = await get("/accuracy");
  assertEquals(a.json.items.length, 1);
  assertEquals(a.json.gaps, []);
});

Deno.test({ name: "zz close pools", sanitizeOps: false, sanitizeResources: false, fn: close });
