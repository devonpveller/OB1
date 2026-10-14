// Tester attack suite from mr-routine-outage attempt 3 (tester-mr-routine-outage-3),
// part of the round-4 REGRESSION SUITE (X1/X1b were the failing cases). Source:
// plan store test-evidence/mr-routine-outage.attempt3.attack.test.ts, kept as
// written; only the harness import points at ./harness.ts (which gained the
// tester's `fetchWrap` option - the tester's harness copy differed from it only
// there and in the temp-dir prefix).
// Run: deno test --allow-all src/routine/routine.attack3.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DATE, harness, iso, Z } from "./harness.ts";
import { RoutineStore } from "./store.ts";
import { MattermostOwnerChannel } from "./owner.ts";
import { postJson, until, UPSTREAM_DOWN_502 } from "./testing.ts";
import { MailSendError } from "../clients/gmail.ts";
let failing = true;

const opts = { sanitizeOps: false, sanitizeResources: false };

/** fetch wrapper: the Nth+ 1-token chat probe takes `ms` VIRTUAL time (cold load / llm-queue wait), then answers `answer`. */
function slowProbes(state: { from: number; ms: number; answer: "up" | "down"; n: number; log: Array<{ start: number; end: number }> }) {
  return (clock: { now(): number; sleep(ms: number): Promise<void> }, f: typeof fetch): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method === "POST" && /\/chat\/completions$/.test(url) && typeof init.body === "string" && JSON.parse(init.body).max_tokens === 1) {
        state.n++;
        if (state.n >= state.from) {
          const start = clock.now();
          await clock.sleep(state.ms);
          state.log.push({ start, end: clock.now() });
          if (state.answer === "down") return new Response(UPSTREAM_DOWN_502, { status: 502 });
        }
      }
      return f(input, init);
    }) as typeof fetch;
}

