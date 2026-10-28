// The panel-library appendix (journal/notes/research-panel-library-2026-09-18.md): every call
// panels read through. `x-appendix-call` names the appendix call an operation implements, so
// the coverage test can fail on a missing one; `x-mcp-tool` names the openbrain-mcp tool that
// exposes a read (D14: reads only).
import { createRoute, z } from "../deps.ts";
import { streamSSE } from "hono/streaming";
import * as src from "../repo/sources.ts";
import * as refs from "../repo/references.ts";
import * as kn from "../repo/knowledge.ts";
import * as ses from "../repo/sessions.ts";
import { evidenceVisibleStates } from "../logic/state.ts";
import { parseFlag, parseLimit, parseList, parseMetadataFilter } from "../logic/scope.ts";
import {
  evidenceOnly, limit, metadataFilter, NotImplemented, pathParam, queryParam,
} from "../schemas/common.ts";
import { ChunkContext, DiffCheck, DiffCheckRequest, Quality, Reference } from "../schemas/sources.ts";
import { Claims, Neighbours, Search, Timeline, Trail } from "../schemas/knowledge.ts";
import { Jobs, Session, SteerRequest, StreamEvent } from "../schemas/sessions.ts";
import { FX } from "../schemas/fixtures.ts";
import { EX } from "../schemas/examples.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send, wire } from "./http.ts";
import { requireIdea } from "../repo/ideas.ts";
import { identityOf } from "../../middleware/identity.ts";

const T = ["retrieval contract (appendix)"];

async function visible(deps: ContractDeps) {
  return evidenceVisibleStates(await deps.registry.entries("source_states"));
}

export function registerAppendix(app: ContractApp, deps: ContractDeps) {
  registerSourceReads(app, deps);
  registerKnowledgeReads(app, deps);
  registerSessionReads(app, deps);
  registerStubs(app);
}

function registerSourceReads(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/references/{id}`, operationId: "reference", tags: T,
    summary: "reference(id, version?) - a reference record read at its pin (P2a), or a source in any lifecycle state, typed",
    "x-appendix-call": "reference", "x-mcp-tool": "contract_reference",
    request: {
      params: z.object({ id: pathParam("id", FX.sourceActive, "a reference record id, or a source id") }),
      query: z.object({
        version: z.string().regex(/^[0-9]{1,6}$/).optional().openapi({ param: { name: "version", in: "query", example: "2" } }),
        evidence_only: evidenceOnly, metadata_filter: metadataFilter,
      }),
    },
    responses: { 200: json(Reference, EX.reference, "the reference, in its state"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      const r = await refs.referenceById(deps.db, c.req.valid("param").id, {
        version: q.version ? Number(q.version) : null, evidenceOnly: parseFlag(q.evidence_only),
        visible: await visible(deps), filter: parseMetadataFilter(q.metadata_filter),
      });
      if (!r) return c.json({ error: "no reference record, source, held source or tombstone with this id" }, 404);
      return send(c, Reference, r);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/chunks/{chunkId}/context`, operationId: "chunkContext", tags: T,
    summary: "chunkContext(chunkId, window) - the chunk and its neighbours, in the source's state",
    "x-appendix-call": "chunkContext", "x-mcp-tool": "contract_chunk_context",
    request: {
      params: z.object({ chunkId: pathParam("chunkId", `${FX.sourceActive}:1`, "<source uuid>:<chunk idx>") }),
      query: z.object({
        window: z.string().regex(/^[0-9]{1,2}$/).optional().openapi({ param: { name: "window", in: "query", example: "1" } }),
        evidence_only: evidenceOnly, metadata_filter: metadataFilter,
      }),
    },
    responses: { 200: json(ChunkContext, EX.chunkContext, "the chunk window"), ...errors },
  }), async (c) => {
    try {
      const m = /^([0-9a-f-]{36}):([0-9]{1,6})$/i.exec(c.req.valid("param").chunkId);
      if (!m) return c.json({ error: "chunkId is <source uuid>:<idx>" }, 400);
      const q = c.req.valid("query");
      const r = await src.chunkContext(deps.db, m[1], Number(m[2]), Math.min(10, Number(q.window ?? 1)), {
        evidenceOnly: parseFlag(q.evidence_only), visible: await visible(deps), filter: parseMetadataFilter(q.metadata_filter),
      });
      if (!r) return c.json({ error: "no such chunk" }, 404);
      return send(c, ChunkContext, r);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/diff-check`, operationId: "diffCheck", tags: T,
    summary: "diffCheck(referenceIds[]) - is each pin out of date, and which current chunk stands for it; " +
      "ids, revisions and states only, never chunk text",
    "x-appendix-call": "diffCheck", "x-mcp-tool": "contract_diff_check",
    request: { body: body(DiffCheckRequest, EX.diffCheckRequest), query: z.object({ metadata_filter: metadataFilter }) },
    responses: { 200: json(DiffCheck, EX.diffCheck, "one result per reference"), ...errors },
  }), async (c) => {
    try {
      return send(c, DiffCheck, await refs.diffCheck(deps.db, c.req.valid("json"), parseMetadataFilter(c.req.valid("query").metadata_filter)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/sources/{id}/quality`, operationId: "quality", tags: T,
    summary: "quality(id) - why this source is rated as it is", "x-appendix-call": "quality",
    "x-mcp-tool": "contract_quality",
    request: {
      params: z.object({ id: pathParam("id", FX.sourceActive, "source id") }),
      query: z.object({ metadata_filter: metadataFilter }),
    },
    responses: { 200: json(Quality, EX.quality, "factors and score, version-stamped"), ...errors },
  }), async (c) => {
    try {
      const r = await src.quality(deps.db, deps.registry, c.req.valid("param").id, parseMetadataFilter(c.req.valid("query").metadata_filter));
      if (!r) return c.json({ error: "no source with this id" }, 404);
      return send(c, Quality, r);
    } catch (e) {
      return fail(c, e);
    }
  });
}

