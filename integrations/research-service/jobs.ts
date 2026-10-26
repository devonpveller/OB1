/**
 * jobs.ts — research job queue: caller deadlines, cancellation, and the
 * model-down PAUSE (mr-research-failfast, 2026-10-13).
 *
 * Before this, the drain loop claimed strictly FIFO with no notion of a caller.
 * On 2026-10-13 the digest gave up on jobs after 2 h but they kept their place
 * and ran for ~77 minutes each anyway; later submissions queued behind orphans.
 *
 *   * deadline_at (options, ISO-8601 UTC, normalised on submit): a QUEUED job past
 *     it is never claimed - the dispatcher marks it `cancelled` with a reason. A
 *     RUNNING job past it is aborted at its next seam call and ends `cancelled`.
 *   * POST /research/jobs/:id/cancel: queued -> `cancelled` at once; running ->
 *     aborted (in-flight LLM request included) and ends `cancelled`.
 *   * model down: a job whose LLM call hit the down latch is requeued (status
 *     `queued`, progress.phase/code `model_down`) - PAUSED, not failed. The
 *     dispatcher claims nothing while the latch is set and re-checks the model
 *     with a single probe every probeIntervalMs. A job paused more than
 *     maxModelDownRequeues times ends `error` with `model_down: ...`.
 *
 * No schema change: statuses stay inside the existing CHECK
 * (queued|running|done|error|cancelled); the machine-readable reason is
 * progress.code and the `model_down:` / `cancelled:` prefix of `error`.
 */
import type { ModelHealth } from "./llm.ts";
import { BRANCH_RANK_SQL } from "./tree.ts";

export type ClaimedJob = {
  jobId: string; query: string; thread_id: string | null; origin: string; options: Record<string, unknown>;
  /** research-workbench P0 column; P3a's fold runs on a job that carries one. */
  refinery_id?: string | null;
  /** research-workbench P4a: the tree. A root has none of parent / root / step. */
  branch_kind?: string;
  parent_job_id?: string | null;
  root_job_id?: string | null;
  rooted_step_id?: string | null;
  anchor?: string | null;
};

/** The minimal pg client surface used here (deno-postgres PoolClient fits). */
export interface SqlClient {
  queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[]; rowCount?: number }>;
  release(): void;
}

// ── deadline_at ─────────────────────────────────────────────────────────────

/** The only shape ever stored (Date#toISOString). The SQL guards on this exact
 *  regex before casting, so a hand-inserted bad value can never poison claims. */
const ISO_RE_SQL = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";
const DEADLINE_SQL =
  `(CASE WHEN options->>'deadline_at' ~ '${ISO_RE_SQL}' THEN (options->>'deadline_at')::timestamptz END)`;
const EXPIRED_SQL = `coalesce(${DEADLINE_SQL} <= now(), false)`;

export class DeadlineError extends Error {}

/** ISO-8601 date-time WITH an explicit zone (Z or +hh:mm). Numbers are refused
 *  (epoch seconds vs milliseconds is a silent 1000x error), and so is a zone-less
 *  time (whose local time?) and a bare date. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** Parse a caller deadline. undefined/null/"" = no deadline. Anything but an
 *  ISO-8601 date-time with a zone throws DeadlineError (-> HTTP 400). */
export function parseDeadline(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !ISO_WITH_ZONE.test(v.trim())) {
    throw new DeadlineError(
      `deadline_at must be an ISO-8601 date-time with a zone, e.g. 2026-10-13T12:00:00Z (got ${JSON.stringify(v).slice(0, 60)}); numbers are refused`,
    );
  }
  const d = new Date(v.trim());
  if (!Number.isFinite(d.getTime())) throw new DeadlineError(`deadline_at is not a valid time: ${String(v).slice(0, 60)}`);
  return d.toISOString();
}

