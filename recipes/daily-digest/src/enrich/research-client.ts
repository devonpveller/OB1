/**
 * openbrain-research client (S3 → the proper research channel).
 *
 * Instead of an ad-hoc local synthesis, each newsletter article is submitted to
 * the shared research harness (`openbrain-research`) in **article mode**:
 *   - the article is the SEED source (already fetched through Tor by S3),
 *   - web search is DISABLED — corroboration comes ONLY from OB's existing
 *     grounded claims (the harness reuse pass), not the open web,
 *   - the harness writes grounded claims + resolves the thread via the curator.
 *
 * Research is ASYNC (submit → poll → terminal). The wait-gate here is the
 * "research complete" condition that MUST hold before any of these claims feed
 * the podcast: we never read a job's result until its status is `done`.
 *
 * Contract (OB1/integrations/research-service/index.ts):
 *   POST /research                -> { job_id, status }      (x-brain-key)
 *   GET  /research/jobs/:id        -> { id, status, result } (x-brain-key)
 *   POST /research/jobs/:id/cancel -> { status }             (x-brain-key)
 *   terminal status ∈ { done, error, cancelled }
 *
 * Model-down signal (mr-research-failfast): when the engine's model is
 * unreachable a job is PAUSED, not failed - it stays `queued` with
 * `progress.code === "model_down"`, and every job read carries
 * `model: { state: "down", since, reason }`. A job that ended because of it reads
 * `status: "error"` with `progress.code === "model_down"` (error starts
 * `model_down:`), or `status: "cancelled"` with `progress.model_down === true`
 * when its deadline passed while paused. Use `isModelDown(job)`.
 */

export interface ResearchSeed { url: string; title: string; content: string }

export interface SubmitArgs {
  /** Free-text query — the article's title/topic (drives recall + thread hint). */
  query: string;
  /**
   * Pre-fetched seed sources. Article mode requires them (the article IS the
   * seed). A gap dive OMITS them: topic mode gathers from the open web, so the
   * research question in `query` is the whole input. Optional for that reason.
   */
  seedSources?: ResearchSeed[];
  /** article-primary synthesis prompt. Omit for a full topic (gap-dive) run. */
  mode?: "article";
  /** seed-only: no web search at all; corroborate from OB claims only. */
  disableWebSearch?: boolean;
  /** "preliminary" → bounded tentative web research on the article's open gaps. */
  gapResearch?: "none" | "preliminary";
  /** run synthesis but write NOTHING canonical (preview). */
  dryRun?: boolean;
  /**
   * The caller's deadline. The engine never STARTS a job still queued past it
   * (the job ends `cancelled`) and aborts one still running at it. Set it to
   * the moment this caller stops waiting.
   */
  deadlineAt?: Date | string | number;
  origin?: string; // "owui" | "agent" | "notebook" | "manual"
  threadId?: string;
}

export interface CuratorEcho {
  thread_id?: string;
  thread_decision?: "explicit" | "existing" | "new";
  thread_name?: string;
  /** delegate echo from /research/persist — source_ids for gmail-metadata stamping. */
  persist?: { source_ids?: Array<string | null>; sources_written?: number } | null;
  claims?: { claimsWritten?: number; claimsDeduped?: number; ungroundedSkipped?: number } | null;
}

export interface ResearchResult {
  synthesis?: string;
  needs?: string[];
  gaps?: string[];
  cited_sources?: Array<{ url: string | null; title: string }>;
  reuse_claims?: Array<{ id: string; text: string }>;
  thread_id?: string;
  reuse_ratio?: number;
  backstop?: string;
  curator?: CuratorEcho | null;
}

export interface ModelState {
  state: "up" | "down";
  since?: string | null;
  reason?: string | null;
  last_check?: string | null;
}

export interface JobRecord {
  id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  /** code: "model_down" (paused, or failed because of it) | "deadline" |
   *  "cancel_requested". model_down: true on a cancel that happened while paused. */
  progress?: { phase?: string; message?: string; code?: string; model_down?: boolean; model_down_since?: string };
  /** The engine's process-wide model latch at the time of this read. */
  model?: ModelState;
  result?: ResearchResult | null;
  metrics?: { claims_reused?: number; claims_freshly_gathered?: number; gap_ratio?: number } | null;
  error?: string | null;
}

