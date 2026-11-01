// The intake and queue panel's reads and writes (research-workbench P5a, rw-p5a-intake).
//
// Five queues, one job shape (the contract's Job: kind, id, status, state, created_at, updated_at,
// detail), each a state machine with ONE primary action:
//   import   import_jobs mode 'import' (the P5 import / grounding route)
//   add      import_jobs mode 'add'    (a user add: fetched by the research service, held in a refinery)
//   chunk    sources waiting for the chunk worker (md5(content) vs metadata.chunked_hash), or stamped with
//            a chunk_error / chunk_cancelled
//   extract  source_extraction_queue  (the entity worker, sources)
//   entity   entity_extraction_queue  (the entity worker, thoughts)
// detail.phase is the state, detail.actions what the panel may do now (retry, cancel), detail.primary
// the one action the panel shows first: cancel while it waits or runs, retry once it failed or was
// cancelled, open once it ended well.
//
// WHOSE (07-MULTI-USER; owner scope through the identity seam, never a caller-supplied user): an import
// or add belongs to the subject that made it (import_jobs.owner_sub); a job made before rw-p5a-intake
// (owner_sub NULL) belongs to WORKSPACE_DEFAULT_SUB (documents/ownership.ts ownerlessOwner; with sign-in
// and no default, an admin who is not impersonating reads them - the seam audits those reads). A chunk or
// extract row is its source's: the subject whose import made that source; a source no import made (and
// every thought, for the entity queue) is ownerless, read under the same rule. Another subject's job is
// never listed, and by id it is not found (404) - so its retry and cancel are refused too.
import type { Db } from "../contracts/db.ts";
import { adminSeesOwnerless, ownerlessOwner } from "../documents/ownership.ts";

export const INTAKE_KINDS = ["import", "add", "chunk", "extract", "entity"] as const;
export type IntakeKind = typeof INTAKE_KINDS[number];
export const isIntakeKind = (k: string): k is IntakeKind => (INTAKE_KINDS as readonly string[]).includes(k);

export interface Who {
  sub: string;
  admin?: boolean;
  impersonating?: unknown;
}

export interface IntakeJob {
  kind: IntakeKind;
  id: string;
  status: string;
  state: "loading" | "current";
  created_at: string;
  updated_at: string;
  detail: Record<string, unknown>;
}

// ── the state machines ────────────────────────────────────────────────────────────────────────
const ACTIVE_IMPORT = new Set(["queued", "fetching", "extracting", "embedding", "linking", "holding"]);
// cancel stops a job before it writes; once it is holding (the one transaction that holds the source)
// or embedding/linking (the import's transaction) it finishes or fails on its own
const CANCELLABLE_IMPORT = new Set(["queued", "fetching", "extracting"]);

export function actionsOf(kind: IntakeKind, status: string): { actions: ("retry" | "cancel")[]; primary: "retry" | "cancel" | "open" | "wait" } {
  if (kind === "import" || kind === "add") {
    if (CANCELLABLE_IMPORT.has(status)) return { actions: ["cancel"], primary: "cancel" };
    if (ACTIVE_IMPORT.has(status)) return { actions: [], primary: "wait" };
    if (status === "failed" || status === "cancelled") return { actions: ["retry"], primary: "retry" };
    return { actions: [], primary: "open" }; // done / held
  }
  if (status === "pending") return { actions: ["cancel"], primary: "cancel" };
  if (status === "processing") return { actions: [], primary: "wait" };
  if (status === "failed" || status === "cancelled" || status === "skipped") return { actions: ["retry"], primary: "retry" };
  return { actions: [], primary: "open" };
}

const isActive = (kind: IntakeKind, status: string) =>
  kind === "import" || kind === "add" ? ACTIVE_IMPORT.has(status) : status === "pending" || status === "processing";

function shape(kind: IntakeKind, r: { id: string; status: string; created_at: string; updated_at: string; detail: Record<string, unknown> }): IntakeJob {
  const a = actionsOf(kind, r.status);
  return {
    kind, id: r.id, status: r.status, state: isActive(kind, r.status) ? "loading" : "current",
    created_at: r.created_at, updated_at: r.updated_at,
    detail: { ...r.detail, phase: r.status, actions: a.actions, primary: a.primary },
  };
}

// ── whose ─────────────────────────────────────────────────────────────────────────────────────
// may this subject read jobs with no recorded owner (made before rw-p5a-intake, or no import made them)?
export function seesOwnerless(who: Who): boolean {
  const o = ownerlessOwner();
  return o === null ? adminSeesOwnerless(who) : who.sub === o;
}
// SQL: import job `j` is the subject's ($sub, $own = seesOwnerless)
const MINE = (j: string, sub: string, own: string) => `(${j}.owner_sub = ${sub} OR (${j}.owner_sub IS NULL AND ${own}::boolean))`;
// SQL: source `s` (an id expression) is the subject's: an import of theirs made it, or no import did
const SOURCE_MINE = (s: string, sub: string, own: string) =>
  `(EXISTS (SELECT 1 FROM public.import_jobs own_j WHERE own_j.source_id = ${s} AND ${MINE("own_j", sub, own)})
    OR (${own}::boolean AND NOT EXISTS (SELECT 1 FROM public.import_jobs own_j WHERE own_j.source_id = ${s})))`;

