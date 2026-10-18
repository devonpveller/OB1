// Route plumbing shared by every contract operation: the dependency bag, response validation
// (a handler cannot send a shape its schema does not describe), and one error mapping.
import type { Context } from "hono";
import { OpenAPIHono, type RouteConfig, z } from "../deps.ts";
import type { Db } from "../db.ts";
import type { RegistryReader } from "../registry.ts";
import { UnregisteredValue } from "../registry.ts";
import type { AdmissionScorer } from "../logic/reopen.ts";
import { BadRequest } from "../logic/scope.ts";
import { Conflict, NotFound } from "../repo/lifecycle.ts";
import { ErrorBody } from "../schemas/common.ts";

export interface ContractDeps {
  db: Db;
  registry: RegistryReader;
  scorer: AdmissionScorer;
  embed: (text: string) => Promise<number[]>;
  chunk: (text: string) => string[];
  mountsRoot: string;
  streamPollMs: number;
  log: (msg: string) => void;
}

export const PREFIX = "/workbench/contract";

export function newApp() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid request", detail: { issues: result.error.issues } }, 400);
      }
    },
  });
}

export type ContractApp = ReturnType<typeof newApp>;

// Register one operation. The route config is the OpenAPI document; the handler is typed
// loosely because every response is validated against its schema at run time by send(), which
// is stricter than the compile-time response typing (it also catches extra keys on strict
// shapes such as the D12 document listing).
// deno-lint-ignore no-explicit-any
export function op(app: ContractApp, route: RouteConfig, handler: (c: any) => Response | Promise<Response>) {
  // deno-lint-ignore no-explicit-any
  (app.openapi as any)(route, handler);
}

// What the wire carries: timestamps as ISO strings, BIGINT as numbers (all ids here are far
// below 2^53). Validation runs on THIS, so the schema describes the bytes a panel receives.
export function wire(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data, (_k, v) => typeof v === "bigint" ? Number(v) : v));
}

// Validate before sending: the contract owns the shape, so a drifted handler is a 500 here,
// never a surprise in a panel.
export function send<S extends z.ZodTypeAny>(c: Context, schema: S, data: unknown, status = 200) {
  const r = schema.safeParse(wire(data));
  if (!r.success) {
    console.error("[contract] response violates its schema:", JSON.stringify(r.error.issues).slice(0, 800));
    return c.json({ error: "contract_violation", detail: { issues: r.error.issues } }, 500);
  }
  return c.json(r.data as never, status as never);
}

export function fail(c: Context, err: unknown) {
  if (err instanceof NotFound) return c.json({ error: err.message }, 404);
  if (err instanceof Conflict) return c.json({ error: err.message, detail: err.detail }, 409);
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  if (err instanceof UnregisteredValue) {
    return c.json({ error: err.message, detail: { registry: err.registry, value: err.value } }, 422);
  }
  const pg = (err as { fields?: { code?: string; message?: string } })?.fields;
  if (pg?.code === "OBT01") return c.json({ error: "tombstoned", detail: { message: pg.message } }, 409);
  // A value the database cannot cast (a non-uuid id on a path or in a query parameter: 22P02
  // invalid_text_representation, 22007/22008 bad datetimes, 22003 out of range) is the caller's
  // error: 400, and the body carries no database text (rw-p0-contract2 attempt 2, tester finding N3).
  if (pg?.code && ["22P02", "22007", "22008", "22003"].includes(pg.code)) {
    return c.json({ error: "invalid request: a parameter is not a valid value for its type" }, 400);
  }
  // Anything else is logged here and answered without its text: the database's or the runtime's
  // message never reaches a caller (the cloud door included).
  console.error("[contract] error:", (err as Error)?.message ?? err);
  return c.json({ error: "internal" }, 500);
}

const errorContent = (description: string) => ({ content: { "application/json": { schema: ErrorBody } }, description });

export const errors = {
  400: errorContent("invalid request"),
  404: errorContent("not found"),
  409: errorContent("refused by the lifecycle (the body says why)"),
  422: errorContent("a value is not a key of its registry"),
  500: errorContent("internal error or a response that violated its schema"),
};

export function json<S extends z.ZodTypeAny>(schema: S, example: unknown, description: string) {
  return { content: { "application/json": { schema, example } }, description };
}

export function body<S extends z.ZodTypeAny>(schema: S, example: unknown) {
  return { content: { "application/json": { schema, example } }, required: true };
}

export function authorOf(c: Context, fallback?: string): string | null {
  return c.req.header("Remote-User") || c.req.header("X-Forwarded-User") || fallback || null;
}
