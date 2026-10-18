// The contract's database seam. Repositories take a Db, so the routes can run over the real
// pool (pool.ts) or a disposable test database, and pure logic never touches either.
import type { PoolClient } from "postgres";

export interface Db {
  query<T>(sql: string, args?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

// A Db bound to one connection inside an open transaction. Nested tx() reuses it.
export function clientDb(client: PoolClient): Db {
  const db: Db = {
    query: async <T>(sql: string, args: unknown[] = []) =>
      (await client.queryObject<T>(sql, args)).rows,
    tx: (fn) => fn(db),
  };
  return db;
}

export interface PoolLike {
  connect(): Promise<PoolClient>;
}

// A Db over a pool: every query takes a connection; tx() is BEGIN/COMMIT on one connection.
export function poolDb(pool: PoolLike): Db {
  return {
    query: async <T>(sql: string, args: unknown[] = []) => {
      const c = await pool.connect();
      try {
        return (await c.queryObject<T>(sql, args)).rows;
      } finally {
        c.release();
      }
    },
    tx: async <T>(fn: (db: Db) => Promise<T>) => {
      const c = await pool.connect();
      try {
        await c.queryObject("BEGIN");
        const out = await fn(clientDb(c));
        await c.queryObject("COMMIT");
        return out;
      } catch (e) {
        try {
          await c.queryObject("ROLLBACK");
        } catch { /* connection already broken */ }
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
