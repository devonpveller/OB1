// Flag for cleanup (research-workbench redesign, rwr-flags-api): create, list and update a flag. Every call acts
// as the identity seam's subject (identityOf) - the bodies have no user field and an unknown field is refused.
// A person lists their own flags (Cleanup > Flagged by you); an admin may also list everyone's (scope=all).
// A flag never changes the flagged item. Another user's flag by id is not found, as a missing one is.
import type { Context } from "hono";
import { createRoute, z } from "../deps.ts";
import * as fl from "../repo/flags.ts";
import { Flag, FlagCreate, Flags, FlagUpdate, FLX } from "../schemas/flags.ts";
import { limit, pathParam, queryParam } from "../schemas/common.ts";
import { parseLimit as lim } from "../logic/scope.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";
import { exemptFromWalk } from "../../middleware/owner-scope.ts";
import { settingsAdmin } from "./system.ts";
import { REGISTRY, requireRegistered } from "../registry.ts";

const T = ["flags (cleanup)"];
const P = `${PREFIX}/flags`;
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SUCH = { error: "no such flag" };

// a write whose JSON body is missing or does not parse is the caller's error: 400 before the validator
async function jsonBody(c: Context, next: () => Promise<void>) {
  if ((c.req.method === "POST" || c.req.method === "PATCH") && (c.req.header("content-type") ?? "").toLowerCase().includes("json")) {
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

export function registerFlags(app: ContractApp, deps: ContractDeps) {
  app.use(P, jsonBody);
  app.use(`${P}/*`, jsonBody);

  op(app, createRoute({
    method: "post", path: P, operationId: "flagCreate", tags: T,
    summary: "flag a source, claim or reference for cleanup; nothing about the item changes",
    description: "The reason is a key of the flag_reasons registry (wrong_claim, low_quality, duplicate, other); anything else is refused (422). " +
      "`from` is where the flag was made: a document of the caller's own, or a source.",
    request: { body: body(FlagCreate, FLX.create) },
    responses: { 201: json(Flag, FLX.flag, "the flag, recorded as the caller's"), ...errors },
  }), async (c) => {
    try {
      return send(c, Flag, await fl.createFlag(deps.db, deps.registry, await identityOf(c), c.req.valid("json")), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: P, operationId: "flagList", tags: T,
    summary: "the caller's own flags, newest first (Cleanup > Flagged by you); an admin may ask scope=all for everyone's",
    request: {
      query: z.object({
        limit: limit(100, 500),
        scope: queryParam("scope", "mine", "mine (default) or all (admins only)"),
        state: queryParam("state", "open", "only flags in this state"),
        item_kind: queryParam("item_kind", "source", "only flags on this kind of item"),
      }),
    },
    responses: { 200: json(Flags, FLX.flags, "the flags"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      const who = await identityOf(c);
      const admin = settingsAdmin(who) && !who.impersonating;
      if (q.scope !== undefined && q.scope !== "mine" && q.scope !== "all") return c.json({ error: "scope is mine or all" }, 400);
      if (q.scope === "all" && !admin) return c.json({ error: "scope=all is for admins" }, 403);
      if (q.scope === "all") exemptFromWalk(c, "flags"); // the admin reads each flag's origin as it was made
      if (q.state) await requireRegistered(deps.registry, REGISTRY.flagStates, q.state);
      if (q.item_kind) await requireRegistered(deps.registry, REGISTRY.flagItemKinds, q.item_kind);
      return send(
        c,
        Flags,
        await fl.listFlags(deps.db, who, { limit: lim(q.limit, 100, 500), state: q.state, itemKind: q.item_kind, all: q.scope === "all" }),
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/{id}`, operationId: "flagGet", tags: T,
    summary: "one flag: the caller's own (any, for an admin); another user's is not found",
    request: { params: z.object({ id: pathParam("id", FLX.flag.id, "flag id") }) },
    responses: { 200: json(Flag, FLX.flag, "the flag"), ...errors },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      const who = await identityOf(c);
      const admin = settingsAdmin(who) && !who.impersonating;
      const f = UUIDISH.test(id) ? await fl.getFlag(deps.db, who, id, admin) : null;
      if (f && admin) exemptFromWalk(c, "flags");
      return f ? send(c, Flag, f) : c.json(NO_SUCH, 404);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "patch", path: `${P}/{id}`, operationId: "flagUpdate", tags: T,
    summary: "change the caller's own flag: its reason, its note, or take it back (state withdrawn); another user's is not found",
    request: { params: z.object({ id: pathParam("id", FLX.flag.id, "flag id") }), body: body(FlagUpdate, FLX.update) },
    responses: { 200: json(Flag, FLX.flag, "the flag, updated"), ...errors },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      if (!UUIDISH.test(id)) return c.json(NO_SUCH, 404);
      const f = await fl.updateFlag(deps.db, deps.registry, await identityOf(c), id, c.req.valid("json"));
      return f ? send(c, Flag, f) : c.json(NO_SUCH, 404);
    } catch (e) {
      return fail(c, e);
    }
  });
}
