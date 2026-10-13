// Tester attack suite from mr-routine-outage attempt 2 (tester-mr-routine-outage-2),
// the round-3 REGRESSION SUITE (R2, R3, R8, R9 must pass). Source: plan store
// test-evidence/mr-routine-outage.attempt2.attack.test.ts. Kept as written EXCEPT
// where it reached into round-1/2 machinery the round-3 redesign REMOVED (claim
// files, force, phase/unconfirmed/outcome fields). Each port is marked
// "ROUND-3 PORT:"; scenarios and intent unchanged:
//  - R1: "unconfirmed:false + claim released" -> digest.status "failed"
//    (definitely not sent); alert.outcome -> alert.lastOutcome.
//  - R3: the 06:30 "forced" /run is now a plain /run (there is no force); the
//    hasClaim() log line is dropped. The assertion (07:00 digest still goes out) is unchanged.
//  - R5: an unknown outcome is no longer re-sent by an explicit force (removed);
//    without the Sent-folder check it stays unknown and is never resent - the
//    final force step now asserts that /run does NOT resend. Alert text
//    "send unconfirmed" -> "send outcome unknown".
//  - R6/R6b: claims -> records left "sending" by a dead process / an alert already delivered.
// Run: deno test --allow-all src/routine/routine.attack2.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { buildDigestApp } from "../app.ts";
import { GmailClient, MailSendError, MailTransport } from "../clients/gmail.ts";
import { GoogleOAuth } from "../clients/google-oauth.ts";
import { startServer } from "../server.ts";
import { dirOf, PodcastService, servePodcast } from "../podcast/podcast-service.ts";
import { RoutineStore } from "./store.ts"; // ROUND-3 PORT: no claims; records only
import { AlertSender, TelegramNotifier } from "./telegram.ts";
import { failedBeforeSend } from "./net-errors.ts";
import {
  activity,
  brainStub,
  fakeOAuthFiles,
  gatewayStub,
  GatewayMode,
  gmailStub,
  guardNetwork,
  postJson,
  stubServer,
  until,
  VirtualClock,
} from "./testing.ts";

guardNetwork();

const TZ = "America/New_York";
const DATE = "2026-10-13";
const Z = (hhmm: string, date = DATE) => Date.parse(`${date}T${hhmm}:00Z`);
const HERE = dirOf(import.meta.url);
const RUNNER = `${HERE}fixtures/fake-runner.ts`;
const iso = (ms: number) => new Date(ms).toISOString();
const opts = { sanitizeOps: false, sanitizeResources: false };

/** Real outbound calls in flight (Windows connect-refused takes ~2 s real): the virtual clock must wait for them. */
let inflight = 0;
function track<T>(p: Promise<T>): Promise<T> {
  inflight++;
  return p.finally(() => inflight--);
}

/** A loopback port with nothing listening (real connect-refused). */
function closedPort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