Deno.test({
  name: "X1 chain ends 06:55 and the pre-deadline FULL send's probe takes 10 min (cold load / queue): is the digest out at 07:00?",
  ...opts,
  async fn() {
    const st = { from: 2, ms: 10 * 60_000, answer: "up" as const, n: 0, log: [] as Array<{ start: number; end: number }> };
    // default config (ROUTINE_CHAIN_START 01:00): booting at 06:55 starts the chain cron missed
    const h = await harness({ start: Z("10:55"), gateway: "up", fetchWrap: slowProbes(st) });
    try {
      await h.clock.advanceTo(Z("11:30"));
      await until(() => h.gmail.sent.length >= 1, 20_000).catch(() => {});
      const rec = await h.store.load(DATE);
      console.log("X1 pull at", h.pullCalls.map(iso), "probes(slow)", JSON.stringify(st.log.map((l) => [iso(l.start), iso(l.end)])));
      console.log("X1 emails", JSON.stringify(h.gmail.sent.map((m) => [m.subject, iso(m.at)])), "alerts", h.tg.messages.length);
      console.log("X1 history", JSON.stringify(rec.history.map((x) => `${x.at} ${x.trigger}: ${x.note}`), null, 1));
      assert(h.gmail.sent.length >= 1, "no digest at all");
      assert(h.gmail.sent[0].at <= Z("11:00"), `digest went out at ${iso(h.gmail.sent[0].at)} - after the 07:00 deadline, with Gmail working`);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "X1b same, the slow probe ends DOWN after 11 min (probe bound): when does the digest go out?",
  ...opts,
  async fn() {
    const st = { from: 2, ms: 11 * 60_000, answer: "down" as const, n: 0, log: [] as Array<{ start: number; end: number }> };
    const h = await harness({ start: Z("10:55"), gateway: "up", fetchWrap: slowProbes(st) });
    try {
      await h.clock.advanceTo(Z("11:30"));
      await until(() => h.gmail.sent.length >= 1, 20_000).catch(() => {});
      console.log("X1b emails", JSON.stringify(h.gmail.sent.map((m) => [m.subject, iso(m.at)])), "alerts", h.tg.messages.map((m) => iso(m.at)));
      assert(h.gmail.sent.length >= 1, "no digest at all");
      assert(h.gmail.sent[0].at <= Z("11:00"), `digest went out at ${iso(h.gmail.sent[0].at)} - after the 07:00 deadline, with Gmail working`);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "X2 same instant: scheduler chain-start mark + cron + L14 ensure (x2): ONE chain trigger, ONE hand-off per dep, ONE digest",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "up" });
    try {
      const adv = h.clock.advanceTo(Z("05:00"));
      const calls = await Promise.all([
        postJson(`${h.digestUrl}/routine/start`, { labelsPrefix: "brain/" }),
        postJson(`${h.digestUrl}/routine/ensure`, { labelsPrefix: "brain/" }),
        postJson(`${h.digestUrl}/routine/ensure`, { labelsPrefix: "brain/" }),
      ]);
      await adv;
      await h.clock.advanceTo(Z("12:00"));
      console.log("X2 statuses", calls.map((c) => `${c.status}:${c.body.chain}`), "pulls", h.pullCalls.map(iso), "emails", h.gmail.sent.map((m) => iso(m.at)));
      assertEquals(h.pullCalls.length, 1, "chain triggered more than once");
      assertEquals(h.gmail.sent.length, 1);
      assertEquals(h.tg.messages.length, 0);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "X3 a stray /run at 01:05 while the chain is IN PROGRESS (e.g. a manual podcast run): does the digest go out at 01:05 without the research?",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "up", pullBehaviour: "noop" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      h.health.pull = { running: true, last_run_at: null, last_error: null };
      await h.clock.advanceTo(Z("05:05"));
      await postJson(`${h.digestUrl}/run`, {});
      await h.clock.advanceTo(Z("05:10"));
      await until(() => h.gmail.sent.length >= 1, 5_000).catch(() => {});
      console.log("X3 emails", JSON.stringify(h.gmail.sent.map((m) => [m.subject, iso(m.at), /STILL RUNNING|not everything/i.test(m.html)])));
      // informational: record what happens (design note, not a fail-bar item by itself)
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "X4 crash while holding the record lock: a lock 10 min old is broken; the 07:00 digest still goes out",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("10:58"),
      gateway: "up",
      env: { ROUTINE_CHAIN_START: "23:00" },
      pre: async (s) => {
        await Deno.mkdir(s.dir, { recursive: true });
        await Deno.writeTextFile(s.lockPath(DATE), "1");
        const old = new Date(Date.now() - 10 * 60_000);
        await Deno.utime(s.lockPath(DATE), old, old);
      },
    });
    try {
      const t0 = Date.now();
      await h.clock.advanceTo(Z("11:01"));
      await until(() => h.gmail.sent.length >= 1, 20_000);
      console.log(`X4 email after ${Date.now() - t0} ms real`);
      assertEquals(h.gmail.sent.length, 1);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  ignore: Deno.build.os === "windows", // run on Linux in a container (bind mount); see evidence
  name: "X4b stale-lock break race: two store instances find the same stale lock and both increment 20x -> any lost update?",
  ...opts,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "routine-t3x-lock-" });
    try {
      let lost = 0;
      for (let round = 0; round < 10; round++) {
        const date = `2026-10-${String(10 + round).padStart(2, "0")}`;
        const a = new RoutineStore(dir), b = new RoutineStore(dir);
        await Deno.writeTextFile(a.lockPath(date), "1");
        const old = new Date(Date.now() - 10 * 60_000);
        await Deno.utime(a.lockPath(date), old, old);
        const inc = (s: RoutineStore) => s.update(date, async (r) => {
          const v = r.chain.attempts;
          await new Promise((res) => setTimeout(res, 3));
          r.chain.attempts = v + 1;
        });
        await Promise.all([...Array(20)].flatMap(() => [inc(a), inc(b)]));
        const got = (await a.load(date)).chain.attempts;
        if (got !== 40) lost += 40 - got;
      }
      console.log(`X4b lost updates over 10 rounds: ${lost}`);
      assertEquals(lost, 0, "the stale-lock break let two writers in at once");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "X5 hand-off unconfigured (blank token/channel): no request is made, recorded 'unconfigured'; chain still waits bounded",
  ...opts,
  async fn() {
    let calls = 0;
    const ch = new MattermostOwnerChannel({ url: "http://127.0.0.1:9", token: "", channelId: "", fetchFn: (() => { calls++; return Promise.reject(new Error("x")); }) as typeof fetch });
    assertEquals(await ch.request("model", "x"), "unconfigured");
    assertEquals(calls, 0);
  },
});

Deno.test({
  name: "X6 model down 01:00-20:00: hand-off ONCE per dep for the whole day; attempts not exhausted by the outage; no chain step; one alert",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "down", research: "down" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await h.clock.advanceTo(Z("00:30", "2026-10-14"));
      const rec = await h.store.load(DATE);
      const deps = h.owner.posts.map((p) => /NOT operational: (\S+)/.exec(p.message)?.[1]);
      console.log("X6 posts", deps, "pulls", h.pullCalls.length, "attempts", rec.chain.attempts, "emails", h.gmail.sent.map((m) => iso(m.at)), "alerts", h.tg.messages.length, "probes", h.gw.log.filter((l) => l.probe).length);
      assertEquals(new Set(deps).size, deps.length, "a dependency handed over twice");
      assertEquals(h.pullCalls.length, 0);
      assertEquals(rec.chain.attempts, 1);
      assertEquals(h.emails().length, 1);
      assertEquals(h.tg.messages.length, 1);
      for (const p of h.owner.posts) assert(!/operator@example|Routing|Subject/.test(p.message));
      assertEquals(h.gw.healthGets(), 0);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "X7 reboot at 23:00 local (03:00Z next UTC day) with nothing done today: no chain, no night digest; next day starts at 01:00",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("03:00", "2026-10-14"), gateway: "up" });
    try {
      await h.clock.advanceTo(Z("03:59", "2026-10-14"));
      assertEquals(h.pullCalls.length, 0, "a chain started at 23:00 local");
      assertEquals(h.gmail.sent.length, 0, "a night digest");
      await h.clock.advanceTo(Z("05:30", "2026-10-14"));
      console.log("X7 pulls", h.pullCalls.map(iso), "emails", h.gmail.sent.map((m) => [m.subject, iso(m.at)]), "alerts", h.tg.messages.map((m) => iso(m.at)));
      assert(h.pullCalls.length === 1 && h.pullCalls[0] >= Z("05:00", "2026-10-14"), "next day's chain at 01:00 local");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "X8 IN PROGRESS legitimately long: podcast research runs 3 h (heartbeat fresh, podcast /health unreadable) -> never FAILED, no 2nd chain",
  ...opts,
  async fn() {
    // podcast health unreadable, but its run record heartbeat is fresh (written by PodcastService). Simulate the
    // run record directly: a run started 01:10, heartbeat every 60 s (we refresh it as virtual time passes).
    const h = await harness({ start: Z("04:59"), gateway: "up", pullBehaviour: "noop" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      const runStart = iso(Z("05:10"));
      for (let t = Z("05:10"); t <= Z("08:10"); t += 5 * 60_000) {
        await h.store.savePodcast({ date: DATE, runs: [{ startedAt: runStart, heartbeatAt: iso(t) }] });
        await h.clock.advanceTo(t);
      }
      const rec = await h.store.load(DATE);
      console.log("X8 chain", rec.chain.status, rec.chain.attempts, rec.chain.reason ?? "", "pulls", h.pullCalls.length);
      assertEquals(rec.chain.status, "running");
      assertEquals(h.pullCalls.length, 1);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "X9 R3 ORIGINAL intent under the DEFAULT config (no pin): Gmail 500 from boot 06:29, chain fails, /run at 06:30, Gmail healthy 06:50 -> one digest before 07:00",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("10:29"),
      gateway: "up",
      runnerMode: "fail",
      mail: (real) => ({ sendHtml: (a) => (failing ? Promise.reject(new MailSendError("Gmail API error 500", true, 500)) : real.sendHtml(a)), checkAuth: () => real.checkAuth!() }),
    });

    try {
      await h.clock.advanceTo(Z("10:30"));
      await postJson(`${h.digestUrl}/run`, {});
      await h.clock.advanceTo(Z("10:45"));
      assertEquals(h.gmail.sent.length, 0);
      failing = false;
      await h.clock.advanceTo(Z("12:00"));
      await h.routine.settled();
      const st = await h.store.load(DATE);
      console.log("X9 emails", h.gmail.sent.map((m) => [m.subject, iso(m.at)]), "alerts", h.tg.messages.length, "digest", JSON.stringify(st.digest.status), st.digest.attempts);
      assertEquals(h.emails().length, 1);
      assert(h.emails()[0].at <= Z("11:00"));
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "X10 T7 ORIGINAL intent under the DEFAULT config: boot at 08:00 local, cron missed -> ONE digest + at most ONE follow-up, ONE alert at most, nothing more",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("12:00"), gateway: "up" });
    try {
      await h.clock.advanceTo(Z("23:30"));
      await h.routine.settled();
      console.log("X10 emails", h.gmail.sent.map((m) => [m.subject, iso(m.at)]), "alerts", h.tg.messages.map((m) => [iso(m.at), m.text]));
      assertEquals(h.emails().length, 1);
      assert(h.followUps().length <= 1);
      assert(h.tg.messages.length <= 1);
      assertEquals(h.pullCalls.length, 1);
    } finally {
      await h.close();
    }
  },
});