const TERMINAL = new Set(["done", "error", "cancelled"]);

/** The engine accepts ISO-8601 with a zone only. A number is read as epoch
 *  MILLISECONDS; one that only makes sense as SECONDS (before 2001-09-09 as ms)
 *  is refused rather than silently becoming a 1970 deadline. */
function deadlineIso(v: Date | string | number): string {
  if (typeof v === "number" && v < 1e12) {
    throw new Error(`deadlineAt ${v} looks like epoch SECONDS; pass milliseconds, a Date, or an ISO string`);
  }
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw new Error(`deadlineAt is not a valid time: ${String(v).slice(0, 60)}`);
  return d.toISOString();
}

/**
 * THE model-down predicate for callers (mr-routine-outage builds on this): true
 * when the job is paused or ended because the engine's model is unreachable, or
 * the engine reports its model down right now.
 */
export function isModelDown(job: Pick<JobRecord, "progress" | "model" | "error"> | null | undefined): boolean {
  if (!job) return false;
  return job.progress?.code === "model_down" || job.progress?.model_down === true ||
    job.model?.state === "down" || /^model_down:/.test(job.error ?? "");
}

/**
 * Thrown by waitForDone when the caller's own deadline passes. `cancelled` says
 * whether the engine confirmed the job will not run (or is being stopped);
 * `modelDown` whether the last read showed the model-down signal - so the caller
 * can say "the model was down" instead of "research timed out".
 */
export class ResearchDeadlineError extends Error {
  constructor(
    readonly jobId: string,
    readonly lastStatus: string,
    readonly modelDown: boolean,
    readonly cancelled: boolean,
  ) {
    super(
      `research job ${jobId} did not complete within deadline (last status: ${lastStatus}` +
        `${modelDown ? ", model_down" : ""}; ${cancelled ? "cancelled" : "NOT cancelled - it may still run"})`,
    );
    this.name = "ResearchDeadlineError";
  }
}

export interface ResearchClientOptions {
  baseUrl: string; // e.g. http://openbrain-research:8000
  brainKey: string; // MCP_ACCESS_KEY
  timeoutMs?: number;
}