type H = Awaited<ReturnType<typeof harness>>;
async function harness(o: {
  start: number;
  gateway: GatewayMode;
  runnerMode?: "produce" | "fail" | "hang-once";
  mail?: (real: MailTransport, oauth: { credentialsPath: string; tokenPath: string }) => MailTransport;
  alerts?: (tgUrl: string) => AlertSender;
  tgStatus?: () => number;
  pullHealth?: () => Response;
  pruneHealth?: () => Response;
  pullBehaviour?: "chain" | "noop";
  pre?: (store: RoutineStore) => Promise<void>;
  env?: Record<string, string>;
}) {
  const dir = await Deno.makeTempDir({ prefix: "routine-t2-" });
  const reports = `${dir}/reports`;
  const stateDir = `${reports}/routine`;
  const clock = new VirtualClock(o.start);
  const gw = gatewayStub(o.gateway);
  const gmail = gmailStub(clock);
  const tgMsgs: Array<{ text: string; at: number; status: number }> = [];
  const tg = stubServer(async (req) => {
    const form = new URLSearchParams(await req.text());
    const status = o.tgStatus ? o.tgStatus() : 200;
    tgMsgs.push({ text: form.get("text") ?? "", at: clock.now(), status });
    if (status !== 200) return Response.json({ ok: false }, { status });
    return Response.json({ ok: true, result: { message_id: tgMsgs.length } });
  });
  const brain = brainStub();
  const store = new RoutineStore(stateDir);
  await Deno.mkdir(stateDir, { recursive: true });
  if (o.pre) await o.pre(store);
  const ac = new AbortController();
  let digestUrl = "";
  const svc = new PodcastService({
    clock,
    tz: TZ,
    followUpCutoff: "20:00",
    store,
    script: RUNNER,
    runArgs: [`--mode=${o.runnerMode ?? "produce"}`, `--reports=${reports}`],
    cwd: HERE,
    get nextTriggerUrl() {
      return `${digestUrl}/run`;
    },
    maxRunMs: 60_000,
    maxResumes: 1,
    log: () => {},
  } as ConstructorParameters<typeof PodcastService>[0]);
  const podcastSrv = servePodcast(svc, { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} });
  const podcastUrl = `http://127.0.0.1:${podcastSrv.addr.port}`;
  activity.busy.push(() => svc.running);
  const pullCalls: number[] = [];
  const health = {
    pull: { running: false, last_run_at: null as string | null, last_error: null as string | null },
    prune: { running: false, last_run_at: null as string | null, last_error: null as string | null },
  };
  const pull = stubServer((req, path) => {
    if (req.method === "GET" && path === "/health") return o.pullHealth ? o.pullHealth() : Response.json(health.pull);
    if (req.method === "GET" && path === "/prune/health") return o.pruneHealth ? o.pruneHealth() : Response.json(health.prune);
    pullCalls.push(clock.now());
    const t = new Date(clock.now()).toISOString();
    health.pull = { running: false, last_run_at: t, last_error: null };
    health.prune = { running: false, last_run_at: t, last_error: null };
    if ((o.pullBehaviour ?? "chain") === "chain") setTimeout(() => postJson(`${podcastUrl}/run`).catch(() => {}), 0);
    return Response.json({ started: true }, { status: 202 });
  });
  const oauth = await fakeOAuthFiles(`${dir}/oauth`);
  const realGmail = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: gmail.url });
  const env: Record<string, string> = {
    DIGEST_TO: "operator@example.test",
    DIGEST_REPORT_DIR: reports,
    OPEN_BRAIN_URL: brain.url,
    LOCAL_LLM_BASE: `${gw.url}/v1`,
    LOCAL_EMBED_BASE: `${gw.url}/v1`,
    CONSIDERATIONS_SYNTH: "false",
    CHAIN_HEAD_URL: `${pull.url}/run`,
    PODCAST_HEALTH_URL: `${podcastUrl}/health`,
    PULL_HEALTH_URL: `${pull.url}/health`,
    PRUNE_HEALTH_URL: `${pull.url}/prune/health`,
    ROUTINE_TZ: TZ,
    ROUTINE_STATE_DIR: stateDir,
    // ROUND-3 PORT: this suite was written when only cron started the chain. Round 3's
    // timer also starts a chain cron missed (from ROUTINE_CHAIN_START). Pinning it after
    // the cutoff makes every scenario start exactly as written (no chain unless the test
    // calls /routine/start itself). Tests that call cron are unaffected.
    ROUTINE_CHAIN_START: "23:00",
    ...(o.env ?? {}),
  };
  const app = buildDigestApp({
    env: (k) => env[k],
    scriptDir: `${dir}/oauth/`,
    clock,
    mail: o.mail ? o.mail(realGmail, oauth) : realGmail,
    alerts: o.alerts ? o.alerts(tg.url) : new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: tg.url }),
  });
  const digestSrv = startServer({ routine: app.routine, port: 0, hostname: "127.0.0.1", signal: ac.signal });
  digestUrl = `http://127.0.0.1:${digestSrv.addr.port}`;
  activity.busy.push(() => inflight > 0);
  app.routine.start();
  await clock.settle();
  return {
    clock, gw, gmail, tgMsgs, pullCalls, digestUrl, podcastUrl, svc, store, dir, routine: app.routine, health,
    delivered: () => tgMsgs.filter((m) => m.status === 200),
    async close() {
      await app.routine.stop();
      await clock.settle().catch(() => {});
      await svc.current?.catch(() => {});
      activity.busy.length = 0;
      ac.abort();
      await Promise.allSettled([digestSrv.finished, podcastSrv.finished]);
      await Promise.all([gw.close(), gmail.close(), tg.close(), brain.close(), pull.close()]);
      inflight = 0;
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}
async function cron(h: H) {
  const r = await postJson(`${h.digestUrl}/routine/start`, { labelsPrefix: "brain/", window: "90d", limit: 500 });
  await h.clock.settle();
  return r;
}

// ── R1 own T4: REAL connect-refused on both transports 07:00-07:20, then healthy ──────────
Deno.test({
  name: "R1 T4-own: real refused Gmail + Telegram 07:00-07:20 -> exactly 1 email, exactly 1 delivered alert with 'digest: sent'",
  ...opts,
  async fn() {
    let down = true;
    const port = closedPort();
    const h = await harness({
      start: Z("04:59"),
      gateway: "down", // model down all morning -> podcast not produced, alert has a reason to exist
      mail: (real, oauth) => {
        const bad = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: `http://127.0.0.1:${port}` });
        return { sendHtml: (a) => track((down ? bad : real).sendHtml(a)) };
      },
      alerts: (u) => {
        const good = new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: u });
        const bad = new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: `http://127.0.0.1:${port}` });
        return { configured: true, send: (t) => track((down ? bad : good).send(t)) };
      },
    });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await cron(h);
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.gmail.sent.length, 0);
      const st = await h.store.load(DATE);
      console.log("R1 at 07:20:", JSON.stringify({ digest: st.digest, alert: st.alert, chain: st.chain }));
      assertEquals(st.digest?.status, "failed", "refused = definitely not sent"); // ROUND-3 PORT
      assertEquals(st.alert?.lastOutcome, "not-delivered"); // ROUND-3 PORT
      down = false;
      await h.clock.advanceTo(Z("11:40"));
      assertEquals(h.gmail.sent.length, 1, "digest delivered at a retry pass");
      assertEquals(h.delivered().length, 1, "alert delivered once");
      assertMatch(h.delivered()[0].text, /digest: sent/);
      assertMatch(h.delivered()[0].text, /podcast: NOT produced/);
      await postJson(`${h.digestUrl}/run`);
      h.gw.mode = "up"; // model back at 07:40: the chain runs, research arrives as the ONE follow-up
      await h.clock.advanceTo(Z("00:05", "2026-10-14"));
      await h.routine.settled();
      const subj = h.gmail.sent.map((m) => m.subject);
      console.log("R1 subjects", JSON.stringify(subj));
      assertEquals(subj.filter((x) => !/follow-up/.test(x)).length, 1, "no duplicate digest all day");
      assertEquals(subj.filter((x) => /follow-up/.test(x)).length, 1, "one follow-up");
      assertEquals(h.delivered().length, 1, "no duplicate alert");
      console.log("R1 first email at", iso(h.gmail.sent[0].at), "alert at", iso(h.delivered()[0].at));
    } finally {
      await h.close();
    }
  },
});

