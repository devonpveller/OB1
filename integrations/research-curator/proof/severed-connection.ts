/**
 * LIVE severed-connection drill (curatorpool/curator2 acceptance criterion 4).
 *
 * The unit tests in ../pool.test.ts drive the wrapper with fakes and with a raw
 * severed TCP socket. This drill is the other half: a REAL deno-postgres pool
 * against a REAL Postgres, whose backends are then killed underneath it exactly
 * the way `docker restart openbrain-db` kills the curator's. It runs the same
 * query shape the curator's shortlistThreads/refreshThread paths use.
 *
 * It is a proof script, not a test: it needs a database, so it is NOT picked up
 * by `deno test integrations/research-curator/`.
 *
 * Run it against a THROWAWAY Postgres — never openbrain-db:
 *
 *   docker run -d --rm --name curator-drill-pg -e POSTGRES_PASSWORD=drillpw \
 *     -e POSTGRES_DB=openbrain -p 55432:5432 postgres:16
 *   deno run -A --config ../deno.json proof/severed-connection.ts \
 *     --host 127.0.0.1 --port 55432 --password drillpw
 *   docker rm -f curator-drill-pg
 *
 * `--plain` runs the SAME drill against a bare `new Pool(...)` — the code the
 * curator shipped until 2026-08-31 — and is expected to FAIL. Run both: a drill
 * that only ever passes proves nothing about the defect it claims to close.
 */
import { Pool } from "postgres";
import { ResilientPool } from "../pool.ts";

type PgClient = Awaited<ReturnType<Pool["connect"]>>;

function arg(name: string, fallback: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : fallback;
}

const CONFIG = {
  hostname: arg("host", "127.0.0.1"),
  port: Number(arg("port", "55432")),
  database: arg("database", "openbrain"),
  user: arg("user", "postgres"),
  password: arg("password", "drillpw"),
};
const PLAIN = Deno.args.includes("--plain");

/** Kill every other backend on this database — what a DB restart does to the pool. */
async function severAllConnections(): Promise<number> {
  const admin = new Pool(CONFIG, 1, true);
  try {
    const c = await admin.connect();
    try {
      const r = await c.queryArray<[number]>(
        `SELECT count(pg_terminate_backend(pid))::int FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [CONFIG.database],
      );
      return Number(r.rows[0]?.[0] ?? 0);
    } finally {
      c.release();
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

async function queryOnce(
  pool: { connect(): Promise<PgClient> },
  label: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const c = await pool.connect();
    try {
      // Same shape as the curator's own reads: one round trip, one row back.
      const r = await c.queryArray<[number]>("SELECT 1");
      return { ok: true, detail: `${label}: SELECT 1 -> ${r.rows[0]?.[0]}` };
    } finally {
      c.release();
    }
  } catch (e) {
    return {
      ok: false,
      detail: `${label}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    };
  }
}

const resilient = new ResilientPool<PgClient>(() => new Pool(CONFIG, 8, true));
const plain = new Pool(CONFIG, 8, true);
const target = PLAIN ? plain : resilient;
const which = PLAIN ? "PLAIN new Pool() (pre-2026-08-31 curator)" : "ResilientPool (pool.ts)";

console.log(`drill: ${which} against ${CONFIG.user}@${CONFIG.hostname}:${CONFIG.port}/${CONFIG.database}`);

const before = await queryOnce(target, "before");
console.log(`  ${before.detail}`);
if (!before.ok) {
  console.error("  the database was not reachable to begin with - fix that first");
  Deno.exit(2);
}

const killed = await severAllConnections();
console.log(`  severed: pg_terminate_backend killed ${killed} backend(s), incl. the pooled one`);

const after = await queryOnce(target, "after");
console.log(`  ${after.detail}`);
if (!PLAIN) console.log(`  pool rebuilds: ${resilient.rebuilds}`);

await plain.end().catch(() => {});
await resilient.end().catch(() => {});

if (after.ok) {
  console.log(PLAIN ? "RESULT: plain pool survived (drill inconclusive)" : "RESULT: RECOVERED");
  Deno.exit(PLAIN ? 3 : 0);
}
console.log(PLAIN ? "RESULT: plain pool LOST the query - this is the defect" : "RESULT: FAILED TO RECOVER");
Deno.exit(PLAIN ? 0 : 1);
