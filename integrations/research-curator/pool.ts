/**
 * ResilientPool — the curator's database handle.
 *
 * WHY THIS MODULE EXISTS (incident 2026-08-31). The curator used to hold a plain
 * `new Pool(...)`. deno-postgres hands back a pooled connection WITHOUT checking
 * that its socket is still alive, so after openbrain-db restarted (or any idle
 * socket was reaped) the first query on a stale checkout died with
 * `Broken pipe (os error 32)`. That error escaped the ingest handler, the whole
 * research package — every source and every grounded claim — was dropped, and
 * the run reported nothing wrong. 244 runs between 2026-06-19 and 2026-08-31
 * were lost that way.
 *
 * The fix is the one openbrain-mcp already runs in
 * `integrations/kubernetes-deployment/index.ts` (class ResilientPool): keep the
 * exact `pool.connect()` / `client.release()` contract so no call site changes,
 * but (a) build the underlying Pool LAZILY so a down DB never throws at
 * construction, (b) liveness-probe every checkout with a cheap `SELECT 1` and,
 * on a connection-class failure, (c) rebuild the Pool once (single-flight) and
 * retry — so a dropped DB self-heals without an operator `docker restart`.
 *
 * The pattern is COPIED, not shared: extracting a library across two Deno
 * services is a bigger change than this incident warrants (curatorpool anchor,
 * out of scope). It lives in its own module — not inline in index.ts — so the
 * retry behaviour is testable without starting the HTTP server or a database:
 * `connect()` takes its underlying pool from an injected factory, and
 * pool.test.ts drives that factory through a real connection-class failure.
 *
 * It deliberately imports NOTHING: the driver comes in through the factory the
 * caller passes. That keeps `deno test integrations/research-curator/` working
 * from the OB1 root, where this subdirectory's "postgres" import map is not in
 * scope, and it means the retry logic can be exercised with no driver at all.
 */

/** The only two members ResilientPool itself uses on a checked-out client. */
export interface ProbeClient {
  queryArray(sql: string): Promise<unknown>;
  release(): void;
}

/** The only two members ResilientPool itself uses on the underlying pool. */
export interface ClientPool<C> {
  connect(): Promise<C>;
  end(): Promise<void>;
}

// deno-postgres raises every connection-level failure as `ConnectionError`
// (name match = future-proof); the message list is a backstop for the raw
// Deno/OS socket errors that surface before the driver wraps them —
// `Broken pipe (os error 32)` is the one that destroyed the 244 runs.
//
// The CamelCase alternatives are Deno's own error CLASS names
// (Deno.errors.ConnectionAborted etc). They are not cosmetic: the real-socket
// test in pool.test.ts severs a live connection and the driver surfaces
// `ConnectionAborted: ... (os error 10053)`, which the spaced-out message list
// copied from openbrain-mcp does NOT match. A classifier that misses the error
// is a wrapper that does not rebuild, i.e. the original defect.
const CONN_ERROR =
  /connectionerror|connectionaborted|connectionreset|connectionrefused|brokenpipe|notconnected|broken pipe|os error 32|os error 10053|os error 10054|connection reset|connection refused|connection closed|connection terminated|connection aborted|session was terminated|terminated unexpectedly|econnreset|bad resource id|unexpected eof|not connected/;

/** True when `e` is a dead-socket / dead-server failure rather than a SQL error. */
export function isConnError(e: unknown): boolean {
  const m = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).toLowerCase();
  return CONN_ERROR.test(m);
}

export interface ResilientPoolOptions {
  /** Total acquire attempts before giving up (default 3). */
  attempts?: number;
  /** Base backoff between attempts, ms (default 200; multiplied by attempt no). */
  backoffMs?: number;
}

export class ResilientPool<C extends ProbeClient> {
  readonly #makePool: () => ClientPool<C>;
  readonly #attempts: number;
  readonly #backoffMs: number;
  #pool: ClientPool<C>;
  #rebuilding: Promise<void> | null = null;
  #rebuilds = 0;

  /**
   * @param makePool builds a fresh underlying pool. Called once at construction
   *   and again on every rebuild. Production passes a `new Pool(cfg, size, true)`
   *   factory (see createCuratorPool); tests pass a fake so the retry path can be
   *   driven without a database.
   */
  constructor(makePool: () => ClientPool<C>, opts: ResilientPoolOptions = {}) {
    this.#makePool = makePool;
    this.#attempts = Math.max(1, opts.attempts ?? 3);
    this.#backoffMs = opts.backoffMs ?? 200;
    this.#pool = makePool();
  }

  /** How many times the underlying pool has been thrown away and rebuilt. */
  get rebuilds(): number {
    return this.#rebuilds;
  }

  async connect(): Promise<C> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.#attempts; attempt++) {
      let client: C | undefined;
      try {
        client = await this.#pool.connect();
        await client.queryArray("SELECT 1"); // probe: rejects a dead socket HERE,
        return client; //                        not in the middle of an ingest
      } catch (e) {
        lastErr = e;
        try {
          client?.release();
        } catch { /* already broken */ }
        if (!isConnError(e)) throw e; // a real query/SQL error — surface it
        await this.#rebuild(); // dead socket(s) in the pool — get fresh ones
        // Brief backoff: Postgres refuses connections for a sub-second window
        // right after a restart (even once pg_isready reports ready), so a tight
        // retry would burn all attempts in that gap.
        if (this.#backoffMs > 0) {
          await new Promise((r) => setTimeout(r, this.#backoffMs * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  // Swap in a fresh pool synchronously (so concurrent connect()s immediately use
  // it) and drain the old one in the background. Single-flight: concurrent
  // failures share one rebuild instead of spawning a pool per caller.
  #rebuild(): Promise<void> {
    if (!this.#rebuilding) {
      const old = this.#pool;
      this.#pool = this.#makePool();
      this.#rebuilds++;
      this.#rebuilding = (async () => {
        try {
          await old.end();
        } catch { /* dead */ }
      })().finally(() => {
        this.#rebuilding = null;
      });
    }
    return this.#rebuilding;
  }

  end(): Promise<void> {
    return this.#pool.end();
  }
}
