/**
 * ResilientPool tests. Run: deno test integrations/research-curator/
 * (add -A to also run the real-socket test at the bottom, which needs net.)
 *
 * These exist because the defect they cover survived two and a half months and
 * 244 lost research runs behind a green happy path. A test that only proves
 * `connect()` returns a client would have passed every single one of those days.
 * So the central test here drives the WRAPPER through a connection-level failure
 * on first acquire and proves the client it finally hands back came from a
 * REBUILT pool — the recovery, not the source text, is what is asserted.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type ClientPool, isConnError, type ProbeClient, ResilientPool } from "./pool.ts";

// The verbatim failure from the production log that destroyed the 244 runs.
const BROKEN_PIPE = () => new Error("Broken pipe (os error 32)");

class FakeClient implements ProbeClient {
  released = 0;
  probes = 0;
  constructor(readonly poolId: number, private readonly failWith?: Error) {}
  queryArray(_sql: string): Promise<unknown> {
    this.probes++;
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve({ rows: [[1]] });
  }
  release(): void {
    this.released++;
  }
}

class FakePool implements ClientPool<FakeClient> {
  ended = 0;
  handed: FakeClient[] = [];
  constructor(
    readonly id: number,
    private readonly failWith?: Error,
    private readonly endDelayMs = 0,
  ) {}
  connect(): Promise<FakeClient> {
    const c = new FakeClient(this.id, this.failWith);
    this.handed.push(c);
    return Promise.resolve(c);
  }
  end(): Promise<void> {
    this.ended++;
    return this.endDelayMs
      ? new Promise<void>((r) => setTimeout(r, this.endDelayMs))
      : Promise.resolve();
  }
}

/** Builds a ResilientPool whose Nth underlying pool fails per `failures[N]`. */
function harness(failures: Array<Error | undefined>, endDelayMs = 0) {
  const pools: FakePool[] = [];
  const rp = new ResilientPool<FakeClient>(() => {
    const p = new FakePool(pools.length, failures[pools.length], endDelayMs);
    pools.push(p);
    return p;
  }, { backoffMs: 0 });
  return { rp, pools };
}

// ── THE regression test ─────────────────────────────────────────────────────
Deno.test("connection-level failure on first acquire is retried against a REBUILT pool", async () => {
  const { rp, pools } = harness([BROKEN_PIPE(), undefined]);

  const client = await rp.connect();

  // The caller gets a WORKING connection, not the 500 the curator used to raise.
  assertEquals(client.poolId, 1, "the returned client must come from the rebuilt pool");
  await client.queryArray("SELECT 1"); // and it is actually usable
  // The recovery is what is asserted: a fresh pool was built, not the dead one reused.
  assertEquals(pools.length, 2, "the dead pool must be REBUILT, not reused");
  assertEquals(rp.rebuilds, 1);
  assertEquals(pools[0].ended, 1, "the dead pool must be drained");
  assertEquals(pools[0].handed[0].released, 1, "the broken checkout must be released");
});

Deno.test("every acquire is probed — a stale socket fails at connect(), not mid-ingest", async () => {
  const { rp, pools } = harness([undefined]);
  const client = await rp.connect();
  assertEquals(pools.length, 1);
  assertEquals(pools[0].handed[0].probes, 1, "the checkout must be probed with SELECT 1");
  assertEquals(client.probes, 1);
});

Deno.test("a SQL error is surfaced immediately — no rebuild, no retry", async () => {
  const { rp, pools } = harness([new Error('syntax error at or near "SELCT"')]);
  await assertRejects(() => rp.connect(), Error, "syntax error");
  assertEquals(pools.length, 1, "a query error must NOT throw the pool away");
  assertEquals(rp.rebuilds, 0);
});

Deno.test("a database that stays down exhausts the attempts and throws the connection error", async () => {
  const { rp, pools } = harness([BROKEN_PIPE(), BROKEN_PIPE(), BROKEN_PIPE(), BROKEN_PIPE()]);
  const err = await assertRejects(() => rp.connect(), Error, "Broken pipe");
  assert(isConnError(err));
  // Bounded: 3 attempts, then give up rather than spin. Each failed attempt
  // rebuilds, so the pool the NEXT caller inherits is already fresh.
  assertEquals(pools.length, 4, "1 initial pool + 1 rebuild per failed attempt");
  assertEquals(rp.rebuilds, 3);
});

