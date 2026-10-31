/**
 * openbrain-podcast — the chain service (S5 / P5).
 *
 * Chain: … prune → POST /run here → link-enrich runner (S3 research → S4a
 * script → S4b audio → loop-close) as a fresh subprocess (fresh per-run state)
 * → on ANY exit, POST NEXT_TRIGGER_URL (openbrain-digest /run), which decides
 * whether a digest, a follow-up or nothing is sent (src/routine/routine.ts).
 *
 * Logic lives in src/podcast/podcast-service.ts (run lock + durable run
 * record + restart recovery + run bound, mr-routine-outage). This file is the
 * composition root only.
 *
 * Env:
 *   PORT                 (default 8080)
 *   PODCAST_RUN_ARGS     extra args for the runner (default "--commit --audio")
 *   PODCAST_RUN_SCRIPT   the runner (default link-enrich.ts)
 *   PODCAST_RUN_MAX_MS   kill a run after this long (default 16 h)
 *   PODCAST_MAX_RESUMES  resume runs per day after a restart (default 1)
 *   NEXT_TRIGGER_URL     chain continuation (openbrain-digest /run)
 *   ROUTINE_TZ / ROUTINE_FOLLOWUP_CUTOFF / ROUTINE_STATE_DIR  (as openbrain-digest)
 *   (plus everything link-enrich.ts reads: MCP_ACCESS_KEY, RESEARCH_URL,
 *    CHAT_API_BASE, BRAIN_REST_URL, REPORTS_DIR, FETCH_PROXY_URL, …)
 *   P7a audio (src/podcast/render-service.ts, link-enrich --audio):
 *   PODCAST_TTS_KEY      this service's LiteLLM virtual key for /v1/audio/speech (blank = inert:
 *                        the gateway refuses every speech call, nothing is voiced)
 *   PODCAST_TEAM / PODCAST_OWNER_SUB  the team that voices the daily episode, and whose it is
 *   WORKBENCH_URL        where the configuration store is read (podcast.archive_destination)
 *   PODCAST_SEGMENT_CACHE_DIR / PODCAST_TTS_CONCURRENCY / FFMPEG_BIN
 */

import { dirOf, PodcastService, servePodcast } from "./src/podcast/podcast-service.ts";
import { ArchiveWriter, storeDestination } from "./src/podcast/archive.ts";
import { PresenterStore } from "./src/podcast/presenter-store.ts";
import { RenderService } from "./src/podcast/render-service.ts";
import { SegmentCache } from "./src/podcast/segment-cache.ts";
import { gatewaySpeech } from "./src/podcast/tts-client.ts";
import { realClock } from "./src/routine/clock.ts";
import { routineConfigFromEnv } from "./src/routine/routine.ts";
import { RoutineStore } from "./src/routine/store.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const num = (k: string, d: number) => {
  const v = env(k).trim();
  return v !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
};
const cfg = routineConfigFromEnv();
const RUN_ARGS = env("PODCAST_RUN_ARGS", "--commit --audio").split(/\s+/).filter(Boolean);

const svc = new PodcastService({
  clock: realClock,
  tz: cfg.tz,
  followUpCutoff: cfg.followUpCutoff,
  store: new RoutineStore(env("ROUTINE_STATE_DIR", `${env("REPORTS_DIR", "/reports")}/routine`)),
  script: env("PODCAST_RUN_SCRIPT", "link-enrich.ts"),
  runArgs: RUN_ARGS,
  cwd: dirOf(import.meta.url),
  nextTriggerUrl: env("NEXT_TRIGGER_URL"),
  maxRunMs: num("PODCAST_RUN_MAX_MS", 16 * 3600 * 1000),
  maxResumes: num("PODCAST_MAX_RESUMES", 1),
});

const restBase = env("BRAIN_REST_URL", "http://openbrain-rest");
const destination = storeDestination({ workbenchUrl: env("WORKBENCH_URL", "http://openbrain-workbench:8000"), key: env("MCP_ACCESS_KEY") });
const render = new RenderService({
  store: new PresenterStore(restBase),
  cache: new SegmentCache(
    env("PODCAST_SEGMENT_CACHE_DIR", `${env("REPORTS_DIR", "/reports")}/podcast-segment-cache`),
    gatewaySpeech({ apiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"), apiKey: env("PODCAST_TTS_KEY") }),
  ),
  archive: new ArchiveWriter(destination),
  destination,
  ffmpeg: { bin: env("FFMPEG_BIN", "ffmpeg") },
  concurrency: num("PODCAST_TTS_CONCURRENCY", 2),
  restBase,
});

servePodcast(svc, {
  render,
  port: parseInt(env("PORT", "8080"), 10),
  onListen: (a) => console.log(`openbrain-podcast listening on :${a.port} (args: ${RUN_ARGS.join(" ") || "(none)"})`),
});
await svc.recover().catch((e) => console.error(`[podcast] boot recovery failed: ${e}`));
