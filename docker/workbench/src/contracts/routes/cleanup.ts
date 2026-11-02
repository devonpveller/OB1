// The cleanup view's routes (research-workbench P8a, rw-p8a2-cleanup; D5 items 5-7). Every write acts
// as the identity seam's subject (identityOf: subject_sub, actor_sub) - never a user the caller names:
// the request bodies have no user field at all, and an unknown field is refused (strict schemas).
import { createRoute, z } from "../deps.ts";
import * as cl from "../repo/cleanup.ts";
import {
  CleanupAction, CleanupActions, CleanupErased, CleanupEraseRequest, CleanupLifted, CleanupLiftRequest, CleanupSevered,
  CleanupSeverRequest, CleanupSources, CX, ProcessAllRequest, ProcessAllResult, ReopenCandidates,
} from "../schemas/cleanup.ts";
import { limit, pathParam } from "../schemas/common.ts";
import { FX } from "../schemas/fixtures.ts";
import { parseLimit as lim } from "../logic/scope.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";

const T = ["cleanup view (D5)"];
const P = `${PREFIX}/cleanup`;
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerCleanup(app: ContractApp, deps: ContractDeps) {
  // rw-p8a2-cleanup round 2 (tester N2): a cleanup write whose JSON body is missing or does not parse is the
  // caller's error - a 400 here, before the validator (whose malformed-JSON refusal escapes to the app's
  // last-resort 500). The body is read once; Hono caches it for the validator.
  app.use(`${P}/*`, async (c, next) => {
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
  });
  op(app, createRoute({
    method: "get", path: `${P}/sources`, operationId: "cleanupSources", tags: T,
    summary: "every suppressed and unlinked source, with its status and dependence counts",
    request: { query: z.object({ limit: limit(200, 500) }) },
    responses: { 200: json(CleanupSources, CX.sources, "the listing (shared knowledge: the same for every user)"), ...errors },
  }), async (c) => {
    try {
      return send(c, CleanupSources, await cl.listSources(deps.db, deps.registry, lim(c.req.valid("query").limit, 200, 500)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/sources/{id}/sever`, operationId: "cleanupSever", tags: T,
    summary: "sever one connection or all severable ones, recorded as the caller's cleanup action",
    request: { params: z.object({ id: pathParam("id", FX.sourceToSever, "source id") }), body: body(CleanupSeverRequest, CX.severRequest) },
    responses: { 200: json(CleanupSevered, CX.severed, "severed"), ...errors },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      if (!b.all && !(b.kind && b.ref)) return c.json({ error: "give {kind, ref} or {all: true}" }, 400);
      return send(c, CleanupSevered, await cl.severFor(deps.db, deps.registry, await identityOf(c), c.req.valid("param").id, b));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/sources/{id}/erase`, operationId: "cleanupErase", tags: T,
    summary: "a manual erase: a reason type (required) and an optional note; refused unless unlinked with zero dependence",
    request: { params: z.object({ id: pathParam("id", FX.sourceUnlinked, "source id") }), body: body(CleanupEraseRequest, CX.eraseRequest) },
    responses: { 200: json(CleanupErased, CX.erased, "erased; the named tombstone"), ...errors },
  }), async (c) => {
    try {
      return send(c, CleanupErased, await cl.eraseFor(deps.db, deps.registry, await identityOf(c), c.req.valid("param").id, c.req.valid("json")));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/process-all`, operationId: "cleanupProcessAll", tags: T,
    summary: "the bulk run over the marked sources: ONE reason type for the batch, no note (D5 item 4)",
    description: "Each source: every severable connection severed, then erased when that left it unlinked with zero " +
      "blocking connections; one the sever tool cannot clear is reported blocked. Each tombstone records the run.",
    request: { body: body(ProcessAllRequest, CX.processAllRequest) },
    responses: { 200: json(ProcessAllResult, CX.processAll, "what the run did, per source"), ...errors },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      return send(c, ProcessAllResult, await cl.processAll(deps.db, deps.registry, await identityOf(c), b.reason_type, b.source_ids));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/reopen-candidates`, operationId: "cleanupReopenCandidates", tags: T,
    summary: "tombstones waiting for a person: user-erased debunked / credibility returns that cleared their bar, deliberate ones with a reopen note",
    description: "Each carries its evidence (the admission attempts that made it a candidate) and, on the debunked path, " +
      "the dispute it would open. Automation-erased readmissions are trail events, never candidates (D5 item 7).",
    request: { query: z.object({ limit: limit(100, 500) }) },
    responses: { 200: json(ReopenCandidates, CX.candidates, "the candidates"), ...errors },
  }), async (c) => {
    try {
      return send(c, ReopenCandidates, await cl.candidates(deps.db, deps.registry, await identityOf(c), lim(c.req.valid("query").limit, 100, 500)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/tombstones/{id}/lift`, operationId: "cleanupLift", tags: T,
    summary: "lift a tombstone from the cleanup view, recorded as the caller's cleanup action",
    request: { params: z.object({ id: pathParam("id", FX.tombstoneToLift, "tombstone id") }), body: body(CleanupLiftRequest, CX.liftRequest) },
    responses: { 200: json(CleanupLifted, CX.lifted, "lifted"), ...errors },
  }), async (c) => {
    try {
      return send(c, CleanupLifted, await cl.liftFor(deps.db, await identityOf(c), c.req.valid("param").id, c.req.valid("json").note));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/actions`, operationId: "cleanupActions", tags: T,
    summary: "the caller's own cleanup actions, newest first",
    request: { query: z.object({ limit: limit(50, 200) }) },
    responses: { 200: json(CleanupActions, CX.actions, "the caller's actions"), ...errors },
  }), async (c) => {
    try {
      return send(c, CleanupActions, await cl.actions(deps.db, await identityOf(c), lim(c.req.valid("query").limit, 50, 200)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/actions/{id}`, operationId: "cleanupAction", tags: T,
    summary: "one of the caller's cleanup actions; another user's is not found",
    request: { params: z.object({ id: pathParam("id", "c1ea0000-0000-4000-8000-000000000001", "action id") }) },
    responses: { 200: json(CleanupAction, CX.action, "the action"), ...errors },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      const a = UUIDISH.test(id) ? await cl.action(deps.db, await identityOf(c), id) : null;
      if (!a) return c.json({ error: "no such cleanup action" }, 404);
      return send(c, CleanupAction, a);
    } catch (e) {
      return fail(c, e);
    }
  });
}
