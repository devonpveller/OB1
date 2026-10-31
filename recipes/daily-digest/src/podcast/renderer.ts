/**
 * The episode audio renderer (research-workbench P7a; it replaced the client of the previous,
 * external audio backend). Input: a RoomTranscript and the Team that speaks it. Each turn is voiced through the
 * segment cache (SHA-256 per turn, in-flight coalescing) with at most `concurrency` syntheses at
 * once (a semaphore - the TTS backend is one CPU container); the turns are joined in order with a
 * short pause, and the episode is encoded by ffmpeg running as a separate process.
 *
 * The renderer has one input type. A daily script, a research room's discussion and a transcript
 * migrated from elsewhere all become a RoomTranscript before they get here.
 */
import { presenterOf, type RoomTranscript, type Team } from "./presenters.ts";
import { type CacheStats, SegmentCache } from "./segment-cache.ts";
import { pcmSeconds, silence } from "./tts-client.ts";

export class Semaphore {
  #free: number;
  readonly #queue: (() => void)[] = [];
  peak = 0;
  #active = 0;
  constructor(n: number) {
    this.#free = Math.max(1, n);
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free === 0) await new Promise<void>((ok) => this.#queue.push(ok));
    else this.#free--;
    this.#active++;
    this.peak = Math.max(this.peak, this.#active);
    try {
      return await fn();
    } finally {
      this.#active--;
      const next = this.#queue.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

export interface RenderedTurn {
  index: number;
  presenterId: string;
  presenter: string;
  voice: string;
  route: string;
  key: string; // the segment cache key
  hit: boolean;
  seconds: number;
}

export interface RenderedAudio {
  pcm: Uint8Array;
  seconds: number;
  turns: RenderedTurn[];
  stats: CacheStats & { turns: number; peakConcurrency: number };
}

export interface RenderOptions {
  cache: SegmentCache;
  concurrency: number;
  pauseMs?: number;
}

export async function renderTranscript(t: RoomTranscript, team: Team, o: RenderOptions): Promise<RenderedAudio> {
  if (!t.turns.length) throw new Error(`"${t.title}" has no turns`);
  const sem = new Semaphore(o.concurrency);
  const before = { ...o.cache.stats };
  const voiced = await Promise.all(t.turns.map((turn, index) =>
    sem.run(async () => {
      const p = presenterOf(team, turn.presenterId);
      const r = await o.cache.get({ route: p.voice.route, voice: p.voice.voice, speed: p.voice.speed, text: turn.text });
      return { index, p, ...r };
    })
  ));
  const pause = silence(o.pauseMs ?? 350);
  const total = voiced.reduce((n, v) => n + v.pcm.length, 0) + pause.length * (voiced.length - 1);
  const pcm = new Uint8Array(total);
  let at = 0;
  voiced.forEach((v, i) => {
    if (i) {
      pcm.set(pause, at);
      at += pause.length;
    }
    pcm.set(v.pcm, at);
    at += v.pcm.length;
  });
  const s = o.cache.stats;
  return {
    pcm,
    seconds: pcmSeconds(pcm.length),
    turns: voiced.map((v) => ({
      index: v.index, presenterId: v.p.id, presenter: v.p.name, voice: v.p.voice.voice, route: v.p.voice.route,
      key: v.key, hit: v.hit, seconds: pcmSeconds(v.pcm.length),
    })),
    stats: {
      // per turn, from this render's own results (a concurrent render on the same cache cannot skew them);
      // coalesced turns are hits that shared another request's synthesis
      hits: voiced.filter((v) => v.hit).length, misses: voiced.filter((v) => !v.hit).length,
      coalesced: s.coalesced - before.coalesced,
      turns: t.turns.length, peakConcurrency: sem.peak,
    },
  };
}
