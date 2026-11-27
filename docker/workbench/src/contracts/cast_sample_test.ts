// deno test --allow-read --allow-env src/contracts/cast_sample_test.ts - rwr-voices: the voice sample route, no database.
// POST /cast/voices/{id}/sample: the caller's OWN voice link only (another user's, a shared pool's and a missing id are one
// 404), voiced by openbrain-podcast and by nothing else (the workbench holds no TTS address and no TTS key: the podcast
// service speaks through LiteLLM with its own virtual key), one fixed sentence the caller cannot change, never cached.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createContractApp, openApiDocument } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { podcastSampler, SampleFailed, sampleUrlFrom } from "./logic/sample.ts";
import { USER_ONLY } from "../middleware/identity.ts";

const VOICE_ROW = { id: "voice-mine", route: "local-tts", voice: "bm_george", speed: 1.2, used_by: [], created_at: "2026-10-17T12:00:00.000Z", updated_at: "2026-10-17T12:00:00.000Z" };
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

// A Db that knows ONE voice link and which owner it belongs to; every statement is kept.
function voiceDb(ownerSub: string) {
  const log: { sql: string; params: unknown[] }[] = [];
  const db: Db = {
    query: <T>(sql: string, params: unknown[] = []) => {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/FROM public\.podcast_voice_links v WHERE v\.id = \$1 AND v\.owner_sub = \$2/.test(sql)) {
        return Promise.resolve((params[0] === "voice-mine" && params[1] === ownerSub ? [VOICE_ROW] : []) as T[]);
      }
      return Promise.resolve([] as T[]);
    },
    tx: (fn) => fn(db),
  };
  return { db, log };
}
function appWith(db: Db, sample?: (v: { route: string; voice: string; speed: number }) => Promise<Uint8Array>) {
  return createContractApp({
    db, registry: new RegistryReader(db), scorer: unavailableScorer, embed: () => Promise.reject(new Error("no embedder")), chunk: () => [],
    mountsRoot: "/mounts", streamPollMs: 1000, log: () => {}, sampleVoice: sample,
  });
}
const URL_ = "http://x/workbench/contract/cast/voices";

Deno.test("the route is in the document: POST /cast/voices/{id}/sample answers audio/wav, user-only, no body, no MCP tool", () => {
  const doc = openApiDocument(appWith(voiceDb("u").db)) as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const op = doc.paths["/workbench/contract/cast/voices/{id}/sample"]?.post as Record<string, unknown> & { responses: Record<string, { content?: Record<string, unknown> }>; requestBody?: unknown };
  assert(op, "the route is documented");
  assert(op.responses["200"].content?.["audio/wav"], "a 200 is audio/wav");
  assertEquals(op.requestBody, undefined, "the sentence is fixed: no body");
  assertEquals(op["x-mcp-tool"], undefined);
  for (const code of ["404", "429", "502", "503"]) assert(op.responses[code], `${code} is documented`);
  assert(USER_ONLY.test("/workbench/contract/cast/voices/x/sample"));
});

Deno.test("a sample of the caller's own voice: audio/wav, no-store, voiced with exactly the link's route, voice and speed", async () => {
  const { db } = voiceDb("operator");
  const seen: unknown[] = [];
  const app = appWith(db, (v) => { seen.push(v); return Promise.resolve(WAV); });
  const r = await app.request(`${URL_}/voice-mine/sample`, { method: "POST" });
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("content-type"), "audio/wav");
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertEquals(new Uint8Array(await r.arrayBuffer()), WAV);
  assertEquals(seen, [{ route: "local-tts", voice: "bm_george", speed: 1.2 }]);
});

Deno.test("another user's voice, a missing id and a malformed id are ONE 404 and nothing is voiced", async () => {
  const { db } = voiceDb("somebody-else");
  let voiced = 0;
  const app = appWith(db, () => { voiced++; return Promise.resolve(WAV); });
  const bodies: string[] = [];
  for (const id of ["voice-mine", "voice-nope", "..%2Fx", "a%20b"]) {
    const r = await app.request(`${URL_}/${id}/sample`, { method: "POST" });
    assertEquals(r.status, 404, id);
    bodies.push(await r.text());
  }
  assertEquals(new Set(bodies).size, 1, "the same body for every refusal");
  assertEquals(voiced, 0);
});

Deno.test("no sampler configured: 503 with a fixed message, nothing voiced", async () => {
  const { db } = voiceDb("operator");
  const r = await appWith(db).request(`${URL_}/voice-mine/sample`, { method: "POST" });
  assertEquals(r.status, 503);
  assert(!(await r.text()).includes("PODCAST"), "no variable name leaks to a browser");
});

