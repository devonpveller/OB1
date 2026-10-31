// research-workbench P4b (rw-p4b-sessions): running sessions - sessions(), steer() (the P4a door),
// cancel and the research flow. The session stream (appendix.ts) carries the card while it runs.
//
// Every route reads and writes for the identity seam's subject only (identityOf: subject_sub; the
// actor and the admin flag from the signed-in token), never a user the caller names. Who may steer or
// cancel (operator 2026-10-30, option "Admins"): a user's job its owner; a service's job an admin; a job
// with no recorded owner the default subject. Anyone else is answered as if the job did not exist
// (404) - the card hides the actions, the route refuses them, and the research service checks again.
import { createRoute, z } from "../deps.ts";
import { CancelRequest, CancelResult, Flow, Sessions, SteerRequest, SteerResult } from "../schemas/sessions.ts";
import { limit, pathParam, queryParam } from "../schemas/common.ts";
import { parseLimit } from "../logic/scope.ts";
import { FX } from "../schemas/fixtures.ts";
import { EX } from "../schemas/examples.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";
import { card, flow, isAdmin, sessions, stepKind } from "../../sessions/repo.ts";
import { owuiBase } from "../../sessions/cards.ts";
import { type ResearchActions, researchActions } from "../../sessions/client.ts";
import { refetchClient } from "../../documents/clients.ts";

const T = ["running sessions (P4b)"];
const idParam = z.object({ id: pathParam("id", FX.job, "research job id") });
const UNCONFIGURED = "the research service is not configured for the workspace (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)";

export interface SessionsDeps {
  research: ResearchActions | null;
  refetch: ((url: string) => Promise<{ title: string; content: string }>) | null;
  owui: string;
}

export function sessionsDepsFromEnv(): SessionsDeps {
  return { research: researchActions(), refetch: refetchClient(), owui: owuiBase() };
}

