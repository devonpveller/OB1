// References as first-class records (research-workbench P2a): place a reference, and read what
// a note or user document holds. reference(id) and diffCheck - the appendix calls - live in
// appendix.ts and read the same records.
//
// Neither operation is an MCP tool: placing a reference is a write (D14: MCP is reads only), and
// a holder's list is the user's own (D12: the links are the only trace a user document leaves;
// the front end reads them over HTTP).
import { createRoute, z } from "../deps.ts";
import * as refs from "../repo/references.ts";
import { pathParam, queryParam } from "../schemas/common.ts";
import { HolderReferences, ReferenceCreated, ReferenceCreateRequest } from "../schemas/references.ts";
import { FX } from "../schemas/fixtures.ts";
import { EX } from "../schemas/examples.ts";
import { authorOf, body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const T = ["references (P2a)"];

export function registerReferences(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "post", path: `${PREFIX}/references`, operationId: "createReference", tags: T,
    summary: "place a reference: a source pointer with its quote, position (and page+quad where required), " +
      "pinned to the source's current revision; optionally held by a note or user document",
    request: { body: body(ReferenceCreateRequest, EX.referenceCreateRequest) },
    responses: { 201: json(ReferenceCreated, EX.referenceCreated, "the reference, pinned"), ...errors },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      const out = await refs.createReference(deps.db, deps.registry, { ...b, by: b.by ?? authorOf(c) ?? undefined });
      return send(c, ReferenceCreated, out, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/holders/{kind}/references`, operationId: "holderReferences", tags: T,
    summary: "the references a note or user document holds, by id, in order - no selectors, no text",
    request: {
      params: z.object({ kind: pathParam("kind", "legacy_note", "a key of reference_holder_kinds") }),
      query: z.object({ ref: queryParam("ref", FX.refNotePath, "the vault path of the holder") }),
    },
    responses: { 200: json(HolderReferences, EX.holderReferences, "the held references"), ...errors },
  }), async (c) => {
    try {
      const ref = c.req.valid("query").ref;
      if (!ref) return c.json({ error: "ref (the holder's path) is required" }, 400);
      const r = await refs.holderReferences(deps.db, c.req.valid("param").kind, ref);
      if (!r) return c.json({ error: "this holder holds no references" }, 404);
      return send(c, HolderReferences, r);
    } catch (e) {
      return fail(c, e);
    }
  });
}
