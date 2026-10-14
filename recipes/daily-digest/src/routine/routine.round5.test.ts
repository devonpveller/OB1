// Round 5 (mr-routine-outage, reviews/mr-routine-outage.md B1 + F3).
//
// B1: every chain start sends the CANONICAL gmail-pull body (brain/, 90d, 500)
// unless a cron/L14 call brought its own; the harness's stub gmail-pull records
// each body it receives. One test per start path. Each is RED on the round-4
// code (08f0add), where a start without a body POSTed `{}` (gmail-pull's CLI
// defaults: SENT mail, 24h, 50).
// F3: first boot with no record + today's digest already produced -> seeded
// DONE, no send; an unreadable day.json -> fail closed, no send, logged.
//
// VIRTUAL clock, day 2026-10-13 America/New_York (EDT): 01:00 local = 05:00Z,
// 07:00 = 11:00Z. Run: deno test --allow-all src/routine/routine.round5.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { DATE, harness, iso, Z } from "./harness.ts";
import { DayRecord, writeJsonAtomic } from "./store.ts";
import { until } from "./testing.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };
const CANONICAL = { labelsPrefix: "brain/", window: "90d", limit: 500 };

type H = Awaited<ReturnType<typeof harness>>;
function assertAllCanonical(h: H, what: string) {
  console.log(`${what}: gmail-pull bodies`, JSON.stringify(h.pullBodies.map((p) => [iso(p.at), p.body])));
  assert(h.pullBodies.length >= 1, `${what}: the chain never reached gmail-pull`);
  for (const p of h.pullBodies) assertEquals(p.body, CANONICAL, `${what}: gmail-pull got ${JSON.stringify(p.body)} at ${iso(p.at)}`);
}

/** A partial record on disk (load() fills the rest from emptyDay). */
function seed(rec: Partial<DayRecord> & { chain: Partial<DayRecord["chain"]> }) {
  return async (store: { dayPath(d: string): string }) => {
    await writeJsonAtomic(store.dayPath(DATE), { date: DATE, history: [{ at: iso(Z("05:00")), trigger: "test", note: "seeded by the test" }], ...rec });
  };
}

// ── B1: one test per start path ──────────────────────────────────────────────
Deno.test({
  name: "B1a TIMER start (ROUTINE_CHAIN_START 01:00, no cron call): gmail-pull gets the canonical body",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:50"), gateway: "up" });
    try {
      await h.clock.advanceTo(Z("05:20"));
      assertEquals(h.pullBodies.length, 1);
      assert(h.pullBodies[0].at >= Z("05:00"), "started by the timer at 01:00 local");
      assertAllCanonical(h, "B1a");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "B1b BOOT start (02:00 local, no record): gmail-pull gets the canonical body",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("06:00"), gateway: "up" });
    try {
      await h.clock.advanceTo(Z("06:05"));
      assertEquals(h.pullBodies.length, 1);
      assertEquals(h.pullBodies[0].at, Z("06:00"), "started by the boot pass");
      assertAllCanonical(h, "B1b");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "B1c FAILED -> retry TICK (record FAILED with no stored body): gmail-pull gets the canonical body",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("06:00"),
      gateway: "up",
      pre: seed({ state: "failed", chain: { status: "failed", attempts: 1, startedAt: iso(Z("05:00")), failedAt: iso(Z("06:00")), reason: "gmail-pull did not answer the chain trigger" } }),
    });
    try {
      await h.clock.advanceTo(Z("06:05"));
      assertEquals(h.pullBodies.length, 0, "boot does not retry inside the re-check gap");
      await h.clock.advanceTo(Z("06:30"));
      assertEquals(h.pullBodies.length, 1);
      assert(h.pullBodies[0].at >= Z("06:10"), `retried by the tick, at ${iso(h.pullBodies[0].at)}`);
      assertEquals((await h.store.load(DATE)).chain.attempts, 2);
      assertAllCanonical(h, "B1c");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "B1d RESUMED dependency wait (no process owned it after a restart): gmail-pull gets the canonical body",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("06:00"),
      gateway: "up",
      pre: seed({
        state: "in-progress",
        chain: { status: "waiting-deps", attempts: 1, startedAt: iso(Z("05:40")), heartbeatAt: iso(Z("05:40")), waitUntil: iso(Z("06:40")) },
      }),
    });
    try {
      await h.clock.advanceTo(Z("06:05"));
      const rec = await h.store.load(DATE);
      assert(rec.history.some((x) => /resuming the dependency wait/.test(x.note)), "the wait was resumed");
      assertEquals(h.pullBodies.length, 1);
      assertAllCanonical(h, "B1d");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "B1e the send-digest.ts AD-HOC command (POST /routine/ensure with no body, and with the old '{}'): gmail-pull gets the canonical body",
  ...opts,
  async fn() {
    for (const body of [undefined, "{}"]) {
      // 00:00 local: before ROUTINE_CHAIN_START, so neither boot nor the timer starts a chain.
      const h = await harness({ start: Z("04:00"), gateway: "up" });
      try {
        await h.clock.advanceTo(Z("04:01"));
        assertEquals(h.pullBodies.length, 0);
        const r = await fetch(`${h.digestUrl}/routine/ensure`, { method: "POST", ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }) });
        assertEquals(r.status, 200);
        await r.body?.cancel();
        await h.clock.settle();
        await h.clock.advanceTo(Z("04:05"));
        assertEquals(h.pullBodies.length, 1, `ad-hoc (${body ?? "no body"}) started the chain once`);
        assertAllCanonical(h, `B1e (${body ?? "no body"})`);
      } finally {
        await h.close();
      }
    }
  },
});

