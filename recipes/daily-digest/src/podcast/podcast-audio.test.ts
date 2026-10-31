// research-workbench P7a (rw-p7a-tts): the renderer, the segment cache, the archive writer and the
// transcoder, with a stub speech function (no network: guardNetwork refuses anything off-host).
// The ffmpeg cases need the binary (the image has it; PODCAST_REQUIRE_FFMPEG=1 makes its absence a
// FAILURE, which the image's build gate sets).
//
// Run: deno test --allow-read --allow-write --allow-env --allow-run --allow-net=127.0.0.1 src/podcast/podcast-audio.test.ts
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { guardNetwork } from "../routine/testing.ts";
import { castBlock, type Team, turnsFromHostScript } from "./presenters.ts";
import { segmentKey, SegmentCache } from "./segment-cache.ts";
import { renderTranscript, Semaphore } from "./renderer.ts";
import { ArchiveWriter, type Destination, readSidecar, sha256Hex, transcodeArchived } from "./archive.ts";
import { encodePcm, ffmpegBuild, TARGET_MENU, targetOf } from "./ffmpeg.ts";
import { voiceAndArchive } from "./episode-audio.ts";
import { renderEpisode } from "./script-renderer.ts";
import { gatewaySpeech, type SpeechRequest } from "./tts-client.ts";

guardNetwork();

const FFMPEG = Deno.env.get("FFMPEG_BIN") ?? "ffmpeg";
async function probeFfmpeg(): Promise<boolean> {
  try {
    return (await new Deno.Command(FFMPEG, { args: ["-version"], stdout: "null", stderr: "null" }).output()).success;
  } catch {
    return false;
  }
}
const hasFfmpeg = await probeFfmpeg();
const requireFfmpeg = Deno.env.get("PODCAST_REQUIRE_FFMPEG") === "1";

function team(voiceB = "bf_emma"): Team {
  return {
    id: "t1", name: "fixture", description: "",
    presenters: [
      { id: "pa", name: "Alex", personality: "Analytical; asks probing questions", backstory: "A researcher", language: "en-US", voice: { id: "va", route: "local-tts", voice: "bm_george", speed: 1 } },
      { id: "pb", name: "Jamie", personality: "Enthusiastic; practical trade-offs", backstory: "An engineer", language: "en-US", voice: { id: "vb", route: "local-tts", voice: voiceB, speed: 1 } },
    ],
  };
}

// A stub synthesiser: deterministic PCM from the request (so equal requests give equal bytes), and a
// call log. The bytes depend on the VOICE, so two voices are distinct audio for the same text.
function stubSpeech(delayMs = 5) {
  const calls: SpeechRequest[] = [];
  let active = 0;
  let peak = 0;
  const fn = async (r: SpeechRequest) => {
    calls.push(r);
    active++;
    peak = Math.max(peak, active);
    await new Promise((ok) => setTimeout(ok, delayMs));
    active--;
    const seed = new TextEncoder().encode(`${r.voice}|${r.text}`);
    const out = new Uint8Array(2400 * 2); // 0.1 s
    for (let i = 0; i < out.length; i++) out[i] = seed[i % seed.length] ^ (i & 0xff);
    return out;
  };
  return { fn, calls, peak: () => peak };
}

const SCRIPT = [
  "HOST A: Good morning, it is October 30th.",
  "HOST B: Morning! Let's get into the feeds.",
  "HOST A: First, a new reference architecture.",
  "It continues on a second line.",
  "HOST B: That one is practical.",
  "HOST A: Then the benchmark question.",
  "HOST B: And we sign off.",
].join("\n");

const tmp = () => Deno.makeTempDir({ prefix: "p7a-test-" });

Deno.test("turns: HOST A/B lines become the team's presenters in order; continuation lines join the turn", () => {
  const t = turnsFromHostScript("Ep", SCRIPT, team());
  assertEquals(t.turns.length, 6);
  assertEquals(t.turns.map((x) => x.presenterId), ["pa", "pb", "pa", "pb", "pa", "pb"]);
  assertEquals(t.turns[2].text, "First, a new reference architecture. It continues on a second line.");
});

Deno.test("turns: a HOST beyond the cast, or text before the first label, is refused (no words in the wrong mouth)", () => {
  assertThrows(() => turnsFromHostScript("Ep", "HOST C: who am I", team()), Error, "HOST C");
  assertThrows(() => turnsFromHostScript("Ep", "stray\nHOST A: hi", team()), Error, "before its first HOST label");
  assertThrows(() => turnsFromHostScript("Ep", "(script generation unavailable)\n\nSEGMENT", team()), Error);
});

