// The owner's review of an idea's research question (research-workbench rw-boundary-ideas, plan 09 PD0b, D7).
//
// An idea's research starts only from a de-personalised question (slot 580: the database queues a private hand-back,
// the research service's drain forms the public question through the boundary). When the boundary cannot phrase one,
// the hand-back waits for its OWNER (awaiting_owner) with the best refused candidate and the tokens that failed - this
// module is the panel's door to that review, for the identity seam's subject only (another user's idea is 404, exactly
// like an idea that does not exist):
//   GET  /workbench/ideas/:id/research           the idea's research state: none | pending | queued | awaiting_owner |
//                                                refused | delivered | failed, and while it waits, the review
//   POST /workbench/ideas/:id/research/approve   {question} - the owner's (edited) question; the research service still
//                                                refuses the owner's identity, the idea's ids and a private link's words
//                                                (202 {job_id} | 200 {refused, failing}); accepted, it runs DERIVED
//                                                (shared knowledge, no tie to the idea on any shared row)
//   POST /workbench/ideas/:id/research/private   {question} - "run privately": a 'personal' job, its report private
//                                                to the owner (slot 390's rule on the idea-tied job)
// Nothing here reads the hand-back table itself: the slot-580 functions are owner-scoped (idea_handback_review,
// idea_handback_run_private) and the approval goes through the research service (the only writer of a derived job).
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";
import { IdeaError, NOT_FOUND } from "./repo.ts";

export const MAX_QUESTION = 2000;
const NOT_WAITING = "this idea's research question is not waiting for you (it was decided, or the idea changed since)";
const UNCONFIGURED = "the research service is not configured for the workspace (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)";

export interface ReviewRow {
  handback_id: string; revision: number | null; state: string; refusal: string | null; candidate: string | null;
  failing: string[] | null; code: string | null; job_id: string | null; created_at: string; updated_at: string;
}

export function parseQuestion(b: Record<string, unknown>): string {
  const q = typeof b.question === "string" ? b.question.trim() : "";
  if (!q) throw new IdeaError(400, "question is the text to research");
  if (q.length > MAX_QUESTION) throw new IdeaError(400, `a question is at most ${MAX_QUESTION} characters`);
  return q;
}

async function ownIdea(db: Db, id: string, who: Identity): Promise<void> {
  const own = await db.query<{ id: string }>(`SELECT id::text AS id FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2`, [id, who.sub]);
  if (!own.length) throw new IdeaError(404, NOT_FOUND);
}

async function latest(db: Db, id: string, who: Identity): Promise<ReviewRow | null> {
  return (await db.query<ReviewRow>(
    `SELECT handback_id::text AS handback_id, revision, state, refusal, candidate, failing, code, job_id::text AS job_id, created_at, updated_at
       FROM public.idea_handback_review($1, $2::uuid)`, [who.sub, id]))[0] ?? null;
}

/** The idea's research state for its owner; the review only while it waits for them. */
export async function researchState(db: Db, id: string, who: Identity) {
  await ownIdea(db, id, who);
  const r = await latest(db, id, who);
  if (!r) return { idea_id: id, state: "none", revision: null, job_id: null, review: null };
  return {
    idea_id: id, state: r.state, revision: r.revision, job_id: r.job_id, updated_at: r.updated_at,
    review: r.state === "awaiting_owner"
      ? { candidate: r.candidate ?? "", failing: r.failing ?? [], code: r.code ?? r.refusal, refusal: r.refusal }
      : null,
  };
}

async function waiting(db: Db, id: string, who: Identity): Promise<ReviewRow> {
  await ownIdea(db, id, who);
  const r = await latest(db, id, who);
  if (!r || r.state !== "awaiting_owner") throw new IdeaError(409, NOT_WAITING, { code: "not-awaiting-owner" });
  return r;
}

/** The research service's approval door (POST /research/derived/approve) under the workspace's own key, for the
 *  identity seam's subject - null when the workspace has no research service configured (shipped inert). */
export type ApproveCall = (handbackId: string, question: string, who: Identity) => Promise<{ status: number; body: Record<string, unknown> }>;
export function approveClient(env = (k: string) => Deno.env.get(k), fetchFn: typeof fetch = fetch): ApproveCall | null {
  const base = (env("RESEARCH_URL") ?? "").replace(/\/+$/, "");
  const key = env("RESEARCH_WORKSPACE_KEY") ?? "";
  if (!base || !key) return null;
  return async (handbackId, question, who) => {
    const r = await fetchFn(`${base}/research/derived/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-brain-key": key, "x-on-behalf-of": who.sub },
      body: JSON.stringify({ handback_id: handbackId, question }), signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json().catch(() => ({}));
    // another service's error text is never handed on (rw-identity-harden2): the typed answers keep their body
    if (![200, 202, 400, 404, 409].includes(r.status)) {
      console.error(`[ideas] the research service answered ${r.status} to an approval`);
      return { status: 502, body: { error: "upstream_error" } };
    }
    return { status: r.status, body: (j ?? {}) as Record<string, unknown> };
  };
}

export async function approveQuestion(db: Db, id: string, question: string, who: Identity, call: ApproveCall | null) {
  if (!call) throw new IdeaError(502, UNCONFIGURED, { code: "research-unconfigured" });
  const r = await waiting(db, id, who);
  const a = await call(r.handback_id, question, who);
  if (a.status === 202) return { status: 202 as const, body: { outcome: "queued", run: "derived", job_id: a.body.job_id } };
  if (a.status === 200) return { status: 200 as const, body: { outcome: "refused", refused: a.body.refused, failing: a.body.failing ?? [] } };
  if (a.status === 404 || a.status === 409) throw new IdeaError(409, NOT_WAITING, { code: "not-awaiting-owner" });
  if (a.status === 400) throw new IdeaError(400, String(a.body.error ?? "the question was refused"));
  throw new IdeaError(502, "the research service did not take the approval", { code: "upstream_error" });
}

export async function runPrivately(db: Db, id: string, question: string, who: Identity) {
  const r = await waiting(db, id, who);
  const job = (await db.query<{ j: string | null }>(`SELECT public.idea_handback_run_private($1, $2, $3::uuid, $4)::text AS j`,
    [who.sub, who.actor, r.handback_id, question]))[0]?.j ?? null;
  if (!job) throw new IdeaError(409, NOT_WAITING, { code: "not-awaiting-owner" });
  return { outcome: "queued", run: "private", job_id: job };
}
