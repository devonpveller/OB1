/**
 * Durable morning-routine state (mr-routine-outage).
 *
 * Lives on the shared /reports volume (ROUTINE_STATE_DIR, default
 * /reports/routine = D:\_data\routine on the host), so it survives a container
 * restart and both openbrain-digest and openbrain-podcast can read it.
 *
 * Files, per LOCAL routine date (YYYY-MM-DD in ROUTINE_TZ):
 *   <date>.day.json            digest-side state (chain, digest, follow-up, alert).
 *                              Written ONLY by openbrain-digest.
 *   <date>.<kind>.claim        THE send-once marker. Created with createNew
 *                              (O_EXCL): exactly one caller wins, across
 *                              processes and restarts. kind = digest | followup | alert.
 *   <date>.podcast.json        podcast-run record. Written ONLY by openbrain-podcast.
 *   <date>.podcast-result.json what the link-enrich run concluded. Written ONLY
 *                              by the link-enrich subprocess.
 * One writer per file, so no cross-process read-modify-write race.
 *
 * A claim is taken BEFORE the transport is called. A definite failure (the
 * transport answered "not sent") releases it so a later attempt may retry; an
 * ambiguous one (the request may have gone out) keeps it - at most once wins
 * over at least once. Forcing a re-send is explicit: POST /run {"force":true}
 * (or delete the claim file by hand).
 */

export type PendingState = "waiting for the model" | "still running" | "interrupted" | "failed" | "not started";

export interface PendingNote {
  section: string;
  state: PendingState;
  detail: string;
}

export interface DayState {
  date: string;
  chain?: {
    startedAt: string;
    modelDownSince?: string;
    modelUpAt?: string;
    gaveUpAt?: string;
    headTriggeredAt?: string;
    headStatus?: number;
    finishedAt?: string;
    probes?: number;
  };
  digest?: {
    attempts: number;
    /** round 2: where the send got to. building = sections being built, no
     *  claim yet (a restart may rebuild); sending = claim held, transport
     *  called; sent / failed (definite, claim released) / unconfirmed (maybe sent). */
    phase?: "building" | "sending" | "sent" | "failed" | "unconfirmed";
    buildStartedAt?: string;
    claimedAt?: string;
    sentAt?: string;
    mode?: "full" | "deadline";
    included?: string[];
    pending?: PendingNote[];
    modelDownAtSend?: boolean;
    lastError?: string;
    unconfirmed?: boolean;
  };
  followUp?: { attempts: number; sentAt?: string; lastError?: string; unconfirmed?: boolean };
  /** outcome: delivered | not-delivered (retried by later passes until the
   *  cutoff) | unknown (may have arrived: never retried) | unconfigured. */
  alert?: {
    at: string;
    delivered: boolean;
    problems: string[];
    outcome?: "delivered" | "not-delivered" | "unknown" | "unconfigured";
    tries?: number;
    lastTryAt?: string;
  };
  forced?: Array<{ at: string; kind: string; ok: boolean }>;
}

export interface PodcastRun {
  startedAt: string;
  finishedAt?: string;
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

export type ClaimKind = "digest" | "followup" | "alert";

export class RoutineStore {
  constructor(readonly dir: string) {}

  dayPath(date: string) {
    return `${this.dir}/${date}.day.json`;
  }
  claimPath(date: string, kind: ClaimKind) {
    return `${this.dir}/${date}.${kind}.claim`;
  }
  podcastPath(date: string) {
    return `${this.dir}/${date}.podcast.json`;
  }
  resultPath(date: string) {
    return `${this.dir}/${date}.podcast-result.json`;
  }

  async load(date: string): Promise<DayState> {
    return (await readJson<DayState>(this.dayPath(date))) ?? { date };
  }

  /** Read-modify-write the day file (single writer: openbrain-digest; callers serialize). */
  async update(date: string, fn: (s: DayState) => void): Promise<DayState> {
    const s = await this.load(date);
    fn(s);
    await writeJsonAtomic(this.dayPath(date), s);
    return s;
  }

  /** Take the send-once marker. true = this caller won and may send. */
  async claim(date: string, kind: ClaimKind, note: Record<string, unknown> = {}): Promise<boolean> {
    await Deno.mkdir(this.dir, { recursive: true });
    try {
      await Deno.writeTextFile(this.claimPath(date, kind), JSON.stringify({ at: new Date().toISOString(), ...note }), {
        createNew: true,
      });
      return true;
    } catch (e) {
      if (e instanceof Deno.errors.AlreadyExists) return false;
      throw e;
    }
  }

  async hasClaim(date: string, kind: ClaimKind): Promise<boolean> {
    try {
      await Deno.stat(this.claimPath(date, kind));
      return true;
    } catch {
      return false;
    }
  }

  /** Give a claim back after a DEFINITE "not sent". */
  async release(date: string, kind: ClaimKind): Promise<void> {
    await Deno.remove(this.claimPath(date, kind)).catch(() => {});
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
