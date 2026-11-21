// The two shared-library reads Home's library cards use (rwr-home round 4). Additive, read-only, shared knowledge only.
import { createRoute, z } from "../deps.ts";
import * as lib from "../repo/library.ts";
import { limit, queryParam } from "../schemas/common.ts";
import { LX, RecentSources, WaitingClaims } from "../schemas/library.ts";
import { parseLimit } from "../logic/scope.ts";
import { type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const T = ["library (shared knowledge)"];

export function registerLibrary(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/library/waiting-claims`, operationId: "waitingClaims", tags: T,
    summary: "claims backed by exactly one active source (not contradicted), newest first, with the exact total",
    request: { query: z.object({ limit: limit(5, 50) }) },
    responses: { 200: json(WaitingClaims, LX.waiting, "the claims waiting for a second source (shared knowledge: the same for every user)"), ...errors },
  }), async (c) => {
    try {
      return send(c, WaitingClaims, await lib.waitingClaims(deps.db, parseLimit(c.req.valid("query").limit, 5, 50)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/library/recent`, operationId: "libraryRecent", tags: T,
    summary: "the active sources first added within the last N days (titles, newest first) and the totals of new sources and claims",
    request: {
      query: z.object({
        days: queryParam("days", "7", "1-90, default 7"),
        limit: limit(5, 50),
      }),
    },
    responses: { 200: json(RecentSources, LX.recent, "what is new in the library (shared knowledge: the same for every user)"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      return send(c, RecentSources, await lib.recentSources(deps.db, parseLimit(q.days, 7, 90), parseLimit(q.limit, 5, 50)));
    } catch (e) {
      return fail(c, e);
    }
  });
}