export class ResearchClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: ResearchClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
  }

  /** Submit a research job. Returns the job id. */
  async submit(args: SubmitArgs): Promise<string> {
    const res = await fetch(`${this.baseUrl}/research`, {
      method: "POST",
      headers: { "x-brain-key": this.opts.brainKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: args.query,
        seed_sources: args.seedSources,
        mode: args.mode,
        disable_web_search: args.disableWebSearch,
        gap_research: args.gapResearch,
        dry_run: args.dryRun,
        origin: args.origin ?? "notebook",
        thread_id: args.threadId,
        deadline_at: args.deadlineAt === undefined ? undefined : deadlineIso(args.deadlineAt),
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      throw new Error(`research submit failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    const d = await res.json() as { job_id?: string };
    if (!d.job_id) throw new Error("research submit: no job_id in response");
    return d.job_id;
  }

  /**
   * Cancel a job. A queued job ends `cancelled` at once; a running one is
   * aborted. Returns the engine's answer: "cancelled" | "cancelling" | "filing"
   * (the curator is already filing it - it will end with its real outcome) | the
   * terminal status it already had. Bounded by timeoutMs; throws on failure.
   */
  async cancel(jobId: string, reason = "caller gave up"): Promise<string> {
    const res = await fetch(`${this.baseUrl}/research/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      headers: { "x-brain-key": this.opts.brainKey, "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (res.status === 409) {
      const d = await res.json().catch(() => ({})) as { filing?: boolean };
      if (d.filing) return "filing";
    }
    if (!res.ok) throw new Error(`research cancel failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const d = await res.json() as { status?: string };
    return d.status ?? "unknown";
  }

  /** One poll. */
  async poll(jobId: string): Promise<JobRecord> {
    const res = await fetch(
      `${this.baseUrl}/research/jobs/${encodeURIComponent(jobId)}`,
      { headers: { "x-brain-key": this.opts.brainKey }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) },
    );
    if (!res.ok) throw new Error(`research poll failed: ${res.status}`);
    return await res.json() as JobRecord;
  }

  /**
   * THE WAIT-GATE. Poll until the job reaches a terminal state (done/error/
   * cancelled) or the bounded deadline elapses. The job's result is NEVER read
   * before `done`. A timeout throws ResearchDeadlineError (caller marks the link
   * email-only) — we do not let a half-finished research feed the podcast.
   *
   * cancelOnTimeout (default true): at the deadline the job is CANCELLED, so it
   * never runs for a caller that is no longer waiting (2026-10-13: abandoned
   * jobs kept their FIFO place and ran ~77 min each). Pass false only for a
   * job someone will come back for (gap dives carry their job ids over).
   *
   * Truthful outcome (round 2): the error's `cancelled` is true ONLY when the
   * engine confirms the job ended `cancelled`. A running job being aborted is
   * awaited for cancelSettleMs; a job already FILING (the engine refuses to
   * cancel it) is awaited for filingGraceMs, and its real terminal record is
   * RETURNED - a filed result is never thrown away as "timed out".
   */
  async waitForDone(
    jobId: string,
    opts: { timeoutMs?: number; intervalMs?: number; cancelOnTimeout?: boolean; cancelSettleMs?: number; filingGraceMs?: number } = {},
  ): Promise<JobRecord> {
    const deadline = Date.now() + (opts.timeoutMs ?? 240_000); // > harness 180s wall
    const interval = opts.intervalMs ?? 3_000;
    let last: JobRecord | null = null;
    while (Date.now() < deadline) {
      last = await this.poll(jobId);
      if (TERMINAL.has(last.status)) return last;
      // Never sleep past the deadline: the wait is bounded by timeoutMs, not by
      // timeoutMs + one interval.
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(interval, deadline - Date.now()))));
    }
    let cancelled = false;
    if (opts.cancelOnTimeout !== false) {
      try {
        const st = await this.cancel(jobId, "caller deadline passed (waitForDone)");
        if (st === "cancelled") {
          cancelled = true;
        } else {
          // "cancelling": the abort is prompt, confirm it. "filing": the curator
          // is storing it, wait for the real outcome (curator timeout is 180 s).
          // A terminal answer: it finished in the gap - read it.
          const settle = st === "filing" ? (opts.filingGraceMs ?? 240_000) : st === "cancelling" ? (opts.cancelSettleMs ?? 30_000) : 0;
          const until = Date.now() + settle;
          for (;;) {
            const fin = await this.poll(jobId).catch(() => null);
            if (fin) last = fin;
            if (fin && TERMINAL.has(fin.status)) {
              if (fin.status === "cancelled") { cancelled = true; break; }
              return fin; // done or error: the real record, never discarded
            }
            if (Date.now() >= until) break;
            await new Promise((r) => setTimeout(r, Math.max(0, Math.min(interval, until - Date.now()))));
          }
        }
      } catch (err) {
        console.warn(`[research] cancel of ${jobId} at deadline failed: ${err}`);
      }
    }
    throw new ResearchDeadlineError(jobId, last?.status ?? "unknown", isModelDown(last), cancelled);
  }
}

/**
 * Wait on many jobs concurrently, each independently. Resolves to a map of
 * jobId → settled outcome (never rejects). The caller proceeds to the podcast
 * ONLY after this resolves — i.e. every research effort has reached a terminal
 * state (the operator's paramount "research complete" gate).
 */
export async function waitForAll(
  client: ResearchClient,
  jobIds: string[],
  opts: { timeoutMs?: number; intervalMs?: number; cancelOnTimeout?: boolean } = {},
): Promise<Map<string, { ok: true; job: JobRecord } | { ok: false; error: string }>> {
  const out = new Map<string, { ok: true; job: JobRecord } | { ok: false; error: string }>();
  await Promise.all(jobIds.map(async (id) => {
    try {
      const job = await client.waitForDone(id, opts);
      out.set(id, job.status === "done" ? { ok: true, job } : { ok: false, error: `status=${job.status}: ${job.error ?? ""}` });
    } catch (err) {
      out.set(id, { ok: false, error: String(err) });
    }
  }));
  return out;
}
