/**
 * curator-filed.test.ts - rw-curator-filed, clauses 1-3 against a LAB curator: a real HTTP server on
 * 127.0.0.1 (no published port, no egress), the REAL delegateCuratorWithRetry (per-attempt timeout)
 * and the REAL deliverToCurator. The lab curator keeps its "database" in memory with the SAME rules the
 * real persist has: the synthesis upserts on research_key (one row), the typed 'filed' event is one row
 * per job and is written in the same step as the synthesis. The real SQL (one transaction, the race on
 * the unique index) is proven in kubernetes-deployment/research-filed.e2e.test.ts against Postgres.
 *
 * DELIVER_IMPL (default ./curator-filed.ts) lets the RED run point at a shim with the pre-change
 * behaviour (one hand-off, no lookup, no resend) - the same tests then FAIL.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyCuratorOutcome, delegateCuratorWithRetry } from "./lib.ts";
import { restateFiledCredibility } from "./harness.ts";
import type { FiledRecord } from "./curator-filed.ts";

const impl = await import(Deno.env.get("DELIVER_IMPL") ?? "./curator-filed.ts");
const deliverToCurator = impl.deliverToCurator as typeof import("./curator-filed.ts").deliverToCurator;

const JOB = "11111111-1111-4111-8111-111111111111";
const KEY = "rs-lab-key";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Mode = "ok" | "slow-then-commit" | "drop-before-commit" | "http500" | "http400";
/** The lab curator + its in-memory store. `plan[n]` = how its n-th request (0-based) behaves. */
function lab(plan: Mode[], slowMs = 700) {
  const syntheses = new Map<string, string>(); // research_key -> synthesis id (upsert: ONE row per key)
  const events = new Map<string, FiledRecord>(); // job id -> filed event (one per job)
  let requests = 0, commits = 0;
  const commit = (pkg: Record<string, unknown>) => {
    commits++;
    const key = String(pkg.research_key);
    const id = syntheses.get(key) ?? `syn-${syntheses.size + 1}`;
    syntheses.set(key, id); // ON CONFLICT (research_key) DO UPDATE
    events.set(String(pkg.job_id), { synthesis_id: id, research_key: key }); // same step as the synthesis
    return id;
  };
  const ac = new AbortController();
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    const n = requests++;
    const pkg = await req.json();
    const mode = plan[Math.min(n, plan.length - 1)];
    if (mode === "slow-then-commit") {
      await sleep(slowMs);
      const id = commit(pkg);
      return Response.json({ persist: { synthesis_id: id }, thread_id: null });
    }
    if (mode === "drop-before-commit") throw new Error("planted: connection dropped before the commit"); // Deno resets the socket
    if (mode === "http500") return Response.json({ error: "persist_failed" }, { status: 502 });
    if (mode === "http400") return Response.json({ error: "claim required" }, { status: 400 });
    const id = commit(pkg);
    return Response.json({ persist: { synthesis_id: id }, thread_id: null });
  });
  const url = `http://127.0.0.1:${(srv.addr as Deno.NetAddr).port}/ingest/research-package`;
  const handOff = (pkg: Record<string, unknown>) =>
    delegateCuratorWithRetry(fetch, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pkg) },
      { retries: 3, timeoutMs: 300, sleep: () => Promise.resolve() });
  return {
    handOff, syntheses, events,
    get requests() { return requests; },
    get commits() { return commits; },
    findFiled: (job: string) => Promise.resolve(events.get(job) ?? null),
    stop: async () => { ac.abort(); await srv.finished; },
  };
}
const pkg = () => ({ research_key: KEY, job_id: JOB, claim: "c", synthesis: "s" });
const opts = (attempts: number, settleMs: number) => ({ attempts, settleMs, pollMs: 50, backoffBaseMs: 1, backoffCapMs: 2 });
const filedStatus = (curator: Record<string, unknown>) => {
  const o = classifyCuratorOutcome(curator);
  const cred = restateFiledCredibility({ value: 0.5, claims: 3, below_floor: 0 } as never, curator, () => {
    throw new Error("n/a");
  });
  return { status: o.status, error: o.error, filed: (cred as { filed: boolean | null }).filed };
};

Deno.test("clause 1: a curator slower than the timeout that then COMMITS -> the job ends filed with the synthesis id, exactly one synthesis", async () => {
  const L = lab(["slow-then-commit"]);
  try {
    const r = await deliverToCurator(L.handOff, L.findFiled, JOB, pkg(), opts(3, 3000));
    assertEquals(r.error, undefined, JSON.stringify(r));
    assertEquals((r.persist as { synthesis_id: string }).synthesis_id, "syn-1");
    assertEquals(L.syntheses.size, 1);
    const st = filedStatus(r);
    assertEquals([st.status, st.error, st.filed], ["done", null, true]);
    assertEquals(L.requests, 1, "the package was not resent while the curator was still working");
  } finally {
    await L.stop();
  }
});

