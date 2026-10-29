// D17 items 5-6 (ideas, the idea refinery), held user sources, and D12 (the document listing).
// No operation here writes `ideas`: the MCP idea tools stay its only writers.
import { createRoute, z } from "../deps.ts";
import * as ideas from "../repo/ideas.ts";
import { requireRegistered } from "../registry.ts";
import { blocksMetadataless, parseLimit, parseMetadataFilter } from "../logic/scope.ts";
import { limit, metadataFilter, pathParam } from "../schemas/common.ts";
import {
  Documents, HiddenRequest, HiddenState, Idea, Ideas, UserSourceAdded, UserSourceAddRequest, UserSourceRemoved,
} from "../schemas/ideas.ts";
import { FX } from "../schemas/fixtures.ts";
import { EX } from "../schemas/examples.ts";
import { authorOf, body, type ContractApp, type ContractDeps, errors, op, fail, json, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";

const T = ["ideas and the idea refinery (D17)"];
const ideaParam = z.object({ id: pathParam("id", FX.idea, "idea (refinery) id") });

export function registerRefinery(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/ideas`, operationId: "ideas", tags: T, summary: "ideas() - every idea, newest first",
    "x-mcp-tool": "contract_ideas",
    request: { query: z.object({ limit: limit(50, 200), metadata_filter: metadataFilter }) },
    responses: { 200: json(Ideas, EX.ideas, "idea summaries"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      if (blocksMetadataless(parseMetadataFilter(q.metadata_filter))) return send(c, Ideas, { ideas: [] });
      return send(c, Ideas, await ideas.ideas(deps.db, parseLimit(q.limit, 50, 200), (await identityOf(c)).sub));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/ideas/{id}`, operationId: "idea", tags: T,
    summary: "idea(id) - the aggregate and its refinery: members, context graph, hidden set, origin, user source list",
    "x-mcp-tool": "contract_idea",
    request: { params: ideaParam, query: z.object({ metadata_filter: metadataFilter }) },
    responses: { 200: json(Idea, EX.idea, "the idea"), ...errors },
  }), async (c) => {
    try {
      if (blocksMetadataless(parseMetadataFilter(c.req.valid("query").metadata_filter))) {
        return c.json({ error: "not found in scope" }, 404);
      }
      const r = await ideas.idea(deps.db, c.req.valid("param").id, (await identityOf(c)).sub);
      if (!r) return c.json({ error: "no idea with this id" }, 404);
      return send(c, Idea, r);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/ideas/{id}/hidden`, operationId: "setHidden", tags: T,
    summary: "hide or unhide a node in this refinery's context graph (a view setting on the refinery only)",
    request: {
      params: ideaParam,
      body: body(HiddenRequest, EX.hiddenRequest),
    },
    responses: { 200: json(HiddenState, EX.hidden, "the node's hidden flag in this refinery"), ...errors },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      await requireRegistered(deps.registry, "node_kinds", b.node_kind);
      return send(c, HiddenState, await ideas.setHidden(deps.db, c.req.valid("param").id, b.node_kind, b.node_ref, b.hidden, (await identityOf(c)).sub));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/ideas/{id}/user-sources`, operationId: "addUserSource", tags: T,
    summary: "add a user-provided source: stored, chunked, embedded, held in this refinery at revision 1",
    request: { params: ideaParam, body: body(UserSourceAddRequest, EX.userSourceAddRequest) },
    responses: { 200: json(UserSourceAdded, EX.userSourceAdded, "held"), 502: json(z.object({ error: z.string() }), { error: "embedding unavailable" }, "embedding failed; nothing stored"), ...errors },
  }), async (c) => {
    try {
      const b = c.req.valid("json");
      if (b.content_type) await requireRegistered(deps.registry, "content_types", b.content_type);
      const r = await ideas.addHeld(deps.db, c.req.valid("param").id, { ...b, by: b.by ?? authorOf(c) ?? undefined },
        deps.chunk, deps.embed, { owner: (await identityOf(c)).sub }).catch((e) => {
          if (String((e as Error)?.message ?? "").startsWith("embedding")) return { embedFailed: String((e as Error).message) };
          throw e;
        });
      if ("embedFailed" in r) return c.json({ error: `embedding unavailable: ${r.embedFailed}` }, 502);
      return send(c, UserSourceAdded, r);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "delete", path: `${PREFIX}/ideas/{id}/user-sources/{sourceId}`, operationId: "removeUserSource", tags: T,
    summary: "remove a held source outright (no tombstone); refused while a user document links it",
    request: { params: z.object({ id: pathParam("id", FX.idea), sourceId: pathParam("sourceId", FX.heldRemovable) }) },
    responses: { 200: json(UserSourceRemoved, EX.userSourceRemoved, "removed"), ...errors },
  }), async (c) => {
    try {
      const p = c.req.valid("param");
      return send(c, UserSourceRemoved, await ideas.removeHeld(deps.db, p.id, p.sourceId, (await identityOf(c)).sub));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/documents`, operationId: "documents", tags: ["user documents (D12)"],
    summary: "the user document listing: title, path, updated, outbound links - never a body",
    "x-mcp-tool": "contract_documents",
    request: { query: z.object({ limit: limit(100, 500), metadata_filter: metadataFilter }) },
    responses: { 200: json(Documents, EX.documents, "listing records"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      if (blocksMetadataless(parseMetadataFilter(q.metadata_filter))) return send(c, Documents, { documents: [] });
      return send(c, Documents, await ideas.documents(deps.db, parseLimit(q.limit, 100, 500), (await identityOf(c)).sub));
    } catch (e) {
      return fail(c, e);
    }
  });
}