function registerKnowledgeReads(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/neighbours`, operationId: "neighbours", tags: T,
    summary: "neighbours(id, kinds[], depth, limit) - the page graph around a page", "x-appendix-call": "neighbours",
    "x-mcp-tool": "contract_neighbours",
    request: {
      query: z.object({
        id: z.string().min(1).openapi({ param: { name: "id", in: "query", example: FX.pageEntity }, description: "page slug" }),
        kinds: queryParam("kinds", "", "comma-separated page_classes to keep (default: all)"),
        depth: z.string().regex(/^[0-9]$/).optional().openapi({ param: { name: "depth", in: "query", example: "1" } }),
        limit: limit(400, 800), metadata_filter: metadataFilter,
      }),
    },
    responses: { 200: json(Neighbours, EX.neighbours, "nodes and links, nearest first"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      const depth = Math.min(5, Math.max(1, Number(q.depth ?? 2) || 2));
      return send(c, Neighbours, await kn.neighbours(deps.db, q.id.replace(/^\/+|\/+$/g, ""), depth,
        parseLimit(q.limit, 400, 800), parseList(q.kinds), parseMetadataFilter(q.metadata_filter)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/claims`, operationId: "claims", tags: T,
    summary: "claims(scope, filter) - claims with tag, status, confidence and typed grounding edges",
    "x-appendix-call": "claims", "x-mcp-tool": "contract_claims",
    request: {
      query: z.object({
        thread_id: queryParam("thread_id", FX.thread), source_id: queryParam("source_id", FX.sourceActive),
        synthesis_id: queryParam("synthesis_id", FX.synthesis), status: queryParam("status", "active"),
        q: queryParam("q", "contract"), limit: limit(50, 200), evidence_only: evidenceOnly, metadata_filter: metadataFilter,
      }),
    },
    responses: { 200: json(Claims, EX.claims, "matching claims"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      return send(c, Claims, await kn.claims(deps.db, {
        thread_id: q.thread_id || null, source_id: q.source_id || null, synthesis_id: q.synthesis_id || null,
        status: q.status || null, q: q.q || null, limit: parseLimit(q.limit, 50, 200),
        evidenceOnly: parseFlag(q.evidence_only), filter: parseMetadataFilter(q.metadata_filter),
      }));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/search`, operationId: "search", tags: T,
    summary: "search(query, kinds[], scope) - pages, claims and sources with typed states (never user documents)",
    "x-appendix-call": "search", "x-mcp-tool": "contract_search",
    request: {
      query: z.object({
        q: z.string().min(2).openapi({ param: { name: "q", in: "query", example: "contract" } }),
        kinds: queryParam("kinds", "page,claim,source", "comma-separated node_kinds (default: all)"),
        refinery_id: queryParam("refinery_id", FX.idea, "scope: also search this refinery's held sources"),
        limit: limit(25, 50), evidence_only: evidenceOnly, metadata_filter: metadataFilter,
      }),
    },
    responses: { 200: json(Search, EX.search, "typed hits"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      // rw-p2b-workspace: a refinery's held sources are its owner's - another user's refinery scopes nothing
      const owner = (await identityOf(c)).sub;
      const refinery = q.refinery_id && await requireIdea(deps.db, q.refinery_id, owner).then(() => q.refinery_id, () => null);
      return send(c, Search, await kn.search(deps.db, {
        q: q.q.trim(), kinds: parseList(q.kinds), refinery_id: refinery || null, limit: parseLimit(q.limit, 25, 50),
        evidenceOnly: parseFlag(q.evidence_only), filter: parseMetadataFilter(q.metadata_filter),
      }));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/timeline`, operationId: "timeline", tags: T,
    summary: "timeline(scope, range) - revisions, sessions, claims and trail events in order",
    "x-appendix-call": "timeline", "x-mcp-tool": "contract_timeline",
    request: {
      query: z.object({
        from: queryParam("from", "2026-01-01T00:00:00Z"), to: queryParam("to", "2030-01-01T00:00:00Z"),
        source_id: queryParam("source_id", FX.sourceActive), limit: limit(100, 500), metadata_filter: metadataFilter,
      }),
    },
    responses: { 200: json(Timeline, EX.timeline, "events, newest first"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      return send(c, Timeline, await kn.timeline(deps.db, q.from || null, q.to || null, q.source_id || null,
        parseLimit(q.limit, 100, 500), parseMetadataFilter(q.metadata_filter)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/trail`, operationId: "trail", tags: T,
    summary: "trail(scope) - suppressions, redactions, tombstones and severances with reason and context",
    "x-appendix-call": "trail", "x-mcp-tool": "contract_trail",
    request: { query: z.object({ source_id: queryParam("source_id", FX.sourceSuppressed), limit: limit(100, 500), metadata_filter: metadataFilter }) },
    responses: { 200: json(Trail, EX.trail, "trail entries, newest first; none of it is evidence"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      return send(c, Trail, await kn.trail(deps.db, q.source_id || null, parseLimit(q.limit, 100, 500), parseMetadataFilter(q.metadata_filter)));
    } catch (e) {
      return fail(c, e);
    }
  });
}

function registerSessionReads(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/sessions/{id}`, operationId: "session", tags: T,
    summary: "session(id) - a research session with its origin, inlet reference and refinery", "x-appendix-call": "session",
    "x-mcp-tool": "contract_session",
    request: { params: z.object({ id: pathParam("id", FX.job, "research job id") }), query: z.object({ metadata_filter: metadataFilter }) },
    responses: { 200: json(Session, EX.session, "the session"), ...errors },
  }), async (c) => {
    try {
      if (parseMetadataFilter(c.req.valid("query").metadata_filter)) return c.json({ error: "not found in scope" }, 404);
      const r = await ses.session(deps.db, c.req.valid("param").id, (await identityOf(c)).sub);
      if (!r) return c.json({ error: "no session with this id" }, 404);
      return send(c, Session, r);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/sessions/{id}/stream`, operationId: "stream", tags: T,
    summary: "stream(sessionId) - server-sent session snapshots until the session ends",
    description: "text/event-stream. Each event is `event: snapshot` (or `end` for the last) with a JSON `data:` " +
      "line shaped as the StreamEvent component. A terminal session yields one snapshot and an end event.",
    "x-appendix-call": "stream", "x-event-schema": "#/components/schemas/StreamEvent",
    request: { params: z.object({ id: pathParam("id", FX.job, "research job id") }) },
    responses: {
      200: { content: { "text/event-stream": { schema: z.string(), example: EX.stream } }, description: "SSE stream" },
      ...errors,
    },
  }), async (c) => {
    const id = c.req.valid("param").id;
    const owner = (await identityOf(c)).sub;
    const first = await ses.session(deps.db, id, owner).catch(() => null);
    if (!first) return c.json({ error: "no session with this id" }, 404);
    return streamSSE(c, async (s) => {
      let last = "";
      let snap: Awaited<ReturnType<typeof ses.session>> = first;
      while (snap) {
        const data = JSON.stringify(StreamEvent.parse(wire({ event: "snapshot", session: snap })));
        if (data !== last) await s.writeSSE({ event: "snapshot", data });
        last = data;
        if (ses.isTerminal(snap.status)) break;
        await s.sleep(deps.streamPollMs);
        snap = await ses.session(deps.db, id, owner);
      }
      await s.writeSSE({ event: "end", data: JSON.stringify({ event: "end", session_id: id }) });
    }) as never;
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/sessions/{id}/steer`, operationId: "steer", tags: T,
    summary: "steer(sessionId, stepId, text, contextSnapshot) - lands with the job tree in P4a",
    "x-appendix-call": "steer",
    request: { params: z.object({ id: pathParam("id", FX.job, "research job id") }), body: body(SteerRequest, EX.steerRequest) },
    responses: { 501: json(NotImplemented, EX.notImplemented("steer", "P4a"), "typed not_implemented"), ...errors },
  }), (c) => c.json(notImplemented("steer", "P4a"), 501));

  op(app, createRoute({
    method: "get", path: `${PREFIX}/jobs`, operationId: "jobs", tags: T,
    summary: "jobs(state) - the import and research queues in one shape", "x-appendix-call": "jobs",
    "x-mcp-tool": "contract_jobs",
    request: {
      query: z.object({
        state: queryParam("state", "done", "a job_states key"), kinds: queryParam("kinds", "import,research", "job_kinds"),
        limit: limit(50, 200), metadata_filter: metadataFilter,
      }),
    },
    responses: { 200: json(Jobs, EX.jobs, "jobs, newest first"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      if (parseMetadataFilter(q.metadata_filter)) return send(c, Jobs, { jobs: [] });
      return send(c, Jobs, await ses.jobs(deps.db, q.state || null, parseList(q.kinds), parseLimit(q.limit, 50, 200), (await identityOf(c)).sub));
    } catch (e) {
      return fail(c, e);
    }
  });
}

export function notImplemented(operation: string, landsIn: string) {
  return NotImplemented.parse({
    status: "not_implemented", operation, lands_in: landsIn,
    message: `${operation} is part of the contract; its backing lands in ${landsIn}`,
  });
}

// Calls whose backing lands in a later phase answer a typed not_implemented that validates
// against its schema, so Dredd passes on P0 alone and every later phase reads a real edge.
function registerStubs(app: ContractApp) {
  const stubs: { op: string; reg: string; path: string; lands: string; tool: string; params?: [string, string][] }[] = [
    { op: "watches", reg: "watches", path: "/watches", lands: "P5b", tool: "contract_watches" },
    { op: "proposals", reg: "proposals", path: "/watches/{watchId}/proposals", lands: "P5b", tool: "contract_proposals", params: [["watchId", FX.watch]] },
    { op: "stanceMap", reg: "stance_map", path: "/stance-maps/{id}", lands: "P7b", tool: "contract_stance_map", params: [["id", FX.job]] },
    { op: "podcasts", reg: "podcasts", path: "/podcasts", lands: "P7a/P7b", tool: "contract_podcasts" },
    { op: "presenters", reg: "presenters", path: "/presenters", lands: "P7a", tool: "contract_presenters" },
    { op: "teams", reg: "teams", path: "/teams", lands: "P7a", tool: "contract_teams" },
  ];
  for (const s of stubs) {
    const params = s.params
      ? z.object(Object.fromEntries(s.params.map(([n, ex]) => [n, pathParam(n, ex)])))
      : undefined;
    op(app, createRoute({
      method: "get", path: `${PREFIX}${s.path}`, operationId: s.op, tags: T,
      summary: `${s.op}() - backing lands in ${s.lands}`, "x-appendix-call": s.op, "x-mcp-tool": s.tool,
      request: params ? { params } : {},
      responses: { 501: json(NotImplemented, EX.notImplemented(s.reg, s.lands), "typed not_implemented"), ...errors },
    }), (c) => c.json(notImplemented(s.reg, s.lands), 501));
  }
}

