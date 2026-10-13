// Morning-routine scenarios (mr-routine-outage), on a VIRTUAL clock.
//
// What is real here: the openbrain-digest service as send-digest.ts builds it
// (src/app.ts: sections, orchestrator, renderers, MorningRoutine, HTTP server
// on a real port), the REAL GmailClient talking to a stub Gmail API, the REAL
// TelegramNotifier talking to a stub Bot API, the REAL model probe against a
// stub LLM gateway that serves the exact 2026-10-13 502 body, and the REAL
// PodcastService (HTTP + run lock + run record + a real subprocess). The only
// stand-ins: gmail-pull/prune (a stub that records the trigger and fires the
// podcast, as prune does) and the podcast's runner subprocess
// (fixtures/fake-runner.ts - link-enrich cannot follow a virtual clock; the
// real link-enrich is driven by link-enrich.e2e.test.ts in real time).
// guardNetwork(): any non-loopback fetch throws, so nothing can really send.
//
// Times: the routine day is 2026-10-13 America/New_York (EDT, UTC-4):
// 01:00 local = 05:00Z, the 07:00 deadline = 11:00Z, the alert = 11:15Z.
//
// Run: deno test --allow-all src/routine/routine.e2e.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { buildDigestApp } from "../app.ts";
import { GmailClient, MailTransport } from "../clients/gmail.ts";
import { GoogleOAuth } from "../clients/google-oauth.ts";
import { startServer } from "../server.ts";
import { dirOf, PodcastService, servePodcast } from "../podcast/podcast-service.ts";
import { RoutineStore } from "./store.ts";
import { AlertSender, TelegramNotifier } from "./telegram.ts";
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
  telegramStub,
  until,
  VirtualClock,
} from "./testing.ts";

guardNetwork();

const TZ = "America/New_York";
const DATE = "2026-10-13";
const Z = (hhmm: string, date = DATE) => Date.parse(`${date}T${hhmm}:00Z`);
const HERE = dirOf(import.meta.url);
const RUNNER = `${HERE}fixtures/fake-runner.ts`;

interface Harness {
  clock: VirtualClock;
  gw: ReturnType<typeof gatewayStub>;
  gmail: ReturnType<typeof gmailStub>;
  tg: ReturnType<typeof telegramStub>;
  pullCalls: number[];
  digestUrl: string;
  podcastUrl: string;
  svc: PodcastService;
  store: RoutineStore;
  dir: string;
  routine: ReturnType<typeof buildDigestApp>["routine"];
  close(): Promise<void>;
}

