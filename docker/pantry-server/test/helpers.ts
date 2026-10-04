// Test fixture. Runs inside the test container on the private harness network; talks to a
// disposable Postgres only. Env (set by run-tests.ps1):
//   DB_HOST DB_PORT DB_NAME  - the throwaway database
//   DB_USER / DB_PASSWORD    - the least-privilege ob_pantry role (what the service uses)
//   ADMIN_DB_USER / ADMIN_DB_PASSWORD - superuser, ONLY for seeding/forcing failures/inspecting
import { Pool } from "postgres";
import { createApp } from "../src/app.ts";
import { fixRows, makeDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";

export const USER_ID = "11111111-1111-1111-1111-111111111111";
export const OTHER_USER = "22222222-2222-2222-2222-222222222222";
export const KEY = "test-pantry-key";

const env = (k: string, d?: string) => Deno.env.get(k) ?? d ?? "";
const conn = (user: string, password: string) => ({
  hostname: env("DB_HOST"),
  port: parseInt(env("DB_PORT", "5432"), 10),
  database: env("DB_NAME", "openbrain"),
  user,
  password,
});

export const db: Db = makeDb(conn(env("DB_USER", "ob_pantry"), env("DB_PASSWORD")), 6);
const adminPool = new Pool(conn(env("ADMIN_DB_USER", "postgres"), env("ADMIN_DB_PASSWORD")), 3);
export const app = createApp({ db, userId: USER_ID, apiKey: KEY });

// deno-lint-ignore no-explicit-any
export type J = any;

/** Superuser query (seed / inspect / force failures). Never used by the service. */
export async function admin<T = J>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await adminPool.connect();
  try {
    return fixRows<T>(await c.queryObject<T>(sql, params));
  } finally {
    c.release();
  }
}

export async function adminExec(sql: string) {
  const c = await adminPool.connect();
  try {
    await c.queryArray(sql);
  } finally {
    c.release();
  }
}

export async function reset() {
  await adminExec(`
    DROP TRIGGER IF EXISTS t_force_fail_cook ON pantry_cook_events;
    DROP TRIGGER IF EXISTS t_force_fail_plan ON meal_plans;
    DROP TRIGGER IF EXISTS t_force_fail_adj ON pantry_adjustments;
    TRUNCATE pantry_evaluations, pantry_preferences, pantry_taste_hypotheses, pantry_explored, pantry_exposures,
             pantry_audit_lines, pantry_audits, pantry_audit_previews, pantry_adjustments, pantry_cook_events,
             pantry_recipe_revisions, pantry_people, pantry_settings, pantry_items CASCADE;
    DELETE FROM meal_plans; DELETE FROM shopping_lists; DELETE FROM recipes;`);
}

export interface Res {
  status: number;
  json: J;
}

export async function api(method: string, path: string, body?: unknown, key: string | null = KEY): Promise<Res> {
  const headers: Record<string, string> = {};
  if (key !== null) headers["x-pantry-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: J = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

export const get = (p: string) => api("GET", p);
export const post = (p: string, b: unknown) => api("POST", p, b);

/** Create pantry items through the real route. Returns name -> id. */
export async function seedItems(lines: J[]): Promise<Record<string, string>> {
  const r = await post("/pantry/adjust", { reason: "manual", items: lines.map((l) => ({ create: true, ...l })) });
  if (r.status !== 200) throw new Error("seed failed " + JSON.stringify(r));
  const out: Record<string, string> = {};
  for (const c of r.json.created) out[c.name] = c.id;
  return out;
}

export async function seedRecipe(rec: J): Promise<string> {
  const r = await post("/recipes", { source: "household", servings: 4, instructions: ["cook"], ...rec });
  if (r.status !== 201) throw new Error("recipe seed failed " + JSON.stringify(r));
  return r.json.recipe.id;
}

export async function qty(name: string): Promise<number> {
  const r = await admin(`SELECT quantity::float8 AS q FROM pantry_items WHERE lower(name) = lower($1)`, [name]);
  return r[0].q;
}

export async function counts() {
  const r = await admin(`SELECT
    (SELECT count(*)::int FROM pantry_items) AS items,
    (SELECT count(*)::int FROM pantry_adjustments) AS ledger,
    (SELECT count(*)::int FROM pantry_cook_events) AS cooks,
    (SELECT count(*)::int FROM pantry_audits) AS audits,
    (SELECT count(*)::int FROM pantry_audit_lines) AS audit_lines,
    (SELECT coalesce(sum(quantity),0)::float8 FROM pantry_items) AS total_qty,
    (SELECT count(*)::int FROM meal_plans WHERE status = 'cooked') AS cooked_plans`);
  return r[0];
}

export const close = async () => {
  await db.end();
  await adminPool.end();
};

export function near(a: number, b: number, eps = 1e-6) {
  if (Math.abs(a - b) > eps) throw new Error(`expected ${a} ~ ${b}`);
}

/** Deno.test with a clean slate and no resource sanitizers (pools outlive a test). */
export function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await reset();
      await fn();
    },
  });
}

export const FORCE_FAIL_FN = `CREATE OR REPLACE FUNCTION t_boom() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'forced test failure'; END $$;`;
