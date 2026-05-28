/**
 * HTTP server. Listens on /run (POST) and /health (GET).
 *
 * The server owns:
 *   - concurrency gating (a single in-flight run; 409 on overlap)
 *   - last-result snapshot for /health observability
 *
 * It does NOT own:
 *   - what a digest is (DigestOrchestrator)
 *   - where data comes from (clients)
 *   - how it's rendered (renderers)
 *
 * Adding a new endpoint or auth check happens here; adding a new
 * section happens in src/sections/ without touching this file.
 */

import { DigestOrchestrator, DigestResult } from "./digest.ts";

export interface ServerOptions {
  orchestrator: DigestOrchestrator;
  port: number;
}

export function startServer(opts: ServerOptions): void {
  let running = false;
  let lastRunAt: string | null = null;
  let lastResult: DigestResult | null = null;
  let lastError: string | null = null;

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  Deno.serve({ port: opts.port, hostname: "0.0.0.0" }, (req) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        service: "openbrain-digest",
        running,
        last_run_at: lastRunAt,
        last_result: lastResult,
        last_error: lastError,
      });
    }

    if (req.method === "POST" && url.pathname === "/run") {
      if (running) {
        return jsonResponse(
          { started: false, reason: "run already in progress" },
          409,
        );
      }
      running = true;
      lastError = null;
      // Fire-and-forget; cron should not hold a connection for the
      // duration of a digest run (LLM call + Gmail send = seconds).
      (async () => {
        try {
          lastResult = await opts.orchestrator.run();
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          lastResult = null;
          console.error(`Digest orchestrator failed: ${lastError}`);
        } finally {
          running = false;
          lastRunAt = new Date().toISOString();
        }
      })();
      return jsonResponse({ started: true }, 202);
    }

    return jsonResponse({ error: "not found", path: url.pathname }, 404);
  });

  console.log(`openbrain-digest listening on :${opts.port}`);
}
