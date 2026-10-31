/**
 * One render, end to end (research-workbench P7a): a RoomTranscript and its Team -> the renderer
 * (cache + semaphore) -> ffmpeg (a separate process) encodes the native format -> the archive
 * writer puts it under the destination the configuration store names at this moment -> a
 * podcast_episodes row records it. Every render lands in the archive on generation.
 */
import { type ArchiveWriter } from "./archive.ts";
import { encodePcm, type Ffmpeg, NATIVE_FORMAT } from "./ffmpeg.ts";
import type { RoomTranscript, Team } from "./presenters.ts";
import type { PresenterStore } from "./presenter-store.ts";
import { type RenderedAudio, renderTranscript } from "./renderer.ts";
import type { SegmentCache } from "./segment-cache.ts";

export interface VoiceDeps {
  cache: SegmentCache;
  concurrency: number;
  ffmpeg: Ffmpeg;
  archive: ArchiveWriter;
  store: PresenterStore | null; // null = no episode row (the capture's lab replays, unit tests)
  log?: (m: string) => void;
}

export interface VoiceRequest {
  ownerSub: string;
  requesterSub?: string | null;
  shared: boolean;
  requestId?: string | null;
  slug: string;
  meta?: Record<string, unknown>;
}

export interface Voiced {
  dir: string;
  archiveId: string;
  episodeRowId: string | null;
  rendered: RenderedAudio;
}

function slugOf(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "episode";
}

export async function voiceAndArchive(t: RoomTranscript, team: Team, req: VoiceRequest, d: VoiceDeps): Promise<Voiced> {
  const log = d.log ?? ((m: string) => console.log(m));
  const rendered = await renderTranscript(t, team, { cache: d.cache, concurrency: d.concurrency });
  log(`[podcast-audio] "${t.title}": ${rendered.stats.turns} turns, ${rendered.stats.hits} cached, ${rendered.stats.misses} synthesised, ` +
    `${rendered.stats.coalesced} coalesced, peak ${rendered.stats.peakConcurrency} at once, ${rendered.seconds.toFixed(1)} s`);
  const tmp = await Deno.makeTempDir({ prefix: "podcast-render-" });
  try {
    const out = `${tmp}/episode.${NATIVE_FORMAT}`;
    await encodePcm(d.ffmpeg, rendered.pcm, out, NATIVE_FORMAT);
    const audio = await Deno.readFile(out);
    const createdAt = new Date().toISOString();
    const archiveId = `${createdAt.slice(0, 10)}-${slugOf(req.slug)}-${crypto.randomUUID().slice(0, 8)}`;
    const { dir } = await d.archive.write({
      origin: "render", episodeId: archiveId, title: t.title, createdAt, ownerSub: req.ownerSub,
      requesterSub: req.requesterSub ?? null, shared: req.shared,
      audio: { data: audio, format: NATIVE_FORMAT, seconds: rendered.seconds },
      parts: [
        { name: "transcript.json", data: JSON.stringify(t, null, 2) + "\n" },
        { name: "render.json", data: JSON.stringify({ team: { id: team.id, name: team.name, presenters: team.presenters }, turns: rendered.turns, stats: rendered.stats }, null, 2) + "\n" },
      ],
      meta: { team_id: team.id, request_id: req.requestId ?? null, ...(req.meta ?? {}) },
    });
    const episodeRowId = d.store
      ? await d.store.recordEpisode({
        ownerSub: req.ownerSub, shared: req.shared, title: t.title, teamId: team.id, audioFormat: NATIVE_FORMAT,
        seconds: rendered.seconds, archiveDir: dir, requestId: req.requestId ?? null,
      })
      : null;
    log(`[podcast-audio] archived ${dir}${episodeRowId ? ` (episode ${episodeRowId})` : ""}`);
    return { dir, archiveId, episodeRowId, rendered };
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}
