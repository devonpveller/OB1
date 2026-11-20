// deno test src/util/embed_private_test.ts - rw-owner-private-view: the private search's query embedder uses the
// workbench's OWN key (PRIVATE_EMBEDDING_API_KEY) and nothing else: blank = no embedder at all (the route answers 503
// and calls nothing), never the shared path's key (which falls back to the MCP key).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { privateEmbedder } from "./embed.ts";

Deno.test("a blank private key gives no embedder (no fallback to the shared key)", () => {
  assertEquals(privateEmbedder(""), null);
});

Deno.test("a set private key: the call carries that key, and only the query text", async () => {
  const seen: { auth: string | null; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    seen.push({ auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const e = privateEmbedder("the-private-key");
    assert(e);
    assertEquals(await e("my query"), [0.1, 0.2]);
    assertEquals(seen.length, 1);
    assertEquals(seen[0].auth, "Bearer the-private-key");
    assertEquals(JSON.parse(seen[0].body).input, "my query");
  } finally {
    globalThis.fetch = real;
  }
});
