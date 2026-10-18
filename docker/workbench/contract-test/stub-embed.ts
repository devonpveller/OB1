// A stand-in for the embedding endpoint, for the disposable contract-test network only
// (rw-p0-contract). Answers POST /v1/embeddings with one fixed 1024-dim vector per input, so
// the workbench's held-source add can store, chunk and embed without an inference plane.
Deno.serve({ port: 8080 }, async (req) => {
  const url = new URL(req.url);
  if (req.method !== "POST" || !url.pathname.endsWith("/embeddings")) return new Response("not found", { status: 404 });
  const body = await req.json().catch(() => ({}));
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
  const vec = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
  return Response.json({ data: inputs.map((_: unknown, index: number) => ({ index, embedding: vec })) });
});
