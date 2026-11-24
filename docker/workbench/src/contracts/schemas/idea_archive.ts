// Archive and reopen an idea by its id (rwr-idea-archive-api): POST /workbench/ideas/{id}/archive and /reopen.
// No body. No enum, no union (the contract's rule): status is a string the description names.
import { z } from "../deps.ts";
import { uuid } from "./common.ts";

export const IdeaRest = z.object({
  idea_id: uuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", "the idea, the caller's own"),
  status: z.string().openapi({ example: "archived", description: "the idea's state after the call: archived, or the state it was archived from (new, engaged, researched, ...) on reopen" }),
  archived: z.boolean().openapi({ description: "true while the idea rests (scheduled research skips it); false once reopened" }),
}).openapi("IdeaRest");

export const IAX = {
  archived: { idea_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", status: "archived", archived: true },
  reopened: { idea_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4", status: "engaged", archived: false },
};
