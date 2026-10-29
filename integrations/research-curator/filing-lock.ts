/**
 * filing-lock.ts - rw-curator-filed3. The per-job filing lock of /ingest/research-package.
 *
 * The lock is a Postgres session advisory lock, so it lives on ONE connection for the whole filing. That
 * connection must NEVER come from the curator's request pool: the holder needs further pool connections
 * (resolve, createThread, persist stamp, claims), so a lock that pins a pool connection deadlocks the
 * curator when POOL_SIZE attempts - on one job or on different jobs - hold or wait for a lock at once
 * (rw-curator-filed2 delta review F6). The lock gets its own `Client`, outside the pool, built by the
 * injected factory, and it is always ended (F7: nothing may throw between taking a connection and
 * guaranteeing its release).
 *
 * No imports: the driver client comes in through the factory, so this is unit-testable with no database.
 */
export interface LockClient {
  connect(): Promise<void>;
  queryArray(sql: string, args?: unknown[]): Promise<unknown>;
  queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export const FILING_LOCK_WAIT_MS_DEFAULT = 240_000;

export function lockWaitMsFromEnv(raw: string | undefined | null, dflt = FILING_LOCK_WAIT_MS_DEFAULT): number {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3_600_000) : dflt;
}

/** The lock could not be taken within CURATOR_FILE_LOCK_WAIT_MS: another attempt of the same job is still filing. */
export class FilingInProgress extends Error {
  constructor(key: string, waitMs: number) {
    super(`filing in progress: another attempt for ${key} still holds the filing lock after ${waitMs} ms`);
    this.name = "FilingInProgress";
  }
}

/** SQLSTATE 55P03 lock_not_available (what lock_timeout raises), as deno-postgres surfaces it. */
export function isLockTimeout(e: unknown): boolean {
  const x = e as { fields?: { code?: string }; message?: string } | null;
  return x?.fields?.code === "55P03" || /lock timeout|55P03/i.test(String(x?.message ?? ""));
}

export class FilingLock {
  #client: LockClient | null = null;
  #connected = false;
  #held = false;
  constructor(
    private readonly make: () => LockClient,
    readonly key: string,
    private readonly waitMs: number,
  ) {}

  /** Connect, bound the wait, take the lock. Throws FilingInProgress on a lock-wait timeout; any other
   *  error propagates (a connect failure is the caller's stage "lock"). release() is safe after a throw. */
  async acquire(): Promise<void> {
    this.#client = this.make();
    await this.#client.connect();
    this.#connected = true;
    await this.#client.queryArray(`SET lock_timeout = ${Math.floor(this.waitMs)}`);
    try {
      await this.#client.queryArray("SELECT pg_advisory_lock(hashtext($1))", [`research-file:${this.key}`]);
      this.#held = true;
    } catch (e) {
      if (isLockTimeout(e)) throw new FilingInProgress(this.key, this.waitMs);
      throw e;
    }
  }

  /** The thread the job's 'filed' event names (a resend files into it), or null. Failures propagate. */
  async filedThread(jobId: string): Promise<string | null> {
    const r = await this.#client!.queryObject<{ thread_id: string | null }>(
      `SELECT e.payload ->> 'thread_id' AS thread_id FROM public.research_job_events e
        WHERE e.job_id = $1 AND e.type = 'filed'`, [jobId]);
    return r.rows[0]?.thread_id ?? null;
  }

  /** Unlock (errors swallowed) and END the connection - the session lock dies with it either way. Idempotent. */
  async release(): Promise<void> {
    const c = this.#client;
    if (!c || !this.#connected) return;
    this.#connected = false;
    if (this.#held) {
      this.#held = false;
      await c.queryArray("SELECT pg_advisory_unlock(hashtext($1))", [`research-file:${this.key}`]).catch(() => {});
    }
    await c.end().catch(() => {});
  }
}