Deno.test({
  name: "B1f CRON (body given): the cron body reaches gmail-pull, and the day's RETRIES reuse it (not '{}')",
  ...opts,
  async fn() {
    // The timer is pinned late so only cron starts the chain; gmail-pull fails, so the routine retries.
    const h = await harness({ start: Z("04:59"), gateway: "up", pullFails: true, env: { ROUTINE_CHAIN_START: "23:00" } });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await h.clock.advanceTo(Z("06:30"));
      assert(h.pullBodies.length >= 2, `a retry happened (${h.pullBodies.length} pulls)`);
      assertAllCanonical(h, "B1f");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "B1g a cron/L14 body still WINS over the default, for the first start and for its retries",
  ...opts,
  async fn() {
    const custom = { labelsPrefix: "brain/", window: "7d", limit: 50 };
    const h = await harness({ start: Z("04:59"), gateway: "up", pullFails: true, env: { ROUTINE_CHAIN_START: "23:00" } });
    try {
      await h.clock.advanceTo(Z("05:00"));
      const r = await fetch(`${h.digestUrl}/routine/ensure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(custom) });
      await r.body?.cancel();
      await h.clock.settle();
      await h.clock.advanceTo(Z("06:30"));
      console.log("B1g bodies", JSON.stringify(h.pullBodies.map((p) => [iso(p.at), p.body])));
      assert(h.pullBodies.length >= 2, `a retry happened (${h.pullBodies.length} pulls)`);
      for (const p of h.pullBodies) assertEquals(p.body, custom);
    } finally {
      await h.close();
    }
  },
});

// ── F3: first boot after deploy / an unreadable record ───────────────────────
async function legacyArtifacts(reports: string, digestIso: string, brief = true) {
  await Deno.mkdir(reports, { recursive: true });
  const ts = digestIso.replace(/[:.]/g, "-");
  await Deno.writeTextFile(`${reports}/openbrain-digest-${ts}.md`, "# Open Brain Daily Digest (sent by the pre-routine code)\n");
  await Deno.writeTextFile(`${reports}/openbrain-digest-latest.md`, "# Open Brain Daily Digest (sent by the pre-routine code)\n");
  if (brief) {
    await Deno.writeTextFile(
      `${reports}/podcast-brief-latest.json`,
      JSON.stringify({
        generatedAt: digestIso,
        date: digestIso.slice(0, 10),
        episode: { name: "001-legacy", title: "Daily #001", viewUrl: null, downloadUrl: null },
        segments: [{ label: "brain/test", items: [{ title: "Legacy", url: "https://example.test/a", keyPoints: ["k"], preliminary: [], gaps: [], emailOnly: false }] }],
        followUps: [],
      }),
    );
  }
}
const reportsOf = (store: { dir: string }) => store.dir.replace(/[\\/]routine$/, "");

Deno.test({
  name: "FB1 first boot 09:00 local, NO record, today's digest + brief already produced by the old code at 08:40: record seeded DONE/sent, nothing sent all day",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("13:00"), gateway: "up", pre: (store) => legacyArtifacts(reportsOf(store), iso(Z("12:40"))) });
    try {
      await h.clock.advanceTo(Z("13:05"));
      const rec = await h.store.load(DATE);
      assertEquals(rec.state, "done");
      assertEquals(rec.digest.status, "sent");
      assertEquals(rec.chain.status, "done");
      assertMatch(rec.history[0].note, /seeded DONE at first boot: today's digest was already produced at 08:40 local/);
      await h.clock.advanceTo(Z("23:30"));
      assertEquals(h.gmail.sent.length, 0, "never a second digest");
      assertEquals(h.pullBodies.length, 0, "no chain re-run");
      assertEquals(h.tg.messages.length, 0, "no alert");
      for (const p of ["/routine/start", "/routine/ensure", "/run"]) {
        const r = await fetch(`${h.digestUrl}${p}`, { method: "POST" });
        await r.body?.cancel();
      }
      await h.clock.advanceTo(Z("23:45"));
      assertEquals(h.gmail.sent.length, 0);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "FB2 first boot, NO record, today's digest report only (no brief): seeded DONE, nothing sent",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("13:00"), gateway: "up", pre: (store) => legacyArtifacts(reportsOf(store), iso(Z("12:40")), false) });
    try {
      await h.clock.advanceTo(Z("16:00"));
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(h.pullBodies.length, 0);
      assertEquals((await h.store.load(DATE)).digest.status, "sent");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "FB3 control: the latest report is YESTERDAY's local date (23:00 local 10-12) -> not evidence; today runs normally",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("13:00"), gateway: "up", pre: (store) => legacyArtifacts(reportsOf(store), iso(Z("03:00")), false) });
    try {
      await h.clock.advanceTo(Z("13:10"));
      await until(() => h.gmail.sent.length >= 1, 20_000).catch(() => {});
      assertEquals(h.emails().length, 1, "today's digest goes out once");
      assertEquals(h.pullBodies.length, 1);
      assert(!(await h.store.load(DATE)).history.some((x) => /seeded/.test(x.note)));
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "FB4 an UNREADABLE day.json fails closed: no chain, no send, no alert all day, the file untouched, a logged reason, /routine/* 503",
  ...opts,
  async fn() {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    };
    const garbage = '{"date":"2026-10-13","state":"in-progr';
    let dayPath = "";
    const h = await harness({
      start: Z("13:00"),
      gateway: "up",
      pre: async (store) => {
        dayPath = store.dayPath(DATE);
        await Deno.writeTextFile(dayPath, garbage);
      },
    });
    try {
      await h.clock.advanceTo(Z("13:05"));
      const r = await fetch(`${h.digestUrl}/routine/ensure`, { method: "POST" });
      assertEquals(r.status, 503);
      assertMatch(String((await r.json()).error), /unreadable \(invalid JSON\) - failing closed/);
      await h.clock.advanceTo(Z("23:30"));
      assertEquals(h.gmail.sent.length, 0, "no send");
      assertEquals(h.pullBodies.length, 0, "no chain");
      assertEquals(h.tg.messages.length, 0);
      assertEquals(await Deno.readTextFile(dayPath), garbage, "the record is left as it is");
      const lines = errors.filter((l) => /day record 2026-10-13 is unreadable \(invalid JSON\) - failing closed: no chain start, no send/.test(l));
      assertEquals(lines.length, 1, `logged once per cause: ${JSON.stringify(errors)}`);
    } finally {
      console.error = orig;
      await h.close();
    }
  },
});
