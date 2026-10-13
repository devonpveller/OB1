/**
 * HTTP server. Listens on:
 *   POST /routine/start  the morning chain head (openbrain-cron, 01:00 local).
 *                        Body = the gmail-pull body, passed through. Waits for
 *                        the model, then triggers the pull. {"force":true} in
 *                        the query (?force=1) restarts a finished day.
 *   POST /run            the chain tail (openbrain-podcast when it finishes;
 *                        gmail-prune's fallback). Sends the digest at most once
 *                        per local day, or the one follow-up. Body
 *                        {"force":true} = an explicit re-send.
 *   GET  /health         last result + today's routine state.
 *
 * The server owns HTTP only. WHEN and WHETHER to send is the MorningRoutine
 * (src/routine/routine.ts); what a digest is, is the DigestOrchestrator.
 */

import { MorningRoutine, RunOutcome } from "./routine/routine.ts";

export interface ServerOptions {
  routine: MorningRoutine;
  port: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (addr: Deno.NetAddr) => void;
}

export function startServer(opts: ServerOptions): Deno.HttpServer<Deno.NetAddr> {
  let inFlight = 0;
  let lastRunAt: string | null = null;
  let lastOutcome: RunOutcome | null = null;
  let lastError: string | null = null;

  // Chain tail: optionally trigger a next step after a run. Inert while
  // NEXT_TRIGGER_URL is empty (the digest is the end of the chain today).
  const NEXT_TRIGGER_URL = Deno.env.get("NEXT_TRIGGER_URL") ?? "";
  const chainTrigger = async () => {
    if (!NEXT_TRIGGER_URL) return;
    try {
      const res = await fetch(NEXT_TRIGGER_URL, { method: "POST", signal: AbortSignal.timeout(30_000) });
      console.log(`digest chain → ${NEXT_TRIGGER_URL} ${res.status}`);
    } catch (err) {
      console.warn(`digest chain trigger failed (non-fatal): ${err}`);
    }
  };

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const readBody = async (req: Request): Promise<Record<string, unknown> | null> => {
    const text = await req.text();
    if (!text.trim()) return {};
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" ? v as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };

  const server = Deno.serve({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",
    signal: opts.signal,
    onListen: (addr) => {
      console.log(`openbrain-digest listening on :${addr.port}`);
      opts.onListen?.(addr);
    },
  }, async (req) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        service: "openbrain-digest",
        running: inFlight > 0,
        last_run_at: lastRunAt,
        last_result: lastOutcome,
        last_error: lastError,
        routine: await opts.routine.status().catch((e) => ({ error: String(e) })),
      });
    }

    if (req.method === "POST" && url.pathname === "/routine/start") {
      const body = await readBody(req);
      if (body === null) return jsonResponse({ started: false, reason: "bad JSON body" }, 400);
      const force = url.searchParams.get("force") === "1";
      const r = await opts.routine.startChain(body, { force });
      return jsonResponse(r.body, r.status);
    }

    if (req.method === "POST" && url.pathname === "/run") {
      const body = await readBody(req);
      if (body === null) return jsonResponse({ started: false, reason: "bad JSON body" }, 400);
      const force = body.force === true;
      inFlight++;
      lastError = null;
      // Fire-and-forget: the caller (podcast / prune) must not hold a
      // connection while the digest waits for the model or sends.
      (async () => {
        try {
          lastOutcome = await opts.routine.onRun({ force });
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          console.error(`Digest run failed: ${lastError}`);
        } finally {
          inFlight--;
          lastRunAt = new Date().toISOString();
        }
        await chainTrigger();
      })();
      return jsonResponse({ started: true, force }, 202);
    }

    return jsonResponse({ error: "not found", path: url.pathname }, 404);
  });
  return server;
}
