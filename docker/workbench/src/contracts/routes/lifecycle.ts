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
import { body, type ContractApp, type ContractDeps, errors, op, fail, json, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";
import { mayLiftTombstone } from "../logic/lift.ts";
import { ACTION_REF, recordAction, signedIn } from "../repo/actions.ts";

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
      const id = c.req.valid("param").id;
      const who = await identityOf(c);
      // rw-p8a2-cleanup round 3b: a signed-in caller is named in the shared rows (retracted_by, the context's
      // suppressed_by, the trail actor) only by a private action ref - never its subject, never a body `by`
      // (not signed in - the single-user default or a service: authorOf's answer would be null; a body `by` is kept)
      if (!signedIn(who)) return send(c, SuppressResult, await lc.suppress(deps.db, id, b.reason, b.by ?? null));
      return send(c, SuppressResult, await deps.db.tx(async (t) => {
        const aid = crypto.randomUUID();
        const r = await lc.suppress(t, id, b.reason, ACTION_REF(aid));
        await recordAction(t, who, aid, "suppress", { source_id: id, detail: { door: "contract" } });
        return r;
      }));
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
      const id = c.req.valid("param").id;
      const who = await identityOf(c);
      // round 3b: the trail actor of a signed-in caller's severance is a private action ref
      if (!signedIn(who)) return send(c, SeverResult, await lc.sever(deps.db, deps.registry, id, { ...b, by: b.by ?? undefined }));
      return send(c, SeverResult, await deps.db.tx(async (t) => {
        const aid = crypto.randomUUID();
        const r = await lc.sever(t, deps.registry, id, { ...b, by: ACTION_REF(aid) });
        await recordAction(t, who, aid, "sever", { source_id: id, detail: { door: "contract", all: !!b.all, severed: r.severed.length } });
        return r;
      }));
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
      // a user's erasure records its eraser for the lift rule - round 3b: as a private action ref (the
      // cleanup_actions row maps it to the identity seam's subject), never the subject and never the body's user
      const b = c.req.valid("json");
      const id = c.req.valid("param").id;
      if (b.eraser.kind !== "user") return send(c, EraseResult, await lc.erase(deps.db, deps.registry, id, b));
      const who = await identityOf(c);
      return send(c, EraseResult, await deps.db.tx(async (t) => {
        const aid = crypto.randomUUID();
        const r = await lc.erase(t, deps.registry, id, { ...b, eraser: { kind: "user", user: ACTION_REF(aid) } });
        await recordAction(t, who, aid, "erase", { reason_type: b.reason_type, source_id: id, tombstone_id: r.tombstone.id, detail: { door: "contract" } });
        return r;
      }));
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
      // round 3: whether THIS caller may lift it (the one rule, logic/lift.ts)
      // round 3b: answered for the viewer from the eraser ref's private record
      const who = await identityOf(c);
      const facts = await lc.liftFacts(deps.db, t, who);
      return send(c, Tombstone, { ...src.tombstoneOut(t), may_lift: mayLiftTombstone(facts, who), erased_by_you: t.eraser_kind === "user" && facts.erased_by_caller });
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/tombstones/{id}/lift`, operationId: "liftTombstone", tags: T,
    summary: "lift a tombstone: its URL may be intaken again - only the user who erased it, or an admin",
    description: "Operator decision 2026-11-02 (rw-p8a1-core round 3): the caller must be the user who erased it (the " +
      "identity seam's subject the erase recorded) or an admin; anyone else gets 403. The actor recorded as lifted_by is " +
      "the identity seam's; the request's `by` is ignored. The rule: mayLiftTombstone (logic/lift.ts), via liftTombstoneAs.",
    request: { params: z.object({ id: pathParam("id", FX.tombstoneToLift, "tombstone id") }), body: body(LiftRequest, EX.liftRequest) },
    responses: {
      200: json(Tombstone, EX.lifted, "the lifted tombstone"),
      403: json(z.object({ error: z.string() }), { error: "only the user who erased this tombstone, or an admin, may lift it" }, "not the eraser, not an admin"),
      ...errors,
    },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      const who = await identityOf(c);
      const tid = c.req.valid("param").id;
      // round 3b: the lifter (lifted_by, the trail actor) is a private action ref; its row is recorded only when this
      // call is what lifted it (a repeat lift stays 200 here and records nothing)
      return send(c, Tombstone, await deps.db.tx(async (t) => {
        const aid = crypto.randomUUID();
        const tb = await lc.liftTombstoneAs(t, tid, who, ACTION_REF(aid), b.note ?? null);
        if (tb.lifted_by === ACTION_REF(aid)) await recordAction(t, who, aid, "lift", { tombstone_id: tid, detail: { door: "contract" } });
        return tb;
      }));
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
