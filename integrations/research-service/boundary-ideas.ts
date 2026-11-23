/**
 * THE IDEA PATH THROUGH THE REQUEST BOUNDARY (research-workbench rw-boundary-ideas, plan 09 PD0b, 2.5 P1, 3.2, D7;
 * operator 2026-11-04, "PD0: approved"). An idea's research starts only from a de-personalised question.
 *
 * The database queues an idea's research as a PENDING private hand-back (slot 580: research_idea_queue and every caller
 * of it - capture, update, the schedule drain, research now - upsert one per idea with the same coalescing and lock; no
 * job, no idea text on a shared row). This module DRAINS them:
 *   1. idea_handback_item(id) - the idea's title, the queued revision's text and its domain, read as a service (the
 *      hand-back's owner is the idea's owner: slot 580's trigger binds it, 420 reviewer R-F4);
 *   2. formDerivedRequest(..., 'idea-research') - the local model proposes, the pure gate decides (boundary.ts);
 *   3. ONE short transaction: insertDerivedJob + idea_handback_settle(id, revision, job, 'queued') - which stamps
 *      ideas.last_job_id and idea_revisions.research_job_id - or, refused, idea_handback_settle(..., 'awaiting_owner')
 *      with the owner's review data (the best candidate and its failing tokens; owner-only). The settle re-checks, under
 *      the idea's lock, that the row is still pending on the SAME revision: an edit while the question was being formed
 *      wins (the formed job is rolled back and the row is formed again from the new revision).
 * No lock is held while the model runs: handback_pending's row lock is released when its statement's transaction ends,
 * so an edit never waits for the model.
 *
 * The owner's review (D7): `approveIdeaQuestion` - the owner's edited question through formOwnerApprovedRequest (the
 * identity deny list still enforced) and, accepted, a derived job via idea_handback_decide. "Run privately" is SQL only
 * (slot 580 idea_handback_run_private: a 'personal' job tied to the idea, its report private by slot 390's rule).
 */
import {
  type BoundaryDeps, type BoundaryVerdict, formDerivedRequest, formOwnerApprovedRequest, insertDerivedJob, type OwnerView,
  type PersonalItem, type Q,
} from "./boundary.ts";

/** The idea as the drain reads it (slot 580 idea_handback_item): never stored by this module. */
export interface IdeaHandbackItem {
  id: string; owner_sub: string; idea_id: string; inlet_revision: number; state: string;
  title: string | null; summary: string | null; domain: string | null;
  gone: boolean;                    // the idea was deleted or archived
}

const URL_RX = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
/** The links an idea names (its title and text) - candidates for public evidence, judged by the boundary. */
export function ideaLinks(...texts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const t of texts) for (const m of String(t ?? "").matchAll(URL_RX)) {
    const u = m[0].replace(/[.,;:!?]+$/, "");
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, 20);
}

/** The PersonalItem of an idea: its personal fields (transient - the proposer sees them; the gate denies their ids and
 *  4-token copies) and its links. The private id is the idea's id (hand-back only). */
export function ideaItem(r: IdeaHandbackItem): PersonalItem {
  const fields: Record<string, string> = {};
  if (r.title) fields.title = r.title;
  if (r.summary) fields.summary = r.summary;
  if (r.domain) fields.domain = r.domain;
  return { kind: "idea", id: r.idea_id, revision: r.inlet_revision, owner_sub: r.owner_sub, fields, links: ideaLinks(r.title, r.summary) };
}

/** The verdict as the hand-back records it: hashes and codes (GateRecord), never the text. */
export const verdictJson = (v: BoundaryVerdict) => JSON.stringify({ ...v.record, verdict_id: v.verdict_id });

/** What only the owner sees on a refused idea: the best candidate and its failing tokens - or, when nothing was proposed
 *  (no model, no link), an empty candidate the owner writes from scratch. */
export function reviewOf(v: BoundaryVerdict & { ok: false }): OwnerView {
  return v.owner_view ?? { candidate: "", failing: [], code: v.refusal };
}

export interface DrainOutcome { formed: number; awaiting: number; refused: number; superseded: number }

