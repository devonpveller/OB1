// Podcasts (research-workbench P7a): podcasts(), presenters(), teams() - the appendix calls whose
// backing landed here - and render requests. Per user: every read and write goes through the
// identity seam's subject (identityOf), never a user named by the caller.
//
// POST /podcasts/requests records the request (requester = the caller's subject_sub) and, when
// PODCAST_RENDER_URL is set, asks openbrain-podcast to render it (POST <url> {"request_id"}). Blank
// (as shipped) = inert: the request stays queued.
//
// rwr-podcast-audio-api: GET /podcasts/{id}/audio serves an episode's archived audio file (one
// byte range for seeking) to its owner, or to any signed-in user when it is shared; the id names a
// row, the row names the archive directory, the archive's sidecar names the file (logic/audio.ts),
// and anything else - another user's unshared episode, no such row, a row whose path leaves the
// archive root - is the same 404 with no bytes. POST /podcasts/requests/{id}/retry moves the
// caller's own failed request back to queued (once) and hands it to the renderer like a new one.
import { createRoute, z } from "../deps.ts";
import { identityOf } from "../../middleware/identity.ts";
import * as pod from "../repo/podcasts.ts";
import { parseLimit } from "../logic/scope.ts";
import { AUDIO_CACHE_CONTROL, AudioUnavailable, type ByteRange, mayHearShared, mediaTypeOf, parseRange, resolveEpisodeAudio } from "../logic/audio.ts";
import { ErrorBody, limit, pathParam, UUID_RE } from "../schemas/common.ts";
import { Podcasts, Presenters, RenderRequest, RenderRequestBody, RenderRequests, Teams } from "../schemas/podcasts.ts";
import { EX } from "../schemas/examples.ts";
import { FX } from "../schemas/fixtures.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const T = ["podcasts (P7a)"];
export const NO_SUCH_EPISODE = "no such episode";

// Hand a queued request to openbrain-podcast (best-effort: a render service that is down leaves the
// request queued, and the row says so). The render service takes only a caller holding the key
// (round 2): this workbench's WORKBENCH_KEY. Blank PODCAST_RENDER_URL (as shipped) = inert.
export function handOff(deps: ContractDeps, requestId: string): void {
  const url = deps.podcastRenderUrl ?? "";
  if (!url) return;
  fetch(url, {
    method: "POST", headers: { "content-type": "application/json", "x-brain-key": deps.podcastRenderKey ?? "" },
    body: JSON.stringify({ request_id: requestId }), signal: AbortSignal.timeout(10_000),
  })
    .then((r) => r.body?.cancel())
    .catch((e) => deps.log(`podcast render hand-off failed: ${e}`));
}

// The bytes [start, end] of a file, read as the client pulls them; the file is closed at the end,
// on an error, or when the client goes away.
function fileStream(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  let f: Deno.FsFile | null = null;
  let left = end - start + 1;
  const close = () => {
    try {
      f?.close();
    } catch { /* already closed */ }
    f = null;
  };
  return new ReadableStream<Uint8Array>({
    async start() {
      f = await Deno.open(path, { read: true });
      if (start > 0) await f.seek(start, Deno.SeekMode.Start);
    },
    async pull(ctl) {
      const buf = new Uint8Array(Math.min(64 * 1024, Math.max(left, 0)));
      const n = f && left > 0 ? await f.read(buf) : null;
      if (!n) {
        close();
        ctl.close();
        return;
      }
      left -= n;
      ctl.enqueue(buf.subarray(0, n));
    },
    cancel() {
      close();
    },
  });
}

const audioHeaders = (type: string): Record<string, string> => ({
  "content-type": type, "accept-ranges": "bytes", "cache-control": AUDIO_CACHE_CONTROL,
  "x-content-type-options": "nosniff", "content-disposition": "inline",
});

const audioBody = (description: string, example: string) => ({
  content: { "audio/mpeg": { schema: z.string().openapi({ format: "binary" }), example } },
  description,
});

