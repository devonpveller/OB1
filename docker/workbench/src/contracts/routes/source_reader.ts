// rwr-source-reader-api: GET /workbench/contract/sources/{id}/reader - one source's text in order, the section each
// chunk sits in, and the claims drawn from the source placed in the chunk their words are found in.
// Its own file: other items add routes to the same contract at the same time.
// Not an MCP tool (no x-mcp-tool): it can return a private source's text, which only its owner reads.
// A private (inlet) source answers 404 to everyone but its owner, with the very body a missing source gets.
import { createRoute, z } from "../deps.ts";
import { sourceReader } from "../repo/source_reader.ts";
import { evidenceVisibleStates } from "../logic/state.ts";
import { parseFlag, parseMetadataFilter } from "../logic/scope.ts";
import { evidenceOnly, metadataFilter, pathParam } from "../schemas/common.ts";
import { SOURCE_READER_EXAMPLE, SourceReader } from "../schemas/source_reader.ts";
import { FX } from "../schemas/fixtures.ts";
import { type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";
import { privateViewConfig } from "../../identity/private_view.ts";

export const NOT_FOUND_BODY = { error: "no source with this id" };

export function registerSourceReader(app: ContractApp, deps: ContractDeps) {
  const privateView = deps.privateView ?? privateViewConfig();
  op(app, createRoute({
    method: "get", path: `${PREFIX}/sources/{id}/reader`, operationId: "sourceReader", tags: ["source reader"],
    summary: "sourceReader(id) - the source's chunks in order with section names, and each claim drawn from it placed " +
      "in its chunk (with a quote span only where the claim's own words are found verbatim); a private source is its owner's only",
    request: {
      params: z.object({ id: pathParam("id", FX.sourceActive, "a source id") }),
      query: z.object({ evidence_only: evidenceOnly, metadata_filter: metadataFilter }),
    },
    responses: { 200: json(SourceReader, SOURCE_READER_EXAMPLE, "the source's text and its claims"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      const entries = await deps.registry.entries("source_states");
      const r = await sourceReader(deps.db, c.req.valid("param").id, {
        evidenceOnly: parseFlag(q.evidence_only), visible: evidenceVisibleStates(entries),
        filter: parseMetadataFilter(q.metadata_filter), who: await identityOf(c), privateView,
      });
      if (!r) return c.json(NOT_FOUND_BODY, 404);
      c.header("Cache-Control", "no-store");
      return send(c, SourceReader, r);
    } catch (e) {
      return fail(c, e);
    }
  });
}
