// Running sessions (research-workbench P4b): the SQL half. Every read is decided for the request's
// subject (subject_sub) where it is read - FOREIGN_JOB (documents/ownership.ts) - so a card, a stream
// event and a flow row of another user's job never carry its original prompt, its inlet, its branch
// texts, its step ids or its per-source events (07-MULTI-USER; rw-identity round 4-5 allow-list).
// The owner's subject is read to decide who may act and never leaves this module.
import type { Db } from "../contracts/db.ts";
import { adminSeesOwnerless, FOREIGN_JOB, ownerlessOwner, type Viewer } from "../documents/ownership.ts";
import { identityConfig } from "../middleware/identity.ts";
import { adminOf, type BranchRow, cardOf, type Card, type EventRow, type InletRef, isOpen, mayActOn } from "./cards.ts";

export interface Who extends Viewer {
  actor?: string;
  admin?: boolean;
  impersonating?: unknown;
}

interface JobRow {
  id: string;
  root_id: string;
  status: string;
  origin: string;
  caller: string | null;
  inlet_ref: InletRef | null;
  refinery_id: string | null;
  query: string;
  phase: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  queue_position: number | null;
  idea_inlet: boolean;
  foreign_: boolean;
  owner_sub: string | null;
}

export function isAdmin(who: Who): boolean {
  return adminOf(who, identityConfig());
}

async function job(db: Db, id: string, who: Who): Promise<JobRow | null> {
  const rows = await db.query<JobRow>(
    `SELECT j.id::text, coalesce(j.root_job_id, j.id)::text AS root_id, j.status, j.origin, j.caller,
            CASE WHEN o.others THEN NULL ELSE j.inlet_ref END AS inlet_ref,
            CASE WHEN o.others THEN NULL ELSE j.refinery_id::text END AS refinery_id,
            CASE WHEN o.others THEN '' ELSE j.query END AS query,
            j.progress ->> 'phase' AS phase, j.created_at, j.started_at, j.finished_at,
            coalesce(j.inlet_ref ->> 'kind' = 'idea', false) AS idea_inlet,
            CASE WHEN j.status = 'queued' THEN (SELECT count(*) + 1 FROM public.research_jobs q
                                                 WHERE q.status = 'queued' AND q.created_at < j.created_at)::int END AS queue_position,
            o.others AS foreign_,
            (SELECT p.owner_sub FROM public.research_prompts p WHERE p.job_id = coalesce(j.root_job_id, j.id)) AS owner_sub
       FROM public.research_jobs j
       CROSS JOIN LATERAL (SELECT ${FOREIGN_JOB("j", "$2", "$3", adminSeesOwnerless(who))} AS others) o
      WHERE j.id = $1`,
    [id, who.sub, who.key],
  );
  return rows[0] ?? null;
}

async function branches(db: Db, rootId: string): Promise<BranchRow[]> {
  return await db.query<BranchRow>(
    `SELECT id::text, parent_job_id::text, branch_kind, rooted_step_id, status, query, created_at
       FROM public.research_jobs WHERE coalesce(root_job_id, id) = $1::uuid ORDER BY created_at, id LIMIT 500`,
    [rootId],
  );
}

// The tree's events after `after` (oldest first). Another user's tree: its stage events only, each
// reduced to its phase and marker - no step id, no message, no trail, no source, no steer text.
export async function events(db: Db, rootId: string, foreign: boolean, after = 0, limit = 500): Promise<EventRow[]> {
  const rows = await db.query<EventRow>(
    `SELECT id, job_id::text, step_id, type, kind, payload, trail, created_at
       FROM public.research_job_events
      WHERE root_job_id = $1::uuid AND id > $2 AND ($3::boolean = false OR type = 'stage')
      ORDER BY id LIMIT $4`,
    [rootId, after, foreign, limit],
  );
  return rows.map((e) => ({
    ...e,
    id: Number(e.id),
    ...(foreign ? { step_id: null, trail: null, payload: { phase: e.payload?.phase ?? null } } : {}),
  }));
}