// ── R1b Telegram 429 at 07:15 x3, then ok: alert delivered at the next pass, once ─────────
Deno.test({
  name: "R1b Telegram 429 for the first 3 tries then ok: alert delivered exactly once at a later pass",
  ...opts,
  async fn() {
    let n = 0;
    const h = await harness({ start: Z("10:50"), gateway: "up", runnerMode: "fail", tgStatus: () => (++n <= 3 ? 429 : 200) });
    try {
      await h.clock.advanceTo(Z("12:30"));
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 1);
      assertEquals(h.delivered().length, 1);
      await h.clock.advanceTo(Z("23:59"));
      assertEquals(h.delivered().length, 1);
      assertEquals(h.tgMsgs.length, 4, "3 refused + 1 delivered, nothing more");
    } finally {
      await h.close();
    }
  },
});

// ── R2 timeouts are always 'maybe sent': a black-holed network at 07:00-07:20 ──────────────
Deno.test({
  name: "R2 black-holed network 07:00-07:20 (both transports time out), healthy after: is anything delivered that day?",
  ...opts,
  async fn() {
    let down = true;
    const timeout = () => Promise.reject(new DOMException("Signal timed out.", "TimeoutError"));
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      runnerMode: "fail",
      mail: (real, oauth) => {
        const bad = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: "http://127.0.0.1:9", fetchFn: timeout as typeof fetch });
        return { sendHtml: (a) => track((down ? bad : real).sendHtml(a)) };
      },
      alerts: (u) => {
        const good = new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: u });
        const bad = new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: u, fetchFn: timeout as typeof fetch });
        return { configured: true, send: (t) => track((down ? bad : good).send(t)) };
      },
    });
    try {
      // the podcast run before 07:00 fails (runner mode fail) -> digest /run triggered; let it go through BEFORE the blackhole?
      // No chain was started, so the deadline is the first send.
      await h.clock.advanceTo(Z("11:20"));
      down = false;
      await h.clock.advanceTo(Z("23:59"));
      await h.routine.settled();
      const st = await h.store.load(DATE);
      console.log("R2 emails:", h.gmail.sent.length, "delivered alerts:", h.delivered().length, "day:", JSON.stringify({ digest: st.digest, alert: st.alert }));
      assert(h.gmail.sent.length >= 1 || h.delivered().length >= 1, "SILENT MISS: no email and no alert all day after a 20-minute black-hole");
    } finally {
      await h.close();
    }
  },
});