Deno.test("C5 textual: the script prompt carries each presenter's name and personality, distinct per HOST", async () => {
  const cast = castBlock(team());
  assert(cast.includes("HOST A is Alex.") && cast.includes("Analytical; asks probing questions"));
  assert(cast.includes("HOST B is Jamie.") && cast.includes("Enthusiastic; practical trade-offs"));
  let system = "";
  await renderEpisode({ date: "2026-10-30", episodeNumber: 7, segments: [{ label: "brain/x", items: [{ title: "T", url: "https://e.x", synthesis: "[SOURCED] a fact" }] }] },
    async (sys) => {
      if (sys.includes("TWO-HOST")) system = sys; // the script call (the topic call comes first)
      return "HOST A: hi\nHOST B: hello";
    }, cast);
  assert(system.endsWith(cast), "the cast block is appended to the writer's instructions");
});

Deno.test("C3 cache: re-render after changing ONE presenter's voice re-synthesises only that presenter's turns", async () => {
  const dir = await tmp();
  const s = stubSpeech();
  const cache = new SegmentCache(dir, s.fn);
  const t1 = turnsFromHostScript("Ep", SCRIPT, team());
  const first = await renderTranscript(t1, team(), { cache, concurrency: 2 });
  assertEquals([first.stats.hits, first.stats.misses], [0, 6]);
  const again = await renderTranscript(t1, team(), { cache, concurrency: 2 });
  assertEquals([again.stats.hits, again.stats.misses], [6, 0], "an unchanged re-render is all cache hits");
  const relinked = team("af_bella"); // Jamie's voice link changes
  const t2 = turnsFromHostScript("Ep", SCRIPT, relinked);
  const third = await renderTranscript(t2, relinked, { cache, concurrency: 2 });
  const bTurns = t2.turns.filter((x) => x.presenterId === "pb").length;
  assertEquals(third.stats.misses, bTurns, "exactly Jamie's turns are synthesised again");
  assertEquals(third.stats.hits, t2.turns.length - bTurns, "every one of Alex's turns is a hit");
  assert(third.turns.filter((x) => !x.hit).every((x) => x.presenterId === "pb"));
  assertEquals(s.calls.length, 6 + bTurns);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("cache: the key is SHA-256 of route, voice, speed and text; the entry is on disk under it", async () => {
  const r = { route: "local-tts", voice: "bm_george", speed: 1, text: "hello" };
  const k = await segmentKey(r);
  assert(/^[0-9a-f]{64}$/.test(k));
  assert(k !== await segmentKey({ ...r, voice: "bf_emma" }) && k !== await segmentKey({ ...r, speed: 1.1 }) && k !== await segmentKey({ ...r, text: "hello." }));
  const dir = await tmp();
  const cache = new SegmentCache(dir, stubSpeech().fn);
  await cache.get(r);
  assert((await Deno.stat(`${dir}/${k.slice(0, 2)}/${k}.pcm`)).isFile);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("cache: in-flight coalescing - the same turn requested concurrently is synthesised once", async () => {
  const dir = await tmp();
  const s = stubSpeech(40);
  const cache = new SegmentCache(dir, s.fn);
  const r = { route: "local-tts", voice: "bm_george", speed: 1, text: "same words" };
  const got = await Promise.all([cache.get(r), cache.get(r), cache.get(r)]);
  assertEquals(s.calls.length, 1);
  assertEquals(cache.stats.coalesced, 2);
  assert(got.every((g) => g.pcm.length === got[0].pcm.length));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("semaphore: never more than `concurrency` syntheses at once", async () => {
  const dir = await tmp();
  const s = stubSpeech(20);
  const cache = new SegmentCache(dir, s.fn);
  const many = { title: "x", turns: Array.from({ length: 12 }, (_, i) => ({ presenterId: i % 2 ? "pb" : "pa", text: `turn ${i}` })) };
  const r = await renderTranscript(many, team(), { cache, concurrency: 3 });
  assert(s.peak() <= 3 && r.stats.peakConcurrency <= 3, `peak ${s.peak()}`);
  assertEquals(s.peak(), 3, "and the bound is used");
  const sem = new Semaphore(1);
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => sem.run(async () => order.push(n))));
  assertEquals(order, [1, 2, 3]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("C5 audible (stub level): two presenters' voices give different audio for the same text", async () => {
  const dir = await tmp();
  const cache = new SegmentCache(dir, stubSpeech().fn);
  const a = await cache.get({ route: "local-tts", voice: "bm_george", speed: 1, text: "identical words" });
  const b = await cache.get({ route: "local-tts", voice: "bf_emma", speed: 1, text: "identical words" });
  assert(await sha256Hex(a.pcm) !== await sha256Hex(b.pcm));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("speech goes to the gateway's /audio/speech with the route, the voice and this service's key", async () => {
  let seen: { url: string; auth: string; body: Record<string, unknown> } | null = null;
  const fn = gatewaySpeech({
    apiBase: "http://127.0.0.1:9/v1", apiKey: "sk-podcast-test", attempts: 1,
    fetchFn: (async (u: string, init: RequestInit) => {
      seen = { url: String(u), auth: String((init.headers as Record<string, string>).Authorization), body: JSON.parse(String(init.body)) };
      return new Response(new Uint8Array(4800));
    }) as unknown as typeof fetch,
  });
  await fn({ route: "local-tts", voice: "bm_george", speed: 1, text: "hi" });
  assertEquals(seen!.url, "http://127.0.0.1:9/v1/audio/speech");
  assertEquals(seen!.auth, "Bearer sk-podcast-test");
  assertEquals(seen!.body, { model: "local-tts", voice: "bm_george", input: "hi", speed: 1, response_format: "pcm" });
});

// ── the archive writer ────────────────────────────────────────────────────────────────────────
function dest(root: string, n: { reads: number; path: string; version: number }) {
  return async (): Promise<Destination> => {
    n.reads++;
    return { path: n.path, value: { path: n.path }, version: n.version, via: "path" };
  };
}

Deno.test("C13 archive: the destination is read on EVERY write; changing it redirects the next write and moves nothing", async () => {
  const root = await tmp();
  const st = { reads: 0, path: `${root}/one`, version: 0 };
  const w = new ArchiveWriter(dest(root, st));
  const a = await w.write({ origin: "render", episodeId: "ep-a", title: "A", createdAt: "2026-10-30T00:00:00Z", ownerSub: "u1", audio: { data: new Uint8Array([1, 2, 3]), format: "mp3" } });
  st.path = `${root}/two`;
  st.version = 1;
  const b = await w.write({ origin: "render", episodeId: "ep-b", title: "B", createdAt: "2026-10-30T00:00:00Z", ownerSub: "u1", audio: { data: new Uint8Array([4]), format: "mp3" } });
  assertEquals(st.reads, 2);
  assertEquals(a.dir, `${root}/one/renders/ep-a`);
  assertEquals(b.dir, `${root}/two/renders/ep-b`);
  assert((await Deno.stat(`${root}/one/renders/ep-a/audio.mp3`)).isFile, "the first file stays where it was");
  const sc = await readSidecar(b.dir);
  assertEquals([sc.origin, sc.destination.path, sc.destination.version, sc.destination.setting], ["render", `${root}/two`, 1, "podcast.archive_destination"]);
  assertEquals(sc.audio!.sha256, await sha256Hex(new Uint8Array([4])));
  await assertRejects(() => w.write({ origin: "render", episodeId: "ep-b", title: "B", createdAt: "x", ownerSub: "u1" }), Error, "never overwritten");
  await assertRejects(() => w.write({ origin: "render", episodeId: "../x", title: "B", createdAt: "x", ownerSub: "u1" }), Error, "unsafe");
  await Deno.remove(root, { recursive: true });
});

Deno.test("C14 the transcode menu is fixed: a format outside it is refused before ffmpeg runs", () => {
  assertEquals(Object.keys(TARGET_MENU), ["mp3", "opus", "m4a", "flac", "wav"]);
  for (const bad of ["aac", "ogg", "../x", "toString", "__proto__", ""]) assertThrows(() => targetOf(bad), RangeError);
});

Deno.test({
  name: "ffmpeg: the image's build is not nonfree; encode and transcode run it as a separate process",
  ignore: !hasFfmpeg && !requireFfmpeg,
  fn: async () => {
    assert(hasFfmpeg, "PODCAST_REQUIRE_FFMPEG=1 and no ffmpeg binary");
    const b = await ffmpegBuild({ bin: FFMPEG });
    assert(b.version.startsWith("ffmpeg version "), b.version);
    assert(!b.configuration.includes("--enable-nonfree"), "a nonfree ffmpeg build");
  },
});

Deno.test({
  name: "C14 transcode: a NEW file per menu format, the sidecar records source and target, the original is never modified",
  ignore: !hasFfmpeg && !requireFfmpeg,
  fn: async () => {
    const root = await tmp();
    const st = { reads: 0, path: root, version: 0 };
    const w = new ArchiveWriter(dest(root, st));
    const cache = new SegmentCache(`${root}/cache`, stubSpeech().fn);
    const v = await voiceAndArchive(turnsFromHostScript("Ep", SCRIPT, team()), team(), { ownerSub: "u1", shared: false, slug: "ep" },
      { cache, concurrency: 2, ffmpeg: { bin: FFMPEG }, archive: w, store: null, log: () => {} });
    const sc0 = await readSidecar(v.dir);
    assertEquals(sc0.audio!.format, "mp3");
    const orig = await Deno.readFile(`${v.dir}/${sc0.audio!.file}`);
    for (const fmt of Object.keys(TARGET_MENU)) {
      const r = await transcodeArchived({ bin: FFMPEG }, v.dir, fmt);
      assert((await Deno.stat(`${v.dir}/${r.file}`)).size > 0);
      const last = r.sidecar.transcodes.at(-1)!;
      assertEquals([last.source_format, last.target_format], ["mp3", fmt]);
    }
    assertEquals(await sha256Hex(await Deno.readFile(`${v.dir}/${sc0.audio!.file}`)), await sha256Hex(orig), "the original is byte-identical");
    assertEquals((await readSidecar(v.dir)).audio!.sha256, sc0.audio!.sha256);
    await assertRejects(() => transcodeArchived({ bin: FFMPEG }, v.dir, "aac"), RangeError);
    await Deno.remove(root, { recursive: true });
  },
});

Deno.test({
  name: "encode: the native episode is a playable mp3 of the rendered length",
  ignore: !hasFfmpeg && !requireFfmpeg,
  fn: async () => {
    const root = await tmp();
    const pcm = new Uint8Array(24_000 * 2); // 1 s of silence
    await encodePcm({ bin: FFMPEG }, pcm, `${root}/x.mp3`);
    const probe = await new Deno.Command(FFMPEG, { args: ["-hide_banner", "-i", `${root}/x.mp3`, "-f", "null", "-"], stderr: "piped" }).output();
    assert(probe.success, new TextDecoder().decode(probe.stderr));
    await Deno.remove(root, { recursive: true });
  },
});

// ── what left (C2, C7) ───────────────────────────────────────────────────────────────────────
const RECIPE = new URL("../../", import.meta.url);

async function* tsFiles(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* tsFiles(u);
    else if (/\.(ts|mjs|js)$/.test(e.name)) yield u;
  }
}

Deno.test("C2: the daily chain has no Open Notebook client, address or setting left", async () => {
  await assertRejects(() => Deno.stat(new URL("src/podcast/on-client.ts", RECIPE)), Deno.errors.NotFound);
  for (const f of ["link-enrich.ts", "podcast-server.ts", "src/podcast/podcast-service.ts", "src/podcast/renderer.ts", "src/podcast/episode-audio.ts", "src/podcast/render-service.ts"]) {
    const t = await Deno.readTextFile(new URL(f, RECIPE));
    for (const bad of ["open_notebook", ":5055", "ON_BASE", "OnClient", "on-client", "/api/podcasts"]) assert(!t.includes(bad), `${f} still has "${bad}"`);
  }
});

Deno.test("C10: the renderer knows nothing of Open Notebook (no ON type, field or module in its path)", async () => {
  for (const f of ["src/podcast/renderer.ts", "src/podcast/presenters.ts", "src/podcast/segment-cache.ts", "src/podcast/episode-audio.ts", "src/podcast/tts-client.ts"]) {
    const t = await Deno.readTextFile(new URL(f, RECIPE));
    for (const bad of [/on-capture/i, /\bopen ?notebook\b/i, /speaker_profile|episode_profile|podcast_config|dialogue/]) assert(!bad.test(t), `${f} matches ${bad}`);
  }
});

Deno.test("C7: no product code imports kokoro, misaki, phonemizer or espeakng-loader (GPL-3 chain)", async () => {
  const bad = /(import|require)\b[^;\n]*["'][^"']*(kokoro|misaki|phonemizer|espeak)/i;
  const hits: string[] = [];
  for await (const u of tsFiles(RECIPE)) {
    const t = await Deno.readTextFile(u);
    t.split("\n").forEach((l, i) => {
      if (bad.test(l)) hits.push(`${u.pathname}:${i + 1}`);
    });
  }
  assertEquals(hits, []);
});
