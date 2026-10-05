// POST /audit/preview, POST /audit/commit, GET /accuracy
import type { Hono } from "hono";
import type { Deps } from "../app.ts";
import { readBody } from "../app.ts";
import {
  applyDelta, HttpError, invalid, isObj, isUuid, ITEM_COLS, lc, ledger, loadItems, matchRef, notFound, optDate,
  optNum, optStr, optStrArr, readPack, setLevel, type Item, type Match, type Row,
} from "../core.ts";
import { CANON, convert, round4, unitDim } from "../units.ts";
import type { Qx } from "../db.ts";

const LEVELS = ["plenty", "low", "out"];
const sameSet = (a: string[], b: string[]) => JSON.stringify(a.map(lc).sort()) === JSON.stringify(b.map(lc).sort());

export function registerAudit(app: Hono, d: Deps) {
  app.post("/audit/preview", async (c) => {
    const b = await readBody(c);
    if (b.source !== "csv" && b.source !== "xlsx" && b.source !== "chat") throw invalid('source must be "csv", "xlsx" or "chat"');
    const fileName = optStr(b.file_name, "file_name") ?? null;
    if (!Array.isArray(b.rows)) throw invalid("rows must be an array");

    const items = await loadItems(d.db, d.userId);
    const changed: Row[] = [];
    const neu: Row[] = [];
    const unmatched: Row[] = [];
    const unconvertible: Row[] = [];
    const matched: Row[] = [];
    const seen = new Set<string>();

    (b.rows as unknown[]).forEach((raw, n) => {
      const w = `rows[${n}]`;
      if (!isObj(raw)) throw invalid(`${w} must be an object`);
      if (raw.id !== undefined && raw.id !== null && !isUuid(raw.id)) throw invalid(`${w}.id must be a UUID`);
      const name = optStr(raw.name, `${w}.name`);
      if (!raw.id && !name) throw invalid(`${w} needs id or name`);
      const quantity = optNum(raw.quantity, `${w}.quantity`);
      const level = optStr(raw.level, `${w}.level`);
      if (level !== undefined && level !== "" && !LEVELS.includes(level)) throw invalid(`${w}.level must be plenty, low or out`);
      const unit = optStr(raw.unit, `${w}.unit`);
      const kindIn = optStr(raw.kind, `${w}.kind`);
      if (kindIn !== undefined && kindIn !== "counted" && kindIn !== "staple") throw invalid(`${w}.kind must be counted or staple`);
      const category = optStr(raw.category, `${w}.category`);
      const location = optStr(raw.location, `${w}.location`);
      const expires = optDate(raw.expires_on, `${w}.expires_on`);
      const allergens = optStrArr(raw.allergens, `${w}.allergens`);
      const mayContain = optStrArr(raw.may_contain, `${w}.may_contain`);
      const forceNew = raw.new === true;
      const pack = readPack(raw, w).value;

      const m: Match = forceNew ? { candidates: [] } : matchRef(items, { id: raw.id, name });
      if (raw.id && !m.item && !forceNew) {
        unmatched.push({ row: n, name: name ?? null, id: raw.id, reason: "unknown_id", candidates: [] });
        return;
      }
      if (!m.item) {
        if (!forceNew && m.ambiguous) {
          unmatched.push({ row: n, name, reason: "ambiguous", candidates: m.candidates });
          return;
        }
        if (!forceNew && m.candidates.length) {
          // Similar but not equal: a human decides (use its id, or send new:true).
          unmatched.push({ row: n, name, reason: "similar_names", candidates: m.candidates });
          return;
        }
        const kind = kindIn ?? (level && quantity === undefined ? "staple" : "counted");
        const line: Row = {
          name, kind, category: category ?? null, location: location ?? null, expires_on: expires ?? null,
          allergens: allergens ?? [], may_contain: mayContain ?? [], aliases: [], quantity: null, unit: null, level: null,
          pack_size: null, pack_unit: null,
        };
        if (kind === "counted") {
          const dim = unit ? unitDim(unit) : null;
          if (quantity === undefined || !dim) {
            unconvertible.push({ row: n, name, quantity: quantity ?? null, unit: unit ?? null, reason: quantity === undefined ? "missing_quantity" : "unknown_unit" });
            return;
          }
          line.unit = CANON[dim];
          line.quantity = convert(quantity, unit, CANON[dim]);
          if (pack) {
            if (dim !== "count") {
              unconvertible.push({ row: n, name, reason: "pack_on_non_count_item" });
              return;
            }
            line.pack_size = pack.size;
            line.pack_unit = pack.unit;
          }
        } else {
          if (pack) {
            unconvertible.push({ row: n, name, reason: "pack_on_non_count_item" });
            return;
          }
          line.level = level || "plenty";
        }
        neu.push(line);
        return;
      }

      const item = m.item;
      if (seen.has(item.id)) {
        unmatched.push({ row: n, name: name ?? item.name, id: item.id, reason: "duplicate_row", candidates: [] });
        return;
      }
      seen.add(item.id);
      const entry: Row = {
        item_id: item.id, name: item.name, kind: item.kind, unit: item.unit, expected: null, actual: null,
        expected_level: null, actual_level: null, fields: [] as string[], meta: {},
      };
      if (item.kind === "counted") {
        entry.expected = item.quantity;
        if (level) {
          unconvertible.push({ row: n, id: item.id, name: item.name, reason: "level_on_counted_item" });
          return;
        }
        if (quantity !== undefined) {
          const conv = convert(quantity, unit || item.unit, item.unit);
          if (conv === null) {
            unconvertible.push({ row: n, id: item.id, name: item.name, quantity, unit: unit || item.unit, item_unit: item.unit, reason: "cross_dimension_or_unknown_unit" });
            return;
          }
          entry.actual = conv;
        }
      } else {
        entry.expected_level = item.level;
        if (quantity !== undefined) {
          unconvertible.push({ row: n, id: item.id, name: item.name, reason: "quantity_on_staple" });
          return;
        }
        if (level) entry.actual_level = level;
      }
      if (pack !== undefined) {
        if (pack !== null && (item.kind !== "counted" || item.unit !== "count")) {
          unconvertible.push({ row: n, id: item.id, name: item.name, reason: "pack_on_non_count_item" });
          return;
        }
        const curSize = item.pack_size === null ? null : Number(item.pack_size);
        if ((pack?.size ?? null) !== curSize || (pack?.unit ?? null) !== (item.pack_unit ?? null)) {
          entry.meta.pack_size = pack?.size ?? null;
          entry.meta.pack_unit = pack?.unit ?? null;
          entry.fields.push("pack");
        }
      }
      if (category !== undefined && category !== (item.category ?? "")) { entry.meta.category = category; entry.fields.push("category"); }
      if (location !== undefined && location !== (item.location ?? "")) { entry.meta.location = location; entry.fields.push("location"); }
      if (expires !== undefined && expires !== item.expires_on) { entry.meta.expires_on = expires; entry.fields.push("expires_on"); }
      if (allergens !== undefined && !sameSet(allergens, item.allergens)) { entry.meta.allergens = allergens; entry.fields.push("allergens"); }
      if (mayContain !== undefined && !sameSet(mayContain, item.may_contain)) { entry.meta.may_contain = mayContain; entry.fields.push("may_contain"); }
      matched.push(entry);

      const qtyChanged = entry.actual !== null && round4(entry.actual - entry.expected) !== 0;
      const lvlChanged = entry.actual_level !== null && entry.actual_level !== entry.expected_level;
      if (qtyChanged || lvlChanged || entry.fields.length) {
        changed.push(item.kind === "counted"
          ? {
            id: item.id, name: item.name, expected: entry.expected, actual: entry.actual ?? entry.expected,
            delta: entry.actual === null ? 0 : round4(entry.actual - entry.expected), unit: item.unit,
            ...(entry.fields.length ? { fields: entry.fields } : {}),
          }
          : {
            id: item.id, name: item.name, expected: entry.expected_level, actual: entry.actual_level ?? entry.expected_level,
            delta: null, unit: null, ...(entry.fields.length ? { fields: entry.fields } : {}),
          });
      }
    });

    const missing = items.filter((i) => !seen.has(i.id)).map((i) => ({ id: i.id, name: i.name }));
    const payload = { matched, new: neu, missing };
    const row = (await d.db.q(
      `INSERT INTO pantry_audit_previews (user_id, source, file_name, payload) VALUES ($1,$2,$3,$4::jsonb)
       RETURNING id, expires_at`,
      [d.userId, b.source, fileName, JSON.stringify(payload)],
    ))[0];
    return c.json({ preview_id: row.id, expires_at: row.expires_at, changed, new: neu, missing, unmatched, unconvertible });
  });

  app.post("/audit/commit", async (c) => {
    const b = await readBody(c);
    if (!isUuid(b.preview_id)) throw invalid("preview_id (UUID) is required");
    const decisions = b.missing === undefined ? {} : b.missing;
    if (!isObj(decisions)) throw invalid('missing must be an object {"<id>": "keep"|"zero"|"remove"}');
    for (const [k, v] of Object.entries(decisions)) {
      if (!isUuid(k) || (v !== "keep" && v !== "zero" && v !== "remove")) throw invalid('missing decisions must be {"<item id>": "keep"|"zero"|"remove"}');
    }
    const exclude = (optStrArr(b.exclude, "exclude") ?? []).map(lc);

    const out = await d.db.tx(async (t: Qx) => {
      const pv = (await t.q(
        `SELECT id, source, file_name, payload, committed_at, (expires_at < now()) AS expired
           FROM pantry_audit_previews WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [b.preview_id, d.userId],
      ))[0];
      if (!pv) throw notFound("preview");
      if (pv.committed_at) throw new HttpError(409, "already_committed", "this preview was already committed");
      if (pv.expired) throw new HttpError(410, "preview_expired", "previews expire after 24 hours; run the preview again");
      const p = pv.payload as { matched: Row[]; new: Row[]; missing: { id: string; name: string }[] };
      const missingIds = new Set(p.missing.map((m) => m.id));
      for (const k of Object.keys(decisions)) if (!missingIds.has(k)) throw invalid(`"${k}" is not a missing item of this preview`);

      const audit = (await t.q(
        `INSERT INTO pantry_audits (user_id, source, file_name) VALUES ($1,$2,$3) RETURNING id`,
        [d.userId, pv.source, pv.file_name],
      ))[0];
      const aid = audit.id as string;
      const addLine = (r: { item_id: string; expected: number | null; actual: number | null; delta: number | null; unit: string | null; el?: string | null; al?: string | null }) =>
        t.q(
          `INSERT INTO pantry_audit_lines (audit_id, user_id, item_id, expected, actual, delta, unit, expected_level, actual_level)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [aid, d.userId, r.item_id, r.expected, r.actual, r.delta, r.unit, r.el ?? null, r.al ?? null],
        );

      await loadItems(t, d.userId, true);
      let checked = 0;
      let changed = 0;

      for (const e of p.matched) {
        if (exclude.includes(lc(e.item_id)) || exclude.includes(lc(e.name))) continue;
        const cur = (await t.q<Item>(`SELECT ${ITEM_COLS} FROM pantry_items WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`, [e.item_id, d.userId]))[0];
        if (!cur) continue;
        checked++;
        let did = false;
        if (cur.kind === "counted" && e.actual !== null) {
          const delta = round4(e.actual - cur.quantity);
          if (delta !== 0) await applyDelta(t, d.userId, cur, delta, { reason: "audit", audit_id: aid });
          await addLine({ item_id: cur.id, expected: cur.quantity, actual: e.actual, delta, unit: cur.unit });
          if (delta !== 0) did = true;
        } else if (cur.kind === "staple" && e.actual_level) {
          if (e.actual_level !== cur.level) {
            await setLevel(t, d.userId, cur, e.actual_level, { reason: "audit", audit_id: aid });
            did = true;
          }
          await addLine({ item_id: cur.id, expected: null, actual: null, delta: null, unit: null, el: cur.level, al: e.actual_level });
        }
        const meta = e.meta as Row;
        const sets: string[] = [];
        const params: unknown[] = [cur.id, d.userId];
        const push = (col: string, v: unknown, cast = "") => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
        if ("category" in meta) push("category", meta.category || null);
        if ("location" in meta) push("location", meta.location || null);
        if ("expires_on" in meta) push("expires_on", meta.expires_on || null, "::date");
        if ("allergens" in meta) push("allergens", meta.allergens, "::text[]");
        if ("may_contain" in meta) push("may_contain", meta.may_contain, "::text[]");
        if ("pack_size" in meta) { push("pack_size", meta.pack_size ?? null); push("pack_unit", meta.pack_unit ?? null); }
        if (sets.length) {
          await t.q(`UPDATE pantry_items SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`, params);
          did = true;
        }
        if (did) changed++;
      }

      for (const n of p.new) {
        if (exclude.includes(lc(n.name))) continue;
        checked++;
        const row = (await t.q(
          `INSERT INTO pantry_items (user_id, name, aliases, category, kind, quantity, unit, level, location, expires_on, allergens, may_contain, pack_size, pack_unit)
           VALUES ($1,$2,$3::text[],$4,$5,$6,$7,$8,$9,$10::date,$11::text[],$12::text[],$13,$14) RETURNING id`,
          [d.userId, n.name, n.aliases ?? [], n.category, n.kind, n.kind === "counted" ? n.quantity : 0, n.unit,
            n.level, n.location, n.expires_on, n.allergens ?? [], n.may_contain ?? [], n.pack_size ?? null, n.pack_unit ?? null],
        ))[0];
        if (n.kind === "counted") {
          await ledger(t, d.userId, { item_id: row.id, delta: n.quantity, before: 0, after: n.quantity, reason: "audit", audit_id: aid });
          // expected is NULL: a brand-new item is not drift, so the accuracy report skips it.
          await addLine({ item_id: row.id, expected: null, actual: n.quantity, delta: null, unit: n.unit });
        } else {
          await ledger(t, d.userId, { item_id: row.id, delta: 0, before: null, after: null, level_after: n.level, reason: "audit", audit_id: aid });
          await addLine({ item_id: row.id, expected: null, actual: null, delta: null, unit: null, al: n.level });
        }
        changed++;
      }

      for (const m of p.missing) {
        const decision = (decisions as Row)[m.id] ?? "keep"; // never auto-zeroed
        checked++;
        if (decision === "keep") continue;
        const cur = (await t.q<Item>(`SELECT ${ITEM_COLS} FROM pantry_items WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`, [m.id, d.userId]))[0];
        if (!cur) continue;
        if (cur.kind === "counted") {
          const r = cur.quantity > 0 ? await applyDelta(t, d.userId, cur, -cur.quantity, { reason: "audit", audit_id: aid }) : null;
          await addLine({ item_id: cur.id, expected: cur.quantity, actual: 0, delta: r ? r.delta : 0, unit: cur.unit });
        } else {
          if (cur.level !== "out") await setLevel(t, d.userId, cur, "out", { reason: "audit", audit_id: aid });
          await addLine({ item_id: cur.id, expected: null, actual: null, delta: null, unit: null, el: cur.level, al: "out" });
        }
        if (decision === "remove") {
          await t.q(`UPDATE pantry_items SET removed_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2`, [cur.id, d.userId]);
        }
        changed++;
      }

      await t.q(`UPDATE pantry_audits SET items_checked = $2, items_changed = $3 WHERE id = $1`, [aid, checked, changed]);
      await t.q(`UPDATE pantry_audit_previews SET committed_at = now(), audit_id = $2 WHERE id = $1`, [pv.id, aid]);
      return { audit_id: aid, items_checked: checked, items_changed: changed };
    });
    return c.json(out, 201);
  });

  app.get("/accuracy", async (c) => {
    const sinceQ = c.req.query("since");
    let since: string | null = null;
    if (sinceQ) {
      if (Number.isNaN(Date.parse(sinceQ))) throw invalid("since must be a date or ISO-8601 time");
      since = new Date(sinceQ).toISOString();
    }
    const uid = d.userId;
    const audits = Number((await d.db.q(
      `SELECT count(*)::int AS n FROM pantry_audits WHERE user_id = $1 AND ($2::timestamptz IS NULL OR at >= $2::timestamptz)`,
      [uid, since],
    ))[0].n);
    const lines = await d.db.q(
      `SELECT l.item_id, i.name, i.category, a.at, l.expected::float8 AS expected, l.actual::float8 AS actual,
              l.delta::float8 AS delta
         FROM pantry_audit_lines l
         JOIN pantry_audits a ON a.id = l.audit_id
         JOIN pantry_items i ON i.id = l.item_id
        WHERE l.user_id = $1 AND l.expected IS NOT NULL AND l.delta IS NOT NULL
          AND ($2::timestamptz IS NULL OR a.at >= $2::timestamptz)
        ORDER BY a.at, a.id`,
      [uid, since],
    );
    const byItem = new Map<string, Row[]>();
    for (const l of lines) {
      if (!byItem.has(l.item_id)) byItem.set(l.item_id, []);
      byItem.get(l.item_id)!.push(l);
    }
    const items: Row[] = [];
    const gaps: Row[] = [];
    const drift = new Map<string, { direction: "over" | "under"; name: string; pct: number | null }>();
    for (const [itemId, ls] of byItem) {
      const deltas = ls.map((l) => Number(l.delta));
      const nz = deltas.filter((x) => round4(x) !== 0);
      const mean = deltas.reduce((a, x) => a + x, 0) / deltas.length;
      const pcts = ls.filter((l) => Number(l.expected) > 0).map((l) => (Number(l.delta) / Number(l.expected)) * 100);
      const meanPct = pcts.length ? pcts.reduce((a, x) => a + x, 0) / pcts.length : null;
      let direction: "over" | "under" | "mixed" = "mixed";
      if (nz.length && nz.every((x) => x > 0)) direction = "over"; // actual above what we believed
      else if (nz.length && nz.every((x) => x < 0)) direction = "under"; // actual below what we believed
      items.push({
        item_id: itemId, name: ls[0].name, category: ls[0].category, audits: ls.length,
        mean_delta: round4(mean), mean_delta_pct: meanPct === null ? null : Math.round(meanPct * 100) / 100, direction,
      });
      if (nz.length >= 2 && direction !== "mixed") {
        drift.set(itemId, { direction, name: ls[0].name, pct: meanPct });
        gaps.push({
          kind: "consistent_drift",
          evidence: { item_id: itemId, name: ls[0].name, direction, audits_with_drift: nz.length, deltas: deltas.map(round4), mean_delta: round4(mean) },
        });
      }
      // never_restocked: stock fell across >= 2 audits and nothing was ever restocked
      const acts = ls.map((l) => Number(l.actual));
      const monotone = acts.every((v, k) => k === 0 || v <= acts[k - 1]);
      if (ls.length >= 2 && monotone && acts[acts.length - 1] < acts[0]) {
        const rs = Number((await d.db.q(
          `SELECT count(*)::int AS n FROM pantry_adjustments WHERE user_id = $1 AND item_id = $2 AND reason = 'restock' AND at >= $3::timestamptz`,
          [uid, itemId, ls[0].at],
        ))[0].n);
        if (rs === 0) {
          gaps.push({
            kind: "never_restocked",
            evidence: { item_id: itemId, name: ls[0].name, audits: ls.length, first_actual: acts[0], last_actual: acts[acts.length - 1] },
          });
        }
      }
    }

    const cooks = (await d.db.q(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE logged_after)::int AS after
         FROM pantry_cook_events
        WHERE user_id = $1 AND undone_at IS NULL AND ($2::timestamptz IS NULL OR cooked_at >= $2::timestamptz)`,
      [uid, since],
    ))[0];
    if (cooks.after > 0) {
      gaps.push({
        kind: "logged_after",
        evidence: { count: cooks.after, total_cooks: cooks.total, share: Math.round((cooks.after / cooks.total) * 1000) / 1000 },
      });
    }

    for (const [itemId, dr] of drift) {
      if (dr.direction !== "under") continue;
      const recipes = await d.db.q(
        `SELECT DISTINCT r.id AS recipe_id, r.name
           FROM pantry_cook_events ce
           JOIN recipes r ON r.id = ce.recipe_id
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.ingredients) = 'array' THEN r.ingredients ELSE '[]'::jsonb END) e(j)
          WHERE ce.user_id = $1 AND ce.undone_at IS NULL AND ($3::timestamptz IS NULL OR ce.cooked_at >= $3::timestamptz)
            AND e.j->>'pantry_item_id' = $2::text
          ORDER BY r.name`,
        [uid, itemId, since],
      );
      if (recipes.length) {
        gaps.push({
          kind: "recipe_understates",
          evidence: { item_id: itemId, name: dr.name, mean_delta_pct: dr.pct === null ? null : Math.round(dr.pct * 100) / 100, recipes },
        });
      }
    }
    return c.json({ audits, items, gaps });
  });
}
