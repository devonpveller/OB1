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
 *   terminal status ∈ { done, error, cancelled }
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

export interface JobRecord {
  id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress?: { phase?: string; message?: string };
  result?: ResearchResult | null;
  metrics?: { claims_reused?: number; claims_freshly_gathered?: number; gap_ratio?: number } | null;
  error?: string | null;
}

const TERMINAL = new Set(["done", "error", "cancelled"]);

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
   * before `done`. A timeout throws (caller marks the link email-only) — we do
   * not let a half-finished research feed the podcast.
   */
  async waitForDone(
    jobId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<JobRecord> {
    const deadline = Date.now() + (opts.timeoutMs ?? 240_000); // > harness 180s wall
    const interval = opts.intervalMs ?? 3_000;
    let last: JobRecord | null = null;
    while (Date.now() < deadline) {
      last = await this.poll(jobId);
      if (TERMINAL.has(last.status)) return last;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`research job ${jobId} did not complete within deadline (last status: ${last?.status ?? "unknown"})`);
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
  opts: { timeoutMs?: number; intervalMs?: number } = {},
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
