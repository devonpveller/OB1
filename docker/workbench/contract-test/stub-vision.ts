// A stand-in for the LiteLLM gateway's OpenAI-compatible chat endpoint, for the disposable P6b network
// only (rw-p6b-gate). The run gives this container the network aliases `llama-cpp` (the gateway alias
// the workbench must call) AND `llama-cpp-upstream` (a model server the workbench must NEVER call), so
// every request is logged with the host it was addressed to. Never pointed at by anything live.
//
//   POST /v1/chat/completions   logs {host, path, auth (the bearer, as sent), model, images, schema}
//                               and answers per the mode: clean (no findings), block (one blocking
//                               finding on page 1), garbage (not the schema), error (503)
//   POST /_mode?m=<mode>        sets the mode;  GET /_log  the log;  POST /_reset  empties it
let mode = "clean";
const log: Record<string, unknown>[] = [];

Deno.serve({ port: 8080 }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/_mode" && req.method === "POST") {
    mode = url.searchParams.get("m") ?? "clean";
    return Response.json({ mode });
  }
  if (url.pathname === "/_log") return Response.json(log);
  if (url.pathname === "/_reset" && req.method === "POST") {
    log.length = 0;
    return Response.json({ ok: true });
  }
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* not json */ }
  const content = body?.messages?.[1]?.content;
  log.push({
    host: req.headers.get("host"), method: req.method, path: url.pathname, auth: req.headers.get("authorization"),
    model: body?.model ?? null, images: Array.isArray(content) ? content.filter((c: any) => c?.type === "image_url").length : 0,
    schema: body?.response_format?.json_schema?.name ?? null, mode,
  });
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return Response.json({ error: "not found" }, { status: 404 });
  if (mode === "error") return Response.json({ error: "stand-in error" }, { status: 503 });
  const answer = mode === "garbage" ? "the pages look fine to me"
    : JSON.stringify(mode === "block"
      ? { blocking_findings: [{ page: 1, issue: "stand-in: the table on this page is cut off at the right edge" }], warnings: [] }
      : { blocking_findings: [], warnings: [] });
  return Response.json({ id: "stand-in", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }] });
});
