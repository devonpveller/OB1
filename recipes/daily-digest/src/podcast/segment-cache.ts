/**
 * The content-addressed segment cache (research-workbench P7a). A voiced turn is stored under
 * SHA-256 of everything that decides how it sounds - the route, the voice, the speed, the text and
 * the audio format - so re-rendering an episode after one presenter's voice changed re-synthesises
 * only that presenter's turns: every other key is unchanged and hits.
 *
 * In-flight coalescing: two requests for the same key while it is being synthesised share ONE
 * synthesis (the same turn repeated in an episode, or two renders at once).
 *
 * Layout: <dir>/<first two hex>/<key>.pcm, written to a temp name and renamed, so a crash never
 * leaves a truncated entry under a real key.
 */
import type { SpeechFn, SpeechRequest } from "./tts-client.ts";

// Bump when the bytes a key maps to would change for the same inputs (a new audio format).
export const CACHE_KEY_VERSION = "p7a-1:pcm_s16le_24k_mono";

export async function segmentKey(r: SpeechRequest): Promise<string> {
  const canon = JSON.stringify({ v: CACHE_KEY_VERSION, route: r.route, voice: r.voice, speed: Number(r.speed.toFixed(3)), text: r.text });
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CacheStats {
  hits: number;
  misses: number;
  coalesced: number;
}

export class SegmentCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, coalesced: 0 };
  readonly #inflight = new Map<string, Promise<{ pcm: Uint8Array; hit: boolean }>>();

  constructor(readonly dir: string, readonly synth: SpeechFn) {}

  #path(key: string): string {
    return `${this.dir.replace(/\/+$/, "")}/${key.slice(0, 2)}/${key}.pcm`;
  }

  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.coalesced = 0;
  }

  async get(r: SpeechRequest): Promise<{ key: string; pcm: Uint8Array; hit: boolean }> {
    const key = await segmentKey(r);
    const pending = this.#inflight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return { key, pcm: (await pending).pcm, hit: true };
    }
    // Registered BEFORE the first await below, so a concurrent request for the same key always
    // finds it (the disk read is part of the shared work, not a window between check and set).
    const work = this.#load(key, r);
    this.#inflight.set(key, work);
    try {
      const got = await work;
      if (got.hit) this.stats.hits++;
      else this.stats.misses++;
      return { key, ...got };
    } finally {
      this.#inflight.delete(key);
    }
  }

  async #load(key: string, r: SpeechRequest): Promise<{ pcm: Uint8Array; hit: boolean }> {
    const path = this.#path(key);
    try {
      return { pcm: await Deno.readFile(path), hit: true };
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    const pcm = await this.synth(r);
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeFile(tmp, pcm);
    await Deno.rename(tmp, path);
    return { pcm, hit: false };
  }
}
