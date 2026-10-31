// research-workbench P3b - the trust panels' contract reads (schemas/trust.ts, repo/trust.ts):
//   reportCredibility  GET /reports/{id}/credibility       the roll-up of a report, its claim-kind weights named (shared)
//   coverage           GET /sessions/{id}/coverage         a session's needs by status, topic estimate + anchor, hubs (owner's)
//   documentCoverage   GET /documents/coverage?path=       a user document's hubs and its owner's sessions (owner's)
// The claims ledger and the source quality panel read claims() and quality() (appendix.ts).
//
// None is an MCP tool: coverage is a user's own view, and the roll-up is already in what the research
// service publishes; D14 keeps MCP to the appendix reads. A metadata filter (the cloud door) answers 404:
// research jobs carry no metadata (fail closed, as session() does).
import { createRoute, z } from "../deps.ts";
import { metadataFilter, pathParam, queryParam } from "../schemas/common.ts";
import { DocumentCoverage, ReportCredibility, SessionCoverage } from "../schemas/trust.ts";
import { FX } from "../schemas/fixtures.ts";
import { TRUST_EX } from "../schemas/trust_examples.ts";
import { parseMetadataFilter } from "../logic/scope.ts";
import * as trust from "../repo/trust.ts";
import { identityOf } from "../../middleware/identity.ts";
import { DocError, ownedPath } from "../../documents/repo.ts";
import { type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const T = ["trust panels (P3b)"];

export function registerTrust(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/reports/{id}/credibility`, operationId: "reportCredibility", tags: T,
    summary: "the report credibility roll-up of a research report, with the claim-kind weights it used (D15 item 5)",
    request: {
      params: z.object({ id: pathParam("id", FX.synthesis, "the report's research synthesis source id") }),
      query: z.object({ metadata_filter: metadataFilter }),
    },
    responses: { 200: json(ReportCredibility, TRUST_EX.reportCredibility, "the roll-up; recorded false when none was"), ...errors },
  }), async (c) => {
    try {
      if (parseMetadataFilter(c.req.valid("query").metadata_filter)) return c.json({ error: "not found in scope" }, 404);
      const r = await trust.reportCredibility(deps.db, c.req.valid("param").id);
      if (!r) return c.json({ error: "no research report with this id" }, 404);
      return send(c, ReportCredibility, r);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/sessions/{id}/coverage`, operationId: "coverage", tags: T,
    summary: "coverage(session) - needs by status (never a percent), the topic estimate beside the anchor, the hubs " +
      "the session touches and its report credibility; the signed-in user's own sessions only",
    request: { params: z.object({ id: pathParam("id", FX.job, "research job id") }), query: z.object({ metadata_filter: metadataFilter }) },
    responses: { 200: json(SessionCoverage, TRUST_EX.sessionCoverage, "the session's coverage"), ...errors },
  }), async (c) => {
    try {
      if (parseMetadataFilter(c.req.valid("query").metadata_filter)) return c.json({ error: "not found in scope" }, 404);
      const r = await trust.sessionCoverage(deps.db, c.req.valid("param").id, await identityOf(c));
      if (!r) return c.json({ error: "no session with this id" }, 404);
      return send(c, SessionCoverage, r);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/documents/coverage`, operationId: "documentCoverage", tags: T,
    summary: "coverage(document) - the hubs a user document touches (the P2b hub context) and the user's own sessions " +
      "started from it or its refinery",
    request: { query: z.object({ path: queryParam("path", FX.documentPath, "the user document's vault path"), metadata_filter: metadataFilter }) },
    responses: { 200: json(DocumentCoverage, TRUST_EX.documentCoverage, "the document's coverage"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      if (parseMetadataFilter(q.metadata_filter)) return c.json({ error: "not found in scope" }, 404);
      if (!q.path) return c.json({ error: "path (the document's vault path) is required" }, 400);
      const who = await identityOf(c);
      const rel = await ownedPath(deps.db, q.path, who);
      return send(c, DocumentCoverage, await trust.documentCoverage(deps.db, rel, who));
    } catch (e) {
      if (e instanceof DocError) return c.json({ error: e.status === 404 ? "no such document" : e.message }, e.status as 400);
      const msg = String((e as Error)?.message ?? e);
      if (/path traversal|empty path|invalid path|a user document is a \.md|invalid folder/.test(msg)) return c.json({ error: msg }, 400);
      return fail(c, e);
    }
  });
}
