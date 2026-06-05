// Health sub-router. Unauthenticated on purpose: the Docker healthcheck has no
// Caddy to inject the key, and the Quartz overlay's connectivity proof
// (fetch('/workbench/health')) just confirms the same-origin route works.
// It reports downstream reachability so P0's gate is observable.
import { Hono } from "hono";
import { dbHealthy } from "../db/pool.ts";
import { rest } from "../db/rest.ts";

export const health = new Hono();

health.get("/", async (c) => {
  const [db, restOk] = await Promise.all([dbHealthy(), rest.restHealthy()]);
  return c.json({
    ok: true,
    service: "openbrain-workbench",
    db,
    rest: restOk,
  });
});
