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
import { makeScriptChat, retryUntil } from "./script-renderer.ts";

type Handler = (req: Request, hit: number) => Response | Promise<Response>;

/** Stub completions endpoint. Returns the base url, a hit counter and a stopper. */
function stubServer(handler: Handler) {
  let hits = 0;
  const seenAuth: string[] = [];
  const seenBodies: string[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      hits++;
      seenAuth.push(req.headers.get("authorization") ?? "");
      seenBodies.push(await req.text().catch(() => ""));
      return await handler(req, hits);
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    hits: () => hits,
    auth: () => seenAuth,
    /** max_tokens actually sent, per request - the truncation tests assert the
     *  budget ESCALATES rather than re-sampling into the same wall. */
    budgets: () => seenBodies.map((b) => JSON.parse(b || "{}").max_tokens),
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

// ── truncation (added 2026-09-04 after test FAILED the delivery item) ─────────
// The 401 fix made a script get GENERATED; it did not make it COMPLETE. Measured
// on the artifact itself: completion_tokens == max_tokens == 2200 exactly, text
// ending "...It also supports" mid-sentence, 4 of 7 segments, no sign-off. A
// truncated completion reads like a finished one, so nothing downstream could
// tell - which is precisely the silent-degradation class this item exists to end.

/** A 200 whose finish_reason says the model ran out of budget. */
function truncated(content: string): Response {
  return Response.json({ choices: [{ message: { content }, finish_reason: "length" }] });
}
function complete(content: string): Response {
  return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

Deno.test("a truncated completion is re-run with a DOUBLED budget, not re-sampled into the same wall", async () => {
  const s = stubServer((_r, hit) => hit === 1 ? truncated("cut off mid-") : complete("the whole script"));
  const chat = makeScriptChat({
    chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0, maxTokens: 2200,
  });
  assertEquals(await chat("sys", "user"), "the whole script");
  assertEquals(s.hits(), 2);
  assertEquals(s.budgets(), [2200, 4400]); // escalated, not repeated
  await s.stop();
});

Deno.test("truncation at the ceiling returns the cut-off text but SAYS SO (never silently)", async () => {
  const s = stubServer(() => truncated("still cut off"));
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  try {
    const chat = makeScriptChat({
      chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0,
      maxTokens: 1000, maxTokensCeiling: 2000, attempts: 3,
    });
    // Least-bad: returning null degrades to dumping raw grounded material.
    assertEquals(await chat("sys", "user"), "still cut off");
    // Doubles once to the ceiling, then STOPS: re-running at a budget already at
    // the ceiling would truncate identically and only burn the clock. So two
    // calls, not the full three attempts.
    assertEquals(s.budgets(), [1000, 2000]);
  } finally {
    console.warn = realWarn;
    await s.stop();
  }
  const loud = warnings.filter((w) => w.includes("TRUNCATED"));
  assertEquals(loud.length > 0, true, `expected a TRUNCATED warning, got ${JSON.stringify(warnings)}`);
  assertEquals(
    loud.some((w) => w.includes("INCOMPLETE")),
    true,
    `the ceiling warning must call the episode INCOMPLETE, got ${JSON.stringify(loud)}`,
  );
});

Deno.test("a complete completion is returned untouched and costs exactly one call", async () => {
  const s = stubServer(() => complete("done properly"));
  const chat = makeScriptChat({ chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0 });
  assertEquals(await chat("sys", "user"), "done properly");
  assertEquals(s.hits(), 1);
  await s.stop();
});

// ── network error (the plan claimed this was covered; it was not) ─────────────
Deno.test("a NETWORK error is retried, not just an HTTP status", async () => {
  // Nothing listens on this port, so fetch REJECTS rather than returning a status.
  const dead = "http://127.0.0.1:9/v1";
  const chat = makeScriptChat({
    chatApiBase: dead, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0, attempts: 3,
  });
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  try {
    assertEquals(await chat("sys", "user"), null);
  } finally {
    console.warn = realWarn;
  }
  // Two "retrying" lines then one "giving up" - i.e. it really made 3 attempts.
  assertEquals(warnings.filter((w) => w.includes("retrying")).length, 2, JSON.stringify(warnings));
  assertEquals(warnings.filter((w) => w.includes("giving up after 3")).length, 1, JSON.stringify(warnings));
});

// ── ON audio retry policy (was UNVERIFIABLE: generateAudio is not exported) ───
Deno.test("retryUntil: a failed first attempt is retried and the second result is taken", async () => {
  const seen: number[] = [];
  const out = await retryUntil<string>(2, (attempt) => {
    seen.push(attempt);
    return Promise.resolve(attempt === 1 ? { done: false } : { done: true, value: "audio-id" });
  });
  assertEquals(out, "audio-id");
  assertEquals(seen, [1, 2]);
});

Deno.test("retryUntil: a THROW counts as a failed attempt and reaches onError", async () => {
  const errs: string[] = [];
  const out = await retryUntil<string>(
    2,
    (attempt) => {
      if (attempt === 1) throw new Error("ON exploded");
      return Promise.resolve({ done: true, value: "recovered" });
    },
    (err) => errs.push(String(err)),
  );
  assertEquals(out, "recovered");
  assertEquals(errs.length, 1);
  assertEquals(errs[0].includes("ON exploded"), true);
});

Deno.test("retryUntil: 'done' ends the loop even when the value is null - a COMPLETED job is not re-submitted", async () => {
  // Faithful to generateAudio: ON said completed but the episode lookup lagged.
  // Re-submitting there would re-run a minutes-long audio job for nothing.
  let calls = 0;
  const out = await retryUntil<string>(3, () => {
    calls++;
    return Promise.resolve({ done: true, value: null });
  });
  assertEquals(out, null);
  assertEquals(calls, 1);
});

Deno.test("retryUntil: exhausting every attempt yields null", async () => {
  let calls = 0;
  const out = await retryUntil<string>(2, () => {
    calls++;
    return Promise.resolve({ done: false });
  });
  assertEquals(out, null);
  assertEquals(calls, 2);
});

// ── attempt-2 regressions (test FAILED the item on all three) ─────────────────

Deno.test("escalation is never WORSE than not escalating: a late timeout keeps the earlier truncated text", async () => {
  // Attempt 2's control: escalate -> null, don't escalate -> usable text. The
  // bigger budget takes proportionally longer, so the retry could time out AFTER
  // usable-but-cut-off text had already been thrown away.
  const s = stubServer(async (_r, hit) => {
    if (hit === 1) return truncated("HOST A: first half. HOST B: cut off mid-");
    await new Promise((r) => setTimeout(r, 300)); // outlast the scaled timeout
    return complete("never arrives");
  });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const chat = makeScriptChat({
      chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0,
      maxTokens: 1000, maxTokensCeiling: 2000, attempts: 2, timeoutMs: 60,
    });
    // Trimmed to the last COMPLETE sentence, never null.
    assertEquals(await chat("sys", "user"), "HOST A: first half.");
  } finally {
    console.warn = realWarn;
    await s.stop();
  }
});

Deno.test("the timeout SCALES with the escalated budget (a doubled budget gets a doubled clock)", async () => {
  // Without scaling, an escalated request cannot physically finish: measured
  // throughput 28.9-60.4 tok/s against a FIXED 200s meant 12k tokens always
  // overran. Assert the second attempt is actually given more time by making it
  // slower than the BASE timeout but faster than the scaled one.
  const s = stubServer(async (_r, hit) => {
    if (hit === 1) return truncated("cut off");
    await new Promise((r) => setTimeout(r, 120));
    return complete("finished in the longer window");
  });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const chat = makeScriptChat({
      chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0,
      maxTokens: 1000, maxTokensCeiling: 2000, attempts: 2, timeoutMs: 100,
    });
    // 120ms > the 100ms base timeout, but < the 200ms the doubled budget earns.
    assertEquals(await chat("sys", "user"), "finished in the longer window");
    assertEquals(s.budgets(), [1000, 2000]);
  } finally {
    console.warn = realWarn;
    await s.stop();
  }
});

Deno.test("cut-off text is trimmed to the last COMPLETE sentence (it becomes the TTS prompt)", async () => {
  // An unterminated segment is what aborted the 2026-08-29 episode downstream.
  const s = stubServer(() => truncated("HOST A: one. HOST B: two! HOST A: three and then it stops mid-"));
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const chat = makeScriptChat({
      chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0,
      maxTokens: 1000, maxTokensCeiling: 1000, attempts: 1,
    });
    assertEquals(await chat("sys", "user"), "HOST A: one. HOST B: two!");
  } finally {
    console.warn = realWarn;
    await s.stop();
  }
});