// ── R3 a forced send that DEFINITELY fails before 07:00 must not suppress the day's digest ──
Deno.test({
  name: "R3 forced /run at 06:30 while Gmail answers 500; Gmail healthy from 06:50 -> the 07:00 digest still goes out",
  ...opts,
  async fn() {
    // ROUND-3 PORT: no chain at boot (the timer would start the chain cron missed, and send before Gmail breaks)
    const h = await harness({ start: Z("10:29"), gateway: "up", runnerMode: "fail", env: { ROUTINE_CHAIN_START: "23:00" } });
    try {
      h.gmail.mode = "fail500";
      await h.clock.advanceTo(Z("10:30"));
      await postJson(`${h.digestUrl}/run`, {}); // ROUND-3 PORT: no force; /run = "the pipeline ended"
      await h.clock.advanceTo(Z("10:45"));
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 0);
      h.gmail.mode = "ok";
      await h.clock.advanceTo(Z("12:00"));
      await h.routine.settled();
      const st = await h.store.load(DATE);
      console.log("R3 emails:", h.gmail.sent.length, "alerts:", JSON.stringify(h.delivered().map((m) => m.text)), "digest:", JSON.stringify(st.digest));
      assertEquals(h.gmail.sent.length, 1, "MISSED 07:00 SEND while the transport works (a failed force kept the claim)");
    } finally {
      await h.close();
    }
  },
});

// ── R4 bounded retries: Gmail 401 + Telegram 502 all day ───────────────────────────────────
Deno.test({
  name: "R4 Gmail 401 + Telegram 502 all day: attempts bounded (<= 1 per 10 min after 07:15), none after 20:00, next day unaffected",
  ...opts,
  async fn() {
    let gmailUp = false;
    const auth = stubServer(() => Response.json({ error: { code: 401, message: "invalid credentials" } }, { status: 401 }));
    let authCalls = 0;
    let tgUp = false;
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      runnerMode: "fail",
      mail: (real, oauth) => {
        const bad = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: auth.url });
        return { sendHtml: (a) => (authCalls++, gmailUp ? real.sendHtml(a) : bad.sendHtml(a)) };
      },
      tgStatus: () => (tgUp ? 200 : 502),
    });
    try {
      await h.clock.advanceTo(Z("00:30", "2026-10-14"));
      await h.routine.settled();
      const byCutoff = authCalls;
      const tgByCutoff = h.tgMsgs.length;
      console.log(`R4 gmail attempts to 20:00 = ${byCutoff}; telegram attempts = ${tgByCutoff}`);
      assert(byCutoff <= 3 + 80, `gmail attempts ${byCutoff}`);
      assert(tgByCutoff <= 3 + 80, `telegram attempts ${tgByCutoff}`);
      const late = h.tgMsgs.filter((m) => m.at > Z("00:00", "2026-10-14"));
      assertEquals(late.length, 0, "no telegram after the 20:00 cutoff");
      assertEquals(h.gmail.sent.length, 0);
      // next day: healthy
      gmailUp = true;
      tgUp = true;
      const before = authCalls;
      await h.clock.advanceTo(Z("11:30", "2026-10-14"));
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 1, "next day digest once");
      assertMatch(h.gmail.sent[0].subject, /2026-10-14/);
      assertEquals(authCalls - before, 1);
    } finally {
      await h.close();
      await auth.close();
    }
  },
});

