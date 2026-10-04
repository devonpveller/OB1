// GET /pantry, POST /pantry/adjust
import type { Hono } from "hono";
import type { Deps } from "../app.ts";
import { readBody } from "../app.ts";
import {
  addDays, applyDelta, getSettings, invalid, isObj, isUuid, ITEM_COLS, lc, loadItems, matchRef, optBool,
  optDate, optNum, optStr, optStrArr, setLevel, todayStr, ledger, type Item, type Row,
} from "../core.ts";
import { CANON, convert, round4, unitDim } from "../units.ts";
import type { Qx } from "../db.ts";

const LEVELS = ["plenty", "low", "out"];

export function itemOut(i: Row, useSoonDays: number, today: string) {
  const limit = addDays(today, useSoonDays);
  return {
    id: i.id,
    name: i.name,
    aliases: i.aliases,
    category: i.category,
    kind: i.kind,
    quantity: i.kind === "counted" ? round4(Number(i.quantity)) : null,
    unit: i.unit,
    level: i.level,
    location: i.location,
    expires_on: i.expires_on,
    allergens: i.allergens,
    may_contain: i.may_contain,
    reserved: i.kind === "counted" ? round4(Number(i.reserved ?? 0)) : 0,
    available: i.kind === "counted" ? round4(Number(i.available ?? i.quantity)) : null,
    use_soon: i.expires_on !== null && i.expires_on <= limit,
  };
}