Deno.test("text with no complete sentence is returned whole, never emptied", async () => {
  const s = stubServer(() => truncated("no terminator anywhere in here"));
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const chat = makeScriptChat({
      chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0,
      maxTokens: 500, maxTokensCeiling: 500, attempts: 1,
    });
    assertEquals(await chat("sys", "user"), "no terminator anywhere in here");
  } finally {
    console.warn = realWarn;
    await s.stop();
  }
});

// ── attempt-3 regression: state must be PER CALL, not per ChatFn ─────────────
// One ChatFn is reused for every email (poiChat/bodyClassifyChat, MAX_EMAILS
// defaults to 1000). With budget/bestTruncated at closure scope, one call's
// truncated text was returned as ANOTHER call's answer, and the escalated
// budget never reset. Every earlier test used a fresh ChatFn for a single
// call, which is precisely why a 19-test green suite missed it.

Deno.test("a reused ChatFn does not leak one call's truncated text into another call's answer", async () => {
  const s = stubServer((_r, hit) => {
    if (hit === 1) return truncated("Call ONE text. It stops mid-");
    return new Response("Virtual Key expected", { status: 401 }); // config fault: null is correct
  });
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const chat = makeScriptChat({
      chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0,
      maxTokens: 100, maxTokensCeiling: 100, attempts: 1,
    });
    assertEquals(await chat("sys", "call one"), "Call ONE text.");
    // A 401 must answer null - NEVER the previous call's content.
    assertEquals(await chat("sys", "call two"), null);
  } finally {
    console.warn = realWarn;
    await s.stop();
  }
});

Deno.test("a reused ChatFn resets its token budget to the base on every call", async () => {
  const s = stubServer((_r, hit) => hit === 1 ? truncated("cut") : complete("fine"));
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const chat = makeScriptChat({
      chatApiBase: s.base, chatModel: "m", apiKey: "sk-test", retryDelayMs: 0,
      maxTokens: 100, maxTokensCeiling: 200, attempts: 2,
    });
    await chat("sys", "call one"); // escalates 100 -> 200
    await chat("sys", "call two"); // must START at 100 again
    assertEquals(s.budgets(), [100, 200, 100]);
  } finally {
    console.warn = realWarn;
    await s.stop();
  }
});
