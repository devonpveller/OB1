// A stand-in embedding endpoint for the [5s] lab (rw-owner-private-view), disposable network only. It COUNTS calls by the
// key they carry (STUB_PRIVATE_KEY = the workbench's own private-search key, STUB_MCP_KEY = the MCP fallback key the
// shared path may use) and answers a fixed one-hot vector: index 7 for a text containing "nearest probe" (the vector the
// plant gives A's and B's probe chunks), index 1023 for anything else. GET /calls -> {"private":n,"mcp":n,"other":n};
// no input text is logged or kept.
const PRIV = Deno.env.get("STUB_PRIVATE_KEY") ?? "";
const MCP = Deno.env.get("STUB_MCP_KEY") ?? "";
const calls = { private: 0, mcp: 0, other: 0 };
const onehot = (k: number) => Array.from({ length: 1024 }, (_, i) => (i === k ? 1 : 0));
Deno.serve({ port: 8080 }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/calls") return Response.json(calls);
  if (req.method !== "POST" || !url.pathname.endsWith("/embeddings")) return new Response("not found", { status: 404 });
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (PRIV && auth === PRIV) calls.private++;
  else if (MCP && auth === MCP) calls.mcp++;
  else calls.other++;
  const body = await req.json().catch(() => ({}));
  const inputs: unknown[] = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  return Response.json({ data: inputs.map((t, index) => ({ index, embedding: onehot(String(t).includes("nearest probe") ? 7 : 1023) })) });
});