// ── R5 maybe-sent (reset after the request left) is never retried by passes; force sends one ──
Deno.test({
  name: "R5 'maybe sent' at 07:00 (connection closed mid-request): no retry pass ever resends; alert 'unconfirmed' once; explicit force sends exactly one",
  ...opts,
  async fn() {
    let ambiguous = true;
    let ambCalls = 0;
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      runnerMode: "fail",
      mail: (real, oauth) => {
        const amb = new GmailClient({
          oauth: new GoogleOAuth(oauth),
          apiBase: "http://127.0.0.1:9",
          fetchFn: (() => Promise.reject(new TypeError("error sending request for url (http://x/): client error (SendRequest): connection closed before message completed"))) as typeof fetch,
        });
        return { sendHtml: (a) => (ambiguous ? (ambCalls++, amb.sendHtml(a)) : real.sendHtml(a)) };
      },
    });
    try {
      await h.clock.advanceTo(Z("11:05"));
      ambiguous = false;
      await h.clock.advanceTo(Z("23:59"));
      await h.routine.settled();
      assertEquals(ambCalls, 1);
      assertEquals(h.gmail.sent.length, 0, "never resent after a maybe-sent");
      assertEquals(h.delivered().length, 1);
      assertMatch(h.delivered()[0].text, /send outcome unknown/); // ROUND-3 PORT: wording
      // ROUND-3 PORT: force is removed; a later /run must NOT resend an unknown outcome
      await postJson(`${h.digestUrl}/run`, {});
      await h.clock.settle();
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(ambCalls, 1);
      const st = await h.store.load(DATE);
      assertEquals(st.digest.status, "unknown");
    } finally {
      await h.close();
    }
  },
});

// ── R6 T3-own: crash points ────────────────────────────────────────────────────────────────
Deno.test({
  name: "R6 T3-own: crash after send but before the day record (claim + phase sending, mail actually went) -> no resend, alert says outcome unknown",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("11:01"),
      gateway: "up",
      runnerMode: "fail",
      pre: async (s) => {
        // ROUND-3 PORT: a record left "sending" by a dead process (no claim files)
        await s.update(DATE, (d) => {
          Object.assign(d.digest, { status: "sending", attempts: 1, sendingAt: iso(Z("11:00")), sendingBy: "dead", lastAttemptAt: iso(Z("11:00")) });
        });
      },
    });
    try {
      await h.clock.advanceTo(Z("23:00"));
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(h.delivered().length, 1);
      assertMatch(h.delivered()[0].text, /send outcome unknown/); // ROUND-3 PORT: wording
      assert(!/not attempted|send failed/.test(h.delivered()[0].text));
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "R6b crash mid-follow-up (followup claim, no followUp record) -> no second follow-up; crash mid-alert (alert claim, no alert record) -> no second alert",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("11:30"),
      gateway: "up",
      pre: async (s) => {
        // ROUND-3 PORT: follow-up left "sending" by a dead process, alert already delivered
        await s.update(DATE, (d) => {
          Object.assign(d.digest, {
            status: "sent", attempts: 1, sentAt: iso(Z("11:00")), mode: "deadline", included: [],
            pending: [{ section: "podcast_brief", state: "waiting for the model", detail: "x", mayFollow: true }],
          });
          Object.assign(d.followUp, { status: "sending", attempts: 1, sendingAt: iso(Z("11:25")), sendingBy: "dead", lastAttemptAt: iso(Z("11:25")) });
          Object.assign(d.alert, { status: "delivered", tries: 1, firstAt: iso(Z("11:15")), lastAt: iso(Z("11:15")), lastOutcome: "delivered" });
        });
      },
    });
    try {
      await postJson(`${h.podcastUrl}/run`);
      await h.clock.advanceTo(Z("23:00"));
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(h.tgMsgs.length, 0);
    } finally {
      await h.close();
    }
  },
});

// ── R7 T5-own: the lock is not held across the Gmail transport ──────────────────────────────
Deno.test({
  name: "R7 T5-own: while the 07:00 send is stuck 5 s in the Gmail transport, /routine/start and /health answer within 1 s",
  ...opts,
  async fn() {
    const slow = stubServer(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return Response.json({ id: "x" });
    });
    let slowCalls = 0;
    const h = await harness({
      start: Z("10:59"),
      gateway: "up",
      mail: (_real, oauth) => {
        const g = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: slow.url });
        return { sendHtml: (a) => (slowCalls++, g.sendHtml(a)) };
      },
    });
    try {
      const p = h.clock.advanceTo(Z("11:00"));
      await until(() => slowCalls === 1, 20_000);
      const t0 = Date.now();
      const r = await fetch(`${h.digestUrl}/routine/start`, { method: "POST", body: "{}" });
      await r.body?.cancel();
      const t1 = Date.now() - t0;
      const hr = await fetch(`${h.digestUrl}/health`);
      await hr.body?.cancel();
      const t2 = Date.now() - t0;
      console.log(`R7 /routine/start answered in ${t1} ms (status ${r.status}); /health by ${t2} ms`);
      assert(t1 < 1000, `/routine/start blocked ${t1} ms behind the transport -> lock held across I/O`);
      await p;
    } finally {
      await h.close();
      await slow.close();
    }
  },
});