async function harness(o: {
  start: number;
  gateway: GatewayMode;
  runnerMode?: "produce" | "fail" | "hang-once";
  mail?: (gmailClient: MailTransport) => MailTransport;
  /** Telegram transport override (receives the stub's URL). */
  alerts?: (tgUrl: string) => AlertSender;
  /** gmail-pull "fails": its /health reports last_error and nothing chains on. */
  pullFails?: boolean;
  pre?: (store: RoutineStore) => Promise<void>;
}): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix: "routine-e2e-" });
  const reports = `${dir}/reports`;
  const stateDir = `${reports}/routine`;
  const clock = new VirtualClock(o.start);
  const gw = gatewayStub(o.gateway);
  const gmail = gmailStub(clock);
  const tg = telegramStub(clock);
  const brain = brainStub();
  const store = new RoutineStore(stateDir);
  const ac = new AbortController();

  // podcast: the REAL service, runner = fixture
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

  // gmail-pull + prune stand-in: record, then trigger the podcast as prune does.
  // GET /health answers like pull-gmail.ts / prune-short-term.ts do.
  const pullCalls: number[] = [];
  const health = {
    pull: { running: false, last_run_at: null as string | null, last_error: null as string | null },
    prune: { running: false, last_run_at: null as string | null, last_error: null as string | null },
  };
  const pull = stubServer((req, path) => {
    if (req.method === "GET" && path === "/health") return Response.json(health.pull);
    if (req.method === "GET" && path === "/prune/health") return Response.json(health.prune);
    pullCalls.push(clock.now());
    const t = new Date(clock.now()).toISOString();
    if (o.pullFails) {
      health.pull = { running: false, last_run_at: t, last_error: "Gmail API error 500" };
    } else {
      health.pull = { running: false, last_run_at: t, last_error: null };
      health.prune = { running: false, last_run_at: t, last_error: null };
      setTimeout(() => postJson(`${podcastUrl}/run`).catch(() => {}), 0);
    }
    return Response.json({ started: true }, { status: 202 });
  });
  await Deno.mkdir(stateDir, { recursive: true });
  if (o.pre) await o.pre(store);

  const oauth = await fakeOAuthFiles(`${dir}/oauth`);
  const realGmail = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: gmail.url });
  assert(gmail.url.startsWith("http://127.0.0.1"), "fail closed: the Gmail API must be the stub");
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
    ROUTINE_SEND_BY: "07:00",
    ROUTINE_ALERT_GRACE_MIN: "15",
    ROUTINE_FOLLOWUP_CUTOFF: "20:00",
    ROUTINE_STATE_DIR: stateDir,
    MODEL_GATE_INITIAL_MS: "30000",
    MODEL_GATE_MAX_MS: "300000",
  };
  const app = buildDigestApp({
    env: (k) => env[k],
    scriptDir: `${dir}/oauth/`,
    clock,
    mail: o.mail ? o.mail(realGmail) : realGmail,
    alerts: o.alerts ? o.alerts(tg.url) : new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: tg.url }),
  });
  const digestSrv = startServer({ routine: app.routine, port: 0, hostname: "127.0.0.1", signal: ac.signal });
  digestUrl = `http://127.0.0.1:${digestSrv.addr.port}`;
  app.routine.start();
  await clock.settle();

  return {
    clock,
    gw,
    gmail,
    tg,
    pullCalls,
    digestUrl,
    podcastUrl,
    svc,
    store,
    dir,
    routine: app.routine,
    async close() {
      await app.routine.stop();
      await clock.settle().catch(() => {});
      await svc.current?.catch(() => {});
      activity.busy.length = 0;
      ac.abort();
      await Promise.allSettled([digestSrv.finished, podcastSrv.finished]);
      await Promise.all([gw.close(), gmail.close(), tg.close(), brain.close(), pull.close()]);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

async function cron(h: Harness) {
  const r = await postJson(`${h.digestUrl}/routine/start`, { labelsPrefix: "brain/", window: "90d", limit: 500 });
  await h.clock.settle();
  return r;
}

const iso = (ms: number) => new Date(ms).toISOString();

Deno.test({
  name: "A1 outage 01:00-03:00: nothing runs while down; the chain resumes at 03:00 and the FULL digest goes out before 07:00 exactly once",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "down" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      const r = await cron(h);
      assertEquals(r.status, 202);

      await h.clock.advanceTo(Z("06:59"));
      assertEquals(h.pullCalls.length, 0, "no chain step may start while the model is down");
      assertEquals(h.gw.work().length, 0, "no model work while down - only 1-token probes");
      assertEquals(h.gmail.sent.length, 0);
      assertEquals((await h.store.load(DATE)).chain?.modelDownSince, iso(Z("05:00")));

      h.gw.mode = "up"; // 03:00 local
      await h.clock.advanceTo(Z("07:00"));
      await h.clock.advanceTo(Z("07:06"));
      assertEquals(h.pullCalls.length, 1);
      assert(h.pullCalls[0] >= Z("07:00") && h.pullCalls[0] <= Z("07:05"), `resumed at ${iso(h.pullCalls[0])}`);
      await until(() => h.gmail.sent.length === 1);
      const [mail] = h.gmail.sent;
      assertEquals(mail.subject, `Open Brain Daily Digest — ${DATE}`);
      assert(mail.at < Z("11:00"), `sent before the deadline: ${iso(mail.at)}`);
      assertMatch(mail.html, /Key point A from research/, "the research section is IN the digest");
      assert(!/not everything is ready|STILL RUNNING|WAITING FOR THE MODEL/i.test(mail.html), "a full digest carries no pending notice");

      await h.clock.advanceTo(Z("13:00")); // through the deadline and the alert check
      assertEquals(h.gmail.sent.length, 1, "exactly once");
      assertEquals(h.tg.messages.length, 0, "nothing to alert about");
      const st = await h.store.load(DATE);
      assertEquals(st.digest?.mode, "full");
      assertEquals(st.digest?.pending, []);
      assertEquals(h.gw.healthGets(), 0, "LiteLLM /health never touched");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "A2 outage 01:00-08:00: digest at 07:00 with the research marked waiting; one alert; after 08:00 ONE follow-up delivers it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "down" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      assertEquals((await cron(h)).status, 202);
      await h.clock.advanceTo(Z("10:59"));
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(h.pullCalls.length, 0);

      await h.clock.advanceTo(Z("11:00")); // 07:00 local
      assertEquals(h.gmail.sent.length, 1, "the deadline send");
      const d = h.gmail.sent[0];
      assertEquals(d.at, Z("11:00"));
      assertEquals(d.subject, `Open Brain Daily Digest — ${DATE}`);
      assertMatch(d.html, /Sent at the 07:00 deadline/);
      assertMatch(d.html, /Researched feeds &amp; podcast: WAITING FOR THE MODEL - down since 01:00 local/);
      assertMatch(d.html, /follow-up email will deliver it/);
      assertMatch(d.html, /model was unreachable at send time/);
      assert(!/Key point A/.test(d.html), "nothing that did not run is shown as done");

      await h.clock.advanceTo(Z("11:15"));
      assertEquals(h.tg.messages.length, 1, "one alert: the podcast was not produced by 07:15");
      const alert = h.tg.messages[0].text;
      assertMatch(alert, /digest: sent/);
      assertMatch(alert, /podcast: NOT produced \(waiting for the model: down since 01:00 local\)/);
      assert(!/@|http|Routing notes|Key point/i.test(alert), `content-free: ${alert}`);

      await h.clock.advanceTo(Z("11:59"));
      h.gw.mode = "up"; // 08:00 local
      await h.clock.advanceTo(Z("12:06"));
      assertEquals(h.pullCalls.length, 1, "the chain started once the model came back");
      await until(() => h.gmail.sent.length === 2);
      const f = h.gmail.sent[1];
      assertEquals(f.subject, `Open Brain Daily Digest — ${DATE} (follow-up: research)`);
      assertMatch(f.html, /Key point A from research/);
      assertMatch(f.html, /not ready at 07:00 finished/);

      // late re-triggers the same day: nothing new
      assertEquals((await cron(h)).body.reason, "already delivered today");
      await postJson(`${h.digestUrl}/run`);
      await postJson(`${h.digestUrl}/run`);
      await h.clock.advanceTo(Z("03:00", "2026-10-14")); // 23:00 local, still 10-13
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 2, "digest + exactly one follow-up");
      assertEquals(h.tg.messages.length, 1, "exactly one alert");
      assertEquals(h.gw.healthGets(), 0);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "A3 total failure (Gmail 500 all day, model down all day): bounded retries, no email, exactly ONE content-free alert",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "down" });
    h.gmail.mode = "fail500";
    try {
      await h.clock.advanceTo(Z("05:00"));
      await cron(h);
      await h.clock.advanceTo(Z("11:10"));
      assertEquals(h.gmail.attempts, 3, "1 + 2 retries of a definite failure, then stop");
      assertEquals(h.gmail.sent.length, 0);
      await h.clock.advanceTo(Z("11:15"));
      assertEquals(h.tg.messages.length, 1);
      const t = h.tg.messages[0].text;
      assertMatch(t, /digest: NOT sent \(3 attempt\(s\); send failed\)/);
      assertMatch(t, /podcast: NOT produced/);
      assert(!/@|http|operator|Subject|backend error/i.test(t), `content-free: ${t}`);

      // later triggers may retry the send (the claim was released: nothing went out) but never re-alert
      await postJson(`${h.digestUrl}/run`);
      await h.clock.advanceTo(Z("12:00")); // (the chain task still waits for the model: no settled() here)
      // 3 at the deadline + 3 for the /run + one per 10-min retry pass (07:25, 07:35, 07:45, 07:55)
      assertEquals(h.gmail.attempts, 10, "definite failures are retried (nothing had gone out), bounded");
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(h.tg.messages.length, 1, "still exactly one alert");
      const st = await h.store.load(DATE);
      assertEquals(st.alert?.problems, ["digest", "podcast"]);
      assert(st.alert?.delivered);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "A3b an AMBIGUOUS send failure (no answer) is never retried - no possible duplicate - and is alerted as unconfirmed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let calls = 0;
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      // the request leaves, the connection dies before an answer
      mail: () => {
        const dir = Deno.makeTempDirSync();
        const creds = `${dir}/c.json`, tok = `${dir}/t.json`;
        Deno.writeTextFileSync(creds, JSON.stringify({ installed: { client_id: "x", client_secret: "y", redirect_uris: [] } }));
        Deno.writeTextFileSync(tok, JSON.stringify({ access_token: "a", refresh_token: "r", token_type: "Bearer", expiry_date: Date.now() + 86400_000 }));
        return new GmailClient({
          oauth: new GoogleOAuth({ credentialsPath: creds, tokenPath: tok }),
          apiBase: "http://127.0.0.1:9",
          fetchFn: () => {
            calls++;
            return Promise.reject(new TypeError("connection reset"));
          },
        });
      },
    });
    try {
      await h.clock.advanceTo(Z("11:00"));
      assertEquals(calls, 1, "ambiguous: one attempt, no retry");
      await postJson(`${h.digestUrl}/run`);
      await h.clock.advanceTo(Z("11:15"));
      await h.routine.settled();
      assertEquals(calls, 1, "a later /run does not resend over an unconfirmed send");
      assertEquals(h.tg.messages.length, 1);
      assertMatch(h.tg.messages[0].text, /digest: NOT sent \(1 attempt\(s\); send unconfirmed \(may have gone out\)\)/);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "A4 re-runs after a successful send send nothing new; only an explicit force re-sends",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "up" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await cron(h);
      await until(() => h.gmail.sent.length === 1);
      await h.clock.settle();

      const again = await cron(h);
      assertEquals(again.status, 200);
      assertEquals(again.body.reason, "already delivered today");
      const pod = await postJson(`${h.podcastUrl}/run`);
      assertEquals(pod.status, 200, "the podcast does not re-run a produced day");
      assertMatch(String(pod.body.reason), /already produced today/);
      await postJson(`${h.digestUrl}/run`);
      await h.clock.settle();
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 1, "nothing new");

      await postJson(`${h.digestUrl}/run`, { force: true });
      await h.clock.settle();
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 2, "an explicit force re-sends");
      const st = await h.store.load(DATE);
      assertEquals(st.forced?.length, 1);

      await h.clock.advanceTo(Z("12:00"));
      assertEquals(h.gmail.sent.length, 2, "the deadline does not add a third");
      assertEquals(h.tg.messages.length, 0);
      assertEquals(h.pullCalls.length, 1);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "A6 the podcast FAILS before 07:00: the digest says FAILED (never empty-as-done), no follow-up promised, one alert",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "up", runnerMode: "fail" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await cron(h);
      await until(() => h.gmail.sent.length === 1);
      const d = h.gmail.sent[0];
      assertMatch(d.html, /Researched feeds &amp; podcast: FAILED - podcast run ended without output \(exit 1/);
      assertMatch(d.html, /No follow-up will come/);
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.gmail.sent.length, 1);
      assertEquals(h.tg.messages.length, 1);
      assertMatch(h.tg.messages[0].text, /podcast: NOT produced \(failed/);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "A7 two digest processes on one state dir (restart overlap): ONE digest and ONE alert - the durable marker, not the in-process lock, decides",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "routine-two-" });
    const clock = new VirtualClock(Z("10:59"));
    const gw = gatewayStub("down");
    const gmail = gmailStub(clock);
    const tg = telegramStub(clock);
    const brain = brainStub();
    try {
      const oauth = await fakeOAuthFiles(`${dir}/oauth`);
      const env: Record<string, string> = {
        DIGEST_TO: "operator@example.test",
        DIGEST_REPORT_DIR: `${dir}/reports`,
        OPEN_BRAIN_URL: brain.url,
        LOCAL_LLM_BASE: `${gw.url}/v1`,
        LOCAL_EMBED_BASE: `${gw.url}/v1`,
        CONSIDERATIONS_SYNTH: "false",
        ROUTINE_STATE_DIR: `${dir}/reports/routine`,
      };
      const mk = () =>
        buildDigestApp({
          env: (k) => env[k],
          scriptDir: `${dir}/oauth/`,
          clock,
          mail: new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: gmail.url }),
          alerts: new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: tg.url }),
        }).routine;
      const a = mk(), b = mk();
      await clock.advanceTo(Z("11:00"));
      await Promise.all([a.onDeadline(DATE), b.onDeadline(DATE)]);
      assertEquals(gmail.sent.length, 1, "two processes at the deadline -> one email");
      await clock.advanceTo(Z("11:15"));
      await Promise.all([a.checkAlert(DATE), b.checkAlert(DATE)]);
      assertEquals(tg.messages.length, 1, "two processes at the alert check -> one alert");
      // a third process booting later (container restart after 07:15) re-runs both checks
      const c = mk();
      c.start();
      await clock.advanceTo(Z("11:30"));
      await c.stop();
      assertEquals(gmail.sent.length, 1);
      assertEquals(tg.messages.length, 1);
    } finally {
      await Promise.all([gw.close(), gmail.close(), tg.close(), brain.close()]);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── round 2 (tester attempt 1: T3 / T4 / T5, pull dies) ─────────────────────

/** A real fetch that goes to a CLOSED loopback port while `down()` - the real
 *  connect-refused error, i.e. the request never left - and to the stub otherwise. */
function blipFetch(down: () => boolean): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (!down()) return fetch(input, init);
    const u = new URL(input instanceof Request ? input.url : String(input));
    u.port = "9";
    // real I/O the virtual clock must wait for (Windows takes ~2 s to refuse)
    activity.inFlight++;
    return fetch(u.toString(), init).finally(() => {
      activity.inFlight--;
      activity.ticks++;
    });
  }) as typeof fetch;
}

