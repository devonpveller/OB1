// rwr-voices: the voice sample the workbench asks this service for (POST /sample). One short fixed sentence, voiced by the
// SAME speech function the renderer uses (gatewaySpeech: LiteLLM's audio route, this service's own virtual key), and
// returned as a WAV. No network: guardNetwork refuses anything off-host, and the stub speech function is the only voice.
//
// Run: deno test --allow-read --allow-env --allow-net=127.0.0.1 src/podcast/sample.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { guardNetwork } from "../routine/testing.ts";
import { PCM, type SpeechRequest } from "./tts-client.ts";
import { pcmToWav, SAMPLE_TEXT, sampleHandler } from "./sample.ts";
import { PodcastService, servePodcast } from "./podcast-service.ts";

guardNetwork();

const KEY = "k-sample";
function stub() {
  const calls: SpeechRequest[] = [];
  const speech = (r: SpeechRequest) => {
    calls.push(r);
    return Promise.resolve(new Uint8Array(2400 * 2).fill(3));
  };
  return { speech, calls };
}
const post = (h: ReturnType<typeof sampleHandler>, body: unknown, key = KEY) =>
  h(new Request("http://podcast/sample", { method: "POST", headers: { "x-brain-key": key, "content-type": "application/json" }, body: JSON.stringify(body) }));

Deno.test("a sample is one fixed sentence through the speech function, returned as a WAV", async () => {
  const s = stub();
  const h = sampleHandler({ speech: s.speech, key: KEY });
  const r = await post(h, { route: "local-tts", voice: "bm_george", speed: 1.1 });
  assertEquals(r.status, 200);
  assertEquals(r.headers.get("content-type"), "audio/wav");
  assertEquals(r.headers.get("cache-control"), "no-store");
  assertEquals(s.calls, [{ route: "local-tts", voice: "bm_george", speed: 1.1, text: SAMPLE_TEXT }]);
  const b = new Uint8Array(await r.arrayBuffer());
  assertEquals(new TextDecoder().decode(b.slice(0, 4)), "RIFF");
  assertEquals(new TextDecoder().decode(b.slice(8, 12)), "WAVE");
  assertEquals(b.length, 44 + 2400 * 2);
  assert(SAMPLE_TEXT.length < 200, "a short sentence");
});

Deno.test("the WAV header says 24 kHz mono 16-bit and the data length", () => {
  const w = pcmToWav(new Uint8Array(100));
  const v = new DataView(w.buffer);
  assertEquals(v.getUint16(20, true), 1); // PCM
  assertEquals(v.getUint16(22, true), PCM.channels);
  assertEquals(v.getUint32(24, true), PCM.sampleRate);
  assertEquals(v.getUint16(34, true), 16);
  assertEquals(v.getUint32(40, true), 100);
  assertEquals(v.getUint32(4, true), 36 + 100);
});

Deno.test("no key, a wrong key, a text of the caller's, a URL as a route, a wild speed: refused, nothing voiced", async () => {
  const s = stub();
  const h = sampleHandler({ speech: s.speech, key: KEY });
  assertEquals((await post(h, { route: "local-tts", voice: "bm_george", speed: 1 }, "")).status, 401);
  assertEquals((await post(h, { route: "local-tts", voice: "bm_george", speed: 1 }, "nope")).status, 401);
  assertEquals((await sampleHandler({ speech: s.speech, key: "" })(new Request("http://p/sample", { method: "POST", body: "{}" }))).status, 401);
  for (const bad of [
    { route: "local-tts", voice: "bm_george", speed: 1, text: "say this instead" },
    { route: "http://kokoro-tts-upstream:8880/v1", voice: "bm_george", speed: 1 },
    { route: "local-tts", voice: "../x", speed: 1 },
    { route: "local-tts", voice: "bm_george", speed: 40 },
    { route: "local-tts", voice: "bm_george" },
    {},
  ]) assertEquals((await post(h, bad)).status, 400, JSON.stringify(bad));
  assertEquals((await h(new Request("http://p/sample", { method: "POST", headers: { "x-brain-key": KEY }, body: "{not json" }))).status, 400);
  assertEquals(s.calls.length, 0, "nothing was voiced");
});

Deno.test("a failing gateway is a 502 with a fixed message (no upstream text)", async () => {
  const h = sampleHandler({ speech: () => Promise.reject(new Error("HTTP 500 secret-upstream-detail")), key: KEY });
  const r = await post(h, { route: "local-tts", voice: "bm_george", speed: 1 });
  assertEquals(r.status, 502);
  const t = await r.text();
  assert(!t.includes("secret-upstream-detail"), t);
});

Deno.test("POST /sample on the service is keyed like /render and absent when no sampler is given", async () => {
  const s = stub();
  const ac = new AbortController();
  const svc = new PodcastService({
    clock: { now: () => new Date(), sleep: () => Promise.resolve() } as never, tz: "UTC", followUpCutoff: "12:00", store: {} as never,
    script: "x.ts", runArgs: [], cwd: ".", nextTriggerUrl: "", maxRunMs: 1000, maxResumes: 0,
  });
  let port = 0;
  const srv = servePodcast(svc, { port: 0, hostname: "127.0.0.1", signal: ac.signal, sample: sampleHandler({ speech: s.speech, key: KEY }), renderKey: KEY, onListen: (a) => { port = a.port; } });
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/sample`, { method: "POST", headers: { "x-brain-key": KEY }, body: JSON.stringify({ route: "local-tts", voice: "af_bella", speed: 1 }) });
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
    const no = await fetch(`http://127.0.0.1:${port}/sample`, { method: "POST", body: "{}" });
    assertEquals(no.status, 401);
    await no.body?.cancel();
  } finally {
    ac.abort();
    await srv.finished;
  }
});
