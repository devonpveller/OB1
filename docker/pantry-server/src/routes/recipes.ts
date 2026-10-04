// POST /recipes (create or NEW revision), GET /recipes, GET /recipes/:id
import type { Hono } from "hono";
import type { Deps } from "../app.ts";
import { readBody } from "../app.ts";
import {
  findAllergenConflicts, invalid, isObj, isUuid, lc, loadItems, matchRef, notFound, optBool, optNum, optStr,
  optStrArr, reqStr, type Ingredient, type Item, type Row,
} from "../core.ts";

const RECIPE_COLS = `id, name, theme, cuisine, servings, ingredients, instructions, tags, source, rotation, draft,
  current_revision, created_at, updated_at`;

function parseIngredients(v: unknown): Ingredient[] {
  if (!Array.isArray(v)) throw invalid("ingredients must be an array");
  return v.map((raw, n) => {
    const w = `ingredients[${n}]`;
    if (!isObj(raw)) throw invalid(`${w} must be an object`);
    const name = reqStr(raw.name, `${w}.name`);
    const quantity = optNum(raw.quantity, `${w}.quantity`);
    if (quantity !== undefined && quantity < 0) throw invalid(`${w}.quantity must be >= 0`);
    if (raw.pantry_item_id !== undefined && raw.pantry_item_id !== null && !isUuid(raw.pantry_item_id)) {
      throw invalid(`${w}.pantry_item_id must be a UUID`);
    }
    return {
      pantry_item_id: (raw.pantry_item_id as string | undefined) ?? null,
      name,
      quantity: quantity ?? null,
      unit: optStr(raw.unit, `${w}.unit`) || null,
      staple: optBool(raw.staple, `${w}.staple`) === true,
    };
  });
}

/** Attach pantry ids where the match is exact; report the rest. Never fuzzy. */
export function bindIngredients(ings: Ingredient[], items: Item[]) {
  const stored: Ingredient[] = [];
  const unmatched: Row[] = [];
  const resolved: { ingredient: string; item: Item }[] = [];
  for (const ing of ings) {
    const m = matchRef(items, { id: ing.pantry_item_id, name: ing.name });
    if (m.item) {
      stored.push({ ...ing, pantry_item_id: m.item.id });
      resolved.push({ ingredient: ing.name, item: m.item });
    } else {
      stored.push({ ...ing, pantry_item_id: null });
      unmatched.push({ name: ing.name, candidates: m.candidates, ...(m.ambiguous ? { ambiguous: true } : {}) });
    }
  }
  return { stored, unmatched, resolved };
}

