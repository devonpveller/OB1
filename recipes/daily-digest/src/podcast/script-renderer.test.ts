// Regression tests for makeScriptChat (2026-08-29).
//
// WHY THESE EXIST: from the J.1 virtual-key flip (2026-08-21) until 2026-08-29 this
// helper sent `Bearer not-needed`, took a 401 on every call, and returned null with
// no retry and no log. renderEpisode fell back to dumping raw grounded material, so
// the daily podcast shipped a 47KB transcript prompt instead of a script for days
// and finally failed outright. Two properties keep that from recurring: the key is
// always sent, and a transient failure is re-sampled instead of silently degrading.
//
// Run: deno test --allow-net --allow-env script-renderer.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { makeScriptChat } from "./script-renderer.ts";

type Handler = (req: Request, hit: number) => Response | Promise<Response>;

/** Stub completions endpoint. Returns the base url, a hit counter and a stopper. */
function stubServer(handler: Handler) {
  let hits = 0;
  const seenAuth: string[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      hits++;
      seenAuth.push(req.headers.get("authorization") ?? "");
      await req.text().catch(() => "");
      return await handler(req, hits);
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    hits: () => hits,
    auth: () => seenAuth,
    stop: async () => { ac.abort(); await server.finished.catch(() => {}); },
  };
}

function ok(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

Deno.test("a 5xx is retried and the eventual success is returned", async () => {
  const s = stubServer((_r, hit) => hit < 3 ? new Response("upstream boom", { status: 503 }) : ok("the script"));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0 });
  assertEquals(await chat("sys", "user"), "the script");
  assertEquals(s.hits(), 3);
  await s.stop();
});

Deno.test("a 429 is retried (queue saturation is transient)", async () => {
  const s = stubServer((_r, hit) => hit < 2 ? new Response("saturated", { status: 429 }) : ok("recovered"));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0 });
  assertEquals(await chat("sys", "user"), "recovered");
  assertEquals(s.hits(), 2);
  await s.stop();
});

Deno.test("a 401 is NOT retried - a missing key is config, not weather", async () => {
  const s = stubServer(() => new Response("Virtual Key expected", { status: 401 }));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0 });
  assertEquals(await chat("sys", "user"), null);
  assertEquals(s.hits(), 1);
  await s.stop();
});

Deno.test("an empty 200 is re-sampled rather than accepted as a null answer", async () => {
  const s = stubServer((_r, hit) => hit < 2 ? ok("   ") : ok("real content"));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0 });
  assertEquals(await chat("sys", "user"), "real content");
  assertEquals(s.hits(), 2);
  await s.stop();
});

Deno.test("attempts are bounded - a permanent 5xx gives up and returns null", async () => {
  const s = stubServer(() => new Response("down", { status: 500 }));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0, attempts: 3 });
  assertEquals(await chat("sys", "user"), null);
  assertEquals(s.hits(), 3);
  await s.stop();
});

Deno.test("the configured key is sent as a Bearer token", async () => {
  const s = stubServer(() => ok("x"));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-explicit", retryDelayMs: 0 });
  await chat("sys", "user");
  assertEquals(s.auth()[0], "Bearer sk-explicit");
  await s.stop();
});

Deno.test("with no apiKey it falls back to CHAT_API_KEY, never a placeholder", async () => {
  const s = stubServer(() => ok("x"));
  Deno.env.set("CHAT_API_KEY", "sk-from-env");
  try {
    const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", retryDelayMs: 0 });
    await chat("sys", "user");
    assertEquals(s.auth()[0], "Bearer sk-from-env");
  } finally {
    Deno.env.delete("CHAT_API_KEY");
    await s.stop();
  }
});