type Row = { id: string; status: string; created_at: string; updated_at: string; detail: Record<string, unknown> };

// ── the reads ─────────────────────────────────────────────────────────────────────────────────
const IMPORT_DETAIL = `jsonb_build_object('mode', j.mode, 'origin', j.origin, 'source_id', j.source_id, 'target_notebook', j.target_notebook,
  'error', j.error, 'staged', j.staged, 'committed', j.committed, 'duplicate', j.duplicate, 'url', j.url, 'filename', j.filename,
  'content_type', j.content_type, 'refinery_id', j.refinery_id, 'doc_path', j.doc_path, 'held_source_id', j.held_source_id,
  'attempts', j.attempts)`;

export async function importRows(db: Db, who: Who, mode: "import" | "add", state: string | null, limit: number, id: string | null = null): Promise<IntakeJob[]> {
  const rows = await db.query<Row>(
    `SELECT j.id::text AS id, j.status, j.created_at, j.updated_at, ${IMPORT_DETAIL} AS detail
       FROM public.import_jobs j
      WHERE j.mode = $1 AND ${MINE("j", "$2", "$3")} AND ($4::text IS NULL OR j.status = $4)
        AND ($6::text IS NULL OR j.id::text = $6)
      ORDER BY j.created_at DESC LIMIT $5`,
    [mode, who.sub, seesOwnerless(who), state, limit, id],
  );
  return rows.map((r) => shape(mode, r));
}

// a source the chunk worker has not chunked since its content last changed (the worker's own scan),
// or one it stamped with an error, or one cancelled here
const CHUNK_ELIGIBLE = `COALESCE(s.content, '') <> '' AND s.content_type <> 'research_synthesis' AND s.retraction_committed_at IS NULL
  AND NOT COALESCE((s.metadata->>'deleted')::boolean, false)`;
const CHUNK_STATUS = `CASE WHEN md5(s.content) IS DISTINCT FROM (s.metadata->>'chunked_hash') THEN 'pending'
  WHEN COALESCE((s.metadata->>'chunk_cancelled')::boolean, false) THEN 'cancelled'
  WHEN s.metadata ? 'chunk_error' THEN 'failed' ELSE 'done' END`;

export async function chunkRows(db: Db, who: Who, state: string | null, limit: number, id: string | null = null): Promise<IntakeJob[]> {
  const rows = await db.query<Row>(
    `SELECT * FROM (
       SELECT s.id::text AS id, ${CHUNK_STATUS} AS status, s.created_at, s.updated_at,
              jsonb_build_object('source_id', s.id, 'title', COALESCE(s.title, ''), 'error', s.metadata->>'chunk_error') AS detail
         FROM public.sources s
        WHERE ${CHUNK_ELIGIBLE} AND ($4::text IS NULL OR s.id::text = $4) AND ${SOURCE_MINE("s.id", "$1", "$2")}
     ) q WHERE q.status <> 'done' AND ($3::text IS NULL OR q.status = $3)
     ORDER BY q.updated_at DESC LIMIT $5`,
    [who.sub, seesOwnerless(who), state, id, limit],
  );
  return rows.map((r) => shape("chunk", r));
}

export async function extractRows(db: Db, who: Who, state: string | null, limit: number, id: string | null = null): Promise<IntakeJob[]> {
  const rows = await db.query<Row>(
    `SELECT q.source_id::text AS id, q.status, q.queued_at AS created_at, COALESCE(q.processed_at, q.started_at, q.queued_at) AS updated_at,
            jsonb_build_object('source_id', q.source_id, 'title', COALESCE(s.title, ''), 'attempts', q.attempt_count, 'error', q.last_error) AS detail
       FROM public.source_extraction_queue q JOIN public.sources s ON s.id = q.source_id
      WHERE q.status NOT IN ('complete') AND ($3::text IS NULL OR q.status = $3) AND ($4::text IS NULL OR q.source_id::text = $4)
        AND ${SOURCE_MINE("q.source_id", "$1", "$2")}
      ORDER BY q.queued_at DESC LIMIT $5`,
    [who.sub, seesOwnerless(who), state, id, limit],
  );
  return rows.map((r) => shape("extract", r));
}

export async function entityRows(db: Db, who: Who, state: string | null, limit: number, id: string | null = null): Promise<IntakeJob[]> {
  // a thought is no user's front-end history: the ownerless rule decides who reads the queue
  if (!seesOwnerless(who)) return [];
  const rows = await db.query<Row>(
    `SELECT q.thought_id::text AS id, q.status, q.queued_at AS created_at, COALESCE(q.processed_at, q.started_at, q.queued_at) AS updated_at,
            jsonb_build_object('thought_id', q.thought_id, 'attempts', q.attempt_count, 'error', q.last_error) AS detail
       FROM public.entity_extraction_queue q
      WHERE q.status NOT IN ('complete') AND ($1::text IS NULL OR q.status = $1) AND ($2::text IS NULL OR q.thought_id::text = $2)
      ORDER BY q.queued_at DESC LIMIT $3`,
    [state, id, limit],
  );
  return rows.map((r) => shape("entity", r));
}

