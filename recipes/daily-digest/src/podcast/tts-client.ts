/**
 * Speech through the gateway (research-workbench P7a). One call = one turn: POST
 * <CHAT_API_BASE>/audio/speech on LiteLLM (the `llama-cpp` alias), model = the voice link's
 * route, with this service's own virtual key. LiteLLM forwards to Kokoro-FastAPI, a separate,
 * unmodified container on the inference plane's backend network - nothing here imports or links
 * a speech engine, and no request goes around the gateway.
 *
 * The format asked for is raw PCM (signed 16-bit little-endian, mono, 24 kHz - Kokoro's native
 * output): turns concatenate byte-for-byte, and one ffmpeg process encodes the episode.
 */

export const PCM = { sampleRate: 24_000, channels: 1, bytesPerSample: 2 } as const;

export interface SpeechRequest {
  route: string;
  voice: string;
  speed: number;
  text: string;
}

export type SpeechFn = (r: SpeechRequest) => Promise<Uint8Array>;

export interface GatewaySpeechConfig {
  apiBase: string; // e.g. http://llama-cpp:8080/v1 (LiteLLM)
  apiKey: string; // this service's LiteLLM virtual key
  timeoutMs?: number;
  attempts?: number;
  fetchFn?: typeof fetch;
}

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

export function gatewaySpeech(cfg: GatewaySpeechConfig): SpeechFn {
  const base = cfg.apiBase.replace(/\/+$/, "");
  const f = cfg.fetchFn ?? fetch;
  const attempts = Math.max(1, cfg.attempts ?? 3);
  return async (r) => {
    let last = "";
    for (let a = 1; a <= attempts; a++) {
      try {
        const res = await f(`${base}/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model: r.route, voice: r.voice, input: r.text, speed: r.speed, response_format: "pcm" }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 300_000),
        });
        if (res.ok) {
          const b = new Uint8Array(await res.arrayBuffer());
          if (b.length < PCM.bytesPerSample || b.length % PCM.bytesPerSample) throw new Error(`speech returned ${b.length} bytes: not 16-bit PCM`);
          return b;
        }
        last = `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
        if (!TRANSIENT.has(res.status)) break;
      } catch (e) {
        last = String(e);
      }
      if (a < attempts) await new Promise((ok) => setTimeout(ok, 1000 * a));
    }
    throw new Error(`speech via the gateway failed (route ${r.route}, voice ${r.voice}): ${last}`);
  };
}

/** n milliseconds of silence in the PCM format. */
export function silence(ms: number): Uint8Array {
  const samples = Math.round((PCM.sampleRate * ms) / 1000) * PCM.channels;
  return new Uint8Array(samples * PCM.bytesPerSample);
}

export function pcmSeconds(bytes: number): number {
  return bytes / (PCM.sampleRate * PCM.channels * PCM.bytesPerSample);
}