export function registerSessions(app: ContractApp, deps: ContractDeps, s: SessionsDeps = sessionsDepsFromEnv()) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/sessions`, operationId: "sessions", tags: T,
    summary: "sessions(state) - every running session as one card (any origin), newest first",
    description: "state=running (default): queued or running, or a finished root with an open branch; state=recent " +
      "adds those finished in the last day. Another user's card carries no original prompt, inlet, branch text " +
      "or step id (07-MULTI-USER).",
    "x-appendix-call": "sessions",
    request: { query: z.object({ state: queryParam("state", "running", "running | recent"), limit: limit(50, 200) }) },
    responses: { 200: json(Sessions, EX.sessions, "the cards"), ...errors },
  }), async (c) => {
    try {
      const q = c.req.valid("query");
      const state = q.state === "recent" ? "recent" : "running";
      return send(c, Sessions, await sessions(deps.db, state, parseLimit(q.limit, 50, 200), await identityOf(c), s.owui));
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/sessions/{id}/flow`, operationId: "flow", tags: T,
    summary: "flow(sessionId) - every source the session's tree met, with its stages and their trail",
    request: { params: idParam },
    responses: { 200: json(Flow, EX.flow, "the per-source flow"), ...errors },
  }), async (c) => {
    try {
      const f = await flow(deps.db, c.req.valid("param").id, await identityOf(c));
      if (!f) return c.json({ error: "no session with this id" }, 404);
      return send(c, Flow, f);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/sessions/{id}/steer`, operationId: "steer", tags: T,
    summary: "steer(sessionId, stepId, text, contextSnapshot) - a branch at a steering point; narrow and add-source too",
    description: "Opens a P4a branch rooted at the step (a STEERING stage only: a due-process step is 409). The answer " +
      "carries the card with the new branch pending. `contract` narrows (never widens) the parent's; `add_source` " +
      "seeds the branch with a source (its text, or fetched through the egress proxy). The research service records " +
      "the actor (research_steers.actor_sub). 404 when the viewer may not act on the job.",
    "x-appendix-call": "steer",
    request: { params: idParam, body: body(SteerRequest, EX.steerRequest) },
    responses: { 201: json(SteerResult, EX.steerResult, "the branch, and the card with it pending"), ...errors,
      503: json(z.object({ error: z.string() }), { error: UNCONFIGURED }, "the research service is not configured") },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      const b = c.req.valid("json");
      const who = await identityOf(c);
      const before = await card(deps.db, id, who, s.owui);
      if (!before || !before.card.can_act) return c.json({ error: "no session with this id" }, 404);
      if (!s.research) return c.json({ error: UNCONFIGURED }, 503);
      const kind = await stepKind(deps.db, id, b.step_id);
      if (kind === null) return c.json({ error: "this session has no such step" }, 400);
      if (kind !== "steering") return c.json({ error: "not a steering point: a due-process stage is not steered", detail: { step_id: b.step_id, kind } }, 409);
      let seeds: { url: string; title: string; content: string }[] | undefined;
      if (b.add_source) {
        let content = b.add_source.content ?? "";
        let title = b.add_source.title ?? "";
        if (!content.trim()) {
          if (!s.refetch) return c.json({ error: "no fetch path is configured to read the source: paste its text" }, 503);
          const got = await s.refetch(b.add_source.url).catch(() => null);
          if (!got || !got.content.trim()) return c.json({ error: "the source could not be fetched: paste its text" }, 502);
          content = got.content;
          title ||= got.title;
        }
        seeds = [{ url: b.add_source.url, title: title || b.add_source.url, content }];
      }
      const r = await s.research.steer(id, {
        step_id: b.step_id, text: b.text, ...(b.contract ? { contract: b.contract } : {}),
        ...(b.context_snapshot ? { context_snapshot: b.context_snapshot } : {}), ...(seeds ? { seed_sources: seeds } : {}),
      }, { sub: who.sub, actor: who.actor, admin: isAdmin(who) });
      if (r.status === 404) return c.json({ error: "no session with this id" }, 404);
      if (r.status !== 201) {
        const status = [400, 409].includes(r.status) ? r.status : 502;
        return c.json({ error: String(r.body.detail ?? r.body.error ?? `the research service answered ${r.status}`) }, status as 400);
      }
      const after = await card(deps.db, id, who, s.owui);
      const o = r.body as Record<string, string>;
      return send(c, SteerResult, {
        steer: { steer_id: o.steer_id, child_job_id: o.child_job_id, root_job_id: o.root_job_id, parent_job_id: o.parent_job_id, step_id: o.step_id, steer_kind: o.steer_kind },
        card: after!.card,
      }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${PREFIX}/sessions/{id}/cancel`, operationId: "cancelSession", tags: T,
    summary: "cancel a session (or one branch): a queued one at once, a running one within moments",
    request: { params: idParam, body: body(CancelRequest, EX.cancelRequest) },
    responses: { 200: json(CancelResult, EX.cancel, "the outcome (cancelled, cancelling, or already terminal)"), ...errors,
      503: json(z.object({ error: z.string() }), { error: UNCONFIGURED }, "the research service is not configured") },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      const who = await identityOf(c);
      const l = await card(deps.db, id, who, s.owui);
      if (!l || !l.card.can_act) return c.json({ error: "no session with this id" }, 404);
      if (!s.research) return c.json({ error: UNCONFIGURED }, 503);
      const r = await s.research.cancel(id, c.req.valid("json").reason ?? null, { sub: who.sub, actor: who.actor, admin: isAdmin(who) });
      if (r.status === 404) return c.json({ error: "no session with this id" }, 404);
      if (r.status >= 500 || r.status === 401 || r.status === 403) return c.json({ error: `the research service answered ${r.status}` }, 502);
      const o = r.body as Record<string, unknown>;
      return send(c, CancelResult, { job_id: id, status: String(o.status ?? ""), ...(o.note ? { note: String(o.note) } : {}) });
    } catch (e) {
      return fail(c, e);
    }
  });
}
