// /workbench/ideas - the ideas panel's and the refinery view's writes (research-workbench rw-p8a4-ideas, D17
// items 5-6). The reads are the contract's (GET /workbench/contract/ideas and /ideas/{id}).
//
//   POST /workbench/ideas/:id/edit          {summary, title?} - a new revision through idea_edit() (identical
//                                           text: outcome unchanged); research is queued by the database
//   POST /workbench/ideas/:id/research-now  research now through idea_research()
//   PUT  /workbench/ideas/:id/draft         {text} - the accreting draft, a field on the idea's one room
//   GET  /workbench/ideas/:id/research               rw-boundary-ideas: the research state; the owner's review while
//   POST /workbench/ideas/:id/research/approve       it waits (approve an edited question: it runs derived, shared;
//   POST /workbench/ideas/:id/research/private       or run it privately: 'personal', the report the owner's) - review.ts
//
// `create document` is the documents API's POST /workbench/documents/seed (P2b's seed action), which moves the
// idea to promoted through idea_promote(). Every route acts for the identity seam's subject; another user's idea
// is 404, exactly like an idea that does not exist; an archived refinery is 409 (engagement skips it).
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../contracts/db.ts";
import { identityOf, type Identity } from "../middleware/identity.ts";
import * as ideas from "./repo.ts";
import * as review from "./review.ts";

export interface IdeasDeps {
  db: Db;
  embed: (t: string) => Promise<number[]>;
  /** the research service's approval door (review.ts approveClient); null = shipped inert (503-like 502 naming the env) */
  approve?: review.ApproveCall | null;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

function fail(c: Context, e: unknown) {
  if (e instanceof ideas.IdeaError) return c.json({ error: e.message, ...e.detail }, e.status);
  // a refused SQL argument (an empty text) is the client's; anything else is logged, never answered
  if ((e as { fields?: { code?: string } })?.fields?.code === "22023") return c.json({ error: "the request was refused" }, 400);
  console.error("[ideas] error:", String((e as Error)?.message ?? e).slice(0, 300));
  return c.json({ error: "internal" }, 500);
}

const wrap = (fn: (c: Context, who: Identity) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c, await identityOf(c));
  } catch (e) {
    return fail(c, e);
  }
};

export function ideasRouter(deps: IdeasDeps) {
  const { db } = deps;
  const r = new Hono();

  r.post("/:id/edit", wrap(async (c, who) => {
    const id = ideas.ideaId(c.req.param("id"));
    return c.json(await ideas.editIdea(db, id, ideas.parseEdit(await body(c)), who, deps.embed));
  }));

  r.post("/:id/research-now", wrap(async (c, who) => {
    const id = ideas.ideaId(c.req.param("id"));
    return c.json(await ideas.researchIdea(db, id, who), 202);
  }));

  r.get("/:id/research", wrap(async (c, who) => {
    const id = ideas.ideaId(c.req.param("id"));
    return c.json(await review.researchState(db, id, who));
  }));

  r.post("/:id/research/approve", wrap(async (c, who) => {
    const id = ideas.ideaId(c.req.param("id"));
    const o = await review.approveQuestion(db, id, review.parseQuestion(await body(c)), who, deps.approve === undefined ? review.approveClient() : deps.approve);
    return c.json(o.body, o.status);
  }));

  r.post("/:id/research/private", wrap(async (c, who) => {
    const id = ideas.ideaId(c.req.param("id"));
    return c.json(await review.runPrivately(db, id, review.parseQuestion(await body(c)), who), 202);
  }));

  r.put("/:id/draft", wrap(async (c, who) => {
    const id = ideas.ideaId(c.req.param("id"));
    return c.json(await ideas.setDraft(db, id, ideas.parseDraft(await body(c)), who));
  }));

  return r;
}