/** One drain pass over the pending idea hand-backs (bounded). `connect` hands out a client per step. */
export async function drainIdeaHandbacks(
  connect: () => Promise<Q & { release(): void }>, deps: BoundaryDeps, opts: { limit?: number; log?: (l: string) => void } = {},
): Promise<DrainOutcome> {
  const log = opts.log ?? console.log;
  const out: DrainOutcome = { formed: 0, awaiting: 0, refused: 0, superseded: 0 };
  const c0 = await connect();
  let pending: Array<{ id: string }>;
  // autocommit: the SKIP LOCKED row lock ends with the statement - nothing is held while the model runs
  try { pending = (await c0.queryObject<{ id: string }>(`SELECT id::text AS id FROM public.handback_pending('idea-research', $1)`, [opts.limit ?? 5])).rows; }
  finally { c0.release(); }
  for (const p of pending) {
    // the read, then the model with NO connection held, then one short transaction on a fresh one
    const c1 = await connect();
    let row: IdeaHandbackItem | undefined;
    try { row = (await c1.queryObject<IdeaHandbackItem>(`SELECT * FROM public.idea_handback_item($1::uuid)`, [p.id])).rows[0]; }
    finally { c1.release(); }
    if (!row || row.state !== "pending") continue;
    if (row.gone) {
      // an archived / deleted idea is not researched - and its row must not be read again on every pass
      const c2 = await connect();
      try {
        const ok = (await c2.queryObject<{ ok: boolean }>(`SELECT public.idea_handback_settle($1::uuid, $2, NULL, 'refused', '{"refusal":"idea_gone"}'::jsonb, NULL) AS ok`,
          [p.id, row.inlet_revision])).rows[0]?.ok === true;
        if (ok) out.refused++;
      } finally { c2.release(); }
      continue;
    }
    let v: BoundaryVerdict;
    try { v = await formDerivedRequest(ideaItem(row), "idea-research", deps); }
    catch (e) { log(`[boundary-ideas] forming hand-back ${p.id.slice(0, 8)} failed (${(e as Error).name}) - left pending`); continue; }
    const c = await connect();
    try {
      await c.queryObject("BEGIN");
      try {
        let settled: boolean;
        if (v.ok) {
          const job = await insertDerivedJob(c, v.request);
          settled = (await c.queryObject<{ ok: boolean }>(`SELECT public.idea_handback_settle($1::uuid, $2, $3::uuid, 'queued', $4::jsonb, NULL) AS ok`,
            [p.id, row.inlet_revision, job, verdictJson(v)])).rows[0]?.ok === true;
        } else {
          // no owner / nothing at all: refused; anything else waits for its owner (D7: never run off-list text automatically)
          const state = v.refusal === "no_owner" || v.refusal === "empty" ? "refused" : "awaiting_owner";
          settled = (await c.queryObject<{ ok: boolean }>(`SELECT public.idea_handback_settle($1::uuid, $2, NULL, $3, $4::jsonb, $5::jsonb) AS ok`,
            [p.id, row.inlet_revision, state, verdictJson(v), state === "awaiting_owner" ? JSON.stringify(reviewOf(v)) : null])).rows[0]?.ok === true;
          if (settled) state === "awaiting_owner" ? out.awaiting++ : out.refused++;
        }
        if (!settled) { await c.queryObject("ROLLBACK"); out.superseded++; continue; }
        await c.queryObject("COMMIT");
        if (v.ok) out.formed++;
      } catch (e) {
        await c.queryObject("ROLLBACK").catch(() => {});
        const code = (e as { fields?: { code?: string } }).fields?.code;
        // rw-private-report-claims (slot 570): a derived question that carries one of the hand-back OWNER's own private
        // report claims is refused by the database (23514, when the hand-back is given the job; rw-private-report-claims-fix
        // A1: another user's claim is never matched); it is never queued - the hand-back waits for its owner instead of
        // retrying every pass
        if (v.ok && code === "23514") {
          try {
            const ok = (await c.queryObject<{ ok: boolean }>(`SELECT public.idea_handback_settle($1::uuid, $2, NULL, 'awaiting_owner', $3::jsonb, $4::jsonb) AS ok`,
              [p.id, row.inlet_revision, JSON.stringify({ refusal: "private_claim" }), JSON.stringify({ candidate: "", failing: [], code: "private_claim" })])).rows[0]?.ok === true;
            if (ok) { out.awaiting++; continue; }
          } catch { /* left pending; logged below */ }
        }
        // the error's own text may quote a value: its class / code only
        log(`[boundary-ideas] settling hand-back ${p.id.slice(0, 8)} failed (${code ?? (e as Error).name})`);
      }
    } finally { c.release(); }
  }
  return out;
}

export type ApproveOutcome =
  | { status: 202; job_id: string }
  | { status: 200; refused: string; failing: string[] }
  | { status: 404 | 409; error: string };

/** The owner approves (an edited) question for their idea that was waiting for them (D7). The approved question still
 *  passes the identity deny list; accepted, ONE derived job is written and the hand-back moves to queued, in one
 *  transaction. Another user's hand-back answers exactly like one that does not exist (404). */
export async function approveIdeaQuestion(
  c: Q, owner: string, handbackId: string, question: string, deps: Pick<BoundaryDeps, "identity" | "lexicon">,
): Promise<ApproveOutcome> {
  const row = (await c.queryObject<IdeaHandbackItem>(`SELECT * FROM public.idea_handback_item($1::uuid, $2)`, [handbackId, owner])).rows[0];
  if (!row) return { status: 404, error: "no review with this id" };
  if (row.state !== "awaiting_owner") return { status: 409, error: "this review is no longer waiting for you" };
  const v = await formOwnerApprovedRequest(ideaItem(row), question, deps);
  if (!v.ok) return { status: 200, refused: v.refusal, failing: v.owner_view?.failing ?? [] };
  await c.queryObject("BEGIN");
  try {
    const job = await insertDerivedJob(c, v.request);
    const ok = (await c.queryObject<{ ok: boolean }>(`SELECT public.idea_handback_decide($1, $2::uuid, $3::uuid, $4::jsonb) AS ok`,
      [owner, handbackId, job, verdictJson(v)])).rows[0]?.ok === true;
    if (!ok) { await c.queryObject("ROLLBACK"); return { status: 409, error: "this review is no longer waiting for you" }; }
    await c.queryObject("COMMIT");
    return { status: 202, job_id: job };
  } catch (e) {
    await c.queryObject("ROLLBACK").catch(() => {});
    throw e;
  }
}
