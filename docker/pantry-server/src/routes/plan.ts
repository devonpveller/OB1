// POST /plan, GET /plan, POST /plan/:id/status   (dinner only, D9)
import type { Hono } from "hono";
import type { Deps } from "../app.ts";
import { readBody } from "../app.ts";
import {
  addDays, allocatePlans, getSettings, guestPortions, HttpError, householdPortions, invalid, isUuid, notFound,
  optNum, optStr, reqDate, todayStr, validateGuest, type Row,
} from "../core.ts";
import { round4 } from "../units.ts";

const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const dow = (date: string) => new Date(date + "T00:00:00Z").getUTCDay();

function weekStartFor(date: string, startDay: string): string {
  const start = DOW.indexOf(startDay);
  const back = (dow(date) - (start < 0 ? 1 : start) + 7) % 7;
  return addDays(date, -back);
}

const PLAN_COLS = `mp.id, mp.plan_date::text AS date, mp.status, mp.recipe_id, mp.custom_meal, mp.leftovers_of,
  mp.servings_exact::float8 AS servings, mp.guest_context, mp.notes, mp.cook_event_id, rc.name AS recipe_name`;

function planOut(r: Row) {
  return {
    id: r.id, date: r.date, status: r.status,
    ...(r.recipe_id ? { recipe: { id: r.recipe_id, name: r.recipe_name } } : {}),
    recipe_id: r.recipe_id ?? null,
    ...(r.custom_meal ? { custom_meal: r.custom_meal } : {}),
    ...(r.leftovers_of ? { leftovers_of: r.leftovers_of } : {}),
    ...(r.guest_context ? { guest_context: r.guest_context } : {}),
    servings: r.servings ?? null,
    notes: r.notes ?? null,
    cook_event_id: r.cook_event_id ?? null,
  };
}

export function registerPlan(app: Hono, d: Deps) {
  app.post("/plan", async (c) => {
    const b = await readBody(c);
    const date = reqDate(b.date, "date");
    const given = [b.recipe_id, b.custom_meal, b.leftovers_of].filter((v) => v !== undefined && v !== null && v !== "");
    if (given.length !== 1) throw invalid("give exactly one of recipe_id, custom_meal, leftovers_of");
    if (b.recipe_id !== undefined && !isUuid(b.recipe_id)) throw invalid("recipe_id must be a UUID");
    if (b.leftovers_of !== undefined && !isUuid(b.leftovers_of)) throw invalid("leftovers_of must be a UUID");
    const custom = optStr(b.custom_meal, "custom_meal");
    const servingsIn = optNum(b.servings, "servings");
    if (servingsIn !== undefined && !(servingsIn > 0)) throw invalid("servings must be > 0");
    const guest = validateGuest(b.guest_context);
    const notes = optStr(b.notes, "notes") ?? null;

    const out = await d.db.tx(async (t) => {
      if (b.recipe_id) {
        const r = (await t.q(`SELECT id FROM recipes WHERE id = $1 AND user_id = $2`, [b.recipe_id, d.userId]))[0];
        if (!r) throw notFound("recipe");
      }
      if (b.leftovers_of) {
        const r = (await t.q(`SELECT id FROM meal_plans WHERE id = $1 AND user_id = $2`, [b.leftovers_of, d.userId]))[0];
        if (!r) throw notFound("plan row to take leftovers of");
      }
      const s = await getSettings(t, d.userId);
      const servings = b.recipe_id
        ? round4(servingsIn ?? (await householdPortions(t, d.userId, s)) + guestPortions(guest, s))
        : (servingsIn ?? null);
      const row = (await t.q(
        `INSERT INTO meal_plans (user_id, week_start, day_of_week, meal_type, recipe_id, custom_meal, servings, notes,
            status, leftovers_of, guest_context, plan_date, servings_exact)
         VALUES ($1,$2::date,$3,'dinner',$4,$5,$6,$7,'planned',$8,$9::jsonb,$10::date,$11) RETURNING id`,
        [d.userId, weekStartFor(date, s.week_start_day), DOW[dow(date)], b.recipe_id ?? null, custom ?? null,
          servings === null ? null : Math.max(1, Math.round(servings)), notes, b.leftovers_of ?? null,
          guest ? JSON.stringify(guest) : null, date, servings],
      ))[0];
      const alloc = (await allocatePlans(t, d.userId)).find((a) => a.plan_id === row.id)!;
      const plan = (await t.q(
        `SELECT ${PLAN_COLS} FROM meal_plans mp LEFT JOIN recipes rc ON rc.id = mp.recipe_id WHERE mp.id = $1`,
        [row.id],
      ))[0];
      return {
        plan: planOut(plan),
        reservations: alloc.reservations,
        shortfalls: alloc.shortfalls,
        unconvertible: alloc.unconvertible,
        allergen_conflicts: alloc.allergen_conflicts,
      };
    });
    return c.json(out, 201);
  });

  app.get("/plan", async (c) => {
    const date = c.req.query("date");
    const ws = c.req.query("week_start");
    let from: string;
    let to: string;
    if (date) {
      from = to = reqDate(date, "date");
    } else if (ws) {
      from = reqDate(ws, "week_start");
      to = addDays(from, 6);
    } else {
      from = todayStr();
      to = "9999-12-31";
    }
    const plans = await d.db.tx(async (t) => {
      const rows = await t.q(
        `SELECT ${PLAN_COLS} FROM meal_plans mp LEFT JOIN recipes rc ON rc.id = mp.recipe_id
          WHERE mp.user_id = $1 AND mp.plan_date BETWEEN $2::date AND $3::date
          ORDER BY mp.plan_date, mp.created_at, mp.id`,
        [d.userId, from, to],
      );
      const alloc = new Map((await allocatePlans(t, d.userId)).map((a) => [a.plan_id, a]));
      return rows.map((r) => ({ ...planOut(r), shortfalls_now: alloc.get(r.id)?.shortfalls ?? [] }));
    });
    return c.json({ plans });
  });

  app.post("/plan/:id/status", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound("plan row");
    const b = await readBody(c);
    if (b.status !== "skipped" && b.status !== "planned") {
      throw invalid('status must be "skipped" or "planned" ("cooked" is set only by /cook)');
    }
    const row = await d.db.tx(async (t) => {
      const cur = (await t.q(`SELECT status FROM meal_plans WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, d.userId]))[0];
      if (!cur) throw notFound("plan row");
      if (cur.status === "cooked") throw new HttpError(409, "plan_cooked", "a cooked plan row cannot change status; undo the cook first");
      await t.q(`UPDATE meal_plans SET status = $2 WHERE id = $1`, [id, b.status]);
      const plan = (await t.q(
        `SELECT ${PLAN_COLS} FROM meal_plans mp LEFT JOIN recipes rc ON rc.id = mp.recipe_id WHERE mp.id = $1`,
        [id],
      ))[0];
      return planOut(plan);
    });
    return c.json(row);
  });
}
