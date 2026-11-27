// The voice sample (rwr-voices): how the workbench gets a few seconds of one voice link to play.
//
// The workbench does NOT speak. It asks openbrain-podcast (POST <that service>/sample, keyed with the workbench key, as it
// already does for /render), and that service voices one fixed sentence through LiteLLM's audio route with its OWN virtual
// key (PODCAST_TTS_KEY: recipes/daily-digest/src/podcast/sample.ts). So this module holds no speech address and no speech
// key, and a sample cannot reach the voice engine by any path the renderer's does not already take. The address is derived
// from the one the render hand-off already uses (PODCAST_RENDER_URL), so there is no new setting; blank = inert (503).
export class SampleFailed extends Error {}

export type VoiceSample = { route: string; voice: string; speed: number };
export type VoiceSampler = (v: VoiceSample) => Promise<Uint8Array>;

const MAX_BYTES = 2 * 1024 * 1024; // a sentence of 24 kHz mono 16-bit is well under 200 KB

// "http://openbrain-podcast:8080/render" -> "http://openbrain-podcast:8080/sample"; anything else is "" (no sampler)
export function sampleUrlFrom(renderUrl: string): string {
  let u: URL;
  try {
    u = new URL(renderUrl);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  u.pathname = u.pathname.replace(/\/render\/?$/, "") + "/sample";
  u.search = "";
  u.hash = "";
  return u.toString();
}

export function podcastSampler(o: { renderUrl: string; key: string; fetchFn?: typeof fetch; timeoutMs?: number }): VoiceSampler | null {
  const url = sampleUrlFrom(o.renderUrl);
  if (!url || !o.key) return null;
  const f = o.fetchFn ?? fetch;
  return async (v) => {
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-brain-key": o.key },
        body: JSON.stringify({ route: v.route, voice: v.voice, speed: v.speed }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
    } catch {
      throw new SampleFailed("the voice service did not answer");
    }
    // the upstream's text is never repeated: only its status is said
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new SampleFailed(`the voice service answered ${res.status}`);
    }
    if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("audio/wav")) {
      await res.body?.cancel().catch(() => {});
      throw new SampleFailed("the voice service did not return audio");
    }
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length === 0 || b.length > MAX_BYTES) throw new SampleFailed("the voice service returned audio of an unexpected size");
    return b;
  };
}

// One person may not hold the voice engine: one sample at a time and at most LIMIT in a window. In memory (per process);
// a restart forgets it, which only ever lets a person start again.
export function sampleLimiter(limit = 12, windowMs = 60_000, now: () => number = Date.now) {
  const busy = new Set<string>();
  const stamps = new Map<string, number[]>();
  return {
    // returns a release function, or null when the person must wait
    take(sub: string): (() => void) | null {
      if (busy.has(sub)) return null;
      const t = now();
      const recent = (stamps.get(sub) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) {
        stamps.set(sub, recent);
        return null;
      }
      recent.push(t);
      stamps.set(sub, recent);
      busy.add(sub);
      return () => {
        busy.delete(sub);
      };
    },
  };
}