Deno.test({
  name: "A8 (T4) internet blip 07:00-07:20 (Gmail + Telegram connect refused): a later pass sends the digest ONCE and delivers the alert ONCE",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let netDown = true;
    const oauthDir = await Deno.makeTempDir({ prefix: "blip-oauth-" });
    const oauth = await fakeOAuthFiles(oauthDir);
    let gmailUrl = "";
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      mail: () =>
        new GmailClient({
          oauth: new GoogleOAuth(oauth),
          get apiBase() {
            return gmailUrl;
          },
          fetchFn: blipFetch(() => netDown),
        } as ConstructorParameters<typeof GmailClient>[0]),
      alerts: (tgUrl) => new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: tgUrl, fetchFn: blipFetch(() => netDown) }),
    });
    gmailUrl = h.gmail.url;
    try {
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(h.tg.messages.length, 0, "Telegram could not take it either");
      let st = await h.store.load(DATE);
      assertEquals(st.digest?.phase, "failed", "connect refused = definitely NOT sent (marker released)");
      assertEquals(st.digest?.unconfirmed, false);
      assertEquals(st.alert?.outcome, "not-delivered");
      netDown = false; // 07:20
      await h.clock.advanceTo(Z("11:30"));
      assertEquals(h.gmail.sent.length, 1, "the 07:25 pass sent the digest");
      assertEquals(h.tg.messages.length, 1, "the 07:25 pass delivered the alert");
      assertMatch(h.tg.messages[0].text, /digest: sent/, "fresh facts at delivery time");
      assertMatch(h.tg.messages[0].text, /podcast: NOT produced/);
      await postJson(`${h.digestUrl}/run`); // a late podcast completion
      await h.clock.advanceTo(Z("03:00", "2026-10-14"));
      assertEquals(h.gmail.sent.length, 1, "exactly once");
      assertEquals(h.tg.messages.length, 1, "exactly once");
      st = await h.store.load(DATE);
      assertEquals(st.alert?.delivered, true);
    } finally {
      await h.close();
      await Deno.remove(oauthDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "A9 (T3) a restart mid-BUILD still sends that day's digest; a crash after the CLAIM is never resent and the alert says 'outcome unknown', not 'not attempted'",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // (a) died mid-build at 06:59 local: building phase, no claim -> boot at 07:05 sends
    const a = await harness({
      start: Z("11:05"),
      gateway: "up",
      pre: async (s) => {
        await s.update(DATE, (d) => {
          d.digest = { attempts: 0, phase: "building", buildStartedAt: iso(Z("10:59")) };
        });
      },
    });
    try {
      await a.clock.advanceTo(Z("11:06"));
      assertEquals(a.gmail.sent.length, 1, "nothing went out, so the day is still sendable");
    } finally {
      await a.close();
    }
    // (b) died between claim and send: at most once -> no resend; the alert tells the truth
    const b = await harness({
      start: Z("10:50"),
      gateway: "up",
      pre: async (s) => {
        await Deno.writeTextFile(s.claimPath(DATE, "digest"), JSON.stringify({ at: iso(Z("10:59")) }));
        await s.update(DATE, (d) => {
          d.digest = { attempts: 0, phase: "sending", claimedAt: iso(Z("10:59")) };
        });
      },
    });
    try {
      await b.clock.advanceTo(Z("12:00"));
      assertEquals(b.gmail.sent.length, 0);
      assertEquals(b.tg.messages.length, 1);
      const t = b.tg.messages[0].text;
      assertMatch(t, /digest: NOT sent \(0 attempt\(s\); claimed 06:59 local send outcome unknown/);
      assert(!/not attempted/.test(t), t);
    } finally {
      await b.close();
    }
  },
});

