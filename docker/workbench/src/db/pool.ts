// Repository-layer Postgres access (G8/§14.5). The workbench talks to
// openbrain-db DIRECTLY via deno-postgres for write paths, so a logical unit
// (import = source + chunks + links) lands in ONE transaction. Reads may use
// PostgREST (see rest.ts), but anything multi-row + mutating goes through
// withTransaction here.
import { Pool, type PoolClient } from "postgres";
import { config } from "../config.ts";

const pool = new Pool(
  {
    hostname: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
  },
  config.db.poolSize,
);

// Run `fn` inside a single BEGIN/COMMIT; ROLLBACK on any throw so a
// mid-sequence failure can never leave a half-written logical unit (G8).
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.queryObject("BEGIN");
    const result = await fn(client);
    await client.queryObject("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.queryObject("ROLLBACK");
    } catch { /* connection already broken — nothing to roll back */ }
    throw err;
  } finally {
    client.release();
  }
}

// Single-statement / read convenience that still uses the pooled pg connection
// (for queries that want the server-side pgvector operators, e.g. similarity).
export async function query<T>(
  text: string,
  args: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const res = await client.queryObject<T>(text, args);
    return res.rows;
  } finally {
    client.release();
  }
}

// Liveness probe for /health — a trivial round-trip.
export async function dbHealthy(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
