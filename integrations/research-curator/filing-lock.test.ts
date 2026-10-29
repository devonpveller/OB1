// filing-lock.test.ts - rw-curator-filed3: the lock never leaks its connection, whatever throws.
import { FilingInProgress, FilingLock, type LockClient, lockWaitMsFromEnv } from "./filing-lock.ts";

function eq(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function fake(opts: { connect?: Error; failOn?: RegExp; failWith?: Error; unlockThrows?: boolean } = {}) {
  const log: string[] = [];
  let ended = 0;
  const c: LockClient = {
    connect: () => { log.push("connect"); return opts.connect ? Promise.reject(opts.connect) : Promise.resolve(); },
    queryArray: (sql: string) => {
      log.push(sql.split("(")[0].trim());
      if (opts.failOn?.test(sql)) return Promise.reject(opts.failWith ?? new Error("planted: lock query failed"));
      if (/pg_advisory_unlock/.test(sql) && opts.unlockThrows) return Promise.reject(new Error("planted: unlock failed"));
      return Promise.resolve([]);
    },
    queryObject: () => Promise.resolve({ rows: [{ thread_id: "t-1" }] as never }),
    end: () => { ended++; log.push("end"); return Promise.resolve(); },
  };
  return { c, log, get ended() { return ended; } };
}

Deno.test("a throwing lock query still ends its connection (F7)", async () => {
  const f = fake({ failOn: /pg_advisory_lock/ });
  const l = new FilingLock(() => f.c, "k", 1000);
  let threw = false;
  try { await l.acquire(); } catch { threw = true; }
  eq(threw, true, "the planted failure propagates");
  await l.release();
  eq(f.ended, 1, "the connection was ended");
  await l.release();
  eq(f.ended, 1, "release is idempotent");
  eq(f.log.includes("SELECT pg_advisory_unlock"), false, "no unlock for a lock never held");
});

Deno.test("a connect failure leaves nothing to end and release is safe", async () => {
  const f = fake({ connect: new Error("planted: connect refused") });
  const l = new FilingLock(() => f.c, "k", 1000);
  let threw = false;
  try { await l.acquire(); } catch { threw = true; }
  eq(threw, true);
  await l.release();
  eq(f.ended, 0, "never connected, so nothing to end");
});

Deno.test("a lock_timeout (55P03) is FilingInProgress, and the connection is still ended", async () => {
  const e = Object.assign(new Error('canceling statement due to lock timeout'), { fields: { code: "55P03" } });
  const f = fake({ failOn: /pg_advisory_lock/, failWith: e });
  const l = new FilingLock(() => f.c, "k", 1000);
  let got: unknown = null;
  try { await l.acquire(); } catch (x) { got = x; }
  eq(got instanceof FilingInProgress, true);
  await l.release();
  eq(f.ended, 1);
});

Deno.test("the order is connect, SET lock_timeout, lock; release unlocks (errors swallowed) then ends", async () => {
  const f = fake({ unlockThrows: true });
  const l = new FilingLock(() => f.c, "k", 5000);
  await l.acquire();
  eq(await l.filedThread("j"), "t-1");
  await l.release();
  eq(f.log, ["connect", "SET lock_timeout = 5000", "SELECT pg_advisory_lock", "SELECT pg_advisory_unlock", "end"]);
});

Deno.test("CURATOR_FILE_LOCK_WAIT_MS: default 240000, junk falls back", () => {
  eq(lockWaitMsFromEnv(undefined), 240000);
  eq(lockWaitMsFromEnv("abc"), 240000);
  eq(lockWaitMsFromEnv("-5"), 240000);
  eq(lockWaitMsFromEnv("1500"), 1500);
});
