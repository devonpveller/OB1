/**
 * openbrain-podcast's render and transcode calls (research-workbench P7a). Internal only (the
 * service publishes no port; the workbench reaches it on obnet):
 *
 *   POST /render     {"request_id": <uuid>}  - voice a podcast_render_requests row: its input is a
 *                    RoomTranscript; the episode is owned by the row's requester_sub (recorded by
 *                    the workbench from the identity seam, never from this body) and archived on
 *                    generation. 202; the row moves queued -> rendering -> done | failed.
 *   POST /transcode  {"episode_id": <uuid>, "format": <menu>} or {"archive_path": "on-archive/<id>",
 *                    "format": <menu>} - a NEW file beside the archived original, in a format of the
 *                    fixed menu (ffmpeg.ts TARGET_MENU); the sidecar records source and target.
 */
import { type ArchiveWriter, type DestinationFn, transcodeArchived } from "./archive.ts";
import { voiceAndArchive } from "./episode-audio.ts";
import { type Ffmpeg, TARGET_MENU } from "./ffmpeg.ts";
import type { RoomTranscript } from "./presenters.ts";
import type { PresenterStore } from "./presenter-store.ts";
import type { SegmentCache } from "./segment-cache.ts";

export interface RenderServiceDeps {
  store: PresenterStore;
  cache: SegmentCache;
  archive: ArchiveWriter;
  destination: DestinationFn;
  ffmpeg: Ffmpeg;
  concurrency: number;
  restBase: string; // PostgREST (episode rows)
  log?: (m: string) => void;
}

function isTranscript(v: unknown): v is RoomTranscript {
  const t = v as RoomTranscript;
  return !!t && typeof t.title === "string" && Array.isArray(t.turns) &&
    t.turns.every((x) => x && typeof x.presenterId === "string" && typeof x.text === "string");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RenderService {
  readonly #d: RenderServiceDeps;
  readonly running = new Set<string>();
  constructor(d: RenderServiceDeps) {
    this.#d = d;
  }

  /** Accept a request id; render in the background. */
  async render(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const id = String(body.request_id ?? "");
    if (!UUID.test(id)) return { status: 400, body: { error: "request_id must be a uuid" } };
    if (this.running.has(id)) return { status: 409, body: { error: "already rendering" } };
    const row = await this.#d.store.request(id);
    if (!row) return { status: 404, body: { error: "no such request" } };
    if (row.state !== "queued") return { status: 409, body: { error: `request is ${row.state}` } };
    this.running.add(id);
    await this.#d.store.updateRequest(id, { state: "rendering", error: null });
    this.#run(id, row).finally(() => this.running.delete(id));
    return { status: 202, body: { request_id: id, state: "rendering" } };
  }

  async #run(id: string, row: Record<string, unknown>): Promise<void> {
    const log = this.#d.log ?? ((m: string) => console.log(m));
    try {
      const owner = String(row.requester_sub);
      const team = await this.#d.store.team(owner, String(row.team_id));
      if (!team) throw new Error(`team ${row.team_id} is not the requester's`);
      const input = (row.input as Record<string, unknown>)?.transcript;
      if (!isTranscript(input)) throw new Error("the request's input is not a room transcript");
      const v = await voiceAndArchive(input, team, {
        ownerSub: owner, requesterSub: owner, shared: false, requestId: id, slug: String(row.title ?? input.title),
      }, { cache: this.#d.cache, concurrency: this.#d.concurrency, ffmpeg: this.#d.ffmpeg, archive: this.#d.archive, store: this.#d.store, log });
      await this.#d.store.updateRequest(id, { state: "done", episode_id: v.episodeRowId });
    } catch (e) {
      log(`[podcast-render] request ${id} failed: ${e}`);
      await this.#d.store.updateRequest(id, { state: "failed", error: String(e).slice(0, 500) }).catch(() => {});
    }
  }

  async transcode(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const format = String(body.format ?? "");
    if (!Object.hasOwn(TARGET_MENU, format)) {
      return { status: 400, body: { error: `format must be one of ${Object.keys(TARGET_MENU).join(", ")}` } };
    }
    let dir: string;
    if (typeof body.episode_id === "string") {
      if (!UUID.test(body.episode_id)) return { status: 400, body: { error: "episode_id must be a uuid" } };
      const res = await fetch(`${this.#d.restBase.replace(/\/+$/, "")}/rest/v1/podcast_episodes?id=eq.${body.episode_id}&select=archive_dir`);
      const rows = res.ok ? await res.json() as { archive_dir: string }[] : [];
      if (!rows[0]) return { status: 404, body: { error: "no such episode" } };
      dir = rows[0].archive_dir;
    } else if (typeof body.archive_path === "string" && /^on-archive\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.archive_path)) {
      dir = `${(await this.#d.destination()).path.replace(/\/+$/, "")}/${body.archive_path}`;
    } else {
      return { status: 400, body: { error: "episode_id or archive_path (on-archive/<id>) is required" } };
    }
    try {
      const r = await transcodeArchived(this.#d.ffmpeg, dir, format);
      return { status: 201, body: { dir, file: r.file, transcodes: r.sidecar.transcodes } };
    } catch (e) {
      return { status: 409, body: { error: String(e).slice(0, 300) } };
    }
  }
}
