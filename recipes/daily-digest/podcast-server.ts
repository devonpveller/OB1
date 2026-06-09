/**
 * openbrain-podcast — the chain service (S5 / P5).
 *
 * The digest event-chain (pull → prune → digest) gains a tail step: after the
 * digest sends the morning email, it POSTs here. This service is a THIN wrapper —
 * on `POST /run` it spawns the link-enrich runner as a fresh subprocess (fresh
 * per-run state, no leakage between days), returns 202 immediately, and lets the
 * pipeline (S3 research → S4a script → S4b audio → loop-close) run asynchronously.
 * Best-effort and decoupled: it NEVER blocks or delays the email.
 *
 * This is an intentional, single-purpose service — it is not an LLM-callable
 * tool; it just runs the podcast pipeline on a trigger.
 *
 * Env:
 *   PORT                 (default 8080)
 *   PODCAST_RUN_ARGS     extra args for link-enrich.ts (default "--commit --audio")
 *   NEXT_TRIGGER_URL     optional chain continuation (unused today; tail of chain)
 *   (plus everything link-enrich.ts reads: MCP_ACCESS_KEY, RESEARCH_URL,
 *    CHAT_API_BASE, ON_BASE, BRAIN_REST_URL, REPORTS_DIR, FETCH_PROXY_URL, …)
 */

const PORT = parseInt(Deno.env.get("PORT") ?? "8080", 10);
const RUN_ARGS = (Deno.env.get("PODCAST_RUN_ARGS") ?? "--commit --audio").split(/\s+/).filter(Boolean);
const NEXT_TRIGGER_URL = Deno.env.get("NEXT_TRIGGER_URL") ?? "";

let running = false;
let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastCode: number | null = null;

async function chainTrigger() {
  if (!NEXT_TRIGGER_URL) return;
  try {
    const res = await fetch(NEXT_TRIGGER_URL, { method: "POST" });
    console.log(`[podcast] chain → ${NEXT_TRIGGER_URL} ${res.status}`);
  } catch (err) {
    console.warn(`[podcast] chain trigger failed: ${err}`);
  }
}

async function runPipeline() {
  // `new Date()` here is fine (a real server, not a workflow script).
  lastStartedAt = new Date().toISOString();
  console.log(`[podcast] run starting: deno run … link-enrich.ts ${RUN_ARGS.join(" ")}`);
  try {
    const cmd = new Deno.Command("deno", {
      args: ["run", "--unstable-net", "-A", "link-enrich.ts", ...RUN_ARGS],
      cwd: new URL(".", import.meta.url).pathname,
      stdout: "inherit",
      stderr: "inherit",
    });
    const { code } = await cmd.output();
    lastCode = code;
    console.log(`[podcast] run finished (exit ${code}).`);
  } catch (err) {
    lastCode = -1;
    console.error(`[podcast] run failed to spawn: ${err}`);
  } finally {
    lastFinishedAt = new Date().toISOString();
    running = false;
    await chainTrigger(); // end of chain by default (no-op)
  }
}

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, running, lastStartedAt, lastFinishedAt, lastCode, service: "openbrain-podcast" });
  }

  if (req.method === "POST" && url.pathname === "/run") {
    if (running) return Response.json({ started: false, reason: "already running" }, { status: 409 });
    running = true;
    runPipeline(); // fire-and-forget; runs async
    return Response.json({ started: true }, { status: 202 });
  }

  return new Response("not found", { status: 404 });
});

console.log(`openbrain-podcast listening on :${PORT} (args: ${RUN_ARGS.join(" ") || "(none)"})`);
