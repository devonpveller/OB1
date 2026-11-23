// Capture an idea in the workbench (rwr-idea-capture-api).
//   POST /workbench/ideas   {summary, title?} -> 201 {idea_id, title, status, research{mode, queued, job_id, next_start}}
// The idea is created for the identity seam's subject (owner) and actor alone - the body has no owner field and an
// unknown field is refused (400) - through idea_capture(), the owner-checked SQL function openbrain-mcp's capture_idea
// calls (ideas/repo.ts captureIdea): the idea and its PRIVATE revision 1, no corpus thought. Research then starts the way
// it does for every captured idea: the revision trigger queues it at once, or (an owner on a daily / weekly schedule)
// marks it deferred for idea_schedule_drain. Its personal wording reaches research only through research_idea_queue(),
// the one idea queue plan 09's PD0b (rw-boundary-ideas) puts behind the request boundary; this route adds no other path.
// /workbench/ideas is a user-only path (middleware/identity.ts USER_ONLY): a service key is 403 before it gets here.
import { createRoute } from "../deps.ts";
import { identityOf } from "../../middleware/identity.ts";
import { captureIdea, IdeaError, parseCapture } from "../../ideas/repo.ts";
import { ICX, IdeaCaptured, IdeaCaptureRequest } from "../schemas/idea_capture.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, send } from "./http.ts";

const T = ["ideas and the idea refinery (D17)"];
export const CAPTURE_PATH = "/workbench/ideas";

export function registerIdeaCapture(app: ContractApp, deps: ContractDeps) {
  // a body that is missing or not a JSON object is the caller's error, before the validator (as research start)
  app.use(CAPTURE_PATH, async (c, next) => {
    if (c.req.method === "POST") {
      const text = await c.req.text();
      let ok = false;
      try {
        const v = JSON.parse(text);
        ok = v !== null && typeof v === "object" && !Array.isArray(v);
      } catch { ok = false; }
      if (!ok) return c.json({ error: "invalid request: the body must be a JSON object" }, 400);
    }
    await next();
  });

  op(app, createRoute({
    method: "post", path: CAPTURE_PATH, operationId: "captureIdea", tags: T,
    summary: "capture a new idea, private to the caller; research starts per the caller's research schedule",
    description: "Creates the idea for the signed-in user only (there is no owner field; any unknown field is 400) through " +
      "the same owner-checked function capture_idea uses. Research is queued at once (schedule immediate, the default) or " +
      "waits for the caller's scheduled start (daily / weekly); research.queued and research.next_start say which.",
    request: { body: body(IdeaCaptureRequest, ICX.request) },
    responses: { 201: json(IdeaCaptured, ICX.captured, "captured"), ...errors },
  }), async (c) => {
    try {
      const input = parseCapture(c.req.valid("json"));
      return send(c, IdeaCaptured, await captureIdea(deps.db, input, await identityOf(c), deps.embed), 201);
    } catch (e) {
      if (e instanceof IdeaError) return c.json({ error: e.message }, e.status);
      return fail(c, e);
    }
  });
}