export function deadlineMs(options: Record<string, unknown> | null | undefined): number | null {
  const v = options?.deadline_at;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// ── SQL (the real statements; exercised against Postgres in failfast.e2e) ──

// research-workbench P4a (D3): a human steer's branch is claimed first, then main lines, then
// system gap work - FIFO within a rank (tree.ts BRANCH_RANK_SQL).
export const CLAIM_SQL =
  `UPDATE research_jobs SET status='running', started_at=now()
   WHERE id = (SELECT id FROM research_jobs WHERE status='queued' AND NOT ${EXPIRED_SQL}
               ORDER BY ${BRANCH_RANK_SQL}, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING id, query, thread_id, origin, options, refinery_id,
             branch_kind, parent_job_id, root_job_id, rooted_step_id, anchor`;

/** Cancel every QUEUED job whose caller deadline has passed. A job that was
 *  paused for model_down says so in its reason - the caller can tell "the model
 *  was down" from "the queue was long". */
export const CANCEL_EXPIRED_SQL =
  `UPDATE research_jobs SET status='cancelled', finished_at=now(),
     error = 'cancelled: caller deadline ' || (options->>'deadline_at') || ' passed before the job ran'
             || CASE WHEN progress->>'code' = 'model_down' THEN ' (paused: model_down)' ELSE '' END,
     progress = jsonb_build_object('phase','cancelled','code','deadline',
                  'model_down', coalesce(progress->>'code','') = 'model_down',
                  'message','cancelled: the caller deadline passed before the job ran')
   WHERE status='queued' AND ${EXPIRED_SQL}
   RETURNING id, options`;

export async function claimNext(c: SqlClient): Promise<ClaimedJob | null> {
  const r = await c.queryObject<{
    id: string; query: string; thread_id: string | null; origin: string; options: Record<string, unknown>; refinery_id?: string | null;
    branch_kind?: string; parent_job_id?: string | null; root_job_id?: string | null; rooted_step_id?: string | null; anchor?: string | null;
  }>(CLAIM_SQL);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    jobId: row.id, query: row.query, thread_id: row.thread_id, origin: row.origin, options: row.options ?? {}, refinery_id: row.refinery_id ?? null,
    branch_kind: row.branch_kind ?? "root", parent_job_id: row.parent_job_id ?? null, root_job_id: row.root_job_id ?? null,
    rooted_step_id: row.rooted_step_id ?? null, anchor: row.anchor ?? null,
  };
}

/**
 * research-workbench P4a round 2: a queued human steer whose parent runs in THIS process. Claimed
 * when the lane has no free slot; the child then runs in its parent's slot (see Dispatcher).
 */
export const CLAIM_STEER_IN_SLOT_SQL =
  `UPDATE research_jobs SET status='running', started_at=now()
   WHERE id = (SELECT id FROM research_jobs
               WHERE status='queued' AND branch_kind='steer' AND parent_job_id = ANY($1::uuid[]) AND NOT ${EXPIRED_SQL}
               ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING id, query, thread_id, origin, options, refinery_id,
             branch_kind, parent_job_id, root_job_id, rooted_step_id, anchor`;

export async function claimSteerInSlot(c: SqlClient, runningIds: string[]): Promise<ClaimedJob | null> {
  if (!runningIds.length) return null;
  const r = await c.queryObject<{
    id: string; query: string; thread_id: string | null; origin: string; options: Record<string, unknown>; refinery_id?: string | null;
    branch_kind?: string; parent_job_id?: string | null; root_job_id?: string | null; rooted_step_id?: string | null; anchor?: string | null;
  }>(CLAIM_STEER_IN_SLOT_SQL, [runningIds]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    jobId: row.id, query: row.query, thread_id: row.thread_id, origin: row.origin, options: row.options ?? {}, refinery_id: row.refinery_id ?? null,
    branch_kind: row.branch_kind ?? "steer", parent_job_id: row.parent_job_id ?? null, root_job_id: row.root_job_id ?? null,
    rooted_step_id: row.rooted_step_id ?? null, anchor: row.anchor ?? null,
  };
}

/**
 * One lane slot's model gate: the jobs sharing a slot make their model calls one at a time, first
 * come first served. A slot held by one job is an uncontended gate (no cost).
 */
export class SlotGate {
  #busy = false;
  #waiters: Array<() => void> = [];
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy) await new Promise<void>((r) => this.#waiters.push(r));
    this.#busy = true;
    try { return await fn(); } finally {
      const next = this.#waiters.shift();
      if (next) next(); else this.#busy = false;
    }
  }
}
interface Slot { gate: SlotGate; members: Set<string> }

export async function cancelExpired(c: SqlClient): Promise<Array<{ id: string; options: Record<string, unknown> }>> {
  const r = await c.queryObject<{ id: string; options: Record<string, unknown> }>(CANCEL_EXPIRED_SQL);
  return r.rows;
}

/** Cancel a QUEUED job (atomic: only if it is still queued). True if it was. */
export async function cancelQueued(c: SqlClient, id: string, reason: string): Promise<boolean> {
  const r = await c.queryObject<{ id: string }>(
    `UPDATE research_jobs SET status='cancelled', finished_at=now(), error=$2,
       progress = jsonb_build_object('phase','cancelled','code','cancel_requested','message',$2::text)
     WHERE id=$1 AND status='queued' RETURNING id`,
    [id, `cancelled: ${reason}`],
  );
  return r.rows.length > 0;
}

export async function jobStatus(c: SqlClient, id: string): Promise<string | null> {
  const r = await c.queryObject<{ status: string }>(`SELECT status FROM research_jobs WHERE id=$1`, [id]);
  return r.rows[0]?.status ?? null;
}

