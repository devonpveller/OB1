// Stand-in for openbrain-mcp / openbrain-ext in the mcpo-resilience throwaway compose.
// Answers an MCP `initialize` POST with the right x-brain-key (200), anything else 401/405.
// START_DELAY_MS holds the listener back, so "upstream not ready yet" is real: connection refused.
const delay = Number(Deno.env.get("START_DELAY_MS") ?? "0");
const key = Deno.env.get("MCP_ACCESS_KEY") ?? "";
await new Promise((r) => setTimeout(r, delay));
Deno.serve({ port: 8000 }, async (req) => {
  if (key === "" || req.headers.get("x-brain-key") !== key) {
    return new Response('{"error":"Invalid or missing access key"}', { status: 401 });
  }
  if (req.method !== "POST") return new Response("{}", { status: 405 });
  const b = await req.json().catch(() => null);
  if (b?.method === "initialize") {
    return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } });
  }
  return Response.json({ jsonrpc: "2.0", id: b?.id ?? null, result: {} });
});