// ── R8 send in flight at 07:15 that later fails definitely: is it retried? ─────────────────
Deno.test({
  name: "R8 a /run send failing (Gmail 500) across the 07:15 check: once Gmail heals at 07:30 is the digest still sent that day?",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("10:59"), gateway: "up", runnerMode: "fail" });
    try {
      h.gmail.mode = "fail500";
      await h.clock.advanceTo(Z("11:13")); // deadline: 3 failed attempts, claim released
      await postJson(`${h.digestUrl}/run`); // e.g. the podcast's chain trigger at 07:13: 07:13, 07:14, 07:15 attempts
      await h.clock.advanceTo(Z("11:20"));
      h.gmail.mode = "ok";
      await h.clock.advanceTo(Z("23:59"));
      await h.routine.settled();
      const st = await h.store.load(DATE);
      console.log("R8 emails:", h.gmail.sent.length, "attempts:", h.gmail.attempts, "alerts:", JSON.stringify(h.delivered().map((m) => m.text)), "digest:", JSON.stringify(st.digest));
      assertEquals(h.gmail.sent.length, 1, "MISSED: Gmail healthy from 07:20 but the digest never went out");
    } finally {
      await h.close();
    }
  },
});

// ── R9 pull restarted after it finished; prune still running at 07:00 -> must not say FAILED ──
Deno.test({
  name: "R9 gmail-pull restarted after handing off (health: never ran), prune still RUNNING at 07:00 -> digest must not claim FAILED/no follow-up",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("04:59"),
      gateway: "up",
      pullBehaviour: "noop",
      pullHealth: () => Response.json({ running: false, last_run_at: null, last_error: null }),
      pruneHealth: () => Response.json({ running: true, last_run_at: null, last_error: null }),
    });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await cron(h);
      await h.clock.advanceTo(Z("11:01"));
      assertEquals(h.gmail.sent.length, 1);
      const d = h.gmail.sent[0].html;
      const m = /Researched feeds &amp; podcast: [^<]*/.exec(d)?.[0];
      console.log("R9 notice:", m);
      assert(!/FAILED/.test(d), `false FAILED while prune is running: ${m}`);
    } finally {
      await h.close();
    }
  },
});

// ── R10 pull/prune health endpoints DOWN while the chain is still in the pull ──────────────
Deno.test({
  name: "R10 PULL_HEALTH_URL unreachable (500) while the chain is in flight: what does the 07:00 digest say?",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("04:59"),
      gateway: "up",
      pullBehaviour: "noop",
      pullHealth: () => new Response("boom", { status: 500 }),
      pruneHealth: () => new Response("boom", { status: 500 }),
    });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await cron(h);
      await h.clock.advanceTo(Z("11:01"));
      const m = /Researched feeds &amp; podcast: [^<]*/.exec(h.gmail.sent[0]?.html ?? "")?.[0];
      console.log("R10 notice:", m);
    } finally {
      await h.close();
    }
  },
});

// ── R11 retry passes on the fall-back day (EST): refused until 07:20 local ──────────────────
Deno.test({
  name: "R11 fall-back day 2026-11-01: Gmail refused until 07:20 EST -> one digest at a 07:2x pass (12:2xZ), one alert",
  ...opts,
  async fn() {
    const D = "2026-11-01";
    let down = true;
    const port = closedPort();
    const h = await harness({
      start: Z("11:50", D),
      gateway: "up",
      runnerMode: "fail",
      mail: (real, oauth) => {
        const bad = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: `http://127.0.0.1:${port}` });
        return { sendHtml: (a) => track((down ? bad : real).sendHtml(a)) };
      },
    });
    try {
      await h.clock.advanceTo(Z("11:30", D)); // 06:30 EST is 11:30Z: nothing yet
      assertEquals(h.gmail.sent.length, 0);
      await h.clock.advanceTo(Z("12:20", D));
      down = false;
      await h.clock.advanceTo(Z("14:00", D));
      await h.routine.settled();
      console.log("R11", h.gmail.sent.map((m) => iso(m.at)), JSON.stringify(await h.store.load(D)));
      assertEquals(h.gmail.sent.length, 1);
      console.log("R11 sent at", iso(h.gmail.sent[0].at));
      assert(h.gmail.sent[0].at >= Z("12:20", D) && h.gmail.sent[0].at <= Z("12:31", D));
      assertEquals(h.delivered().length, 1);
    } finally {
      await h.close();
    }
  },
});

