/**
 * The durable per-day routine record (mr-routine-outage, round 3).
 *
 * One record per LOCAL routine date (ROUTINE_TZ) in ROUTINE_STATE_DIR
 * (default /reports/routine = host D:\_data\routine), shared by
 * openbrain-digest and openbrain-podcast:
 *
 *   <date>.day.json            THE record: state (NOT STARTED / IN PROGRESS /
 *                              DONE / FAILED), chain, digest, follow-up, alert.
 *                              Written ONLY by openbrain-digest, always under
 *                              <date>.lock.
 *   <date>.lock                cross-process mutex for a read-modify-write of
 *                              the record (O_EXCL create; a lock older than
 *                              LOCK_STALE_MS is broken - its holder died).
 *   <date>.podcast.json        podcast run record + heartbeat. Written ONLY by
 *                              openbrain-podcast.
 *   <date>.podcast-result.json what the link-enrich run concluded. Written ONLY
 *                              by the link-enrich subprocess.
 *
 * There are no send-once claim files any more (round 1/2): "was it sent?" is the
 * record's send status, and an UNKNOWN outcome is resolved by looking in Gmail's
 * Sent folder (src/routine/sent-check.ts).
 */

export type RoutineState = "not-started" | "in-progress" | "done" | "failed";

export type PendingState =
  | "waiting for the model"
  | "waiting for a dependency"
  | "still running"
  | "status unknown"
  | "interrupted"
  | "failed"
  | "not started";

export interface PendingNote {
  section: string;
  state: PendingState;
  detail: string;
  /** The routine may still deliver it later today (a follow-up). */
  mayFollow: boolean;
}

export type SendStatus = "not-sent" | "sending" | "sent" | "failed" | "unknown";

export interface SendRecord {
  status: SendStatus;
  attempts: number;
  lastAttemptAt?: string;
  /** In flight: when, and which process (another process waits SEND_STALE before calling it unknown). */
  sendingAt?: string;
  sendingBy?: string;
  sentAt?: string;
  /** Sent-folder verification: true found, false not found, null check unavailable. */
  verified?: boolean | null;
  verifyNote?: string;
  lastError?: string;
  mode?: "full" | "deadline";
  included?: string[];
  pending?: PendingNote[];
}

export type ChainStatus = "not-started" | "waiting-deps" | "running" | "done" | "failed";

export interface DepFailure {
  dep: "model" | "research" | "gmail-auth";
  reason: string;
}

export interface DayRecord {
  date: string;
  state: RoutineState;
  chain: {
    status: ChainStatus;
    attempts: number;
    startedAt?: string;
    heartbeatAt?: string;
    waitUntil?: string;
    headTriggeredAt?: string;
    headStatus?: number;
    doneAt?: string;
    failedAt?: string;
    /** FAILED: when the dependencies were last checked for a retry. */
    lastCheckAt?: string;
    reason?: string;
    /** produced | nothing-to-do (done) */
    outcome?: string;
    modelDownSince?: string;
    /** Round 5 (B1): the gmail-pull body this day's chain was started with
     *  (a cron/L14 body, else the canonical CHAIN_HEAD_BODY); a retry or a
     *  resumed wait reuses it. */
    headBody?: Record<string, unknown>;
  };
  deps?: { checkedAt: string; ok: boolean; failing: DepFailure[] };
  /** A down dependency handed to the system that owns it (once per dependency per day). */
  handoffs?: Array<{ dep: string; owner: string; at: string; outcome: string }>;
  digest: SendRecord;
  followUp: SendRecord;
  alert: {
    status: "none" | "pending" | "delivered" | "resolved";
    tries: number;
    firstAt?: string;
    lastAt?: string;
    lastOutcome?: string;
    problems?: string[];
  };
  /** Transitions, newest last, capped. */
  history: Array<{ at: string; trigger: string; note: string }>;
}

export function emptyDay(date: string): DayRecord {
  return {
    date,
    state: "not-started",
    chain: { status: "not-started", attempts: 0 },
    digest: { status: "not-sent", attempts: 0 },
    followUp: { status: "not-sent", attempts: 0 },
    alert: { status: "none", tries: 0 },
    history: [],
  };
}

export interface PodcastRun {
  startedAt: string;
  finishedAt?: string;
  heartbeatAt?: string;
  code?: number;
  interrupted?: boolean;
  timedOut?: boolean;
  resume?: boolean;
}

export interface PodcastRecord {
  date: string;
  runs: PodcastRun[];
}

export interface PodcastResult {
  date: string;
  at: string;
  /** produced: brief + episode written. nothing-to-do: no items today (not a
   *  failure). model-down: gave up waiting for the model. error: anything else. */
  outcome: "produced" | "nothing-to-do" | "model-down" | "error";
  detail?: string;
}

