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
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type ChatFn,
  type Episode,
  type EpisodeInput,
  failureReason,
  makeScriptChat,
  primaryTopic,
  renderEpisode,
} from "./script-renderer.ts";

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

// ── the S4a fallback must announce itself (2026-09-04) ──────────────────────
//
// WHY THESE EXIST: authenticating the chat call (2026-08-29) made the FAILURE
// loud, but not the DEGRADATION. renderEpisode still swapped a written script
// for a raw material dump with nothing in the log saying an episode had
// degraded, so episodes 076-089 shipped the fallback marker and the only
// visible symptom was a filename that read like a sentence. A caller that
// degrades has to say so, and name what it was degrading from.

/** Collect console.warn output while fn runs. */
async function captureWarn(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.warn = orig; }
  return lines;
}

const EPISODE: EpisodeInput = {
  date: "2026-08-29",
  episodeNumber: 83,
  segments: [{
    label: "brain/ai/nate b jones",
    items: [{
      title: "Codex, Grok and Claude all agree",
      url: "https://example.invalid/a",
      synthesis: "[SOURCED] The article is a Substack post by Nate. [Source 1]",
    }],
  }],
};

Deno.test("renderEpisode WARNs when it falls back to raw grounded material", async () => {
  const chat: ChatFn = () => Promise.resolve(null);
  let ep: Episode | undefined;
  const warns = await captureWarn(async () => { ep = await renderEpisode(EPISODE, chat); });

  // the degraded episode still ships - that is deliberate
  assertStringIncludes(ep!.script, "script generation unavailable");

  const line = warns.find((l) => l.includes("DEGRADED"));
  assert(line, `no DEGRADED warning emitted; got: ${JSON.stringify(warns)}`);
  assertStringIncludes(line!, "[script]");        // names the stage
  assertStringIncludes(line!, "083");             // names the episode
  assertStringIncludes(line!, "raw grounded material");
});

Deno.test("the DEGRADED warning names the underlying chat failure, not just 'null'", async () => {
  const s = stubServer(() => new Response("Virtual Key expected", { status: 401 }));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0 });
  const warns = await captureWarn(async () => { await renderEpisode(EPISODE, chat); });
  await s.stop();

  const line = warns.find((l) => l.includes("DEGRADED"));
  assert(line, `no DEGRADED warning emitted; got: ${JSON.stringify(warns)}`);
  assertStringIncludes(line!, "HTTP 401");
  assertStringIncludes(line!, "Virtual Key expected");
});

Deno.test("makeScriptChat records why its last call returned null", async () => {
  const s = stubServer(() => new Response("down", { status: 500 }));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0, attempts: 2 });
  assertEquals(await chat("sys", "user"), null);
  assertStringIncludes(failureReason(chat), "HTTP 500");
  await s.stop();
});

Deno.test("a successful call clears the recorded failure", async () => {
  const s = stubServer((_r, hit) => hit < 2 ? new Response("down", { status: 500 }) : ok("the script"));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0 });
  assertEquals(await chat("sys", "user"), "the script");
  assertEquals(failureReason(chat), "no failure recorded");
  await s.stop();
});

Deno.test("failureReason is safe on a plain ChatFn that records nothing", () => {
  const plain: ChatFn = () => Promise.resolve(null);
  assertStringIncludes(failureReason(plain), "not recorded");
});

Deno.test("primaryTopic WARNs when it falls back to the heuristic slug", async () => {
  const chat: ChatFn = () => Promise.resolve(null);
  let slug = "";
  const warns = await captureWarn(async () => { slug = await primaryTopic(EPISODE, chat); });
  // the sentence-shaped slug is the operator-visible symptom of this fallback
  assertStringIncludes(slug, "the-article-is-a-substack-post-by-nate");
  const line = warns.find((l) => l.includes("topic"));
  assert(line, `no topic warning emitted; got: ${JSON.stringify(warns)}`);
  assertStringIncludes(line!, "[script]");
});