export async function markCancelled(c: SqlClient, id: string, reason: string, code: string): Promise<void> {
  await c.queryObject(
    `UPDATE research_jobs SET status='cancelled', finished_at=now(), error=$2,
       progress = jsonb_build_object('phase','cancelled','code',$3::text,'message',$2::text)
     WHERE id=$1`,
    [id, `cancelled: ${reason}`, code],
  );
}

export type PauseOutcome = "paused" | "error" | "cancelled";

/**
 * A running job hit the model-down latch: requeue it (keeps created_at, so it
 * stays at the head of the FIFO) - unless its caller deadline has passed
 * (`cancelled`) or it has already been paused maxRequeues times (`error`).
 */
export async function pauseForModelDown(
  c: SqlClient, job: ClaimedJob, reason: string, downSinceIso: string | null, maxRequeues: number, nowMs: number,
): Promise<PauseOutcome> {
  const n = (Number(job.options?.model_down_requeues) || 0) + 1;
  const dl = deadlineMs(job.options);
  if (dl !== null && dl <= nowMs) {
    await c.queryObject(
      `UPDATE research_jobs SET status='cancelled', finished_at=now(), error=$2,
         progress = jsonb_build_object('phase','cancelled','code','deadline','model_down',true,'message',$2::text)
       WHERE id=$1`,
      [job.jobId, `cancelled: caller deadline ${job.options.deadline_at} passed while the model was down (${reason})`],
    );
    return "cancelled";
  }
  if (n > maxRequeues) {
    await c.queryObject(
      `UPDATE research_jobs SET status='error', finished_at=now(), error=$2,
         progress = jsonb_build_object('phase','error','code','model_down','message',$2::text)
       WHERE id=$1`,
      [job.jobId, `model_down: ${reason} (paused ${n - 1} time(s); giving up)`],
    );
    return "error";
  }
  await c.queryObject(
    `UPDATE research_jobs SET status='queued', started_at=NULL,
       options = options || jsonb_build_object('model_down_requeues', $2::int),
       progress = jsonb_build_object('phase','model_down','code','model_down',
         'message', 'paused: the model is unreachable; this job re-runs when it is back',
         'reason', $3::text, 'model_down_since', $4::text, 'requeues', $2::int)
     WHERE id=$1`,
    [job.jobId, n, reason, downSinceIso],
  );
  return "paused";
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export class JobCancelled extends Error {
  constructor(readonly reason: string, readonly code: "cancel_requested" | "deadline") {
    super(`cancelled: ${reason}`);
    this.name = "JobCancelled";
  }
}

export interface DispatcherOpts {
  connect(): Promise<SqlClient>;
  /** Runs one claimed job to a terminal (or paused) state. Never re-claims. */
  /** `gate`: the lane slot's model gate - every model call of the job goes through it. */
  execute(job: ClaimedJob, signal: AbortSignal, gate: SlotGate): Promise<void>;
  health: ModelHealth;
  probe(): Promise<boolean>;
  /** A number, or (P4a, D16) a getter read on every tick: the research-branch lane's derived
   *  concurrency, which moves when llm-queue reloads with another LLM_QUEUE_SLOTS. */
  maxConcurrency: number | (() => number);
  probeIntervalMs: number;
  onExpired?(rows: Array<{ id: string; options: Record<string, unknown> }>): void;
  /**
   * P4a round 2 (Case 1 under a full lane): when no lane slot is free, a queued human steer whose
   * parent runs here starts at once IN ITS PARENT'S SLOT - parent and children share that slot's
   * model gate, so the model calls in flight never exceed the slots held (<= the lane), and the
   * child's first model call comes as soon as the call the slot is making returns.
   */
  steersShareParentSlot?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * The sole dispatcher. One tick: cancel expired queued jobs; if the model is
 * down, re-check it (single-flight, at most once per probeIntervalMs) and claim
 * nothing; otherwise fill free slots FIFO. Recovery is therefore never a herd:
 * one probe, then at most maxConcurrency jobs, exactly as in normal running.
 */
export class Dispatcher {
  readonly running = new Map<string, AbortController>();
  #pendingCancel = new Map<string, string>();
  #probing: Promise<void> | null = null;
  #lastProbe = -Infinity;
  #wake: (() => void) | null = null;
  #stopped = false;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(private readonly o: DispatcherOpts) {
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? console.log;
  }

  readonly #slotOf = new Map<string, Slot>();
  readonly #slots = new Set<Slot>();
  /** Lane slots held (a steer's child running in its parent's slot does not take another). */
  get inFlight(): number { return this.#slots.size; }

  /** The current cap (re-read every tick). */
  get maxConcurrency(): number {
    const m = this.o.maxConcurrency;
    return Math.max(1, typeof m === "function" ? m() : m);
  }

  wake(): void { this.#wake?.(); }

  /** Abort a job this process is running (or about to: the claim races the
   *  cancel request, so a not-yet-registered id is remembered). */
  cancelRunning(id: string, reason: string): boolean {
    const ctl = this.running.get(id);
    if (ctl) { ctl.abort(new JobCancelled(reason, "cancel_requested")); return true; }
    this.#pendingCancel.set(id, reason);
    return false;
  }

  async tick(): Promise<void> {
    // 1. Deadlines first, even while the model is down: a paused job whose caller
    //    gave up must end `cancelled`, not wait for the model.
    try {
      const c = await this.o.connect();
      try {
        const rows = await cancelExpired(c);
        if (rows.length) {
          this.#log(`cancelled ${rows.length} queued job(s) past their caller deadline: ${rows.map((r) => r.id.slice(0, 8)).join(", ")}`);
          this.o.onExpired?.(rows);
        }
      } finally { c.release(); }
    } catch (e) { this.#log(`cancelExpired failed: ${(e as Error).message}`); }

    // 2. Model down: probe (bounded, single-flight), claim nothing.
    if (this.o.health.isDown) {
      if (!this.#probing && this.#now() - this.#lastProbe >= this.o.probeIntervalMs) {
        this.#lastProbe = this.#now();
        this.#probing = this.o.probe()
          .then((up) => { if (up) this.#log("[model] probe succeeded - resuming the queue"); })
          .catch((e) => this.#log(`[model] probe error: ${(e as Error).message}`))
          .finally(() => { this.#probing = null; this.wake(); });
      }
      return;
    }

    // 3. Fill free slots.
    while (this.#slots.size < this.maxConcurrency && !this.o.health.isDown) {
      let job: ClaimedJob | null = null;
      try {
        const c = await this.o.connect();
        try { job = await claimNext(c); } finally { c.release(); }
      } catch (e) { this.#log(`claimNext failed: ${(e as Error).message}`); break; }
      if (!job) break;
      this.#start(job);
    }
    // 4. The lane is full: a pending human steer on a job running here runs in its parent's slot.
    while (this.o.steersShareParentSlot && this.#slots.size >= this.maxConcurrency && !this.o.health.isDown) {
      let job: ClaimedJob | null = null;
      try {
        const c = await this.o.connect();
        try { job = await claimSteerInSlot(c, [...this.running.keys()]); } finally { c.release(); }
      } catch (e) { this.#log(`claimSteerInSlot failed: ${(e as Error).message}`); break; }
      if (!job) break;
      const slot = this.#slotOf.get(job.parent_job_id ?? "");
      if (!slot) { this.#log(`[job ${job.jobId}] parent slot vanished; running in a slot of its own`); }
      else this.#log(`[job ${job.jobId}] lane full: steer runs in its parent's slot (${job.parent_job_id})`);
      this.#start(job, slot);
    }
  }

  #start(job: ClaimedJob, shared?: Slot): void {
    const ctl = new AbortController();
    this.running.set(job.jobId, ctl);
    const slot: Slot = shared ?? { gate: new SlotGate(), members: new Set() };
    slot.members.add(job.jobId);
    this.#slots.add(slot);
    this.#slotOf.set(job.jobId, slot);
    const pending = this.#pendingCancel.get(job.jobId);
    if (pending !== undefined) {
      this.#pendingCancel.delete(job.jobId);
      ctl.abort(new JobCancelled(pending, "cancel_requested"));
    }
    // A running job outlives its caller's deadline only until the next seam call.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dl = deadlineMs(job.options);
    if (dl !== null) {
      const ms = Math.max(0, dl - this.#now());
      // setTimeout fires at once past 2^31-1 ms; a deadline that far out needs no timer.
      if (ms <= 2_147_483_647) timer = setTimeout(
        () => ctl.abort(new JobCancelled(`caller deadline ${job.options.deadline_at} passed while running`, "deadline")),
        ms,
      );
    }
    this.o.execute(job, ctl.signal, slot.gate)
      .catch((e) => this.#log(`executeJob failed: ${(e as Error).message}`))
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        this.running.delete(job.jobId);
        this.#slotOf.delete(job.jobId);
        slot.members.delete(job.jobId);
        if (slot.members.size === 0) this.#slots.delete(slot); // a slot is free when its last job ends
        this.wake();
      });
  }

  #waitForWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; this.#wake = null; clearTimeout(t); resolve(); };
      const t = setTimeout(finish, ms);
      this.#wake = finish;
    });
  }

  async run(pollMs = 2000): Promise<void> {
    while (!this.#stopped) {
      await this.tick();
      await this.#waitForWake(pollMs);
    }
  }

  stop(): void { this.#stopped = true; this.wake(); }
}
