#!/usr/bin/env node
/**
 * stub-llm - the STUB chat endpoint rw-p1a-render's compile cases run against
 * (acceptance 7 and 8). Never the live llm-gateway. OpenAI-compatible enough
 * for recipes/_shared/llm-call.mjs:
 *   POST /v1/chat/completions   per the current mode
 *   GET  /v1/models             {data:[{id}]} when models are healthy, else 503
 *   GET  /health/liveliness     200 when models are healthy, else 503
 * Control (test only):
 *   POST /__stub/mode  {"mode": "ok"|"flaky503"|"fail"|"badparse", "n": 3, "modelsOk": true, "model": "stub-model"}
 *   GET  /__stub/state -> {mode, n, modelsOk, chatCalls, modelsCalls, livelinessCalls}
 * Mode changes reset the counters.
 */
import http from "node:http";

const st = { mode: "ok", n: 3, modelsOk: true, model: "stub-model", chatCalls: 0, modelsCalls: 0, livelinessCalls: 0 };

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
      Object.assign(st, { mode: b.mode ?? "ok", n: b.n ?? 3, modelsOk: b.modelsOk ?? true, model: b.model ?? st.model, chatCalls: 0, modelsCalls: 0, livelinessCalls: 0 });
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
    if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
      st.chatCalls++;
      const body = JSON.parse(raw || "{}");
      const ok = (content) => reply(res, 200, { id: "stub", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] });
      if (st.mode === "fail") return reply(res, 503, { error: { message: "stub: upstream unavailable" } });
      if (st.mode === "flaky503" && st.chatCalls <= st.n) return reply(res, 503, { error: { message: `stub: 503 #${st.chatCalls}` } });
      if (st.mode === "badparse") return ok("Sure! I cannot write that page, but here is a JSON blob: {\"nope\": true}");
      return ok(pageFor(body));
    }
    reply(res, 404, { error: "stub: no route" });
  });
}).listen(8080, () => console.log("[stub-llm] listening on :8080"));
