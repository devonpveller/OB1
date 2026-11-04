// Notifications (D13 item 7: a READ endpoint for the research front end only - no tool, no
// webhook, no post anywhere), the configuration store (D6 item 5), the registries (D18).
import { type Identity, identityConfig, identityOf } from "../../middleware/identity.ts";

export function settingsAdmin(who: Identity, cfg = identityConfig()): boolean {
  if (who.kind === "service" || who.kind === "anonymous") return false;
  if (who.admin === true) return true;
  // rw-privacy-hardening (400-A4): the default subject is the admin of single-user mode. A request that NAMES that subject in
  // the identity header (header mode) is a header user like any other - the header is the edge's word, not the operator's.
  if (who.kind === "header") return false;
  return !cfg.signIn && who.sub === cfg.defaultSub;
}
import { createRoute, z } from "../deps.ts";
import * as sys from "../repo/system.ts";
import { parseLimit } from "../logic/scope.ts";
import { ErrorBody, limit, pathParam, queryParam } from "../schemas/common.ts";
import { Notifications, Registries, RegistryDetail, Setting, Settings, SettingWrite } from "../schemas/system.ts";
import { EX } from "../schemas/examples.ts";
import { authorOf, body, type ContractApp, type ContractDeps, errors, op, fail, json, PREFIX, send } from "./http.ts";

export function registerSystem(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/notifications`, operationId: "notifications", tags: ["notifications (D13)"],
    summary: "research notifications for the front end (class, subject, slug or entity, error, first seen, count)",
    description: "Producers post through the database (public.post_research_notification). Nothing here, or " +
      "anywhere in the research service, posts to Mattermost, Telegram or the status pipe.",
    request: {
      query: z.object({
        class: queryParam("class", "transient", "a notification_classes key"),
        since: queryParam("since", "2026-01-01T00:00:00Z", "last_seen at or after"),
        limit: limit(100, 500),
      }),
    },
    responses: { 200: json(Notifications, EX.notifications, "newest first"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      return send(c, Notifications, await sys.notifications(deps.db, q.class || null, q.since || null, parseLimit(q.limit, 100, 500), await identityOf(c)));
    } catch (e) {
      return fail(c, e);
    }
  });

  const ST = ["configuration store (D6)"];
  op(app, createRoute({
    method: "get", path: `${PREFIX}/settings`, operationId: "settings", tags: ST,
    summary: "every setting the settings registry declares, with its value and where it resolves",
    responses: { 200: json(Settings, EX.settings, "settings"), ...errors },
  }), async (c) => {
    try {
      return send(c, Settings, await sys.settings(deps.db, deps.registry, deps.mountsRoot));
    } catch (e) {
      return fail(c, e);
    }
  });

  const keyParam = z.object({ key: pathParam("key", "podcast.archive_destination", "a settings registry key") });
  op(app, createRoute({
    method: "get", path: `${PREFIX}/settings/{key}`, operationId: "setting", tags: ST, summary: "one setting",
    request: { params: keyParam },
    responses: { 200: json(Setting, EX.setting, "the setting"), ...errors },
  }), async (c) => {
    try {
      return send(c, Setting, await sys.setting(deps.db, deps.registry, c.req.valid("param").key, deps.mountsRoot));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "put", path: `${PREFIX}/settings/{key}`, operationId: "writeSetting", tags: ST,
    summary: "write a setting (admin only); the next read returns the new value",
    request: { params: keyParam, body: body(SettingWrite, EX.settingWrite) },
    responses: { 200: json(Setting, EX.settingWritten, "the setting as stored"), 403: { content: { "application/json": { schema: ErrorBody } }, description: "not an admin (a setting is global)" }, ...errors },
  }), async (c) => {
    try {
      // rw-p7a-tts round 2 (tester D3): a setting is GLOBAL (it redirects every user's next render), so
      // only an admin writes it: a signed-in member of the admin group, or - without sign-in, the
      // single-user mode - the default subject itself. A service, another header user: 403.
      if (!settingsAdmin(await identityOf(c))) return c.json({ error: "only an admin may change a setting" }, 403);
      const b = c.req.valid("json");
      return send(c, Setting, await sys.writeSetting(deps.db, deps.registry, c.req.valid("param").key, b.value,
        b.by ?? authorOf(c), deps.mountsRoot));
    } catch (e) {
      return fail(c, e);
    }
  });

  const RT = ["registries (D18)"];
  op(app, createRoute({
    method: "get", path: `${PREFIX}/registries`, operationId: "registries", tags: RT,
    summary: "every registry: the enumerated kinds the contract exposes", "x-mcp-tool": "contract_registries",
    responses: { 200: json(Registries, EX.registries, "registries"), ...errors },
  }), async (c) => {
    try {
      return send(c, Registries, await sys.registries(deps.db));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/registries/{name}`, operationId: "registry", tags: RT,
    summary: "one registry and its declared, versioned entries", "x-mcp-tool": "contract_registry",
    request: { params: z.object({ name: pathParam("name", "notification_classes") }) },
    responses: { 200: json(RegistryDetail, EX.registry, "the registry"), ...errors },
  }), async (c) => {
    try {
      const r = await sys.registry(deps.db, deps.registry, c.req.valid("param").name);
      if (!r) return c.json({ error: "no such registry" }, 404);
      return send(c, RegistryDetail, r);
    } catch (e) {
      return fail(c, e);
    }
  });
}