// ── R12 classification table: real Deno errors where we can make them on loopback ──────────
Deno.test({ name: "R12 failedBeforeSend on real loopback errors (refused, TLS against plain HTTP, reset mid-response) and known strings", ...opts, async fn() {
  const results: Record<string, boolean> = {};
  // real refused
  try {
    await fetch(`http://127.0.0.1:${closedPort()}/x`, { method: "POST", body: "a" });
  } catch (e) {
    results[`refused: ${(e as Error).message.slice(0, 120)}`] = failedBeforeSend(e);
  }
  // real TLS handshake failure: https to a plain TCP server that answers garbage
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  (async () => {
    for await (const c of l) {
      const buf = new Uint8Array(1024);
      await c.read(buf).catch(() => null);
      await c.write(new TextEncoder().encode("HTTP/1.1 400 Bad\r\n\r\n")).catch(() => {});
      c.close();
    }
  })();
  try {
    await fetch(`https://127.0.0.1:${(l.addr as Deno.NetAddr).port}/x`, { method: "POST", body: "a" });
  } catch (e) {
    results[`tls: ${(e as Error).message.slice(0, 160)}`] = failedBeforeSend(e);
  }
  l.close();
  // real reset after the request was read (request DID reach the server)
  const l2 = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  (async () => {
    for await (const c of l2) {
      const buf = new Uint8Array(65536);
      await c.read(buf).catch(() => null);
      c.close();
    }
  })();
  try {
    await fetch(`http://127.0.0.1:${(l2.addr as Deno.NetAddr).port}/x`, { method: "POST", body: "a" });
  } catch (e) {
    results[`closed-after-read: ${(e as Error).message.slice(0, 160)}`] = failedBeforeSend(e);
  }
  l2.close();
  const strings: Record<string, string> = {
    dns: "error sending request for url (https://gmail.googleapis.com/x): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution",
    proxyTunnel: "error sending request for url (https://gmail.googleapis.com/x): client error (Connect): unsuccessful tunnel",
    bodyWrite: "error sending request for url (https://gmail.googleapis.com/x): client error (SendRequest): connection error: connection reset by peer",
    timeout: "Signal timed out.",
  };
  for (const [k, m] of Object.entries(strings)) results[`str ${k}`] = failedBeforeSend(new TypeError(m));
  console.log("R12", JSON.stringify(results, null, 1));
  assertEquals(results["str bodyWrite"], false, "a reset after the request started stays maybe-sent");
  for (const [k, v] of Object.entries(results)) if (k.startsWith("closed-after-read")) assertEquals(v, false, k);
  for (const [k, v] of Object.entries(results)) if (k.startsWith("refused")) assertEquals(v, true, k);
} });

// ── R13 MailSendError status for 4xx/5xx is definite; non-MailSendError from transport ─────
Deno.test({ name: "R13 GmailClient: 401 and 503 with a response -> definite; token refresh failure -> definite", ...opts, async fn() {
  const s = stubServer((req) => new URL(req.url).searchParams.get("x") ? new Response("", { status: 503 }) : Response.json({}, { status: 401 }));
  const dir = await Deno.makeTempDir();
  const oauth = await fakeOAuthFiles(dir);
  try {
    for (const st of [401, 503]) {
      const srv = stubServer(() => new Response("{}", { status: st }));
      const g = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: srv.url });
      try {
        await g.sendHtml({ to: "a@example.test", from: "a@example.test", subject: "s", htmlBody: "h" } as never);
        throw new Error("no throw");
      } catch (e) {
        assert(e instanceof MailSendError);
        assertEquals(e.definite, true, `status ${st}`);
        assertEquals(e.status, st);
      }
      await srv.close();
    }
  } finally {
    await s.close();
    await Deno.remove(dir, { recursive: true });
  }
} });