Deno.test("clause 2: a curator that drops the connection before committing, then recovers -> the run is resent and ends filed once", async () => {
  const L = lab(["drop-before-commit", "http500", "ok"]);
  try {
    const r = await deliverToCurator(L.handOff, L.findFiled, JOB, pkg(), opts(3, 0));
    assertEquals(r.error, undefined, JSON.stringify(r));
    assertEquals(L.requests, 3);
    assertEquals(L.syntheses.size, 1);
    assertEquals(L.commits, 1);
    assertEquals(filedStatus(r).filed, true);
  } finally {
    await L.stop();
  }
});

Deno.test("clause 2: a curator that never recovers -> bounded hand-offs, then error with a stated reason and filed:false", async () => {
  const L = lab(["drop-before-commit"]);
  try {
    const r = await deliverToCurator(L.handOff, L.findFiled, JOB, pkg(), opts(3, 0));
    assertEquals(L.requests, 3, "exactly the bound: neither silent loss after one try nor an unbounded retry");
    assert(String(r.error).includes("after 3 attempt(s)") && String(r.error).includes("not filed"), String(r.error));
    assertEquals(L.syntheses.size, 0);
    const st = filedStatus(r);
    assertEquals([st.status, st.filed], ["error", false]);
    assert(String(st.error).includes("NOT filed into Open Brain"), String(st.error));
  } finally {
    await L.stop();
  }
});

Deno.test("clause 2: a final refusal (HTTP 400) is not resent", async () => {
  const L = lab(["http400"]);
  try {
    const r = await deliverToCurator(L.handOff, L.findFiled, JOB, pkg(), opts(3, 0));
    assertEquals(L.requests, 1);
    assert(String(r.error).includes("curator 400"), String(r.error));
  } finally {
    await L.stop();
  }
});

Deno.test("clause 3: a late first commit racing the retry never produces a duplicate", async () => {
  // attempt 1 hangs past the 300 ms timeout and commits at ~700 ms; the settle window is 0, so the retry
  // (attempt 2) goes out at once and commits first. Both land on research_key.
  const L = lab(["slow-then-commit", "ok"], 700);
  try {
    const r = await deliverToCurator(L.handOff, L.findFiled, JOB, pkg(), opts(2, 0));
    assertEquals(r.error, undefined, JSON.stringify(r));
    await sleep(900); // let the late first commit land AFTER the retry's
    assertEquals(L.commits, 2, "both attempts committed (the race really happened)");
    assertEquals(L.syntheses.size, 1, "one synthesis");
    assertEquals(L.events.size, 1, "one filed event for the job");
  } finally {
    await L.stop();
  }
});

Deno.test("clause 1: attempts 1 / settle 0 is the pre-change behaviour (a slow curator is 'not filed')", async () => {
  const L = lab(["slow-then-commit"]);
  try {
    const r = await deliverToCurator(L.handOff, L.findFiled, JOB, pkg(), opts(1, 0));
    assert(String(r.error).includes("curator timed out"), String(r.error));
    await sleep(600); // let the lab's late commit finish before the server stops
  } finally {
    await L.stop();
  }
});

Deno.test("round 2: a curator 4xx is final BEFORE the settle wait (no 30 s wait), and says so", async () => {
  const L = lab(["http400"]);
  try {
    const t0 = Date.now();
    const r = await deliverToCurator(L.handOff, L.findFiled, JOB, pkg(), opts(3, 5000));
    assert(Date.now() - t0 < 1500, `a 4xx must not wait out the settle window (${Date.now() - t0} ms)`);
    assertEquals(L.requests, 1);
    assert(String(r.error).includes("curator 400") && String(r.error).includes("final refusal"), String(r.error));
  } finally {
    await L.stop();
  }
});

Deno.test("round 2: the final error does not claim 'not retried' for a package that WAS resent", async () => {
  const L = lab(["slow-then-commit"], 700); // every attempt times out (300 ms) and commits only afterwards
  try {
    const r = await deliverToCurator(L.handOff, () => Promise.resolve(null), JOB, pkg(), opts(2, 0));
    assertEquals(L.requests, 2);
    assert(String(r.error).includes("after 2 attempt(s)"), String(r.error));
    assert(!/not retried/i.test(String(r.error)), String(r.error));
    assert(String(r.error).includes("timed out after"), "the cause is still stated: " + String(r.error));
    await sleep(900); // let the lab's late commits finish (no timers left for the leak sanitizer)
  } finally {
    await L.stop();
  }
});
