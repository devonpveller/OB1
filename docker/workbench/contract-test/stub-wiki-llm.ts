// stub-wiki-llm.ts - rw-inlet-owner's stand-in for the LiteLLM gateway (alias `llama-cpp`) while the REAL entity-wiki
// compiler (recipes/entity-wiki/generate-wiki.mjs) rebuilds the withheld entity pages in the disposable lab. It keeps
// every prompt it was sent (so the lab can prove the rebuild read shared material only), and answers a well-formed
// entity page that names only how many characters of material it got - never the material.
//
//   POST /v1/chat/completions   kept; answers "# <Entity>" + a one-line body
//   POST /v1/embeddings         kept; answers zero vectors of the requested dimension (1024 by default)
//   GET  /_log                  [{host, path, prompt}]   POST /_reset empties it
const log: { host: string | null; path: string; prompt: string }[] = [];

Deno.serve({ port: 8080 }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/_log") return Response.json(log);
  if (url.pathname === "/_reset" && req.method === "POST") { log.length = 0; return Response.json({ ok: true }); }
  // deno-lint-ignore no-explicit-any
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* not json */ }
  const prompt = JSON.stringify(body?.messages ?? body?.input ?? "");
  log.push({ host: req.headers.get("host"), path: url.pathname, prompt });
  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
    const dim = Number(body?.dimensions ?? 1024);
    return Response.json({ object: "list", data: inputs.map((_: unknown, i: number) => ({ object: "embedding", index: i, embedding: Array(dim).fill(0) })) });
  }
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return Response.json({ error: "not found" }, { status: 404 });
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const user = String(msgs[msgs.length - 1]?.content ?? "");
  const name = (user.match(/Entity(?: name)?:\s*([^\n]+)/i)?.[1] ?? "Entity").trim().slice(0, 80);
  return Response.json({
    id: "stand-in", object: "chat.completion", model: body?.model ?? "stub",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `# ${name}\n\nRebuilt by the lab's stand-in from ${prompt.length} characters of material.\n` } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
});
