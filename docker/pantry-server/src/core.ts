// Shared building blocks: errors, validation, the household, item matching, ingredient
// resolution and the reservation walk. No HTTP here, no LLM anywhere.
import type { Qx, Row } from "./db.ts";
import { convert, ingredientUnit, packFraction, round4, unitDim } from "./units.ts";
export type { Row };

/** SQLSTATE of a database error. deno-postgres raises a PostgresError (code in .fields.code) but, inside a
 *  transaction, wraps it in a TransactionError whose .cause is the PostgresError - read both. */
// deno-lint-ignore no-explicit-any
export function pgCode(e: any): string | undefined {
  return e?.fields?.code ?? e?.code ?? e?.cause?.fields?.code ?? e?.cause?.code;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(detail);
  }
}
export const invalid = (detail: string, extra: Record<string, unknown> = {}) =>
  new HttpError(400, "invalid", detail, extra);
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);

// ---------- validation helpers ----------
export const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export function reqStr(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw invalid(`${field} is required (non-empty string)`);
  return v.trim();
}
export function optStr(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid(`${field} must be a string`);
  return v.trim();
}
export function optNum(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalid(`${field} must be a number`);
  return v;
}
export function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw invalid(`${field} must be a boolean`);
  return v;
}
export function optStrArr(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw invalid(`${field} must be an array of strings`);
  return (v as string[]).map((s) => s.trim()).filter((s) => s !== "");
}
export function reqDate(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid(`${field} must be YYYY-MM-DD`);
  const d = new Date(v + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw invalid(`${field} is not a real date`);
  return v;
}
export function optDate(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return reqDate(v, field);
}
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** "today" in the service's local date (TZ env). */
export function todayStr(): string {
  const tz = Deno.env.get("TZ") || undefined;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ---------- items ----------
export const ITEM_COLS = `id, name, aliases, category, kind, quantity::float8 AS quantity, unit, level,
  location, expires_on::text AS expires_on, allergens, may_contain, pack_size::float8 AS pack_size, pack_unit`;

export interface Item {
  id: string;
  name: string;
  aliases: string[];
  category: string | null;
  kind: "counted" | "staple";
  quantity: number;
  unit: "g" | "ml" | "count" | null;
  level: "plenty" | "low" | "out" | null;
  location: string | null;
  expires_on: string | null;
  allergens: string[];
  may_contain: string[];
  pack_size: number | null;
  pack_unit: string | null;
}

// ---------- package size ----------
export interface Pack {
  /** undefined = the line said nothing about a pack; null = clear it; else set it. */
  value: { size: number; unit: string } | null | undefined;
}

/** Read pack_size / pack_unit off a request line. Both or neither; both null clears. The unit must be a
 *  known mass or volume unit (the pack is "1 gal", "500 g"; a count is not a size) and the size > 0. */
export function readPack(raw: Row, w: string): Pack {
  const hasS = "pack_size" in raw;
  const hasU = "pack_unit" in raw;
  if (!hasS && !hasU) return { value: undefined };
  const size = raw.pack_size ?? null;
  const unit = raw.pack_unit === null || raw.pack_unit === undefined ? null : String(raw.pack_unit).trim();
  if (size === null && (unit === null || unit === "")) return { value: null };
  if (typeof size !== "number" || !Number.isFinite(size) || !(size > 0)) {
    throw invalid(`${w}.pack_size must be a number > 0 (give pack_size and pack_unit together, or both null to clear)`);
  }
  const dim = unit ? unitDim(unit) : null;
  if (dim !== "mass" && dim !== "volume") {
    throw invalid(`${w}.pack_unit must be a mass or volume unit (g, kg, mg, oz, lb, ml, l, tsp, tbsp, cup, fl_oz)`);
  }
  return { value: { size, unit: unit!.toLowerCase() } };
}

export async function loadItems(t: Qx, uid: string, lock = false): Promise<Item[]> {
  return await t.q<Item>(
    `SELECT ${ITEM_COLS} FROM pantry_items WHERE user_id = $1 AND removed_at IS NULL
      ORDER BY id ${lock ? "FOR UPDATE" : ""}`,
    [uid],
  );
}

export interface Match {
  item?: Item;
  candidates: { id: string; name: string }[];
  ambiguous?: boolean;
}

/** id wins; else exact name (case-insensitive); else aliases. NEVER fuzzy: a miss returns
 *  substring candidates for a human to choose from, and no item. */
export function matchRef(items: Item[], ref: { id?: unknown; name?: unknown }): Match {
  if (typeof ref.id === "string" && ref.id) {
    const it = items.find((i) => i.id === ref.id);
    if (it) return { item: it, candidates: [] };
  }
  const name = lc(ref.name);
  if (name === "") return { candidates: [] };
  const exact = items.filter((i) => lc(i.name) === name);
  if (exact.length === 1) return { item: exact[0], candidates: [] };
  const byAlias = items.filter((i) => i.aliases.some((a) => lc(a) === name));
  if (exact.length === 0 && byAlias.length === 1) return { item: byAlias[0], candidates: [] };
  const hits = exact.length ? exact : byAlias;
  if (hits.length > 1) {
    return { candidates: hits.slice(0, 5).map((i) => ({ id: i.id, name: i.name })), ambiguous: true };
  }
  const cands = items.filter((i) => {
    const n = lc(i.name);
    return n.includes(name) || (n.length >= 3 && name.includes(n)) ||
      i.aliases.some((a) => lc(a).includes(name));
  }).slice(0, 5).map((i) => ({ id: i.id, name: i.name }));
  return { candidates: cands };
}

// ---------- settings / household ----------
export interface Settings {
  portions: { adult: number; child: number };
  child_cooldown_days: number;
  week_start_day: string;
  use_soon_days: number;
  default_servings: { adults: number; children: number };
}

/** `write:false` is for a read-only transaction (a cook preview): no row is created, the table defaults apply. */
export async function getSettings(t: Qx, uid: string, write = true): Promise<Settings> {
  if (write) await t.q(`INSERT INTO pantry_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid]);
  const r = (await t.q(
    `SELECT portions, child_cooldown_days, week_start_day, use_soon_days, default_servings
       FROM pantry_settings WHERE user_id = $1`,
    [uid],
  ))[0] ?? {}; // no row (only possible with write:false): the column defaults
  return {
    portions: { adult: Number(r.portions?.adult ?? 1), child: Number(r.portions?.child ?? 0.5) },
    child_cooldown_days: Number(r.child_cooldown_days ?? 7),
    week_start_day: r.week_start_day ?? "monday",
    use_soon_days: Number(r.use_soon_days ?? 5),
    default_servings: r.default_servings ?? { adults: 2, children: 1 },
  };
}

export interface Person {
  id: string;
  label: string;
  role: "adult" | "child";
  birth_month: string | null;
  allergies: string[];
  active: boolean;
}

export async function activePeople(t: Qx, uid: string): Promise<Person[]> {
  return await t.q<Person>(
    `SELECT id, label, role, birth_month, allergies, active FROM pantry_people
      WHERE user_id = $1 AND active ORDER BY created_at, id`,
    [uid],
  );
}

export function guestPortions(g: Row | null | undefined, s: Settings): number {
  if (!g) return 0;
  return Number(g.adults ?? 0) * s.portions.adult + Number(g.children ?? 0) * s.portions.child;
}

export async function householdPortions(t: Qx, uid: string, s: Settings): Promise<number> {
  const people = await activePeople(t, uid);
  if (people.length === 0) {
    return s.default_servings.adults * s.portions.adult + s.default_servings.children * s.portions.child;
  }
  return people.reduce((a, p) => a + (p.role === "adult" ? s.portions.adult : s.portions.child), 0);
}

export function validateGuest(g: unknown): Row | null {
  if (g === undefined || g === null) return null;
  if (!isObj(g)) throw invalid("guest_context must be an object");
  for (const k of ["adults", "children"]) {
    if (g[k] !== undefined && (typeof g[k] !== "number" || g[k] < 0)) throw invalid(`guest_context.${k} must be a number >= 0`);
  }
  for (const k of ["allergies", "avoid", "diet"]) optStrArr(g[k], `guest_context.${k}`);
  return g;
}

export interface Conflict {
  ingredient: string;
  allergen: string;
  who: string;
}

/** Item allergens vs the allergies of every active person plus the guests'. */
export async function findAllergenConflicts(
  t: Qx,
  uid: string,
  resolved: { ingredient: string; item: Item }[],
  guest: Row | null,
): Promise<Conflict[]> {
  const eaters: { who: string; allergies: string[] }[] = (await activePeople(t, uid))
    .map((p) => ({ who: p.label, allergies: p.allergies.map(lc) }));
  const ga = Array.isArray(guest?.allergies) ? (guest!.allergies as string[]).map(lc) : [];
  if (ga.length) eaters.push({ who: "guest", allergies: ga });
  const out: Conflict[] = [];
  for (const r of resolved) {
    const al = r.item.allergens.map(lc);
    for (const e of eaters) {
      for (const a of al) {
        if (e.allergies.includes(a)) out.push({ ingredient: r.ingredient, allergen: a, who: e.who });
      }
    }
  }
  return out;
}

// ---------- ingredients ----------
export interface Ingredient {
  pantry_item_id?: string | null;
  name: string;
  quantity?: number | null;
  unit?: string | null;
  staple?: boolean;
}

export interface Resolution {
  resolved: { ingredient: string; item: Item; staple: boolean }[];
  needs: Map<string, number>; // item id -> amount in the item's unit
  packed: Map<string, { ingredient: string; quantity: number; unit: string }[]>; // lines converted through a pack size
  unmatched: Row[];
  unconvertible: Row[];
}

export function resolveIngredients(ings: Ingredient[], items: Item[], scale: number): Resolution {
  const out: Resolution = { resolved: [], needs: new Map(), packed: new Map(), unmatched: [], unconvertible: [] };
  for (const ing of ings) {
    const m = matchRef(items, { id: ing.pantry_item_id, name: ing.name });
    if (!m.item) {
      out.unmatched.push({
        name: ing.name,
        quantity: ing.quantity ?? null,
        unit: ing.unit ?? null,
        candidates: m.candidates,
        ...(m.ambiguous ? { ambiguous: true } : {}),
      });
      continue;
    }
    const item = m.item;
    const staple = ing.staple === true || item.kind === "staple";
    out.resolved.push({ ingredient: ing.name, item, staple });
    if (staple) continue;
    if (typeof ing.quantity !== "number" || !Number.isFinite(ing.quantity) || ing.quantity < 0) {
      out.unconvertible.push({
        name: ing.name, item_id: item.id, quantity: ing.quantity ?? null, unit: ing.unit ?? null,
        item_unit: item.unit, reason: "missing_quantity",
      });
      continue;
    }
    const ingUnit = ingredientUnit(ing.unit);
    let c = convert(ing.quantity * scale, ingUnit, item.unit);
    let viaPack = false;
    if (c === null && item.unit === "count" && item.pack_size) {
      // a count item with a package size: a mass/volume line of the pack's dimension is a fraction of one package
      c = packFraction(ing.quantity * scale, ingUnit, item.pack_size, item.pack_unit);
      viaPack = c !== null;
    }
    if (c === null) {
      const d = unitDim(ingUnit);
      const needsPack = item.unit === "count" && (d === "mass" || d === "volume");
      out.unconvertible.push({
        name: ing.name, item_id: item.id, quantity: ing.quantity, unit: ing.unit ?? "count",
        item_unit: item.unit, reason: "cross_dimension_or_unknown_unit",
        ...(needsPack
          ? {
            hint: item.pack_size
              ? `its package size is ${item.pack_size} ${item.pack_unit}, a different kind of unit from ${ingUnit}; never guess - ask the household`
              : `no package size on file: ask how big one ${item.name} package is, then record it (pack_size + pack_unit) with update_pantry`,
          }
          : {}),
      });
      continue;
    }
    out.needs.set(item.id, round4((out.needs.get(item.id) ?? 0) + c));
    if (viaPack) {
      const l = out.packed.get(item.id) ?? [];
      l.push({ ingredient: ing.name, quantity: round4(ing.quantity * scale), unit: ingUnit });
      out.packed.set(item.id, l);
    }
  }
  return out;
}

// ---------- the reservation walk ----------
export interface Shortfall {
  name: string;
  item_id: string | null;
  needed: number;
  available: number;
  unit: string | null;
}
export interface PlanAlloc {
  plan_id: string;
  plan_date: string;
  recipe_id: string | null;
  status: string;
  reservations: { item_id: string; name: string; reserved: number; unit: string | null; available_before: number }[];
  shortfalls: Shortfall[];
  unconvertible: Row[];
  allergen_conflicts: Conflict[];
}

/** Walk every dated plan row in date order against on-hand stock. Each PLANNED, uncooked
 *  recipe row reserves its needs; what on-hand cannot cover is that row's shortfall. Earlier
 *  dinners take stock first, so a shared item shows reduced availability for the later one and
 *  nothing is counted twice. Pure function of the DB state at call time. */
export async function allocatePlans(t: Qx, uid: string): Promise<PlanAlloc[]> {
  const items = await loadItems(t, uid);
  const remaining = new Map(items.map((i) => [i.id, i.quantity]));
  const plans = await t.q(
    `SELECT mp.id, mp.plan_date::text AS plan_date, mp.recipe_id, mp.status, mp.leftovers_of,
            mp.servings_exact::float8 AS servings_exact, mp.guest_context,
            rc.servings AS recipe_servings, rc.ingredients
       FROM meal_plans mp LEFT JOIN recipes rc ON rc.id = mp.recipe_id
      WHERE mp.user_id = $1 AND mp.plan_date IS NOT NULL
      ORDER BY mp.plan_date, mp.created_at, mp.id`,
    [uid],
  );
  const out: PlanAlloc[] = [];
  for (const p of plans) {
    const a: PlanAlloc = {
      plan_id: p.id, plan_date: p.plan_date, recipe_id: p.recipe_id, status: p.status,
      reservations: [], shortfalls: [], unconvertible: [], allergen_conflicts: [],
    };
    out.push(a);
    if (p.status !== "planned" || !p.recipe_id || p.leftovers_of || !Array.isArray(p.ingredients)) continue;
    const scale = (p.servings_exact ?? 0) / (p.recipe_servings || 1);
    if (!(scale > 0)) continue;
    const res = resolveIngredients(p.ingredients, items, scale);
    a.unconvertible = res.unconvertible;
    a.allergen_conflicts = await findAllergenConflicts(t, uid, res.resolved, p.guest_context);
    for (const [itemId, need] of res.needs) {
      const it = items.find((i) => i.id === itemId)!;
      const rem = remaining.get(itemId) ?? 0;
      const take = Math.min(rem, need);
      remaining.set(itemId, round4(rem - take));
      a.reservations.push({ item_id: itemId, name: it.name, reserved: need, unit: it.unit, available_before: rem });
      if (need > rem) {
        a.shortfalls.push({ name: it.name, item_id: itemId, needed: need, available: rem, unit: it.unit });
      }
    }
    // Lines naming something the pantry has never heard of: needed in full.
    for (const u of res.unmatched) {
      if (typeof u.quantity === "number") {
        a.shortfalls.push({
          name: u.name, item_id: null, needed: round4(u.quantity * scale), available: 0, unit: u.unit ?? null,
        });
      }
    }
  }
  return out;
}

/** Key for comparing shortfalls before/after: only the amounts that matter. */
export function shortfallSignature(sfs: Shortfall[]): string {
  return JSON.stringify(
    sfs.map((s) => [s.item_id ?? lc(s.name), round4(s.needed - s.available)]).sort((a, b) =>
      String(a[0]).localeCompare(String(b[0]))
    ),
  );
}

export async function ledger(
  t: Qx,
  uid: string,
  row: {
    item_id: string;
    delta: number;
    before: number | null;
    after: number | null;
    level_before?: string | null;
    level_after?: string | null;
    reason: string;
    cook_event_id?: string | null;
    shopping_list_id?: string | null;
    audit_id?: string | null;
  },
) {
  await t.q(
    `INSERT INTO pantry_adjustments (user_id, item_id, delta, quantity_before, quantity_after, level_before,
        level_after, reason, cook_event_id, shopping_list_id, audit_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [uid, row.item_id, row.delta, row.before, row.after, row.level_before ?? null, row.level_after ?? null,
      row.reason, row.cook_event_id ?? null, row.shopping_list_id ?? null, row.audit_id ?? null],
  );
}

/** Add `delta` (may be negative) to a counted item (row locked by the caller's FOR UPDATE or
 *  by this UPDATE); floors at 0; writes the ledger row with the delta actually applied. */
export async function applyDelta(
  t: Qx,
  uid: string,
  item: Item,
  delta: number,
  ctx: { reason: string; cook_event_id?: string; shopping_list_id?: string; audit_id?: string },
): Promise<{ before: number; after: number; delta: number }> {
  const cur = (await t.q<{ q: number }>(
    `SELECT quantity::float8 AS q FROM pantry_items WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [item.id, uid],
  ))[0];
  const before = cur.q;
  const after = (await t.q<{ q: number }>(
    `UPDATE pantry_items SET quantity = round(GREATEST(0, quantity + $3::numeric), 4), updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING quantity::float8 AS q`,
    [item.id, uid, round4(delta)],
  ))[0].q;
  const applied = round4(after - before);
  await ledger(t, uid, {
    item_id: item.id, delta: applied, before, after, reason: ctx.reason,
    cook_event_id: ctx.cook_event_id, shopping_list_id: ctx.shopping_list_id, audit_id: ctx.audit_id,
  });
  return { before, after, delta: applied };
}

export async function setLevel(
  t: Qx,
  uid: string,
  item: Item,
  level: string,
  ctx: { reason: string; shopping_list_id?: string; audit_id?: string },
) {
  await t.q(`UPDATE pantry_items SET level = $3, updated_at = now() WHERE id = $1 AND user_id = $2`, [item.id, uid, level]);
  await ledger(t, uid, {
    item_id: item.id, delta: 0, before: null, after: null, level_before: item.level, level_after: level,
    reason: ctx.reason, shopping_list_id: ctx.shopping_list_id, audit_id: ctx.audit_id,
  });
}