export function registerPodcasts(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/podcasts`, operationId: "podcasts", tags: T,
    summary: "podcasts() - the caller's renders and renders shared with everyone (never an archived Open Notebook episode)",
    "x-appendix-call": "podcasts", "x-mcp-tool": "contract_podcasts",
    request: { query: z.object({ limit: limit(50, 200) }) },
    responses: { 200: json(Podcasts, EX.podcasts, "newest first"), ...errors },
  }), async (c) => {
    try {
      return send(c, Podcasts, await pod.podcasts(deps.db, (await identityOf(c)).sub, parseLimit(c.req.valid("query").limit, 50, 200)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/presenters`, operationId: "presenters", tags: T,
    summary: "presenters() - the caller's presenters with their voice links", "x-appendix-call": "presenters", "x-mcp-tool": "contract_presenters",
    responses: { 200: json(Presenters, EX.presenters, "by name"), ...errors },
  }), async (c) => {
    try {
      return send(c, Presenters, await pod.presenters(deps.db, (await identityOf(c)).sub));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/teams`, operationId: "teams", tags: T,
    summary: "teams() - the caller's teams: the cast in speaking order and the formats", "x-appendix-call": "teams", "x-mcp-tool": "contract_teams",
    responses: { 200: json(Teams, EX.teams, "by name"), ...errors },
  }), async (c) => {
    try {
      return send(c, Teams, await pod.teams(deps.db, (await identityOf(c)).sub));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/podcasts/requests`, operationId: "podcastRequests", tags: T,
    summary: "the caller's own render requests (no one else's, ever)",
    request: { query: z.object({ limit: limit(50, 200) }) },
    responses: { 200: json(RenderRequests, EX.podcastRequests, "newest first"), ...errors },
  }), async (c) => {
    try {
      return send(c, RenderRequests, await pod.requests(deps.db, (await identityOf(c)).sub, parseLimit(c.req.valid("query").limit, 50, 200)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/podcasts/requests`, operationId: "podcastRequest", tags: T,
    summary: "ask for a render of a room transcript by one of the caller's teams; the requester is the caller",
    request: { body: body(RenderRequestBody, EX.podcastRequestBody) },
    responses: { 202: json(RenderRequest, EX.podcastRequest, "recorded (and handed to the renderer when configured)"), ...errors },
  }), async (c) => {
    try {
      const who = await identityOf(c);
      const row = await pod.createRequest(deps.db, who, c.req.valid("json"));
      handOff(deps, String(row.id));
      return send(c, RenderRequest, row, 202);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/podcasts/requests/{id}/retry`, operationId: "podcastRequestRetry", tags: T,
    summary: "try a failed render request again: the caller's own request only, failed -> queued once, then handed to the renderer",
    description: "Only a FAILED request moves (to queued, its error cleared); a second retry finds it queued and is refused (409). " +
      "Another user's request is the same 404 as a request that does not exist.",
    request: { params: z.object({ id: pathParam("id", FX.podcastFailedRequest, "render request id") }) },
    responses: { 200: json(RenderRequest, EX.podcastRequestRetried, "moved back to queued (and handed to the renderer when configured)"), ...errors },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      if (!UUID_RE.test(id)) return c.json({ error: pod.NO_SUCH_REQUEST }, 404);
      const row = await pod.retryRequest(deps.db, (await identityOf(c)).sub, id);
      handOff(deps, String(row.id));
      return send(c, RenderRequest, row);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/podcasts/{id}/audio`, operationId: "podcastAudio", tags: T,
    summary: "an episode's archived audio: to its owner, or to any signed-in user when it is shared; one byte range for seeking",
    description: "The id names an episode row, never a path: the row names its archive directory and the archive's sidecar.json " +
      "names the file. Another user's unshared episode, an id that is no row, and a row whose stored path leaves the archive " +
      "root are the same 404, with no file bytes. A single `Range: bytes=` range answers 206 with Content-Range; a range past " +
      "the end is 416; any other Range header is ignored (200, the whole file). Content-Type follows the episode's format " +
      "(audio/mpeg for the renderer's native mp3; the transcode menu's own types otherwise). Cache-Control is always " +
      "`private, no-store`.",
    request: { params: z.object({ id: pathParam("id", FX.podcastEpisode, "episode id") }) },
    responses: {
      200: audioBody("the whole file", EX.podcastAudio),
      206: audioBody("the requested byte range (Content-Range: bytes start-end/size)", EX.podcastAudio.slice(0, 4)),
      400: errors[400],
      404: errors[404],
      416: { content: { "application/json": { schema: ErrorBody } }, description: "the range selects no byte of the file (Content-Range: bytes */size)" },
      500: errors[500],
    },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      const who = await identityOf(c);
      const missing = () => c.json({ error: NO_SUCH_EPISODE }, 404);
      if (!UUID_RE.test(id)) return missing();
      const row = await pod.episodeAudio(deps.db, who.sub, id, mayHearShared(who.kind));
      if (!row) return missing();
      let file;
      try {
        file = await resolveEpisodeAudio(row.archive_dir, deps.mountsRoot);
      } catch (e) {
        if (!(e instanceof AudioUnavailable)) throw e;
        deps.log(`podcast audio ${row.id} refused: ${e.reason}`);
        return missing();
      }
      const range: ByteRange = parseRange(c.req.header("range"), file.size);
      if (range.kind === "unsatisfiable") {
        return c.json({ error: "the range selects no byte of this episode" }, 416, {
          "content-range": `bytes */${file.size}`, "cache-control": AUDIO_CACHE_CONTROL,
        });
      }
      const [start, end, status] = range.kind === "partial" ? [range.start, range.end, 206] : [0, file.size - 1, 200];
      const headers: Record<string, string> = { ...audioHeaders(mediaTypeOf(row.audio_format)), "content-length": String(Math.max(0, end - start + 1)) };
      if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${file.size}`;
      if (file.size === 0) return new Response(null, { status: 200, headers });
      return new Response(fileStream(file.path, start, end), { status, headers });
    } catch (e) {
      return fail(c, e);
    }
  });
}
