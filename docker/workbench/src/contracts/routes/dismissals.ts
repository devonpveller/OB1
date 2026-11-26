// Cleanup "Not again for this" (research-workbench redesign, rwr-cleanup): list, add and take back the caller's own
// dismissals. Every call acts as the identity seam's subject (identityOf); the bodies have no user field.
// A person reads only their own; another person's by id is not found, as a missing one is. No operation is an MCP tool.
import { createRoute, z } from "../deps.ts";
import * as dm from "../repo/dismissals.ts";
import { Dismissal, DismissalCreate, DismissalRemoved, Dismissals, DSX } from "../schemas/dismissals.ts";
import { limit, pathParam, queryParam } from "../schemas/common.ts";
import { parseLimit as lim } from "../logic/scope.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";
import { REGISTRY, requireRegistered } from "../registry.ts";

const T = ["cleanup view (D5)"];
const P = `${PREFIX}/cleanup/dismissals`;
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerDismissals(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: P, operationId: "cleanupDismissalList", tags: T,
    summary: "the caller's own dismissals (what Cleanup no longer shows them), newest first",
    request: { query: z.object({ limit: limit(500, 1000), kind: queryParam("kind", "reopen_candidate", "only dismissals of this kind") }) },
    responses: { 200: json(Dismissals, DSX.dismissals, "the caller's dismissals"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      if (q.kind) await requireRegistered(deps.registry, REGISTRY.dismissalKinds, q.kind);
      return send(c, Dismissals, await dm.listDismissals(deps.db, await identityOf(c), { limit: lim(q.limit, 500, 1000), kind: q.kind }));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: P, operationId: "cleanupDismissalCreate", tags: T,
    summary: "tell Cleanup not to show the caller a reopen candidate or a suggestion again (for the caller only)",
    description: "The kind is a key of the dismissal_kinds registry; anything else is refused (422). Dismissing the same thing twice is the same dismissal. Nothing about the thing, and nobody else's view, changes.",
    request: { body: body(DismissalCreate, DSX.create) },
    responses: { 201: json(Dismissal, DSX.dismissal, "the dismissal, recorded as the caller's"), ...errors },
  }), async (c) => {
    try {
      return send(c, Dismissal, await dm.addDismissal(deps.db, deps.registry, await identityOf(c), c.req.valid("json")), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "delete", path: `${P}/{id}`, operationId: "cleanupDismissalRemove", tags: T,
    summary: "take back one of the caller's own dismissals; another person's is not found",
    request: { params: z.object({ id: pathParam("id", DSX.dismissal.id, "dismissal id") }) },
    responses: { 200: json(DismissalRemoved, DSX.removed, "the dismissal is gone; the thing shows again"), ...errors },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      const gone = UUIDISH.test(id) && await dm.removeDismissal(deps.db, await identityOf(c), id);
      return gone ? send(c, DismissalRemoved, { id }) : c.json({ error: "no such dismissal" }, 404);
    } catch (e) {
      return fail(c, e);
    }
  });
}
