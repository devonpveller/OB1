// D5: dependence, suppress, sever, erase, tombstones and the admission gate.
import { createRoute, z } from "../deps.ts";
import * as lc from "../repo/lifecycle.ts";
import * as src from "../repo/sources.ts";
import {
  AdmissionDecision, AdmissionRequest, Dependence, EraseRequest, EraseResult, LiftRequest, SeverRequest, SeverResult,
  SuppressRequest, SuppressResult, Tombstone,
} from "../schemas/sources.ts";
import { metadataFilter, pathParam } from "../schemas/common.ts";
import { parseMetadataFilter } from "../logic/scope.ts";
import { FX } from "../schemas/fixtures.ts";
import { EX } from "../schemas/examples.ts";
import { authorOf, body, type ContractApp, type ContractDeps, errors, op, fail, json, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";

const T = ["source lifecycle (D5)"];
const idParam = (example: string) => z.object({ id: pathParam("id", example, "source id") });

export function registerLifecycle(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/sources/{id}/dependence`, operationId: "dependence", tags: T,
    summary: "dependence(id) - every connection of a source, counted and listed", "x-mcp-tool": "contract_dependence",
    description: "Under metadata_filter (the cloud door forces {\"share\":\"cloud\"}) a source outside the filter " +
      "is not found, and only in-scope connections are listed: the source's own chunks and trail events, claims " +
      "and citing or lead sources whose metadata contains the filter; pages, entities, sessions and user documents " +
      "carry no metadata and are left out, and erase_allowed is false (rw-p0-contract2).",
    request: { params: idParam(FX.sourceSuppressed), query: z.object({ metadata_filter: metadataFilter }) },
    responses: { 200: json(Dependence, EX.dependence, "connections by kind; blocking ones gate erasure"), ...errors },
  }), async (c) => {
    try {
      const f = parseMetadataFilter(c.req.valid("query").metadata_filter);
      const d = await lc.dependence(deps.db, deps.registry, c.req.valid("param").id, f, await identityOf(c));
      if (d.lifecycle === null) {
        return c.json({ error: f ? "not found in scope" : "no source or held source with this id" }, 404);
      }
      return send(c, Dependence, d);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/sources/{id}/suppress`, operationId: "suppress", tags: T,
    summary: "stage 1: suppress - excluded from every consumer, viewable with its reason",
    request: { params: idParam(FX.sourceToSuppress), body: body(SuppressRequest, EX.suppressRequest) },
    responses: { 200: json(SuppressResult, EX.suppress, "suppressed"), ...errors },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      return send(c, SuppressResult, await lc.suppress(deps.db, c.req.valid("param").id, b.reason, b.by ?? authorOf(c)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/sources/{id}/sever`, operationId: "sever", tags: T,
    summary: "stage 2: sever(id, connection) - remove one connection (or all severable), re-score, mark pages pending-compile",
    request: { params: idParam(FX.sourceToSever), body: body(SeverRequest, EX.severRequest) },
    responses: { 200: json(SeverResult, EX.sever, "severed"), ...errors },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      if (!b.all && !(b.kind && b.ref)) return c.json({ error: "give {kind, ref} or {all: true}" }, 400);
      return send(c, SeverResult, await lc.sever(deps.db, deps.registry, c.req.valid("param").id, { ...b, by: b.by ?? authorOf(c) ?? undefined }));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/sources/{id}/erase`, operationId: "erase", tags: T,
    summary: "stage 4: erase - refused unless unlinked with zero dependence; leaves a named tombstone",
    request: { params: idParam(FX.sourceUnlinked), body: body(EraseRequest, EX.eraseRequest) },
    responses: { 200: json(EraseResult, EX.erase, "erased; the tombstone"), ...errors },
  }), async (c) => {
    try {
      return send(c, EraseResult, await lc.erase(deps.db, deps.registry, c.req.valid("param").id, c.req.valid("json")));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/tombstones/{id}`, operationId: "tombstone", tags: T,
    summary: "a tombstone with every reopen attempt", "x-mcp-tool": "contract_tombstone",
    description: "Under metadata_filter only a tombstone whose erased source's metadata (snapshotted at erase " +
      "time) contains the filter resolves; any other is not found (rw-p0-contract2).",
    request: {
      params: z.object({ id: pathParam("id", FX.tombstoneAutomation, "tombstone id") }),
      query: z.object({ metadata_filter: metadataFilter }),
    },
    responses: { 200: json(Tombstone, EX.tombstone, "the tombstone"), ...errors },
  }), async (c) => {
    try {
      const f = parseMetadataFilter(c.req.valid("query").metadata_filter);
      const t = await src.tombstoneById(deps.db, c.req.valid("param").id, f);
      if (!t) return c.json({ error: f ? "not found in scope" : "no tombstone with this id" }, 404);
      return send(c, Tombstone, src.tombstoneOut(t));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/tombstones/{id}/lift`, operationId: "liftTombstone", tags: T,
    summary: "the operator lifts a tombstone: its URL may be intaken again",
    request: { params: z.object({ id: pathParam("id", FX.tombstoneToLift, "tombstone id") }), body: body(LiftRequest, EX.liftRequest) },
    responses: { 200: json(Tombstone, EX.lifted, "the lifted tombstone"), ...errors },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      return send(c, Tombstone, await lc.lift(deps.db, c.req.valid("param").id, b.by, b.note ?? null));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/admission`, operationId: "admission", tags: T,
    summary: "the admission gate: a door asks before it intakes, watches, follows or uses a URL",
    description: "A tombstoned URL is refused unless lifted; otherwise its reason type is the reopen path and its " +
      "eraser the gate (D5 items 6-7). Every attempt is recorded on the tombstone. Independently of this call, a " +
      "BEFORE INSERT trigger on sources refuses a tombstoned URL at every door (SQLSTATE OBT01).",
    request: { body: body(AdmissionRequest, EX.admissionRequest) },
    responses: { 200: json(AdmissionDecision, EX.admission, "the decision"), ...errors },
  }), async (c) => {
    try {
      return send(c, AdmissionDecision, await lc.admission(deps.db, deps.registry, deps.scorer, c.req.valid("json")));
    } catch (e) {
      return fail(c, e);
    }
  });
}