export function registerRecipes(app: Hono, d: Deps) {
  app.post("/recipes", async (c) => {
    const b = await readBody(c);
    if (b.id !== undefined && !isUuid(b.id)) throw invalid("id must be a UUID");
    const name = reqStr(b.name, "name");
    const servings = optNum(b.servings, "servings");
    if (servings === undefined || !Number.isInteger(servings) || servings < 1) throw invalid("servings must be an integer >= 1");
    const ings = parseIngredients(b.ingredients ?? []);
    const instructions = optStrArr(b.instructions, "instructions") ?? [];
    const source = b.source;
    if (source !== "generated" && source !== "household") throw invalid('source must be "generated" or "household"');
    const tags = optStrArr(b.tags, "tags") ?? [];
    const cuisine = optStr(b.cuisine, "cuisine") ?? null;
    const theme = optStr(b.theme, "theme") ?? null;
    const rotation = optBool(b.rotation, "rotation");
    const draft = optBool(b.draft, "draft");
    const reason = optStr(b.reason, "reason") ?? null;

    const out = await d.db.tx(async (t) => {
      const items = await loadItems(t, d.userId);
      const { stored, unmatched, resolved } = bindIngredients(ings, items);
      const conflicts = await findAllergenConflicts(t, d.userId, resolved, null);
      let recipe: Row;
      let revision: number;
      let created = true;
      const existing = b.id
        ? (await t.q(`SELECT id, current_revision FROM recipes WHERE id = $1 AND user_id = $2 FOR UPDATE`, [b.id, d.userId]))[0]
        : undefined;
      if (b.id && !existing) throw notFound("recipe");
      if (existing) {
        created = false;
        revision = Number(existing.current_revision) + 1;
        recipe = (await t.q(
          `UPDATE recipes SET name = $3, cuisine = COALESCE($4, cuisine), servings = $5, ingredients = $6::jsonb,
                  instructions = $7::jsonb, tags = $8::text[], theme = COALESCE($9, theme), source = $10,
                  rotation = COALESCE($11, rotation), draft = COALESCE($12, draft),
                  current_revision = $13, updated_at = now()
            WHERE id = $1 AND user_id = $2 RETURNING ${RECIPE_COLS}`,
          [b.id, d.userId, name, cuisine, servings, JSON.stringify(stored), JSON.stringify(instructions), tags,
            theme, source, rotation ?? null, draft ?? null, revision],
        ))[0];
      } else {
        revision = 1;
        recipe = (await t.q(
          `INSERT INTO recipes (user_id, name, cuisine, servings, ingredients, instructions, tags, theme, source,
              rotation, draft, current_revision)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::text[],$8,$9,$10,$11,1) RETURNING ${RECIPE_COLS}`,
          [d.userId, name, cuisine, servings, JSON.stringify(stored), JSON.stringify(instructions), tags, theme,
            source, rotation ?? false, draft ?? false],
        ))[0];
      }
      await t.q(
        `INSERT INTO pantry_recipe_revisions (user_id, recipe_id, revision, servings, ingredients, instructions, reason)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [d.userId, recipe.id, revision, servings, JSON.stringify(stored), JSON.stringify(instructions), reason],
      );
      return { recipe, revision, reason, unmatched, conflicts, created };
    });
    return c.json({
      recipe: out.recipe,
      revision: { revision: out.revision, reason: out.reason },
      unmatched: out.unmatched,
      allergen_conflicts: out.conflicts,
    }, out.created ? 201 : 200);
  });

  app.get("/recipes", async (c) => {
    const where = ["user_id = $1"];
    const params: unknown[] = [d.userId];
    const q = c.req.query("q");
    if (q) { params.push(`%${q}%`); where.push(`name ILIKE $${params.length}`); }
    const theme = c.req.query("theme");
    if (theme) { params.push(lc(theme)); where.push(`lower(theme) = $${params.length}`); }
    const source = c.req.query("source");
    if (source) { params.push(source); where.push(`source = $${params.length}`); }
    for (const k of ["rotation", "draft"] as const) {
      const v = c.req.query(k);
      if (v === "true" || v === "false") { params.push(v === "true"); where.push(`${k} = $${params.length}`); }
    }
    where.push("(source IS NOT NULL)");
    const rows = await d.db.q(
      `SELECT ${RECIPE_COLS} FROM recipes WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id`,
      params,
    );
    return c.json({ recipes: rows });
  });

  app.get("/recipes/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound("recipe");
    const recipe = (await d.db.q(`SELECT ${RECIPE_COLS} FROM recipes WHERE id = $1 AND user_id = $2`, [id, d.userId]))[0];
    if (!recipe) throw notFound("recipe");
    const revs = await d.db.q(
      `SELECT revision, servings, ingredients, instructions, reason, created_at FROM pantry_recipe_revisions
        WHERE recipe_id = $1 ORDER BY revision DESC`,
      [id],
    );
    const current = revs.find((r) => Number(r.revision) === Number(recipe.current_revision)) ?? null;
    return c.json({
      recipe,
      revision: current,
      revisions: revs.map((r) => ({ revision: r.revision, reason: r.reason, created_at: r.created_at })),
    });
  });
}
