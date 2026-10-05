// openbrain-pantry HTTP app. createApp() takes its dependencies so the tests can run it
// in-process against a disposable Postgres; main.ts wires the real env.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "./db.ts";
import { HttpError, invalid, isObj, pgCode, type Row } from "./core.ts";
import { registerHousehold } from "./routes/household.ts";
import { registerPantry } from "./routes/pantry.ts";
import { registerRecipes } from "./routes/recipes.ts";
import { registerCook } from "./routes/cook.ts";
import { registerPlan } from "./routes/plan.ts";
import { registerShopping } from "./routes/shopping.ts";
import { registerAudit } from "./routes/audit.ts";
import { registerTaste } from "./routes/taste.ts";

export interface Deps {
  db: Db;
  userId: string;
  apiKey: string;
}

/** Constant-time-ish string compare. */
function safeEq(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function readBody(c: Context): Promise<Row> {
  let b: unknown;
  try {
    b = await c.req.json();
  } catch {
    throw invalid("request body must be a JSON object");
  }
  if (!isObj(b)) throw invalid("request body must be a JSON object");
  return b;
}

export function createApp(d: Deps): Hono {
  if (!d.apiKey) throw new Error("PANTRY_API_KEY is required");
  const app = new Hono();

  // Auth: everything except GET /health. Unknown paths are 401 too (no probing without the key).
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" && c.req.path === "/health") return await next();
    const k = c.req.header("x-pantry-key");
    if (!k || !safeEq(k, d.apiKey)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/health", async (c) => {
    const ok = await d.db.ping();
    return c.json({ ok, db: ok }, ok ? 200 : 503);
  });

  registerHousehold(app, d);
  registerPantry(app, d);
  registerRecipes(app, d);
  registerCook(app, d);
  registerPlan(app, d);
  registerShopping(app, d);
  registerAudit(app, d);
  registerTaste(app, d);

  app.notFound((c) => c.json({ error: "not_found", detail: "no such route" }, 404));

  app.onError((e, c) => {
    if (e instanceof HttpError) {
      return c.json({ error: e.code, detail: e.detail, ...e.extra }, e.status as 400);
    }
    const code = pgCode(e);
    if (code === "23505") return c.json({ error: "conflict", detail: "a row with that identity already exists" }, 409);
    if (code === "22P02" || code === "22007" || code === "22008") {
      return c.json({ error: "invalid", detail: "a value has the wrong format" }, 400);
    }
    console.error("pantry: unhandled", e);
    return c.json({ error: "internal", detail: "internal error; nothing was partially written" }, 500);
  });

  return app;
}