const LOCK_STALE_MS = 120_000;

/** Round 5 (F3): today's record exists but cannot be read. The routine fails
 *  closed on it: no chain start, no send, a logged reason. The file is left as
 *  it is (update() throws before writing). */
export class DayRecordUnreadableError extends Error {
  override name = "DayRecordUnreadableError";
  constructor(readonly date: string, readonly why: string) {
    super(`day record ${date} is unreadable (${why}) - failing closed: no chain start, no send`);
  }
}

export class RoutineStore {
  constructor(readonly dir: string) {}

  dayPath(date: string) {
    return `${this.dir}/${date}.day.json`;
  }
  lockPath(date: string) {
    return `${this.dir}/${date}.lock`;
  }
  podcastPath(date: string) {
    return `${this.dir}/${date}.podcast.json`;
  }
  resultPath(date: string) {
    return `${this.dir}/${date}.podcast-result.json`;
  }

  /**
   * Round 5 (F3): does today's record exist, and can it be read? "unreadable"
   * = the file is there but is not a JSON object (after a few short retries,
   * so a reader racing an atomic rename is not mistaken for corruption).
   */
  async inspect(date: string): Promise<{ kind: "missing" } | { kind: "ok"; r: Partial<DayRecord> } | { kind: "unreadable"; why: string }> {
    const p = this.dayPath(date);
    let why = "";
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise((res) => setTimeout(res, 25));
      let text: string;
      try {
        text = await Deno.readTextFile(p);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return { kind: "missing" };
        why = `read failed (${(e as Error)?.name ?? "error"})`;
        continue;
      }
      try {
        const v = JSON.parse(text);
        if (v && typeof v === "object" && !Array.isArray(v)) return { kind: "ok", r: v as Partial<DayRecord> };
        why = "not a JSON object";
      } catch {
        why = "invalid JSON";
      }
    }
    return { kind: "unreadable", why };
  }

  /** Today's record; a missing one is NOT STARTED. An unreadable one THROWS
   *  (fail closed: never mistaken for "nothing happened today"). */
  async load(date: string): Promise<DayRecord> {
    const got = await this.inspect(date);
    const e = emptyDay(date);
    if (got.kind === "missing") return e;
    if (got.kind === "unreadable") throw new DayRecordUnreadableError(date, got.why);
    const r = got.r;
    return {
      ...e,
      ...r,
      chain: { ...e.chain, ...r.chain },
      digest: { ...e.digest, ...r.digest },
      followUp: { ...e.followUp, ...r.followUp },
      alert: { ...e.alert, ...r.alert },
      history: r.history ?? [],
    };
  }

  /**
   * Read-modify-write under the cross-process lock. `fn` must not do slow I/O:
   * the lock is held for its duration. Bounded: waits at most ~LOCK_STALE_MS,
   * then breaks a lock whose holder must have died.
   */
  async update<T>(date: string, fn: (r: DayRecord) => T | Promise<T>): Promise<T> {
    await Deno.mkdir(this.dir, { recursive: true });
    const lp = this.lockPath(date);
    const start = Date.now();
    for (;;) {
      try {
        await Deno.writeTextFile(lp, String(Date.now()), { createNew: true });
        break;
      } catch (e) {
        if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
        const age = await Deno.stat(lp).then((s) => Date.now() - (s.mtime?.getTime() ?? 0), () => 0);
        if (age > LOCK_STALE_MS || Date.now() - start > LOCK_STALE_MS + 5_000) {
          await Deno.remove(lp).catch(() => {});
          continue;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    try {
      const r = await this.load(date);
      const out = await fn(r);
      await writeJsonAtomic(this.dayPath(date), r);
      return out;
    } finally {
      await Deno.remove(lp).catch(() => {});
    }
  }

  loadPodcast(date: string): Promise<PodcastRecord | null> {
    return readJson<PodcastRecord>(this.podcastPath(date));
  }
  async savePodcast(rec: PodcastRecord): Promise<void> {
    await writeJsonAtomic(this.podcastPath(rec.date), rec);
  }
  loadResult(date: string): Promise<PodcastResult | null> {
    return readJson<PodcastResult>(this.resultPath(date));
  }
  async saveResult(r: PodcastResult): Promise<void> {
    await writeJsonAtomic(this.resultPath(r.date), r);
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

/** tmp + rename: a reader never sees a half-written file. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const dir = path.replace(/[\\/][^\\/]*$/, "");
  if (dir && dir !== path) await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2));
  await Deno.rename(tmp, path);
}