Deno.test("concurrent failures share ONE rebuild (single-flight)", async () => {
  const { rp, pools } = harness([BROKEN_PIPE(), undefined], 20);
  const [a, b] = await Promise.all([rp.connect(), rp.connect()]);
  assertEquals(a.poolId, 1);
  assertEquals(b.poolId, 1);
  assertEquals(pools.length, 2, "two simultaneous failures must not spawn two pools");
  assertEquals(rp.rebuilds, 1);
});

Deno.test("isConnError classifies the incident's own error strings", () => {
  for (
    const m of [
      "Broken pipe (os error 32)",
      "Connection reset by peer (os error 104)",
      "unexpected EOF during message length reading",
      "Bad resource ID",
      "connection refused",
    ]
  ) assert(isConnError(new Error(m)), `should be a connection error: ${m}`);

  const named = new Error("the connection to the database has been severed");
  named.name = "ConnectionError";
  assert(isConnError(named), "deno-postgres ConnectionError must classify by name");

  for (
    const m of [
      'syntax error at or near "SELCT"',
      'relation "sources" does not exist',
      "duplicate key value violates unique constraint",
    ]
  ) assert(!isConnError(new Error(m)), `should NOT be a connection error: ${m}`);
});

// ── Real socket, no mock ─────────────────────────────────────────
// Everything above feeds the wrapper an Error object WE wrote, so it can only
// ever be as right as our guess about what a dead connection looks like. This
// one severs a REAL TCP connection and lets the operating system produce the
// failure: the probe writes to a socket whose peer has closed, and whatever the
// OS raises is what the wrapper has to classify and recover from.
//
// It earned its place immediately: the classifier copied from openbrain-mcp
// missed the error this produces on Windows
// (`ConnectionAborted: ... (os error 10053)`), because that list only matches
// spaced-out message text, not Deno's error CLASS names. A miss here means no
// rebuild, i.e. the original defect.
//
// Needs --allow-net; visibly skipped when the suite is run without it.
class SeveredSocketClient implements ProbeClient {
  released = 0;
  constructor(readonly poolId: number, private readonly conn: Deno.Conn) {}
  async queryArray(_sql: string): Promise<unknown> {
    // Writes to a half-closed socket are buffered until the OS notices the RST,
    // so push until it actually raises. It normally raises within a few writes.
    const payload = new TextEncoder().encode("SELECT 1\n");
    for (let i = 0; i < 200; i++) {
      await this.conn.write(payload);
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("the severed socket never raised - test setup is wrong");
  }
  release(): void {
    this.released++;
  }
}

Deno.test({
  name: "a REAL severed socket on first acquire is classified AND recovered from",
  ignore: (await Deno.permissions.query({ name: "net" })).state !== "granted",
  fn: async () => {
    // A listener that accepts every connection and immediately hangs up.
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    const accepting = (async () => {
      for await (const conn of listener) {
        try {
          conn.close();
        } catch { /* client already gone */ }
      }
    })();
    const severed = await Deno.connect({ hostname: "127.0.0.1", port });

    try {
      const pools: Array<FakePool | { id: number }> = [];
      let severedClient: SeveredSocketClient | undefined;
      const rp = new ResilientPool<ProbeClient>(() => {
        const id = pools.length;
        if (id === 0) {
          const p = {
            id,
            connect: () => {
              severedClient = new SeveredSocketClient(id, severed);
              return Promise.resolve<ProbeClient>(severedClient);
            },
            end: () => Promise.resolve(),
          };
          pools.push(p);
          return p;
        }
        const p = new FakePool(id);
        pools.push(p);
        return p as unknown as ClientPool<ProbeClient>;
      }, { backoffMs: 0 });

      const client = await rp.connect();

      assertEquals(pools.length, 2, "the OS-level failure must trigger a rebuild");
      assertEquals(rp.rebuilds, 1);
      assertEquals((client as FakeClient).poolId, 1, "must be served from the rebuilt pool");
      await client.queryArray("SELECT 1"); // and the recovered client works
      assertEquals(severedClient?.released, 1, "the dead checkout must be released");
    } finally {
      try {
        severed.close();
      } catch { /* already broken by the write that failed */ }
      listener.close();
      await accepting.catch(() => {});
    }
  },
});