export function registerPantry(app: Hono, d: Deps) {
  app.get("/pantry", async (c) => {
    const q = lc(c.req.query("q"));
    const category = lc(c.req.query("category"));
    const useSoon = c.req.query("use_soon") === "true";
    const s = await getSettings(d.db, d.userId);
    const today = todayStr();
    const rows = await d.db.q(
      `SELECT i.id, i.name, i.aliases, i.category, i.kind, i.quantity::float8 AS quantity, i.unit, i.level,
              i.location, i.expires_on::text AS expires_on, i.allergens, i.may_contain,
              COALESCE(v.reserved, 0)::float8 AS reserved, v.available::float8 AS available
         FROM pantry_items i
         LEFT JOIN pantry_available v ON v.item_id = i.id AND v.user_id = i.user_id
        WHERE i.user_id = $1 AND i.removed_at IS NULL
        ORDER BY lower(i.name)`,
      [d.userId],
    );
    let items = rows.map((r) => itemOut(r, s.use_soon_days, today));
    if (q) items = items.filter((i) => lc(i.name).includes(q) || i.aliases.some((a: string) => lc(a).includes(q)));
    if (category) items = items.filter((i) => lc(i.category) === category);
    if (useSoon) items = items.filter((i) => i.use_soon);
    return c.json({ items });
  });

  app.post("/pantry/adjust", async (c) => {
    const b = await readBody(c);
    const reason = b.reason;
    if (reason !== "manual" && reason !== "correct") throw invalid('reason must be "manual" or "correct"');
    if (!Array.isArray(b.items) || b.items.length === 0) throw invalid("items must be a non-empty array");

    // Validate EVERY line before anything is written.
    interface Line {
      raw: Row; id?: string; name?: string; create: boolean; kind?: string; quantity?: number; delta?: number;
      unit?: string; level?: string; category?: string; location?: string; expires_on?: string | null;
      has_expires: boolean; allergens?: string[]; may_contain?: string[]; aliases?: string[];
    }
    const lines: Line[] = b.items.map((raw: unknown, n: number): Line => {
      const w = `items[${n}]`;
      if (!isObj(raw)) throw invalid(`${w} must be an object`);
      if (raw.id !== undefined && !isUuid(raw.id)) throw invalid(`${w}.id must be a UUID`);
      const name = optStr(raw.name, `${w}.name`);
      if (!raw.id && !name) throw invalid(`${w} needs id or name`);
      const quantity = optNum(raw.quantity, `${w}.quantity`);
      const delta = optNum(raw.delta, `${w}.delta`);
      if (quantity !== undefined && delta !== undefined) throw invalid(`${w}: give quantity OR delta, not both`);
      if (quantity !== undefined && quantity < 0) throw invalid(`${w}.quantity must be >= 0`);
      const level = optStr(raw.level, `${w}.level`);
      if (level !== undefined && !LEVELS.includes(level)) throw invalid(`${w}.level must be plenty, low or out`);
      const kind = optStr(raw.kind, `${w}.kind`);
      if (kind !== undefined && kind !== "counted" && kind !== "staple") throw invalid(`${w}.kind must be counted or staple`);
      const unit = optStr(raw.unit, `${w}.unit`);
      if (unit !== undefined && unit !== "" && unitDim(unit) === null) throw invalid(`${w}.unit "${unit}" is not a known unit`);
      let expires: string | null | undefined;
      if ("expires_on" in raw) expires = raw.expires_on === null ? null : (optDate(raw.expires_on, `${w}.expires_on`) ?? null);
      return {
        raw, id: raw.id as string | undefined, name, create: optBool(raw.create, `${w}.create`) === true, kind,
        quantity, delta, unit: unit || undefined, level, category: optStr(raw.category, `${w}.category`),
        location: optStr(raw.location, `${w}.location`), expires_on: expires, has_expires: "expires_on" in raw,
        allergens: optStrArr(raw.allergens, `${w}.allergens`), may_contain: optStrArr(raw.may_contain, `${w}.may_contain`),
        aliases: optStrArr(raw.aliases, `${w}.aliases`),
      };
    });

    const out = await d.db.tx(async (t: Qx) => {
      const items = await loadItems(t, d.userId, true);
      const applied: Row[] = [];
      const created: Row[] = [];
      const unmatched: Row[] = [];
      const unconvertible: Row[] = [];

      for (const ln of lines) {
        const m = matchRef(items, { id: ln.id, name: ln.name });
        if (!m.item) {
          if (!ln.create || !ln.name) {
            unmatched.push({ name: ln.name ?? null, id: ln.id ?? null, candidates: m.candidates });
            continue;
          }
          // create:true on this line, and only this line, makes a new item.
          const kind = ln.kind ?? (ln.level && ln.quantity === undefined ? "staple" : "counted");
          if (ln.delta !== undefined) throw invalid(`new item "${ln.name}": give quantity, not delta`);
          let qty = 0;
          let unit: string | null = null;
          let level: string | null = null;
          if (kind === "counted") {
            if (ln.level) throw invalid(`new item "${ln.name}": level is for staples`);
            if (!ln.unit) throw invalid(`new counted item "${ln.name}" needs a unit`);
            const dim = unitDim(ln.unit)!;
            unit = CANON[dim];
            qty = convert(ln.quantity ?? 0, ln.unit, unit) as number;
          } else {
            if (ln.quantity !== undefined) throw invalid(`new staple "${ln.name}": level, not quantity`);
            level = ln.level ?? "plenty";
          }
          const row = (await t.q(
            `INSERT INTO pantry_items (user_id, name, aliases, category, kind, quantity, unit, level, location,
                expires_on, allergens, may_contain)
             VALUES ($1,$2,$3::text[],$4,$5,$6,$7,$8,$9,$10::date,$11::text[],$12::text[])
             RETURNING ${ITEM_COLS}`,
            [d.userId, ln.name, ln.aliases ?? [], ln.category ?? null, kind, qty, unit, level, ln.location ?? null,
              ln.has_expires ? ln.expires_on ?? null : null, ln.allergens ?? [], ln.may_contain ?? []],
          ))[0] as Item;
          items.push(row);
          if (kind === "counted" && qty > 0) {
            await ledger(t, d.userId, { item_id: row.id, delta: qty, before: 0, after: qty, reason: reason as string });
          } else if (kind === "staple") {
            await ledger(t, d.userId, { item_id: row.id, delta: 0, before: null, after: null, level_before: null, level_after: level, reason: reason as string });
          }
          created.push({ id: row.id, name: row.name, kind, quantity: kind === "counted" ? qty : null, unit, level });
          continue;
        }

        const item = m.item;
        if (ln.kind !== undefined && ln.kind !== item.kind) throw invalid(`"${item.name}" is ${item.kind}; its kind cannot change here`);
        if (item.kind === "staple" && (ln.quantity !== undefined || ln.delta !== undefined)) {
          throw invalid(`"${item.name}" is a staple: set level, not quantity`);
        }
        if (item.kind === "counted" && ln.level !== undefined) {
          throw invalid(`"${item.name}" is counted: set quantity, not level`);
        }

        // Quantity first, so an unconvertible line writes NOTHING about that line.
        let target: number | null = null; // absolute new quantity
        let rel: number | null = null; // delta in item unit
        if (item.kind === "counted" && (ln.quantity !== undefined || ln.delta !== undefined)) {
          const from = ln.unit ?? item.unit!;
          const val = (ln.quantity ?? ln.delta)!;
          const conv = convert(val, from, item.unit);
          if (conv === null) {
            unconvertible.push({
              id: item.id, name: item.name, quantity: val, unit: from, item_unit: item.unit,
              reason: "cross_dimension_or_unknown_unit",
            });
            continue;
          }
          if (ln.quantity !== undefined) target = conv;
          else rel = conv;
        }

        const sets: string[] = [];
        const params: unknown[] = [item.id, d.userId];
        const push = (col: string, v: unknown, cast = "") => {
          params.push(v);
          sets.push(`${col} = $${params.length}${cast}`);
        };
        if (ln.category !== undefined) push("category", ln.category);
        if (ln.location !== undefined) push("location", ln.location);
        if (ln.has_expires) push("expires_on", ln.expires_on ?? null, "::date");
        if (ln.allergens !== undefined) push("allergens", ln.allergens, "::text[]");
        if (ln.may_contain !== undefined) push("may_contain", ln.may_contain, "::text[]");
        if (ln.aliases !== undefined) push("aliases", ln.aliases, "::text[]");
        if (sets.length) {
          await t.q(`UPDATE pantry_items SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`, params);
        }

        if (item.kind === "counted") {
          let before = item.quantity;
          let after = item.quantity;
          if (target !== null || rel !== null) {
            const dlt = target !== null ? round4(target - item.quantity) : rel!;
            const r = await applyDelta(t, d.userId, item, dlt, { reason: reason as string });
            before = r.before;
            after = r.after;
            item.quantity = after;
          }
          applied.push({ id: item.id, name: item.name, before, after, unit: item.unit });
        } else {
          const before = item.level;
          if (ln.level !== undefined && ln.level !== item.level) {
            await setLevel(t, d.userId, item, ln.level, { reason: reason as string });
            item.level = ln.level as Item["level"];
          }
          applied.push({ id: item.id, name: item.name, before, after: item.level, unit: null });
        }
      }
      return { applied, created, unmatched, unconvertible };
    });
    return c.json(out);
  });
}