export async function listJobs(db: Db, who: Who, kinds: string[], state: string | null, limit: number): Promise<{ jobs: IntakeJob[] }> {
  const want = (k: IntakeKind) => kinds.length === 0 || kinds.includes(k);
  const out: IntakeJob[] = [];
  if (want("import")) out.push(...await importRows(db, who, "import", state, limit));
  if (want("add")) out.push(...await importRows(db, who, "add", state, limit));
  if (want("chunk")) out.push(...await chunkRows(db, who, state, limit));
  if (want("extract")) out.push(...await extractRows(db, who, state, limit));
  if (want("entity")) out.push(...await entityRows(db, who, state, limit));
  out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return { jobs: out };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validId(kind: IntakeKind, id: string): boolean {
  return kind === "entity" ? /^[0-9]{1,18}$/.test(id) : UUID.test(id);
}

export async function getJob(db: Db, who: Who, kind: IntakeKind, id: string): Promise<IntakeJob | null> {
  if (!validId(kind, id)) return null;
  const rows = kind === "import" || kind === "add" ? await importRows(db, who, kind, null, 1, id.toLowerCase())
    : kind === "chunk" ? await chunkRows(db, who, null, 1, id.toLowerCase())
    : kind === "extract" ? await extractRows(db, who, null, 1, id.toLowerCase())
    : await entityRows(db, who, null, 1, id);
  return rows[0] ?? null;
}

// ── the writes (the caller checked the job is the subject's: getJob first) ───────────────────
export class ActionRefused extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ActionRefused";
  }
}

// cancel: only a job whose phase offers it; the write is conditional on that phase, so a job that moved
// on meanwhile is not touched (409)
export async function cancel(db: Db, job: IntakeJob): Promise<IntakeJob["status"]> {
  if (!actionsOf(job.kind, job.status).actions.includes("cancel")) throw new ActionRefused(`a ${job.status} ${job.kind} job cannot be cancelled`);
  let n: unknown[] = [];
  if (job.kind === "import" || job.kind === "add") {
    n = await db.query(`UPDATE public.import_jobs SET status = 'cancelled', error = 'cancelled by the user' WHERE id = $1 AND status = ANY($2) RETURNING id`,
      [job.id, [...CANCELLABLE_IMPORT]]);
  } else if (job.kind === "chunk") {
    n = await db.query(
      `UPDATE public.sources SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('chunked_hash', md5(content), 'chunk_cancelled', true)
        WHERE id = $1 AND md5(content) IS DISTINCT FROM (metadata->>'chunked_hash') RETURNING id`, [job.id]);
  } else {
    const t = job.kind === "extract" ? "source_extraction_queue" : "entity_extraction_queue";
    const col = job.kind === "extract" ? "source_id::text" : "thought_id::text";
    n = await db.query(`UPDATE public.${t} SET status = 'cancelled', processed_at = now() WHERE ${col} = $1 AND status = 'pending' RETURNING status`, [job.id]);
  }
  if (!n.length) throw new ActionRefused("the job moved on before it could be cancelled");
  return "cancelled";
}

// retry: only a failed / cancelled (/ skipped) job; it goes back to the start of its queue
export async function retryQueue(db: Db, job: IntakeJob): Promise<string> {
  if (!actionsOf(job.kind, job.status).actions.includes("retry")) throw new ActionRefused(`a ${job.status} ${job.kind} job cannot be retried`);
  let n: unknown[] = [];
  if (job.kind === "chunk") {
    n = await db.query(
      `UPDATE public.sources SET metadata = metadata - 'chunked_hash' - 'chunk_error' - 'chunk_cancelled'
        WHERE id = $1 AND md5(content) IS NOT DISTINCT FROM (metadata->>'chunked_hash') RETURNING id`, [job.id]);
  } else if (job.kind === "extract" || job.kind === "entity") {
    const t = job.kind === "extract" ? "source_extraction_queue" : "entity_extraction_queue";
    const col = job.kind === "extract" ? "source_id::text" : "thought_id::text";
    n = await db.query(
      `UPDATE public.${t} SET status = 'pending', attempt_count = 0, last_error = NULL, started_at = NULL, processed_at = NULL, worker_version = NULL
        WHERE ${col} = $1 AND status IN ('failed', 'cancelled', 'skipped') RETURNING status`, [job.id]);
  } else {
    throw new Error("import / add retries run their pipeline (pipeline.ts)");
  }
  if (!n.length) throw new ActionRefused("the job moved on before it could be retried");
  return "pending";
}
