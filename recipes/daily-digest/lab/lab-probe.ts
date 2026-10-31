// LAB ONLY (rw-p7a-tts): the probes lab/run-podcast-lab.ps1 runs inside the openbrain-podcast :wt
// image on the lab network. Each prints one JSON line prefixed "PROBE " that the runner parses.
// Real Kokoro behind a lab LiteLLM (alias llama-cpp), the lab PostgREST (openbrain-rest), the lab
// workbench (openbrain-workbench). Never pointed at the live stack.
//
//   deno run -A lab/lab-probe.ts speech          the local-tts route: with the key, without, a wrong route
//   deno run -A lab/lab-probe.ts c3 <team>       render, relink presenter 2's voice, re-render: cache counts
//   deno run -A lab/lab-probe.ts c5 <team> <ev>  two presenters, one sentence: distinct audio; a fixture episode
//   deno run -A lab/lab-probe.ts render <team> <slug>  one render through the archive writer (C13)
//   deno run -A lab/lab-probe.ts archive-check   every on-archive entry has its parts; a sample plays
//   deno run -A lab/lab-probe.ts load <seconds>  keep Kokoro synthesising (the GPU measurement window)
import { ArchiveWriter, readSidecar, storeDestination } from "../src/podcast/archive.ts";
import { voiceAndArchive } from "../src/podcast/episode-audio.ts";
import { PresenterStore } from "../src/podcast/presenter-store.ts";
import type { RoomTranscript, Team } from "../src/podcast/presenters.ts";
import { SegmentCache } from "../src/podcast/segment-cache.ts";
import { gatewaySpeech } from "../src/podcast/tts-client.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const API = env("CHAT_API_BASE", "http://llama-cpp:8080/v1");
const KEY = env("PODCAST_TTS_KEY");
const OWNER = env("PODCAST_OWNER_SUB", "operator");
const store = new PresenterStore(env("BRAIN_REST_URL", "http://openbrain-rest"));
const destination = storeDestination({ workbenchUrl: env("WORKBENCH_URL", "http://openbrain-workbench:8000"), key: env("MCP_ACCESS_KEY") });
const archive = new ArchiveWriter(destination);
const out = (o: unknown) => console.log(`PROBE ${JSON.stringify(o)}`);
const [verb, a1, a2] = Deno.args;

async function team(id: string): Promise<Team> {
  const t = await store.team(OWNER, id);
  if (!t) throw new Error(`no team ${id} of ${OWNER}`);
  return t;
}

function stats(pcm: Uint8Array) {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = pcm.length / 2;
  let zc = 0, abs = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const s = v.getInt16(i * 2, true);
    abs += Math.abs(s);
    if (i && (s >= 0) !== (prev >= 0)) zc++;
    prev = s;
  }
  return { seconds: n / 24000, zero_crossings_per_s: Math.round(zc / (n / 24000)), mean_abs: Math.round(abs / n) };
}

