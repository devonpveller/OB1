// GET/PUT /settings, GET/POST /people
import type { Hono } from "hono";
import type { Deps } from "../app.ts";
import { readBody } from "../app.ts";
import {
  getSettings, invalid, isObj, isUuid, optBool, optNum, optStr, optStrArr, reqStr, type Row,
} from "../core.ts";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function ageYears(birth: string | null): number | null {
  if (!birth) return null;
  const [y, m] = birth.split("-").map(Number);
  const now = new Date();
  const months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
  return Math.max(0, Math.round((months / 12) * 10) / 10);
}

export const personOut = (p: Row) => ({
  id: p.id, label: p.label, role: p.role, birth_month: p.birth_month, age_years: ageYears(p.birth_month),
  allergies: p.allergies, active: p.active,
});

export function registerHousehold(app: Hono, d: Deps) {
  const settingsOut = (s: Awaited<ReturnType<typeof getSettings>>) => ({
    portions: s.portions,
    child_cooldown_days: s.child_cooldown_days,
    week_start_day: s.week_start_day,
    use_soon_days: s.use_soon_days,
  });

  app.get("/settings", async (c) => c.json(settingsOut(await getSettings(d.db, d.userId))));

  app.put("/settings", async (c) => {
    const b = await readBody(c);
    const cur = await getSettings(d.db, d.userId);
    let portions = cur.portions;
    if (b.portions !== undefined) {
      if (!isObj(b.portions)) throw invalid("portions must be an object {adult, child}");
      const a = optNum(b.portions.adult, "portions.adult");
      const ch = optNum(b.portions.child, "portions.child");
      if ((a !== undefined && a < 0) || (ch !== undefined && ch < 0)) throw invalid("portions must be >= 0");
      portions = { adult: a ?? cur.portions.adult, child: ch ?? cur.portions.child };
    }
    const cd = optNum(b.child_cooldown_days, "child_cooldown_days");
    const us = optNum(b.use_soon_days, "use_soon_days");
    for (const [n, v] of [["child_cooldown_days", cd], ["use_soon_days", us]] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw invalid(`${n} must be an integer >= 0`);
    }
    const wsd = optStr(b.week_start_day, "week_start_day")?.toLowerCase();
    if (wsd !== undefined && !DAYS.includes(wsd)) throw invalid("week_start_day must be a weekday name");
    await d.db.q(
      `UPDATE pantry_settings SET portions = $2::jsonb, child_cooldown_days = $3, use_soon_days = $4,
              week_start_day = $5, updated_at = now() WHERE user_id = $1`,
      [d.userId, JSON.stringify(portions), cd ?? cur.child_cooldown_days, us ?? cur.use_soon_days,
        wsd ?? cur.week_start_day],
    );
    return c.json(settingsOut(await getSettings(d.db, d.userId)));
  });

  app.get("/people", async (c) => {
    const rows = await d.db.q(
      `SELECT id, label, role, birth_month, allergies, active FROM pantry_people
        WHERE user_id = $1 ORDER BY created_at, id`,
      [d.userId],
    );
    return c.json({ people: rows.map(personOut) });
  });

  app.post("/people", async (c) => {
    const b = await readBody(c);
    if (b.id !== undefined && !isUuid(b.id)) throw invalid("id must be a UUID");
    const label = optStr(b.label, "label");
    const role = optStr(b.role, "role");
    if (role !== undefined && role !== "adult" && role !== "child") throw invalid("role must be adult or child");
    const birth = b.birth_month === null ? null : optStr(b.birth_month, "birth_month");
    if (birth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(birth)) throw invalid("birth_month must be YYYY-MM");
    const allergies = optStrArr(b.allergies, "allergies");
    const active = optBool(b.active, "active");

    const out = await d.db.tx(async (t) => {
      const existing = b.id
        ? (await t.q(`SELECT * FROM pantry_people WHERE id = $1 AND user_id = $2 FOR UPDATE`, [b.id, d.userId]))[0]
        : undefined;
      if (existing) {
        const r = (await t.q(
          `UPDATE pantry_people SET label = $3, role = $4, birth_month = $5, allergies = $6::text[],
                  active = $7, updated_at = now()
            WHERE id = $1 AND user_id = $2
            RETURNING id, label, role, birth_month, allergies, active`,
          [b.id, d.userId, label || existing.label, role ?? existing.role,
            birth === undefined ? existing.birth_month : birth, allergies ?? existing.allergies,
            active ?? existing.active],
        ))[0];
        return { row: r, created: false };
      }
      const lab = reqStr(label, "label");
      if (!role) throw invalid("role is required (adult or child)");
      const r = (await t.q(
        `INSERT INTO pantry_people (id, user_id, label, role, birth_month, allergies, active)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::text[], $7)
         RETURNING id, label, role, birth_month, allergies, active`,
        [b.id ?? null, d.userId, lab, role, birth ?? null, allergies ?? [], active ?? true],
      ))[0];
      return { row: r, created: true };
    });
    return c.json(personOut(out.row), out.created ? 201 : 200);
  });
}
