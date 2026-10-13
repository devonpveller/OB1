/**
 * HTTP server. Every route that does anything calls the ONE action,
 * MorningRoutine.ensureToday() (round 3):
 *   POST /routine/start   openbrain-cron, 01:00 local. Body = the gmail-pull
 *                         body, passed through to the chain head.
 *   POST /routine/ensure  the L14 whole-chain trigger (and any on-demand
 *                         button). Same body. Idempotent: it starts, resumes,
 *                         retries or does nothing, by today's state.
 *   POST /run             the chain tail (openbrain-podcast when it ends;
 *                         gmail-prune's fallback): "the content pipeline ended".
 *   GET  /health          today's record (state, chain, digest, follow-up, alert).
 * There is no force / re-send switch: the record decides (see the recipe README
 * to re-open a day by hand).
 */

import { MorningRoutine, Trigger } from "./routine/routine.ts";

export interface ServerOptions {
  routine: MorningRoutine;
  port: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (addr: Deno.NetAddr) => void;
}

export function startServer(opts: ServerOptions): Deno.HttpServer<Deno.NetAddr> {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });

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

  const ensure = async (trigger: Trigger, body: unknown) => {
    const r = await opts.routine.ensureToday(trigger, { body });
    return jsonResponse({
      date: r.date,
      state: r.state,
      chain: r.chain.status,
      digest: r.digest.status,
      follow_up: r.followUp.status,
      alert: r.alert.status,
    });
  };

  return Deno.serve({
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
      return jsonResponse({ service: "openbrain-digest", routine: await opts.routine.status().catch((e) => ({ error: String(e) })) });
    }
    if (req.method === "POST" && (url.pathname === "/routine/start" || url.pathname === "/routine/ensure" || url.pathname === "/run")) {
      const body = await readBody(req);
      if (body === null) return jsonResponse({ error: "bad JSON body" }, 400);
      const trigger: Trigger = url.pathname === "/routine/start" ? "cron" : url.pathname === "/routine/ensure" ? "l14" : "run";
      try {
        return await ensure(trigger, url.pathname === "/run" ? undefined : body);
      } catch (e) {
        return jsonResponse({ error: (e as Error)?.message ?? String(e) }, 500);
      }
    }
    return jsonResponse({ error: "not found", path: url.pathname }, 404);
  });
}
