// The document's "to place" queue (research-workbench redesign, rwr-doc-toplace-api): add a cite gathered anywhere,
// list a document's queue, take one out, place one at the cursor. Every call acts as the identity seam's subject
// (identityOf) - the bodies have no user field and an unknown field is refused. Another user's document answers
// like a missing one and another user's queue row like a missing row (repo/pending_refs.ts). Never an MCP tool.
import type { Context } from "hono";
import { createRoute, z } from "../deps.ts";
import * as pr from "../repo/pending_refs.ts";
import { PendingRef, PendingRefCreate, PendingRefPlace, PendingRefPlaced, PendingRefRemoved, PendingRefs, PRX } from "../schemas/pending_refs.ts";
import { limit, pathParam, queryParam } from "../schemas/common.ts";
import { parseLimit as lim } from "../logic/scope.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";

const T = ["documents (to place)"];
const P = `${PREFIX}/documents/pending-refs`;

// a write whose JSON body is missing or does not parse is the caller's error: 400 before the validator
async function jsonBody(c: Context, next: () => Promise<void>) {
  if (c.req.method === "POST" && (c.req.header("content-type") ?? "").toLowerCase().includes("json")) {
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

export function registerPendingRefs(app: ContractApp, deps: ContractDeps) {
  app.use(P, jsonBody);
  app.use(`${P}/*`, jsonBody);

  op(app, createRoute({
    method: "get", path: P, operationId: "pendingRefList", tags: T,
    summary: "the caller's own 'to place' queue for one of their documents, oldest first",
    description: "path is required: the document's vault path. A document that is another user's, not listed or missing is 404 no such document.",
    request: { query: z.object({ path: queryParam("path", PRX.refs.path, "the document's vault path"), limit: limit(100, 200) }) },
    responses: { 200: json(PendingRefs, PRX.refs, "the document's queue"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      if (!q.path) return c.json({ error: "path (the document's vault path) is required" }, 400);
      return send(c, PendingRefs, await pr.listPendingRefs(deps.db, await identityOf(c), q.path, lim(q.limit, 100, 200)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: P, operationId: "pendingRefAdd", tags: T,
    summary: "add a cite (a source or a claim) to a document's 'to place' queue, from any screen",
    description: "Exactly one of source_id and claim_id. The same cite and quote added twice to one document is 409 (the body names the row already waiting).",
    request: { body: body(PendingRefCreate, PRX.create) },
    responses: { 201: json(PendingRef, PRX.ref, "the queue row, recorded as the caller's"), ...errors },
  }), async (c) => {
    try {
      return send(c, PendingRef, await pr.addPendingRef(deps.db, await identityOf(c), c.req.valid("json")), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "delete", path: `${P}/{id}`, operationId: "pendingRefRemove", tags: T,
    summary: "take one of the caller's own cites out of the queue; another user's is not found, as a missing one is",
    request: { params: z.object({ id: pathParam("id", PRX.ref.id, "pending reference id") }) },
    responses: { 200: json(PendingRefRemoved, PRX.removed, "the row that was removed"), ...errors },
  }), async (c) => {
    try {
      return send(c, PendingRefRemoved, await pr.removePendingRef(deps.db, await identityOf(c), c.req.valid("param").id));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/{id}/place`, operationId: "pendingRefPlace", tags: T,
    summary: "place one of the caller's queued cites at the cursor: a pinned reference record is created and the row leaves the queue",
    description: "Calls the existing place-reference path (the document holds the new record as cited). A refusal (the quote is not in the source, " +
      "the document already cites that source) leaves the row in the queue. form is chip (default) or transclusion (needs a quote).",
    request: { params: z.object({ id: pathParam("id", PRX.ref.id, "pending reference id") }), body: body(PendingRefPlace, PRX.place) },
    responses: { 201: json(PendingRefPlaced, PRX.placed, "the pinned reference and the text to put at the cursor"), ...errors },
  }), async (c) => {
    try {
      const out = await pr.placePendingRef(deps.db, deps.registry, await identityOf(c), c.req.valid("param").id, c.req.valid("json").form);
      return send(c, PendingRefPlaced, out, 201);
    } catch (e) {
      return fail(c, e);
    }
  });
}
