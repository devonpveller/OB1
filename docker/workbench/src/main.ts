// openbrain-workbench — the browser-facing read/write API behind the Quartz
// viewer (D-A). Deno + Hono, internal PORT=8000, reached same-origin via the
// portal Caddy `handle /workbench/* { reverse_proxy openbrain-workbench:8000 }`
// (prefix-PRESERVING — §2.3), which injects the shared secret as X-Brain-Key.
//
// Architecture (G9): Hono SUB-ROUTERS per resource over a thin
// service → repository layering. Routes are PREFIX-INCLUSIVE (mounted under
// /workbench) to match the prefix-preserving `handle` proxy. DB writes go
// through withTransaction (repository, G8); reads may use PostgREST.
//
// Kept OFF the MCP server + cloud-gateway (8-tool contract) so the
// multipart/upload/auth surface stays isolated (plan §2.1).
//
// Routers land per phase:
//   /workbench/health      — P0 (this skeleton)
//   /workbench/notebooks   — P2
//   /workbench/notes       — P3
//   /workbench/sources     — P4
//   /workbench/import      — P5  (+ /workbench/jobs)
//   /workbench/grounding   — P6
import { Hono } from "hono";
import { config } from "./config.ts";
import { requireBrainKey } from "./middleware/auth.ts";
import { health } from "./routes/health.ts";
import { notebooks } from "./routes/notebooks.ts";
import { notes } from "./routes/notes.ts";
import { sources } from "./routes/sources.ts";
import { imports, jobs } from "./routes/import.ts";
import { grounding } from "./routes/grounding.ts";
import { ensureVaultRepo } from "./util/vault.ts";

// deno-postgres returns BIGINT columns (e.g. entities.id, thoughts.id) as JS
// BigInt, which JSON.stringify cannot serialize → every response carrying one
// would 500. Make BigInt serialize as a number globally (all our ids are well
// under 2^53). One line, app-wide.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

const app = new Hono();

// Health is unauthenticated (Docker healthcheck + overlay connectivity proof).
// Exposed both at the bare path (internal healthcheck) and the prefix-inclusive
// path (what the browser reaches through Caddy).
app.route("/health", health);
app.route("/workbench/health", health);

// Everything else requires the Caddy-injected secret (G7). The gate is
// registered before the resource routers so it runs first in the chain.
app.use("/workbench/*", requireBrainKey);

// Resource sub-routers (prefix-inclusive). Added per phase.
app.route("/workbench/notebooks", notebooks); // P2
app.route("/workbench/notes", notes); // P3
app.route("/workbench/sources", sources); // P4
app.route("/workbench/import", imports); // P5 (single upload route; P6 grounding too)
app.route("/workbench/jobs", jobs); // P5
app.route("/workbench/grounding", grounding); // P6

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error("[workbench] error:", err?.message || err);
  return c.json({ error: "internal", detail: String(err?.message || err) }, 500);
});

// Make sure we can commit notes / the Changes log into the vault (best-effort).
await ensureVaultRepo();

Deno.serve({ port: config.port }, app.fetch);
console.log(`[workbench] listening on :${config.port} (auth=${config.workbenchKey ? "on" : "OPEN — set WORKBENCH_KEY"})`);
