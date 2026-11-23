// Archive and reopen an idea by its id (rwr-idea-archive-api).
//   POST /workbench/ideas/{id}/archive  -> 200 {idea_id, status: "archived", archived: true}
//   POST /workbench/ideas/{id}/reopen   -> 200 {idea_id, status: <the state it was archived from>, archived: false}
// For the identity seam's subject only (ideas/repo.ts archiveIdea / reopenIdea: the same writes as the document-path
// archive, keyed on the idea). Another user's idea is 404 with the body of an idea that does not exist; archiving an
// archived idea, or reopening an open one, is 409 (it says nothing about anyone else's). Archived research rests: the
// engagement queue and idea_schedule_drain skip status = 'archived'. /workbench/ideas is a user-only path (a service key is 403).
import { createRoute, z } from "../deps.ts";
import { identityOf } from "../../middleware/identity.ts";
import { archiveIdea, ideaId, IdeaError, reopenIdea } from "../../ideas/repo.ts";
import { IAX, IdeaRest } from "../schemas/idea_archive.ts";
import { pathParam } from "../schemas/common.ts";
import { type ContractApp, type ContractDeps, errors, fail, json, op, send } from "./http.ts";

const T = ["ideas and the idea refinery (D17)"];
const param = z.object({ id: pathParam("id", IAX.archived.idea_id, "idea id (the caller's own)") });

export function registerIdeaArchive(app: ContractApp, deps: ContractDeps) {
  const route = (verb: "archive" | "reopen", summary: string, description: string, ex: unknown, run: typeof archiveIdea) =>
    op(app, createRoute({
      method: "post", path: `/workbench/ideas/{id}/${verb}`, operationId: `${verb}Idea`, tags: T, summary, description,
      request: { params: param },
      responses: { 200: json(IdeaRest, ex, summary), ...errors },
    }), async (c) => {
      try {
        const id = ideaId(c.req.valid("param").id);
        return send(c, IdeaRest, await run(deps.db, id, await identityOf(c)));
      } catch (e) {
        if (e instanceof IdeaError) return c.json({ error: e.message, ...e.detail }, e.status);
        return fail(c, e);
      }
    });
  route("archive", "archive the caller's idea: it rests until reopened",
    "Works for an idea with or without a document. Scheduled research skips an archived idea; nothing is deleted. " +
    "Another user's idea is 404, exactly like an idea that does not exist; an already archived idea is 409.", IAX.archived, archiveIdea);
  route("reopen", "reopen the caller's archived idea, in the state it was archived from",
    "Restores the state the idea was archived from, with its wording, revisions and linked items untouched. " +
    "An idea that is not archived is 409; another user's idea is 404.", IAX.reopened, reopenIdea);
}