// The last `n` events of the tree plus the job's latest steering stage (where an interjection lands).
async function recentEvents(db: Db, jobId: string, rootId: string, foreign: boolean): Promise<EventRow[]> {
  const last = await db.query<{ id: number }>(
    `SELECT coalesce(max(id), 0) AS id FROM public.research_job_events WHERE root_job_id = $1::uuid`, [rootId]);
  const from = Math.max(0, Number(last[0]?.id ?? 0) - 200);
  const tail = await events(db, rootId, foreign, from, 200);
  const steering = await db.query<EventRow>(
    `SELECT id, job_id::text, step_id, type, kind, payload, trail, created_at FROM public.research_job_events
      WHERE job_id = $1::uuid AND type = 'stage' AND kind = 'steering' ORDER BY id DESC LIMIT 1`, [jobId]);
  const s = steering.map((e) => ({ ...e, id: Number(e.id), ...(foreign ? { step_id: null, trail: null, payload: { phase: e.payload?.phase ?? null } } : {}) }));
  const ids = new Set(tail.map((e) => e.id));
  return [...s.filter((e) => !ids.has(e.id)), ...tail].sort((a, b) => Number(a.id) - Number(b.id));
}

export interface Loaded {
  card: Card;
  rootId: string;
  foreign: boolean;
}

// One job's card, as `who` may see it; null = no such job.
export async function card(db: Db, id: string, who: Who, owui: string): Promise<Loaded | null> {
  const j = await job(db, id, who);
  if (!j) return null;
  const canAct = mayActOn(j.owner_sub, who, ownerlessOwner(), isAdmin(who));
  const tree = await branches(db, j.root_id);
  const ev = await recentEvents(db, j.id, j.root_id, j.foreign_);
  const c = cardOf({
    id: j.id, status: j.status, origin: j.origin, caller: j.caller, inlet_ref: j.inlet_ref, refinery_id: j.refinery_id,
    query: j.query, progress: { phase: j.phase ?? j.status }, created_at: j.created_at, started_at: j.started_at,
    finished_at: j.finished_at, queue_position: j.queue_position, foreign: j.foreign_, idea_inlet: j.idea_inlet,
    can_act: canAct, branches: tree, events: ev,
  }, owui);
  return { card: c, rootId: j.root_id, foreign: j.foreign_ };
}

// sessions(state): the root sessions that are running (queued or running, or with an open branch) -
// with state=recent also those finished in the last day - newest first, one card each.
export async function sessions(db: Db, state: string, limit: number, who: Who, owui: string): Promise<{ sessions: Card[] }> {
  const ids = await db.query<{ id: string }>(
    `SELECT j.id::text FROM public.research_jobs j
      WHERE j.parent_job_id IS NULL
        AND (j.status IN ('queued', 'running')
             OR EXISTS (SELECT 1 FROM public.research_jobs c WHERE c.root_job_id = j.id AND c.status IN ('queued', 'running'))
             OR ($1 = 'recent' AND j.finished_at > now() - interval '1 day'))
      ORDER BY j.created_at DESC, j.id LIMIT $2`,
    [state, limit],
  );
  const out: Card[] = [];
  for (const { id } of ids) {
    const l = await card(db, id, who, owui);
    if (l) out.push(l.card);
  }
  return { sessions: out };
}

// The research flow: every source the tree met, in order, each with its stages (the trail entries the
// pre-ingestion stage recorded for it) - another user's tree withholds them (the round-4 allow-list).
export async function flow(db: Db, id: string, who: Who) {
  const j = await job(db, id, who);
  if (!j) return null;
  const tree = await branches(db, j.root_id);
  const running = tree.some((b) => isOpen(b.status));
  if (j.foreign_) return { session_id: j.id, running, withheld: true, sources: [] };
  const ev = (await events(db, j.root_id, false, 0, 2000)).filter((e) => e.type === "source");
  const byUrl = new Map<string, { url: string; job_id: string; stages: { kind: string; at: string; trail: Record<string, unknown> }[] }>();
  for (const e of ev) {
    const url = String(e.payload?.url ?? e.trail?.url ?? "");
    if (!url || !e.trail) continue;
    const row = byUrl.get(url) ?? { url, job_id: e.job_id, stages: [] };
    row.stages.push({ kind: String(e.trail.kind ?? e.payload?.outcome ?? ""), at: new Date(e.created_at).toISOString(), trail: e.trail });
    byUrl.set(url, row);
  }
  return { session_id: j.id, running, withheld: false, sources: [...byUrl.values()] };
}

// Is `stepId` a steering stage of job `id`? (the card offers a steer only there; P4a STAGE_KINDS)
export async function stepKind(db: Db, id: string, stepId: string): Promise<string | null> {
  const r = await db.query<{ kind: string }>(
    `SELECT kind FROM public.research_job_events WHERE job_id = $1::uuid AND step_id = $2 AND type = 'stage' ORDER BY id DESC LIMIT 1`,
    [id, stepId],
  );
  return r[0]?.kind ?? null;
}
