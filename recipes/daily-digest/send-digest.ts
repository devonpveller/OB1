#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * openbrain-digest entrypoint.
 *
 * Composition root only: builds the service from the environment
 * (src/app.ts), starts the morning-routine scheduler (send-by deadline +
 * alert check, src/routine/routine.ts) and the HTTP server (src/server.ts).
 * No business logic in this file.
 *
 * Container is long-running. openbrain-cron POSTs /routine/start at 01:00
 * local (the chain head: model gate -> gmail pull -> prune -> podcast ->
 * POST /run here). The digest goes out at most once per local day; by the
 * send-by deadline (ROUTINE_SEND_BY, default 07:00 America/New_York) at the
 * latest. Ad-hoc / forced runs:
 *   docker exec openbrain-cron sh -c "curl -fsS -X POST http://openbrain-digest:8080/run"                 # once-per-day rules apply
 *   docker exec openbrain-cron sh -c "curl -fsS -X POST -d '{\"force\":true}' http://openbrain-digest:8080/run"  # explicit re-send
 */

import { buildDigestApp } from "./src/app.ts";
import { startServer } from "./src/server.ts";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;

let app;
try {
  app = buildDigestApp({ env: (k) => Deno.env.get(k), scriptDir: SCRIPT_DIR });
} catch (err) {
  console.error(`${(err as Error).message}`);
  Deno.exit(1);
}

app.routine.start();
startServer({ routine: app.routine, port: parseInt(Deno.env.get("DIGEST_PORT") ?? "8080", 10) || 8080 });