Deno.test({
  name: "A10 (T5) the 07:00 send does not wait on a model probe: a 5 s-slow gateway does not delay the email",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await harness({ start: Z("10:50"), gateway: "up" });
    try {
      h.gw.mode = "slow";
      h.gw.slowMs = 5000;
      const t0 = Date.now();
      const p = h.clock.advanceTo(Z("11:00"));
      await until(() => h.gmail.sent.length === 1, 60_000);
      const realWait = Date.now() - t0;
      await p;
      assert(realWait < 4000, `the 07:00 email was held ${realWait} ms`);
      assertEquals(h.gw.log.filter((l) => l.probe).length, 0, "no probe at the deadline");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "A11 gmail-pull dies: the 07:00 digest says FAILED (the chain stopped), promises no follow-up, one alert",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "up", pullFails: true });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await cron(h);
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.gmail.sent.length, 1);
      const d = h.gmail.sent[0].html;
      assertMatch(d, /Researched feeds &amp; podcast: FAILED - gmail pull failed/);
      assertMatch(d, /No follow-up will come/);
      assert(!/follow-up email will deliver/.test(d), "no promise that cannot be kept");
      assertEquals(h.tg.messages.length, 1);
      assertMatch(h.tg.messages[0].text, /podcast: NOT produced \(failed: gmail pull failed/);
    } finally {
      await h.close();
    }
  },
});