Deno.test("a failing voice engine is a 502 with a fixed message (no upstream text)", async () => {
  const { db } = voiceDb("operator");
  const app = appWith(db, () => Promise.reject(new SampleFailed("HTTP 500 upstream-secret")));
  const r = await app.request(`${URL_}/voice-mine/sample`, { method: "POST" });
  assertEquals(r.status, 502);
  assert(!(await r.text()).includes("upstream-secret"));
});

Deno.test("two samples at once, and a burst, are refused with 429 (one person cannot hold the voice engine)", async () => {
  const { db } = voiceDb("operator");
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => { release = ok; });
  const app = appWith(db, async () => { await gate; return WAV; });
  const first = app.request(`${URL_}/voice-mine/sample`, { method: "POST" });
  await new Promise((ok) => setTimeout(ok, 10));
  const second = await app.request(`${URL_}/voice-mine/sample`, { method: "POST" });
  assertEquals(second.status, 429);
  release();
  assertEquals((await first).status, 200);
  // a burst: more than 12 in a minute
  const quick = appWith(db, () => Promise.resolve(WAV));
  const codes: number[] = [];
  for (let i = 0; i < 16; i++) codes.push((await quick.request(`${URL_}/voice-mine/sample`, { method: "POST" })).status);
  assertEquals(codes.slice(0, 12).every((c) => c === 200), true);
  assertEquals(codes.slice(12).every((c) => c === 429), true);
});

Deno.test("sampleUrlFrom: the sample address is the render service's own host, /sample", () => {
  assertEquals(sampleUrlFrom("http://openbrain-podcast:8080/render"), "http://openbrain-podcast:8080/sample");
  assertEquals(sampleUrlFrom("http://openbrain-podcast:8080/render/"), "http://openbrain-podcast:8080/sample");
  assertEquals(sampleUrlFrom(""), "");
  assertEquals(sampleUrlFrom("not a url"), "");
  assertEquals(sampleUrlFrom("ftp://x/render"), "");
});

Deno.test("podcastSampler asks ONLY the podcast service, keyed, with route/voice/speed and no text; a direct TTS host never appears", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(WAV, { status: 200, headers: { "content-type": "audio/wav" } }));
  }) as unknown as typeof fetch;
  const s = podcastSampler({ renderUrl: "http://openbrain-podcast:8080/render", key: "k1", fetchFn })!;
  assertEquals(await s({ route: "local-tts", voice: "af_bella", speed: 0.9 }), WAV);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://openbrain-podcast:8080/sample");
  assertEquals((calls[0].init.headers as Record<string, string>)["x-brain-key"], "k1");
  assertEquals(JSON.parse(String(calls[0].init.body)), { route: "local-tts", voice: "af_bella", speed: 0.9 });
  for (const c of calls) assert(!/kokoro|llama-cpp|audio\/speech|:8880/.test(c.url), `no direct TTS call: ${c.url}`);
  assertEquals(podcastSampler({ renderUrl: "", key: "k", fetchFn }), null, "blank = inert");
  assertEquals(podcastSampler({ renderUrl: "http://openbrain-podcast:8080/render", key: "", fetchFn }), null, "no key = inert");
});

Deno.test("podcastSampler refuses what is not a short WAV, and never repeats the upstream's text", async () => {
  const mk = (res: () => Response) => podcastSampler({ renderUrl: "http://p:8080/render", key: "k", fetchFn: (() => Promise.resolve(res())) as unknown as typeof fetch })!;
  const v = { route: "local-tts", voice: "af_bella", speed: 1 };
  for (const res of [
    () => new Response("secret-upstream", { status: 500 }),
    () => new Response(WAV, { status: 200, headers: { "content-type": "text/html" } }),
    () => new Response(new Uint8Array(5 * 1024 * 1024), { status: 200, headers: { "content-type": "audio/wav" } }),
    () => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "audio/wav" } }),
  ]) {
    let msg = "";
    try { await mk(res)(v); } catch (e) { assert(e instanceof SampleFailed); msg = String((e as Error).message); }
    assert(msg !== "", "refused");
    assert(!msg.includes("secret-upstream"));
  }
});

Deno.test("the workbench source names no speech host and no audio/speech route (the sample goes through the podcast service)", async () => {
  const bad = /audio\/speech|kokoro|local-tts-upstream|:8880/i;
  const hits: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) { if (e.name !== "generated") await walk(p); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith("_test.ts")) continue;
      const t = await Deno.readTextFile(p);
      // a comment that says what the sample does not do is allowed to name them
      const code = t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      if (bad.test(code)) hits.push(p);
    }
  };
  await walk(decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"));
  assertEquals(hits, []);
});
