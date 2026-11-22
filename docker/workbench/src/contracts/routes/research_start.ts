// Starting research from anywhere (rwr-research-start-api). Two operations, both acting as the identity seam's
// subject (never a user the caller names - the body has no user field, and an unknown field is refused):
//   POST /workbench/research/preview   what WOULD leave the workbench: the boundary's question, topic and public links;
//                                      creates no job, no row, and asks only the boundary's preview (no start call)
//   POST /workbench/research           starts the run (attach to nothing / a document; depth quick | standard
//                                      | deep inside the admin ceilings); the same boundary function as the preview
// Attach to an idea is refused by both, alike (400, nothing read): an idea is researched from the idea itself, its
// owner's request path (slot 580 PD0b; logic/research_start.ts). Another user's document is the same 404 as a missing
// one. Personal text goes to the research service's request boundary only (repo/research_start.ts) and is stored
// nowhere by this item.
import { createRoute } from "../deps.ts";
import { readDocument } from "../../documents/repo.ts";
import { identityOf } from "../../middleware/identity.ts";
import { BadRequest } from "../logic/scope.ts";
import { parseStart } from "../logic/research_start.ts";
import { doorClient, type DoorClient, previewStart, startResearch, type StartDeps, Unavailable } from "../repo/research_start.ts";
import { NotFound } from "../repo/lifecycle.ts";
import { ErrorBody } from "../schemas/common.ts";
import { RSX, StartPreview, StartRequestBody, StartStarted } from "../schemas/research_start.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, send } from "./http.ts";

const T = ["research start"];
const unavailableResponse = { content: { "application/json": { schema: ErrorBody } }, description: "the research service is not configured or did not answer" };
export const START_PATH = "/workbench/research";

export interface StartSeams {
  door?: DoorClient | null;
  readDoc?: StartDeps["readDoc"];
  identity?: typeof identityOf;
  newId?: () => string;
}

export function registerResearchStart(app: ContractApp, deps: ContractDeps, seams: StartSeams = {}) {
  const door = "door" in seams ? (seams.door ?? null) : doorClient();
  const who = seams.identity ?? identityOf;
  const sd: StartDeps = {
    db: deps.db, door,
    readDoc: seams.readDoc ?? ((path, id) => readDocument({ db: deps.db, reg: deps.registry }, path, id)),
    newId: seams.newId,
  };
  const unavailable = (c: Parameters<typeof fail>[0], e: unknown) => {
    if (e instanceof Unavailable) return c.json({ error: e.message }, 503);
    return fail(c, e);
  };
  // a body that is missing or not JSON is the caller's error, before the validator (as the cleanup routes)
  const jsonBody = async (c: Parameters<typeof fail>[0], next: () => Promise<void>) => {
    if (c.req.method === "POST" && (c.req.header("content-type") ?? "").toLowerCase().includes("json")) {
      const text = await c.req.text();
      let ok = text.trim() !== "";
      if (ok) { try { JSON.parse(text); } catch { ok = false; } }
      if (!ok) return c.json({ error: "invalid request: the body must be a JSON object" }, 400);
    }
    await next();
  };
  app.use(START_PATH, jsonBody);
  app.use(`${START_PATH}/preview`, jsonBody);

  op(app, createRoute({
    method: "post", path: `${START_PATH}/preview`, operationId: "researchStartPreview", tags: T,
    summary: "what would leave the workbench if this research were started - and nothing else happens",
    description: "Runs the request boundary in preview: the question, topic and public links it forms from the caller's " +
      "question and attached document. Creates no job and no row; the start call forms the same request by the " +
      "same function. The personal text itself is never in the answer.",
    request: { body: body(StartRequestBody, RSX.request) },
    responses: { 200: json(StartPreview, RSX.preview, "what would leave (or the boundary's refusal)"), ...errors, 503: unavailableResponse },
  }), async (c) => {
    try {
      const req = parseStart(c.req.valid("json"));
      const s = await previewStart(sd, await who(c), req);
      return send(c, StartPreview, s);
    } catch (e) {
      return unavailable(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: START_PATH, operationId: "researchStart", tags: T,
    summary: "start research: attached to nothing or a document, at a chosen depth",
    description: "The same boundary function as the preview forms the question; a refusal starts nothing (200, started " +
      "false). With approved_question, a start that would send a different question answers 409 and starts nothing. " +
      "Depth quick | standard | deep is a preset of today's research limits, never above the admin ceilings. " +
      "Attach to an idea is refused (400) as in the preview: an idea is researched from the idea itself.",
    request: { body: body(StartRequestBody, RSX.request) },
    responses: { 200: json(StartStarted, { ...RSX.started, started: false, job_id: null, question: null, links: [], depth: null, refusal: "no_candidate_passed" }, "the boundary refused: nothing was started"),
      202: json(StartStarted, RSX.started, "queued"), ...errors, 503: unavailableResponse },
  }), async (c) => {
    try {
      const req = parseStart(c.req.valid("json"));
      const o = await startResearch(sd, await who(c), req);
      if (o.started) return send(c, StartStarted, { started: true, job_id: o.job_id, ...o.shown }, 202);
      if (o.changed) return c.json({ error: "the request changed since the preview: preview again", detail: { question: o.shown.question, topic: o.shown.topic, links: o.shown.links } }, 409);
      return send(c, StartStarted, { started: false, job_id: null, ...o.shown });
    } catch (e) {
      if (e instanceof BadRequest || e instanceof NotFound) return fail(c, e);
      return unavailable(c, e);
    }
  });
}
