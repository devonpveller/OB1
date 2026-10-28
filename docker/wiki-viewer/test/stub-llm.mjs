#!/usr/bin/env node
/**
 * stub-llm - the STUB chat endpoint rw-p1a-render's compile cases run against
 * (acceptance 7 and 8). Never the live llm-gateway. OpenAI-compatible enough
 * for recipes/_shared/llm-call.mjs:
 *   POST /v1/chat/completions   per the current mode
 *   GET  /v1/models             {data:[{id}]} when models are healthy, else 503
 *   GET  /health/liveliness     200 when models are healthy, else 503
 * Control (test only):
 *   POST /__stub/mode  {"mode": <mode>, "n": 3, "modelsOk": true, "model": "stub-model"}
 *   GET  /__stub/state -> {mode, n, modelsOk, chatCalls, modelsCalls, livelinessCalls, perTask, callers}
 *   callers (rw-p1c-retire): chat + embedding calls per Authorization bearer - which caller key the
 *   wiki's LLM calls carry (fixture keys only; this stub never sees a real key)
 * Modes: ok | flaky503 (503 for the first n calls) | fail (503 always) |
 *   badparse (a reply with no page heading) - and, from the attempt-1
 *   tester's stub (attempt 2: their failure-class matrix is a plan case):
 *   empty200 (200, empty body) | emptycontent (200, blank content) | 429 |
 *   timeout (never answers) | 400 | 503x2-badparse (per task: 503 twice,
 *   then a bad reply) | mixed (Dave: bad reply; everyone else: 503) |
 *   davebad (Dave: bad reply; everyone else: a good page).
 * "delayMs" (attempt 3): every chat reply waits that long first - two compiles
 * started inside that window overlap for certain (the ledger race cases).
 * Mode changes reset the counters.
 */
import http from "node:http";

const st = { mode: "ok", n: 3, modelsOk: true, model: "stub-model", delayMs: 0, chatCalls: 0, modelsCalls: 0, livelinessCalls: 0, perTask: {}, callers: {} };
const noteCaller = (req) => {
  const k = String(req.headers.authorization || "(none)").replace(/^Bearer\s+/i, "");
  st.callers[k] = (st.callers[k] || 0) + 1;
};

function reply(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function pageFor(body) {
  const sys = String(body?.messages?.[0]?.content || "");
  if (/notebook-synthesis section/.test(sys)) {
    return "## Synthesis\n\nA stub synthesis of the notebook's sources [S1].\n\n- Key finding one [S1].\n";
  }
  const user = String(body?.messages?.[1]?.content || "");
  const name = (/"canonical_name":"([^"]+)"/.exec(user) || /"name":"([^"]+)"/.exec(user) || [])[1] || "Stub Entity";
  return `# ${name}\n\n## Summary\n\n${name} is a fixture entity written by the stub model.\n\n## Key Facts\n\n- One fact.\n`;
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (u.pathname === "/__stub/mode" && req.method === "POST") {
      const b = JSON.parse(raw || "{}");
      Object.assign(st, { mode: b.mode ?? "ok", n: b.n ?? 3, modelsOk: b.modelsOk ?? true, model: b.model ?? st.model, delayMs: Number(b.delayMs || 0), chatCalls: 0, modelsCalls: 0, livelinessCalls: 0, perTask: {}, callers: {} });
      return reply(res, 200, st);
    }
    if (u.pathname === "/__stub/state") return reply(res, 200, st);
    if (u.pathname === "/v1/models") {
      st.modelsCalls++;
      return st.modelsOk ? reply(res, 200, { object: "list", data: [{ id: st.model, object: "model" }] }) : reply(res, 503, { error: "stub: models down" });
    }
    if (u.pathname === "/health/liveliness") {
      st.livelinessCalls++;
      return st.modelsOk ? reply(res, 200, "I'm alive!") : reply(res, 503, { error: "stub: down" });
    }
    if (u.pathname === "/v1/chat/completions" && req.method === "POST" && st.delayMs > 0 && !req.__delayed) {
      req.__delayed = true;
      setTimeout(() => req.emit("end"), st.delayMs);
      return;
    }
    if ((u.pathname === "/v1/chat/completions" || u.pathname === "/v1/embeddings") && req.method === "POST") noteCaller(req);
    if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
      st.chatCalls++;
      const body = JSON.parse(raw || "{}");
      const ok = (content) => reply(res, 200, { id: "stub", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] });
      const user = String(body?.messages?.[1]?.content || "");
      const dave = /Dave Fixture/.test(user);
      const task = dave ? "Dave Fixture" : ((/"canonical_name":"([^"]+)"/.exec(user) || [])[1] || "other");
      const k = (st.perTask[task] = (st.perTask[task] || 0) + 1);
      const bad = () => ok("Sure! I cannot write that page, but here is a JSON blob: {\"nope\": true}");
      switch (st.mode) {
        case "fail": return reply(res, 503, { error: { message: "stub: upstream unavailable" } });
        case "flaky503": return st.chatCalls <= st.n ? reply(res, 503, { error: { message: `stub: 503 #${st.chatCalls}` } }) : ok(pageFor(body));
        case "badparse": return bad();
        case "empty200": res.writeHead(200, { "content-type": "application/json" }); return res.end();
        case "emptycontent": return ok("   ");
        case "429": return reply(res, 429, { error: { message: "stub: queue full" } });
        case "timeout": return undefined; // never answers (the caller's LLM_TIMEOUT_MS decides)
        case "400": return reply(res, 400, { error: { message: "stub: bad request" } });
        case "503x2-badparse": return k <= 2 ? reply(res, 503, { error: { message: `stub: 503 #${k}` } }) : bad();
        case "mixed": return dave ? bad() : reply(res, 503, { error: { message: "stub: down" } });
        case "davebad": return dave ? bad() : ok(pageFor(body));
        default: return ok(pageFor(body));
      }
    }
    reply(res, 404, { error: "stub: no route" });
  });
}).listen(8080, () => console.log("[stub-llm] listening on :8080"));
