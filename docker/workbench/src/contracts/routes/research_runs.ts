// A person's own research runs (rwr-research-runs): the list with state counts, one run's tree with node details, archive /
// unarchive (slot 640: a per-user view state) and "open the report as a document". All for the identity seam's subject (user-only: a
// service key has no runs); no request names a person. A run that is not the caller's answers the 404 of a missing one.
// Steer, add a follow-up and cancel are the sessions routes (routes/sessions.ts), unchanged; the live tree is the sessions stream.
import { createRoute, z } from "../deps.ts";
import { identityOf } from "../../middleware/identity.ts";
import { owuiBase } from "../../sessions/cards.ts";
import { type DocSeam, listRuns, reportAsDocument, runDetail, setArchived, Unavailable } from "../repo/research_runs.ts";
import { RRX, RunArchived, RunDetail, RunDocument, RunList } from "../schemas/research_runs.ts";
import { limit, pathParam, queryParam } from "../schemas/common.ts";
import { parseLimit } from "../logic/scope.ts";
import { ErrorBody } from "../schemas/common.ts";
import { type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const T = ["research runs (rwr-research-runs)"];
const P = `${PREFIX}/research/runs`;
export const RUN_ID_EXAMPLE = RRX.row.id;
const idParam = z.object({ id: pathParam("id", RUN_ID_EXAMPLE, "a research run (root job) id; the caller's own") });
const unavailable = { content: { "application/json": { schema: ErrorBody } }, description: "documents are not available here" };

export function registerResearchRuns(app: ContractApp, deps: ContractDeps, seam: DocSeam = { createOwnDocument: deps.createOwnDocument }) {
  op(app, createRoute({
    method: "get", path: P, operationId: "researchRuns", tags: T,
    summary: "the caller's own research runs, with state counts (another person's runs are not listed, counted or hinted at)",
    description: "view=active (default) | archived | all. counts cover all of the caller's runs; archived runs are the caller's own view " +
      "state (slot 640) and never another person's. Each run carries its root question, the boundary's topic, the document it was " +
      "started from (the caller's own), its state group and its dates, so a screen can group by document, topic or date.",
    request: { query: z.object({ view: queryParam("view", "active", "active | archived | all"), limit: limit(200, 1000) }) },
    responses: { 200: json(RunList, { runs: [RRX.row], counts: RRX.counts }, "the caller's runs"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      const view = q.view === "archived" || q.view === "all" ? q.view : "active";
      return send(c, RunList, await listRuns(deps.db, await identityOf(c), view, parseLimit(q.limit, 200, 1000)));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/{id}`, operationId: "researchRun", tags: T,
    summary: "one of the caller's runs: its tree, and for each node its sources and claims",
    description: "Another person's run, and a missing one, are the same 404. A claim that moved to its owner's private store (a claim " +
      "drawn from a private report) is never listed or counted here.",
    request: { params: idParam },
    responses: { 200: json(RunDetail, { run: RRX.row, can_act: true, running: false, next_steering_point: null, nodes: [] }, "the run"), ...errors },
  }), async (c) => {
    try {
      const d = await runDetail(deps.db, await identityOf(c), c.req.valid("param").id, owuiBase());
      if (!d) return c.json({ error: "no research run with this id" }, 404);
      return send(c, RunDetail, d);
    } catch (e) {
      return fail(c, e);
    }
  });

  const mark = (verb: "archive" | "unarchive", archived: boolean, ex: unknown) =>
    op(app, createRoute({
      method: "post", path: `${P}/{id}/${verb}`, operationId: `${verb}ResearchRun`, tags: T,
      summary: archived ? "archive the caller's run: it leaves the caller's list only" : "unarchive the caller's run",
      description: "A per-user view state (slot 640). The run, its sources, claims and every other person's view of it are untouched. " +
        (archived ? "An already archived run is 409." : "A run that is not archived is 409.") + " Another person's run is 404.",
      request: { params: idParam },
      responses: { 200: json(RunArchived, ex, "the run's view state"), ...errors },
    }), async (c) => {
      try {
        return send(c, RunArchived, await setArchived(deps.db, await identityOf(c), c.req.valid("param").id, archived));
      } catch (e) {
        return fail(c, e);
      }
    });
  mark("archive", true, RRX.archived);
  mark("unarchive", false, RRX.unarchived);

  op(app, createRoute({
    method: "post", path: `${P}/{id}/document`, operationId: "researchRunDocument", tags: T,
    summary: "open the run's report as a document: a new document in the caller's own folder",
    description: "The document is the caller's and private to them (a user document is never shared or ingested); nothing but the document " +
      "and its own listing is written. A run with no report yet is 409; another person's run is 404.",
    request: { params: idParam },
    responses: { 201: json(RunDocument, RRX.document, "the new document"), ...errors, 503: unavailable },
  }), async (c) => {
    try {
      return send(c, RunDocument, await reportAsDocument(deps.db, seam, await identityOf(c), c.req.valid("param").id), 201);
    } catch (e) {
      if (e instanceof Unavailable) return c.json({ error: e.message }, 503);
      return fail(c, e);
    }
  });
}
