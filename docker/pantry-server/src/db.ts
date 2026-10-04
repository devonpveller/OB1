import { Pool } from "postgres";

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

/** Anything you can run SQL on: the pool, or one transaction. */
export interface Qx {
  q<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Qx {
  /** Run fn inside ONE transaction; any throw rolls everything back. */
  tx<T>(fn: (t: Qx) => Promise<T>): Promise<T>;
  ping(): Promise<boolean>;
  end(): Promise<void>;
}

// deno-postgres hands float4/float8/numeric back as strings; every number the service reads
// goes through here so arithmetic never sees "1500" + 1.
const NUMERIC_OIDS = new Set([700, 701, 1700]);
// deno-lint-ignore no-explicit-any
export function fixRows<T>(res: { rows: any[]; rowDescription?: { columns: { name: string; typeOid: number }[] } }): T[] {
  const names = (res.rowDescription?.columns ?? []).filter((c) => NUMERIC_OIDS.has(c.typeOid)).map((c) => c.name);
  if (names.length) {
    for (const r of res.rows) {
      for (const n of names) if (typeof r[n] === "string") r[n] = Number(r[n]);
    }
  }
  return res.rows as T[];
}

export function makeDb(opts: {
  hostname: string;
  port: number;
  database: string;
  user: string;
  password: string;
}, size = 8): Db {
  const pool = new Pool(opts, size);
  return {
    async q<T = Row>(sql: string, params: unknown[] = []) {
      const c = await pool.connect();
      try {
        return fixRows<T>(await c.queryObject<T>(sql, params));
      } finally {
        c.release();
      }
    },
    async tx<T>(fn: (t: Qx) => Promise<T>) {
      const c = await pool.connect();
      try {
        const t = c.createTransaction("pantry_tx");
        await t.begin();
        try {
          const r = await fn({
            async q<U = Row>(sql: string, params: unknown[] = []) {
              return fixRows<U>(await t.queryObject<U>(sql, params));
            },
          });
          await t.commit();
          return r;
        } catch (e) {
          try {
            await t.rollback();
          } catch { /* already aborted */ }
          throw e;
        }
      } finally {
        c.release();
      }
    },
    async ping() {
      try {
        const r = await this.q<{ ok: number }>("SELECT 1 AS ok");
        return r[0]?.ok === 1;
      } catch {
        return false;
      }
    },
    end: () => pool.end(),
  };
}
