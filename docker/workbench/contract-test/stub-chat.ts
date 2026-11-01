// A stand-in for the LiteLLM gateway's OpenAI-compatible chat endpoint, for the disposable rw-p8a3-room
// network only. The run gives one container the network aliases `llama-cpp` (the gateway alias the
// workbench must call) AND `llama-cpp-upstream` (a model server it must NEVER call), and runs a second
// copy as `mattermost` (nothing in the room may call it). Every request is logged with the host it was
// addressed to. It never echoes the question: its answer names only how many passages it was given.
//
//   POST /v1/chat/completions   logs {host, path, auth, model, system, turns, user} and answers
//   GET  /_log                  the log;  POST /_reset  empties it
//   anything else               logged, 404
const log: Record<string, unknown>[] = [];

Deno.serve({ port: 8080 }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/_log") return Response.json(log);
  if (url.pathname === "/_reset" && req.method === "POST") {
    log.length = 0;
    return Response.json({ ok: true });
  }
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* not json */ }
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const system = String(msgs[0]?.content ?? "");
  log.push({
    host: req.headers.get("host"), method: req.method, path: url.pathname, auth: req.headers.get("authorization"),
    model: body?.model ?? null, system, turns: msgs.length, user: String(msgs[msgs.length - 1]?.content ?? ""),
  });
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return Response.json({ error: "not found" }, { status: 404 });
  const passages = (system.match(/^\[\d+\] /gm) ?? []).length;
  return Response.json({
    id: "stand-in", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: `stand-in answer over ${passages} passages` }, finish_reason: "stop" }],
  });
});
