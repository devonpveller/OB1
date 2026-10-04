// POST /shopping-list, POST /restock
import type { Hono } from "hono";
import type { Deps } from "../app.ts";
import { readBody } from "../app.ts";
import {
  addDays, allocatePlans, applyDelta, invalid, isObj, isUuid, lc, loadItems, matchRef, notFound, reqDate,
  setLevel, shortfallSignature, type Item, type Row,
} from "../core.ts";
import { convert, round4 } from "../units.ts";

const keyOf = (l: Row) => (l.pantry_item_id ? `i:${l.pantry_item_id}` : `n:${lc(l.name)}|${lc(l.unit)}`);

export function registerShopping(app: Hono, d: Deps) {
  // Net shortfall of the week's planned dinners (stock is handed out in date order, so a
  // shared item is only counted once) plus staples at low/out, plus last list's unbought lines.
  app.post("/shopping-list", async (c) => {
    const b = await readBody(c);
    const ws = reqDate(b.week_start, "week_start");
    const we = addDays(ws, 6);

    const out = await d.db.tx(async (t) => {
      const items = await loadItems(t, d.userId);
      const alloc = (await allocatePlans(t, d.userId)).filter((a) => a.status === "planned" && a.plan_date >= ws && a.plan_date <= we);
      const lines = new Map<string, Row>();
      const unconvertible: Row[] = [];
      for (const a of alloc) {
        unconvertible.push(...a.unconvertible.map((u) => ({ ...u, plan_id: a.plan_id })));
        for (const s of a.shortfalls) {
          const short = round4(s.needed - s.available);
          if (short <= 0) continue;
          const line = { name: s.name, pantry_item_id: s.item_id, unit: s.unit };
          const k = keyOf(line);
          const cur = lines.get(k);
          if (cur) {
            cur.quantity = round4(cur.quantity + short);
            cur.for_plans.push(a.plan_id);
          } else {
            lines.set(k, { ...line, quantity: short, reason: "shortfall", for_plans: [a.plan_id], purchased: false });
          }
        }
      }
      for (const it of items) {
        if (it.kind === "staple" && (it.level === "low" || it.level === "out")) {
          const line = { name: it.name, pantry_item_id: it.id, unit: "count" };
          lines.set(keyOf(line), { ...line, quantity: 1, reason: "staple_low", for_plans: [], purchased: false });
        }
      }

      // Lines an earlier restock left unbought come along (once).
      const carried: Row[] = [];
      const prior = await t.q(
        `SELECT id, items FROM shopping_lists WHERE user_id = $1 ORDER BY created_at, id FOR UPDATE`,
        [d.userId],
      );
      const consumed: { listId: string; items: Row[] }[] = [];
      for (const pl of prior) {
        if (!Array.isArray(pl.items)) continue;
        let touched = false;
        for (const l of pl.items as Row[]) {
          if (l.carried_over === true && l.purchased !== true && !l.carried_to) {
            const k = keyOf(l);
            const cur = lines.get(k);
            if (cur) {
              if (cur.unit === l.unit) cur.quantity = Math.max(cur.quantity, Number(l.quantity));
              cur.carried_over = true;
            } else {
              lines.set(k, {
                name: l.name, pantry_item_id: l.pantry_item_id ?? null, unit: l.unit, quantity: Number(l.quantity),
                reason: l.reason ?? "shortfall", for_plans: l.for_plans ?? [], purchased: false, carried_over: true,
              });
            }
            carried.push({ name: l.name, pantry_item_id: l.pantry_item_id ?? null, quantity: Number(l.quantity), unit: l.unit, reason: l.reason ?? "shortfall", from_list: pl.id });
            l.carried_to = "pending";
            touched = true;
          }
        }
        if (touched) consumed.push({ listId: pl.id, items: pl.items });
      }

      const list = [...lines.values()];
      const row = (await t.q(
        `INSERT INTO shopping_lists (user_id, week_start, items) VALUES ($1, $2::date, $3::jsonb) RETURNING id`,
        [d.userId, ws, JSON.stringify(list)],
      ))[0];
      for (const cn of consumed) {
        const stamped = cn.items.map((l) => (l.carried_to === "pending" ? { ...l, carried_to: row.id } : l));
        await t.q(`UPDATE shopping_lists SET items = $2::jsonb, updated_at = now() WHERE id = $1`, [cn.listId, JSON.stringify(stamped)]);
      }
      return { list_id: row.id, items: list, carried_over: carried, unconvertible };
    });
    return c.json(out, 201);
  });

  app.post("/restock", async (c) => {
    const b = await readBody(c);
    if (!isUuid(b.list_id)) throw invalid("list_id (UUID) is required");
    const bought = b.bought;
    if (bought !== "all" && !(Array.isArray(bought) && bought.every((x) => typeof x === "string"))) {
      throw invalid('bought must be "all" or an array of names/ids');
    }
    const except = b.except === undefined ? [] : b.except;
    if (!Array.isArray(except) || except.some((x) => typeof x !== "string")) throw invalid("except must be an array of names/ids");
    const subsIn = b.substitutions === undefined ? [] : b.substitutions;
    if (!Array.isArray(subsIn)) throw invalid("substitutions must be an array");
    const subs = subsIn.map((s: unknown, n: number) => {
      if (!isObj(s) || typeof s.for !== "string" || typeof s.name !== "string" || typeof s.quantity !== "number" ||
        !(s.quantity >= 0) || typeof s.unit !== "string") {
        throw invalid(`substitutions[${n}] needs for, name, quantity, unit`);
      }
      return { for: s.for, name: s.name, quantity: s.quantity, unit: s.unit };
    });
    const actualIn = b.actual === undefined ? [] : b.actual;
    if (!Array.isArray(actualIn)) throw invalid("actual must be an array");
    const actual = actualIn.map((a: unknown, n: number) => {
      if (!isObj(a) || (typeof a.id !== "string" && typeof a.name !== "string") || typeof a.quantity !== "number" ||
        !(a.quantity >= 0) || typeof a.unit !== "string") {
        throw invalid(`actual[${n}] needs id or name, quantity, unit`);
      }
      return { ref: (a.id ?? a.name) as string, quantity: a.quantity, unit: a.unit };
    });

    const out = await d.db.tx(async (t) => {
      const list = (await t.q(`SELECT id, items FROM shopping_lists WHERE id = $1 AND user_id = $2 FOR UPDATE`, [b.list_id, d.userId]))[0];
      if (!list) throw notFound("shopping list");
      const lines: Row[] = Array.isArray(list.items) ? list.items : [];
      const items = await loadItems(t, d.userId, true);
      const before = await allocatePlans(t, d.userId);

      const findLines = (ref: string): Row[] => {
        const r = lc(ref);
        let hit = lines.filter((l) => l.pantry_item_id === ref || lc(l.name) === r);
        if (!hit.length) {
          const m = matchRef(items, { id: ref, name: ref });
          if (m.item) hit = lines.filter((l) => l.pantry_item_id === m.item!.id || lc(l.name) === lc(m.item!.name));
        }
        return hit;
      };
      const open = (l: Row) => l.purchased !== true && !l.carried_to;

      const unmatched: Row[] = [];
      const unconvertible: Row[] = [];
      const restocked: Row[] = [];

      let set = new Set<Row>();
      if (bought === "all") {
        for (const l of lines) if (open(l)) set.add(l);
      } else {
        for (const ref of bought as string[]) {
          const hit = findLines(ref).filter(open);
          if (!hit.length) unmatched.push({ name: ref, reason: "not_on_list", candidates: [] });
          hit.forEach((l) => set.add(l));
        }
      }
      for (const ref of except as string[]) {
        const hit = findLines(ref);
        if (!hit.length) unmatched.push({ name: ref, reason: "not_on_list", candidates: [] });
        hit.forEach((l) => set.delete(l));
      }

      // Substitutions: the planned line is resolved by buying something else.
      for (const sb of subs) {
        const forLines = findLines(sb.for).filter(open);
        if (!forLines.length) {
          unmatched.push({ name: sb.for, reason: "not_on_list", candidates: [] });
          continue;
        }
        const m = matchRef(items, { name: sb.name });
        if (!m.item) {
          unmatched.push({ name: sb.name, reason: "substitute_not_in_pantry", candidates: m.candidates });
          forLines.forEach((l) => set.delete(l));
          continue;
        }
        const item = m.item;
        forLines.forEach((l) => set.delete(l));
        if (item.kind === "staple") {
          await setLevel(t, d.userId, item, "plenty", { reason: "restock", shopping_list_id: list.id });
          restocked.push({ item_id: item.id, name: item.name, delta: 0, unit: null, level: "plenty", substitution_for: sb.for });
        } else {
          const conv = convert(sb.quantity, sb.unit, item.unit);
          if (conv === null) {
            unconvertible.push({ name: item.name, quantity: sb.quantity, unit: sb.unit, item_unit: item.unit, reason: "cross_dimension_or_unknown_unit" });
            continue;
          }
          const r = await applyDelta(t, d.userId, item, conv, { reason: "restock", shopping_list_id: list.id });
          item.quantity = r.after;
          restocked.push({ item_id: item.id, name: item.name, delta: r.delta, unit: item.unit, substitution_for: sb.for });
        }
        for (const l of forLines) {
          l.purchased = true;
          l.substituted_by = item.name;
          l.purchased_quantity = sb.quantity;
          l.purchased_unit = sb.unit;
        }
      }

      // Actual pack sizes override the listed quantity.
      const override = new Map<Row, { quantity: number; unit: string }>();
      for (const a of actual) {
        const hit = findLines(a.ref).filter((l) => set.has(l));
        if (!hit.length) {
          unmatched.push({ name: a.ref, reason: "actual_for_line_not_being_restocked", candidates: [] });
          continue;
        }
        hit.forEach((l) => override.set(l, { quantity: a.quantity, unit: a.unit }));
      }

      for (const l of set) {
        let item: Item | undefined;
        if (l.pantry_item_id) item = items.find((i) => i.id === l.pantry_item_id);
        if (!item) {
          const m = matchRef(items, { name: l.name });
          item = m.item;
          if (!item) {
            unmatched.push({ name: l.name, reason: "no_pantry_item", candidates: m.candidates });
            continue;
          }
        }
        if (item.kind === "staple") {
          if (item.level !== "plenty") await setLevel(t, d.userId, item, "plenty", { reason: "restock", shopping_list_id: list.id });
          item.level = "plenty";
          restocked.push({ item_id: item.id, name: item.name, delta: 0, unit: null, level: "plenty" });
          l.purchased = true;
          continue;
        }
        const ov = override.get(l);
        const qty = ov?.quantity ?? Number(l.quantity);
        const unit = ov?.unit ?? l.unit;
        const conv = convert(qty, unit ?? "count", item.unit);
        if (conv === null) {
          unconvertible.push({ name: l.name, quantity: qty, unit: unit ?? null, item_unit: item.unit, reason: "cross_dimension_or_unknown_unit" });
          continue;
        }
        const r = await applyDelta(t, d.userId, item, conv, { reason: "restock", shopping_list_id: list.id });
        item.quantity = r.after;
        restocked.push({ item_id: item.id, name: item.name, delta: r.delta, unit: item.unit });
        l.purchased = true;
        l.purchased_quantity = qty;
        l.purchased_unit = unit;
      }

      // Everything still open is carried to the next list.
      const carried: Row[] = [];
      for (const l of lines) {
        if (open(l) && !l.carried_to) {
          l.carried_over = true;
          carried.push({ name: l.name, pantry_item_id: l.pantry_item_id ?? null, quantity: Number(l.quantity), unit: l.unit, reason: l.reason ?? "shortfall" });
        }
      }
      await t.q(`UPDATE shopping_lists SET items = $2::jsonb, updated_at = now() WHERE id = $1`, [list.id, JSON.stringify(lines)]);

      const after = await allocatePlans(t, d.userId);
      const beforeById = new Map(before.map((a) => [a.plan_id, a]));
      const affected: Row[] = [];
      for (const a of after) {
        const bf = beforeById.get(a.plan_id);
        if (!bf || a.status !== "planned" || !a.recipe_id) continue;
        if (shortfallSignature(bf.shortfalls) !== shortfallSignature(a.shortfalls)) {
          affected.push({
            plan_id: a.plan_id, date: a.plan_date, recipe_id: a.recipe_id,
            shortfalls_before: bf.shortfalls, shortfalls_after: a.shortfalls,
          });
        }
      }
      return { restocked, carried_over: carried, affected_plans: affected, unmatched, unconvertible };
    });
    return c.json(out);
  });
}

