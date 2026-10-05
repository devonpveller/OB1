// POST /cook, POST /cook/:id/correct   - each is ONE transaction.
import type { Hono } from "hono";
import type { Deps } from "../app.ts";
import { readBody } from "../app.ts";
import {
  applyDelta, findAllergenConflicts, getSettings, guestPortions, HttpError, householdPortions, invalid, isObj,
  isUuid, loadItems, notFound, optBool, optNum, resolveIngredients, validateGuest, type Item, type Row,
} from "../core.ts";
import { convert, packFraction, round4 } from "../units.ts";
import type { Qx } from "../db.ts";
import { previewExplored, recordExplored, unrecordExplored } from "../taste.ts";

async function itemInfo(t: Qx, uid: string, ids: string[]): Promise<Map<string, Row>> {
  if (!ids.length) return new Map();
  const rows = await t.q(`SELECT id, name, unit, pack_size::float8 AS pack_size, pack_unit FROM pantry_items WHERE user_id = $1 AND id = ANY($2::uuid[])`, [uid, ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

/** When a mass/volume recipe line was converted through the item's package size, say how (for the table the model shows). */
function packInfo(item: Item, lines?: { ingredient: string; quantity: number; unit: string }[]): Row {
  return lines?.length ? { pack: { size: item.pack_size, unit: item.pack_unit }, converted_from: lines } : {};
}

export function registerCook(app: Hono, d: Deps) {
  app.post("/cook", async (c) => {
    const b = await readBody(c);
    if (!isUuid(b.recipe_id)) throw invalid("recipe_id (UUID) is required");
    const servingsIn = optNum(b.servings, "servings");
    if (servingsIn !== undefined && !(servingsIn > 0)) throw invalid("servings must be > 0");
    if (b.meal_plan_id !== undefined && b.meal_plan_id !== null && !isUuid(b.meal_plan_id)) throw invalid("meal_plan_id must be a UUID");
    const guestIn = validateGuest(b.guest_context);
    const loggedAfter = optBool(b.logged_after, "logged_after") === true;
    const preview = optBool(b.preview, "preview") === true;
    let cookedAt: string | null = null;
    if (b.cooked_at !== undefined && b.cooked_at !== null) {
      if (typeof b.cooked_at !== "string" || Number.isNaN(Date.parse(b.cooked_at))) throw invalid("cooked_at must be an ISO-8601 time");
      cookedAt = new Date(b.cooked_at).toISOString();
    }

    // preview:true = the SAME computation, in a READ ONLY transaction: nothing can be written (the database
    // refuses), so no event, ledger row, plan status, explored value or settings row can leak out of it.
    const out = await d.db.tx(async (t) => {
      const recipe = (await t.q(
        `SELECT id, name, servings, ingredients, current_revision, cuisine, tags FROM recipes WHERE id = $1 AND user_id = $2`,
        [b.recipe_id, d.userId],
      ))[0];
      if (!recipe) throw notFound("recipe");
      if (!Array.isArray(recipe.ingredients) || !recipe.servings) throw invalid("recipe has no ingredients/servings to cook");

      let plan: Row | undefined;
      if (b.meal_plan_id) {
        plan = (await t.q(
          `SELECT id, recipe_id, status, servings_exact::float8 AS servings_exact, guest_context
             FROM meal_plans WHERE id = $1 AND user_id = $2 ${preview ? "" : "FOR UPDATE"}`,
          [b.meal_plan_id, d.userId],
        ))[0];
        if (!plan) throw notFound("meal plan");
        if (plan.status === "cooked") throw new HttpError(409, "plan_cooked", "that plan row is already cooked");
        if (plan.recipe_id && plan.recipe_id !== recipe.id) throw invalid("meal_plan_id belongs to a different recipe");
      }
      const guest = guestIn ?? (plan?.guest_context as Row | null) ?? null;
      const s = await getSettings(t, d.userId, !preview);
      const servings = round4(
        servingsIn ?? plan?.servings_exact ?? (await householdPortions(t, d.userId, s)) + guestPortions(guest, s),
      );
      const scale = servings / Number(recipe.servings);

      const items = await loadItems(t, d.userId, !preview); // lock every item row, in id order (a preview locks nothing)
      const res = resolveIngredients(recipe.ingredients, items, scale);

      const conflicts = await findAllergenConflicts(t, d.userId, res.resolved, guest);
      if (conflicts.length) {
        throw new HttpError(409, "allergen_conflict", "an ingredient carries an allergen of someone eating this meal", { conflicts });
      }

      if (preview) {
        const deductions: Row[] = [];
        const shortfalls: Row[] = [];
        for (const itemId of [...res.needs.keys()].sort()) {
          const need = res.needs.get(itemId)!;
          if (need <= 0) continue;
          const item = items.find((i) => i.id === itemId) as Item;
          const after = round4(Math.max(0, item.quantity - need));
          deductions.push({
            item_id: item.id, name: item.name, before: item.quantity, after, delta: round4(after - item.quantity),
            unit: item.unit, ...packInfo(item, res.packed.get(item.id)),
          });
          if (need > item.quantity) {
            shortfalls.push({ name: item.name, item_id: item.id, needed: need, available: item.quantity, unit: item.unit });
          }
        }
        return {
          preview: true, servings, cook_event_id: null, deductions, shortfalls, unconvertible: res.unconvertible,
          unmatched: res.unmatched, explored_new: await previewExplored(t, d.userId, recipe),
        };
      }

      const ev = (await t.q(
        `INSERT INTO pantry_cook_events (user_id, recipe_id, recipe_revision, meal_plan_id, servings, guest_context,
            logged_after, cooked_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7, COALESCE($8::timestamptz, now())) RETURNING id, cooked_at`,
        [d.userId, recipe.id, recipe.current_revision, plan?.id ?? null, servings,
          guest ? JSON.stringify(guest) : null, loggedAfter, cookedAt],
      ))[0];

      const deductions: Row[] = [];
      const shortfalls: Row[] = [];
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const itemId of [...res.needs.keys()].sort()) {
        const need = res.needs.get(itemId)!;
        if (need <= 0) continue;
        const item = byId.get(itemId) as Item;
        const r = await applyDelta(t, d.userId, item, -need, { reason: "cook", cook_event_id: ev.id });
        deductions.push({ item_id: item.id, name: item.name, before: r.before, after: r.after, delta: r.delta, unit: item.unit, ...packInfo(item, res.packed.get(item.id)) });
        if (need > r.before) {
          shortfalls.push({ name: item.name, item_id: item.id, needed: need, available: r.before, unit: item.unit });
        }
      }
      // Lines naming something not in the pantry: reported, never written, never blocking.
      await t.q(`UPDATE pantry_cook_events SET shortfalls = $2::jsonb WHERE id = $1`, [ev.id, JSON.stringify(shortfalls)]);
      // pantry-taste: trying a dish is a fact, so the explored map is updated for every cook,
      // guest or not, in this same transaction (it rolls back with the cook).
      const explored_new = await recordExplored(t, d.userId, ev.id, ev.cooked_at, recipe);
      if (plan) {
        await t.q(`UPDATE meal_plans SET status = 'cooked', cook_event_id = $2 WHERE id = $1`, [plan.id, ev.id]);
      }
      return {
        preview: false, servings, cook_event_id: ev.id, deductions, shortfalls, unconvertible: res.unconvertible, unmatched: res.unmatched,
        explored_new,
      };
    }, { readOnly: preview });
    return c.json(out, preview ? 200 : 201);
  });

  app.post("/cook/:id/correct", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound("cook event");
    const b = await readBody(c);
    const undo = b.undo === true;
    if (!undo && (!Array.isArray(b.adjustments) || b.adjustments.length === 0)) {
      throw invalid("give adjustments:[{item_id, actual_used, unit}] or undo:true");
    }
    const adj: { item_id: string; actual_used: number; unit: string }[] = [];
    if (!undo) {
      (b.adjustments as unknown[]).forEach((a, n) => {
        if (!isObj(a) || !isUuid(a.item_id) || typeof a.actual_used !== "number" || !(a.actual_used >= 0) ||
          typeof a.unit !== "string") {
          throw invalid(`adjustments[${n}] needs item_id (UUID), actual_used (number >= 0) and unit`);
        }
        adj.push({ item_id: a.item_id, actual_used: a.actual_used, unit: a.unit });
      });
    }

    const out = await d.db.tx(async (t) => {
      const ev = (await t.q(
        `SELECT id, meal_plan_id, undone_at FROM pantry_cook_events WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, d.userId],
      ))[0];
      if (!ev) throw notFound("cook event");
      if (ev.undone_at) throw new HttpError(409, "already_undone", "this cook was already undone");

      const net = await t.q<{ item_id: string; total: number }>(
        `SELECT item_id, SUM(delta)::float8 AS total FROM pantry_adjustments
          WHERE cook_event_id = $1 AND user_id = $2 AND reason IN ('cook', 'correct') GROUP BY item_id`,
        [id, d.userId],
      );
      const netMap = new Map(net.map((n) => [n.item_id, Number(n.total)]));
      await loadItems(t, d.userId, true);

      const deductions: Row[] = [];
      const unconvertible: Row[] = [];
      if (undo) {
        const info = await itemInfo(t, d.userId, [...netMap.keys()]);
        for (const itemId of [...netMap.keys()].sort()) {
          const total = round4(netMap.get(itemId)!);
          if (total === 0) continue;
          const r = await applyDelta(t, d.userId, { id: itemId } as Item, -total, { reason: "undo", cook_event_id: id });
          deductions.push({ item_id: itemId, name: info.get(itemId)?.name, before: r.before, after: r.after, delta: r.delta, unit: info.get(itemId)?.unit });
        }
        await t.q(`UPDATE pantry_cook_events SET undone_at = now() WHERE id = $1`, [id]);
        await unrecordExplored(t, d.userId, id); // pantry-taste: the cook's explored contribution goes back out
        if (ev.meal_plan_id) {
          await t.q(`UPDATE meal_plans SET status = 'planned', cook_event_id = NULL WHERE id = $1 AND user_id = $2`, [ev.meal_plan_id, d.userId]);
        }
        return { cook_event_id: id, undone: true, deductions, unconvertible };
      }

      const info = await itemInfo(t, d.userId, adj.map((a) => a.item_id));
      for (const a of adj) {
        const it = info.get(a.item_id);
        if (!it) throw notFound(`pantry item ${a.item_id}`);
        const kind = (await t.q(`SELECT kind FROM pantry_items WHERE id = $1`, [a.item_id]))[0].kind;
        if (kind !== "counted") throw invalid(`"${it.name}" is a staple; it has no quantity to correct`);
        const want = convert(a.actual_used, a.unit, it.unit) ??
          (it.unit === "count" && it.pack_size ? packFraction(a.actual_used, a.unit, it.pack_size, it.pack_unit) : null);
        if (want === null) {
          unconvertible.push({ item_id: a.item_id, name: it.name, actual_used: a.actual_used, unit: a.unit, item_unit: it.unit, reason: "cross_dimension_or_unknown_unit" });
          continue;
        }
        const usedNow = round4(-(netMap.get(a.item_id) ?? 0));
        const giveBack = round4(usedNow - want);
        if (giveBack === 0) continue;
        const r = await applyDelta(t, d.userId, { id: a.item_id } as Item, giveBack, { reason: "correct", cook_event_id: id });
        netMap.set(a.item_id, round4((netMap.get(a.item_id) ?? 0) + r.delta));
        deductions.push({ item_id: a.item_id, name: it.name, before: r.before, after: r.after, delta: r.delta, unit: it.unit });
      }
      return { cook_event_id: id, deductions, unconvertible };
    });
    return c.json(out);
  });
}
