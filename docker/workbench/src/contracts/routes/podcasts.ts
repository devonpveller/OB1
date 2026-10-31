// Podcasts (research-workbench P7a): podcasts(), presenters(), teams() - the appendix calls whose
// backing landed here - and render requests. Per user: every read and write goes through the
// identity seam's subject (identityOf), never a user named by the caller.
//
// POST /podcasts/requests records the request (requester = the caller's subject_sub) and, when
// PODCAST_RENDER_URL is set, asks openbrain-podcast to render it (POST <url> {"request_id"}). Blank
// (as shipped) = inert: the request stays queued.
import { createRoute, z } from "../deps.ts";
import { identityOf } from "../../middleware/identity.ts";
import * as pod from "../repo/podcasts.ts";
import { parseLimit } from "../logic/scope.ts";
import { limit } from "../schemas/common.ts";
import { Podcasts, Presenters, RenderRequest, RenderRequestBody, RenderRequests, Teams } from "../schemas/podcasts.ts";
import { EX } from "../schemas/examples.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const T = ["podcasts (P7a)"];

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
      const url = deps.podcastRenderUrl ?? "";
      if (url) {
        // best-effort: a render service that is down leaves the request queued (the row says so)
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: row.id }), signal: AbortSignal.timeout(10_000) })
          .then((r) => r.body?.cancel())
          .catch((e) => deps.log(`podcast render hand-off failed: ${e}`));
      }
      return send(c, RenderRequest, row, 202);
    } catch (e) {
      return fail(c, e);
    }
  });
}
