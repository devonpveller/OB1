/**
 * The voice sample (rwr-voices). The workbench asks this service for a short sample of one voice link (POST /sample, the
 * same X-Brain-Key as /render); this service voices ONE fixed sentence through the speech function the renderer already
 * uses (tts-client.ts gatewaySpeech: LiteLLM's /v1/audio/speech with PODCAST_TTS_KEY, this service's own virtual key) and
 * returns it as a WAV. So the sample reaches the voice engine only through the gateway path the stack already has: the
 * workbench holds no TTS key and no TTS address, and nothing here names a speech host.
 *
 * The text is fixed here: a caller cannot make this service speak words of its own. The route is a LiteLLM model name
 * (never a URL), the voice a plain name, the speed within the renderer's range.
 */
import { PCM, type SpeechFn } from "./tts-client.ts";

export const SAMPLE_TEXT = "Hello. This is how I will sound when I present your episode.";
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const VOICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 16-bit mono PCM as a WAV file (44-byte header). */
export function pcmToWav(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(44 + pcm.length));
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); tag(8, "WAVE"); tag(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, PCM.channels, true);
  v.setUint32(24, PCM.sampleRate, true); v.setUint32(28, PCM.sampleRate * PCM.channels * PCM.bytesPerSample, true);
  v.setUint16(32, PCM.channels * PCM.bytesPerSample, true); v.setUint16(34, PCM.bytesPerSample * 8, true);
  tag(36, "data"); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function keyEquals(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

export function sampleHandler(o: { speech: SpeechFn; key: string }): (req: Request) => Promise<Response> {
  return async (req) => {
    // a blank key = inert: no caller can voice anything
    if (!o.key || !keyEquals(req.headers.get("x-brain-key") ?? "", o.key)) return Response.json({ error: "unauthorized" }, { status: 401 });
    let b: Record<string, unknown>;
    try {
      const t = JSON.parse((await req.text().catch(() => "")) || "null");
      if (t === null || typeof t !== "object" || Array.isArray(t)) throw new Error("not an object");
      b = t as Record<string, unknown>;
    } catch {
      return Response.json({ error: "bad JSON body" }, { status: 400 });
    }
    const { route, voice, speed } = b;
    const ok = Object.keys(b).every((k) => k === "route" || k === "voice" || k === "speed") &&
      typeof route === "string" && ROUTE.test(route) && typeof voice === "string" && VOICE.test(voice) &&
      typeof speed === "number" && Number.isFinite(speed) && speed > 0.25 && speed <= 4;
    if (!ok) return Response.json({ error: "a sample takes route, voice and speed only" }, { status: 400 });
    try {
      const pcm = await o.speech({ route: route as string, voice: voice as string, speed: speed as number, text: SAMPLE_TEXT });
      return new Response(pcmToWav(pcm), { status: 200, headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
    } catch (e) {
      console.error(`[podcast] sample failed: ${String(e).slice(0, 300)}`);
      return Response.json({ error: "the voice engine did not answer" }, { status: 502 });
    }
  };
}
