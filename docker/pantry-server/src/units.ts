// Unit conversion WITHIN a dimension only. Mirrors pantry_unit_dim / pantry_unit_factor in
// init-pantry.sql (a test asserts the two agree). Anything not in the table is unknown and
// never guessed at.

export type Dim = "mass" | "volume" | "count";
export type Canon = "g" | "ml" | "count";

const TABLE: Record<string, { dim: Dim; f: number }> = {
  g: { dim: "mass", f: 1 },
  kg: { dim: "mass", f: 1000 },
  mg: { dim: "mass", f: 0.001 },
  oz: { dim: "mass", f: 28.349523125 },
  lb: { dim: "mass", f: 453.59237 },
  ml: { dim: "volume", f: 1 },
  l: { dim: "volume", f: 1000 },
  tsp: { dim: "volume", f: 4.92892159375 },
  tbsp: { dim: "volume", f: 14.78676478125 },
  cup: { dim: "volume", f: 236.5882365 },
  fl_oz: { dim: "volume", f: 29.5735295625 },
  count: { dim: "count", f: 1 },
  each: { dim: "count", f: 1 },
  pc: { dim: "count", f: 1 },
};

export const CANON: Record<Dim, Canon> = { mass: "g", volume: "ml", count: "count" };

const norm = (u: unknown) => String(u ?? "").trim().toLowerCase();

export function unitDim(u: unknown): Dim | null {
  return TABLE[norm(u)]?.dim ?? null;
}

export function isKnownUnit(u: unknown): boolean {
  return norm(u) in TABLE;
}

export const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Convert qty from one unit to another. null = not convertible (unknown unit or cross-dimension). */
export function convert(qty: number, from: unknown, to: unknown): number | null {
  const a = TABLE[norm(from)];
  const b = TABLE[norm(to)];
  if (!a || !b || a.dim !== b.dim) return null;
  return round4((qty * a.f) / b.f);
}

/** What fraction of ONE package a recipe quantity is: qty (any mass/volume unit) against a pack of
 *  packSize packUnit. null = not computable (unknown unit, a count unit, or a different dimension from the
 *  pack) - never guessed. Done in base units, rounded once (so 1 tsp of a gallon is not lost to an
 *  intermediate rounding). */
export function packFraction(qty: number, from: unknown, packSize: unknown, packUnit: unknown): number | null {
  const a = TABLE[norm(from)];
  const p = TABLE[norm(packUnit)];
  const size = Number(packSize);
  if (!a || !p || a.dim !== p.dim || a.dim === "count" || !(size > 0)) return null;
  return round4((qty * a.f) / (size * p.f));
}

/** An ingredient with no unit means "count" (e.g. "2 onions"). */
export const ingredientUnit = (u: unknown) => (norm(u) === "" ? "count" : norm(u));