async function sha(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const FIXTURE = (t: Team): RoomTranscript => ({
  title: "P7a fixture episode",
  turns: [
    { presenterId: t.presenters[0].id, text: "Good morning. Today we look at how a local inference stack recovers after an outage." },
    { presenterId: t.presenters[1].id, text: "Morning! And honestly, the practical bit is the queue: nothing gets dropped." },
    { presenterId: t.presenters[0].id, text: "What evidence do we have that the brief waits for the model, rather than running degraded?" },
    { presenterId: t.presenters[1].id, text: "The run record says so. It waits, then it runs once the model is back. That's the whole trick." },
    { presenterId: t.presenters[0].id, text: "Then that is where we leave it for today." },
  ],
});

if (verb === "speech") {
  const call = async (key: string, model: string) => {
    const r = await fetch(`${API}/audio/speech`, {
      method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, voice: "bm_george", input: "A short line through the gateway.", response_format: "pcm" }),
    });
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, bytes: b.length, type: r.headers.get("content-type") };
  };
  out({ verb, with_key: await call(KEY, "local-tts"), no_key: await call("", "local-tts"), wrong_route: await call(KEY, "local-large") });
} else if (verb === "c3") {
  const t = await team(a1);
  const dir = await Deno.makeTempDir({ prefix: "c3-cache-" });
  const cache = new SegmentCache(dir, gatewaySpeech({ apiBase: API, apiKey: KEY }));
  const tr = FIXTURE(t);
  const deps = { cache, concurrency: 2, ffmpeg: { bin: "ffmpeg" }, archive, store: null, log: () => {} };
  const first = await voiceAndArchive(tr, t, { ownerSub: OWNER, shared: false, slug: "c3-first" }, deps);
  const relink = t.presenters[1];
  const newVoice = relink.voice.voice === "af_bella" ? "af_heart" : "af_bella";
  await store.setVoice(OWNER, relink.voice.id, newVoice);
  const t2 = await team(a1);
  const second = await voiceAndArchive(tr, t2, { ownerSub: OWNER, shared: false, slug: "c3-second" }, deps);
  out({
    verb, turns: tr.turns.length, relinked: { presenter: relink.name, from: relink.voice.voice, to: newVoice },
    relinked_turns: tr.turns.filter((x) => x.presenterId === relink.id).length,
    first: first.rendered.stats, second: second.rendered.stats,
    second_misses_are_relinked_presenter: second.rendered.turns.filter((x) => !x.hit).every((x) => x.presenterId === relink.id),
  });
  await Deno.remove(dir, { recursive: true });
} else if (verb === "c5") {
  const t = await team(a1);
  const [pa, pb] = t.presenters;
  const speak = gatewaySpeech({ apiBase: API, apiKey: KEY });
  const text = "The same sentence, read by two different presenters.";
  const A = await speak({ route: pa.voice.route, voice: pa.voice.voice, speed: pa.voice.speed, text });
  const B = await speak({ route: pb.voice.route, voice: pb.voice.voice, speed: pb.voice.speed, text });
  const dir = await Deno.makeTempDir({ prefix: "c5-cache-" });
  const v = await voiceAndArchive(FIXTURE(t), t, { ownerSub: OWNER, shared: false, slug: "c5-fixture" },
    { cache: new SegmentCache(dir, speak), concurrency: 2, ffmpeg: { bin: "ffmpeg" }, archive, store, log: () => {} });
  if (a2) {
    await Deno.copyFile(`${v.dir}/audio.mp3`, `${a2}/c5-fixture-episode.mp3`);
    for (const [n, pcm] of [["a", A], ["b", B]] as const) {
      const p = new Deno.Command("ffmpeg", { args: ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-y", `${a2}/c5-same-sentence-${n}.mp3`], stdin: "piped" }).spawn();
      const w = p.stdin.getWriter();
      await w.write(pcm);
      await w.close();
      await p.status;
    }
  }
  out({
    verb, presenters: [{ name: pa.name, voice: pa.voice.voice, personality: pa.personality }, { name: pb.name, voice: pb.voice.voice, personality: pb.personality }],
    same_sentence: { a: { sha256: await sha(A), ...stats(A) }, b: { sha256: await sha(B), ...stats(B) } },
    fixture: { dir: v.dir, turns: v.rendered.turns.map((x) => ({ presenter: x.presenter, voice: x.voice })), texts_distinct: new Set(FIXTURE(t).turns.map((x) => x.text)).size === FIXTURE(t).turns.length },
  });
  await Deno.remove(dir, { recursive: true });
} else if (verb === "render") {
  const t = await team(a1);
  const dir = await Deno.makeTempDir({ prefix: "render-cache-" });
  const v = await voiceAndArchive({ title: `render ${a2}`, turns: FIXTURE(t).turns.slice(0, 2) }, t, { ownerSub: OWNER, shared: false, slug: a2 ?? "render" },
    { cache: new SegmentCache(dir, gatewaySpeech({ apiBase: API, apiKey: KEY })), concurrency: 2, ffmpeg: { bin: "ffmpeg" }, archive, store, log: () => {} });
  const sc = await readSidecar(v.dir);
  out({ verb, dir: v.dir, destination: sc.destination, row: v.episodeRowId });
  await Deno.remove(dir, { recursive: true });
} else if (verb === "archive-check") {
  const root = `${(await destination()).path}/on-archive`;
  const need = ["sidecar.json", "row.json", "outline.json", "transcript.json", "sources.json", "profile.json"];
  let dirs = 0, withAudio = 0, absentAudio = 0;
  const missing: string[] = [];
  const formats = new Set<string>();
  let sample = "";
  for await (const e of Deno.readDir(root)) {
    if (!e.isDirectory) continue;
    dirs++;
    for (const f of need) {
      try {
        await Deno.stat(`${root}/${e.name}/${f}`);
      } catch {
        missing.push(`${e.name}/${f}`);
      }
    }
    const sc = await readSidecar(`${root}/${e.name}`).catch(() => null);
    if (!sc || sc.origin !== "on-archive") missing.push(`${e.name}: sidecar origin ${sc?.origin}`);
    if (sc?.audio) {
      withAudio++;
      formats.add(sc.audio.format);
      if (!sample) sample = `${root}/${e.name}/${sc.audio.file}`;
    } else if (sc && (sc.meta.absent as string[] | undefined)?.some((x) => x.startsWith("audio:"))) absentAudio++;
    else missing.push(`${e.name}: no audio and no recorded reason`);
  }
  const play = await new Deno.Command("ffmpeg", { args: ["-hide_banner", "-v", "error", "-i", sample, "-f", "null", "-"], stderr: "piped" }).output();
  const dur = await new Deno.Command("ffmpeg", { args: ["-hide_banner", "-i", sample], stderr: "piped" }).output();
  const d = /Duration: (\d+:\d+:\d+\.\d+)/.exec(new TextDecoder().decode(dur.stderr))?.[1] ?? null;
  out({ verb, dirs, with_audio: withAudio, absent_audio_with_reason: absentAudio, formats: [...formats], missing, sample, sample_plays: play.success, sample_duration: d });
} else if (verb === "load") {
  const until = Date.now() + Number(a1 ?? "60") * 1000;
  const speak = gatewaySpeech({ apiBase: API, apiKey: KEY });
  let n = 0;
  const worker = async (i: number) => {
    while (Date.now() < until) {
      await speak({ route: "local-tts", voice: i % 2 ? "bf_emma" : "bm_george", speed: 1, text: `Load sentence ${n++} for the measurement window: the quick brown fox jumps over the lazy dog, twice over, slowly.` });
    }
  };
  await Promise.all([0, 1].map(worker));
  out({ verb, syntheses: n });
} else {
  console.error("usage: lab-probe.ts speech | c3 <team> | c5 <team> [evdir] | render <team> <slug> | archive-check | load <seconds>");
  Deno.exit(2);
}
