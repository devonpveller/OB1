// Document gaps (research-workbench redesign, rwr-doc-gaps-api): create, list, read, change and remove a gap, and
// "research these" (ONE run for the ticked gaps). Every call acts as the identity seam's subject (identityOf) - the
// bodies have no user field and an unknown field is refused. Another user's gap by id is not found, as a missing one is:
// the same status, the same words. No call here reaches a model: research goes through the existing research path (the
// workspace caller key, the local model) by the injected deps.queueGapResearch.
import type { Context } from "hono";
import { createRoute, z } from "../deps.ts";
import * as gp from "../repo/gaps.ts";
import { Gap, GapCreate, Gaps, GapResearch, GapResearchStarted, GapUpdate, GPX } from "../schemas/gaps.ts";
import { ErrorBody, limit, pathParam, queryParam } from "../schemas/common.ts";
import { parseLimit as lim } from "../logic/scope.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";
import { REGISTRY, requireRegistered } from "../registry.ts";

const T = ["gaps (documents)"];
const P = `${PREFIX}/gaps`;
const NO_SUCH = { error: gp.NO_SUCH_GAP };
const unavailable = { content: { "application/json": { schema: ErrorBody } }, description: "the research service is not configured or could not queue the run" };
const Deleted = z.object({ id: z.string(), deleted: z.boolean() }).openapi("GapDeleted");

// a write whose JSON body is missing or does not parse is the caller's error: 400 before the validator
async function jsonBody(c: Context, next: () => Promise<void>) {
  if (["POST", "PATCH"].includes(c.req.method) && (c.req.header("content-type") ?? "").toLowerCase().includes("json")) {
    const text = await c.req.text();
    let ok = text.trim() !== "";
    if (ok) {
      try {
        JSON.parse(text);
      } catch {
        ok = false;
      }
    }
    if (!ok) return c.json({ error: "invalid request: the body must be a JSON object" }, 400);
  }
  await next();
}

export function registerGaps(app: ContractApp, deps: ContractDeps, minSim = gp.parseMinSim(Deno.env.get("GAP_COVER_MIN_SIM"))) {
  app.use(P, jsonBody);
  app.use(`${P}/*`, jsonBody);
  const unavail = (c: Context, e: unknown) =>
    e instanceof gp.ResearchUnavailable ? c.json({ error: "the research service is not available for the workbench" }, 503) : fail(c, e);
  // the settle (a finished run covers a gap or hands it back) happens as the caller reads their own list or gap
  const settle = async (who: Awaited<ReturnType<typeof identityOf>>) => {
    try {
      await gp.settleGaps(deps.db, deps.embed, who, minSim);
    } catch (e) {
      deps.log(`gaps settle failed: ${(e as Error)?.name ?? "error"}`); // never the gap text
    }
  };

  op(app, createRoute({
    method: "post", path: P, operationId: "gapCreate", tags: T,
    summary: "add a gap to one of the caller's own documents",
    description: "Text that matches (normalised) an open or researching gap of the same document is refused 409 and names that gap " +
      "(detail.existing); so is text dismissed from the same origin. Nothing is added then. origin is a key of gap_origins (default user).",
    request: { body: body(GapCreate, GPX.create) },
    responses: { 201: json(Gap, GPX.gap, "the gap, recorded as the caller's"), ...errors },
  }), async (c) => {
    try {
      return send(c, Gap, await gp.createGap(deps.db, deps.registry, await identityOf(c), c.req.valid("json")), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: P, operationId: "gapList", tags: T,
    summary: "the caller's own gaps, newest first (dismissed ones only when asked)",
    request: {
      query: z.object({
        limit: limit(100, 500),
        // no example: Dredd would send a path that is not its own identity's document (a 404 by design)
        path: z.string().optional().openapi({ param: { name: "path", in: "query" }, description: "only the gaps of this document (the caller's own)" }),
        state: queryParam("state", "open", "only gaps in this state (default: every state but dismissed)"),
      }),
    },
    responses: { 200: json(Gaps, GPX.gaps, "the gaps, their total and per-state counts"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      const who = await identityOf(c);
      if (q.state) await requireRegistered(deps.registry, REGISTRY.gapStates, q.state);
      await settle(who);
      return send(c, Gaps, await gp.listGaps(deps.db, who, { limit: lim(q.limit, 100, 500), path: q.path, state: q.state }));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/research`, operationId: "gapResearch", tags: T,
    summary: "research the ticked gaps in ONE run: one job, every ticked gap researching with that job id",
    description: "All ticked gaps must be the caller's own, open, and of one document; a gap of another user's is refused exactly as a " +
      "missing one is (404 no such gap). The run goes through the existing research path (gap kind, the local model); a covered gap " +
      "rotates out after the run ends and its question has a claim backed by two agreeing sources.",
    request: { body: body(GapResearch, GPX.research) },
    responses: { 202: json(GapResearchStarted, GPX.started, "the one run, and the gaps now researching"), ...errors, 503: unavailable },
  }), async (c) => {
    try {
      const who = await identityOf(c);
      return send(c, GapResearchStarted, await gp.researchGaps(deps.db, deps.queueGapResearch, who, c.req.valid("json").ids), 202);
    } catch (e) {
      if (e instanceof gp.ResearchUnavailable) return unavail(c, e);
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/{id}`, operationId: "gapGet", tags: T,
    summary: "one gap: the caller's own; another user's is not found",
    request: { params: z.object({ id: pathParam("id", GPX.gap.id, "gap id") }) },
    responses: { 200: json(Gap, GPX.gap, "the gap"), ...errors },
  }), async (c) => {
    try {
      const who = await identityOf(c);
      await settle(who);
      const g = await gp.getGap(deps.db, who, c.req.valid("param").id);
      return g ? send(c, Gap, g) : c.json(NO_SUCH, 404);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "patch", path: `${P}/{id}`, operationId: "gapUpdate", tags: T,
    summary: "reword the caller's own gap, or mark it open, covered or dismissed; another user's is not found",
    request: { params: z.object({ id: pathParam("id", GPX.gap.id, "gap id") }), body: body(GapUpdate, GPX.update) },
    responses: { 200: json(Gap, GPX.gap, "the gap, updated"), ...errors },
  }), async (c) => {
    try {
      const who = await identityOf(c);
      const g = await gp.updateGap(deps.db, deps.registry, who, c.req.valid("param").id, c.req.valid("json"));
      return g ? send(c, Gap, g) : c.json(NO_SUCH, 404);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "delete", path: `${P}/{id}`, operationId: "gapDelete", tags: T,
    summary: "remove the caller's own gap (a dismissed gap is kept; reopen it instead); another user's is not found",
    request: { params: z.object({ id: pathParam("id", GPX.gap.id, "gap id") }) },
    responses: { 200: json(Deleted, { id: GPX.gap.id, deleted: true }, "removed"), ...errors },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      return (await gp.deleteGap(deps.db, await identityOf(c), id)) ? send(c, Deleted, { id, deleted: true }) : c.json(NO_SUCH, 404);
    } catch (e) {
      return fail(c, e);
    }
  });
}
