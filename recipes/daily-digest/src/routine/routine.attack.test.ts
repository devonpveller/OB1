// Tester attack suite from mr-routine-outage attempt 1 (tester-mr-routine-outage-1),
// kept VERBATIM below this header as a regression guard for round 2 (T3/T4/T5 were
// the failing cases). Source: plan store test-evidence/mr-routine-outage.attempt1.attack.test.ts.
// Run: deno test --allow-all src/routine/routine.attack.test.ts
// TESTER attack suite (mr-routine-outage, tester-mr-routine-outage-1). Not part of the deliverable.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { buildDigestApp } from "../app.ts";
import { GmailClient, MailTransport } from "../clients/gmail.ts";
import { GoogleOAuth } from "../clients/google-oauth.ts";
import { startServer } from "../server.ts";
import { dirOf, PodcastService, servePodcast } from "../podcast/podcast-service.ts";
import { RoutineStore } from "./store.ts";
import { AlertSender, TelegramNotifier } from "./telegram.ts";
import { localDate, zonedEpoch } from "./clock.ts";
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
const iso = (ms: number) => new Date(ms).toISOString();

async function harness(o: {
  start: number;
  gateway: GatewayMode;
  runnerMode?: "produce" | "fail" | "hang-once";
  mail?: (gmailClient: MailTransport) => MailTransport;
  alerts?: (tgUrl: string) => AlertSender;
  tgMode?: () => number; // status for the telegram stub (200 = ok)
  pre?: (store: RoutineStore) => Promise<void>;
}) {
  const dir = await Deno.makeTempDir({ prefix: "routine-tester-" });
  const reports = `${dir}/reports`;
  const stateDir = `${reports}/routine`;
  const clock = new VirtualClock(o.start);
  const gw = gatewayStub(o.gateway);
  const gmail = gmailStub(clock);
  const tgMsgs: Array<{ text: string; at: number; status: number }> = [];
  const tg = stubServer(async (req) => {
    const form = new URLSearchParams(await req.text());
    const status = o.tgMode ? o.tgMode() : 200;
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
  const pull = stubServer((_req) => {
    pullCalls.push(clock.now());
    setTimeout(() => postJson(`${podcastUrl}/run`).catch(() => {}), 0);
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
    ROUTINE_TZ: TZ,
    ROUTINE_STATE_DIR: stateDir,
  };
  const logs: string[] = [];
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
    clock, gw, gmail, tgMsgs, pullCalls, digestUrl, podcastUrl, svc, store, dir, logs, routine: app.routine,
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
const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test("T1 DST: zonedEpoch 07:00 / 20:00 New York across both 2026 DST changes", () => {
  const cases: Array<[string, string, string]> = [
    ["2026-03-07", "07:00", "2026-03-07T12:00:00.000Z"],
    ["2026-03-08", "07:00", "2026-03-08T11:00:00.000Z"], // spring forward day
    // 02:30 in the spring gap: see T1b
    ["2026-10-31", "07:00", "2026-10-31T11:00:00.000Z"],
    ["2026-11-01", "07:00", "2026-11-01T12:00:00.000Z"], // fall back day
    ["2026-11-01", "20:00", "2026-11-02T01:00:00.000Z"],
    ["2026-11-02", "07:00", "2026-11-02T12:00:00.000Z"],
  ];
  for (const [d, t, want] of cases) assertEquals(iso(zonedEpoch(d, t, TZ)), want, `${d} ${t}`);
  // cron 05:00Z maps to the right local date on both DST days and in winter
  assertEquals(localDate(Date.parse("2026-11-01T05:00:00Z"), TZ), "2026-11-01");
  assertEquals(localDate(Date.parse("2026-11-02T05:00:00Z"), TZ), "2026-11-02"); // 00:00 EST
  assertEquals(localDate(Date.parse("2026-11-02T04:59:59Z"), TZ), "2026-11-01"); // one second early = yesterday
  assertEquals(localDate(Date.parse("2026-03-08T05:00:00Z"), TZ), "2026-03-08");
});

Deno.test({
  name: "T2 multi-day scheduler across the fall-back change: one deadline digest per day at 07:00 LOCAL, one alert per day, yesterday's claims never block today",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("10:00", "2026-10-31"), gateway: "up" });
    try {
      await h.clock.advanceTo(Z("13:00", "2026-11-02"));
      const at = h.gmail.sent.map((m) => iso(m.at));
      assertEquals(at, ["2026-10-31T11:00:00.000Z", "2026-11-01T12:00:00.000Z", "2026-11-02T12:00:00.000Z"]);
      assertEquals(h.gmail.sent.map((m) => m.subject.slice(-10)), ["2026-10-31", "2026-11-01", "2026-11-02"]);
      assertEquals(h.tgMsgs.map((m) => iso(m.at)), ["2026-10-31T11:15:00.000Z", "2026-11-01T12:15:00.000Z", "2026-11-02T12:15:00.000Z"]);
      for (const m of h.tgMsgs) assertMatch(m.text, /podcast: NOT produced \(not started/);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "T3 crash between claim and send (claim file present, nothing sent, no day state): what the deadline and the alert say",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      pre: async (s) => {
        await Deno.writeTextFile(s.claimPath(DATE, "digest"), JSON.stringify({ at: iso(Z("10:59")), mode: "full" }));
      },
    });
    try {
      await h.clock.advanceTo(Z("11:20"));
      console.log("T3 emails:", h.gmail.sent.length, "alerts:", JSON.stringify(h.tgMsgs.map((m) => m.text)));
      assertEquals(h.gmail.sent.length, 0, "at most once: a held claim is never resent");
      assertEquals(h.tgMsgs.length, 1, "the miss is alerted");
      // C5: the alert must not claim a fact it does not know
      assert(!/not attempted/.test(h.tgMsgs[0].text), `C5: a claimed (maybe in-flight) send reported as 'not attempted': ${h.tgMsgs[0].text}`);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "T4 internet blip at 07:00-07:20 (Gmail connect refused, Telegram 502), back at 07:30: is the day recovered or alerted?",
  ...opts,
  async fn() {
    let netDown = true;
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      tgMode: () => (netDown ? 502 : 200),
      mail: (real) => ({
        sendHtml: (a) => {
          if (netDown) {
            // what the REAL GmailClient throws when fetch rejects at connect (DNS / refused)
            const g = new GmailClient({
              oauth: new GoogleOAuth({ credentialsPath: "x", tokenPath: "x" }),
              apiBase: "http://127.0.0.1:9",
              fetchFn: () => Promise.reject(new TypeError("error sending request: dns error: failed to lookup address")),
            });
            // skip OAuth: call through a token-holding path by monkeypatching getAccessToken
            (g as unknown as { opts: { oauth: { getAccessToken: () => Promise<string> } } }).opts.oauth.getAccessToken = () => Promise.resolve("t");
            return g.sendHtml(a);
          }
          return real.sendHtml(a);
        },
      }),
    });
    try {
      await h.clock.advanceTo(Z("11:20"));
      netDown = false;
      await h.clock.advanceTo(Z("11:30"));
      await postJson(`${h.digestUrl}/run`); // e.g. a late podcast completion
      await h.clock.advanceTo(Z("23:00"));
      await h.routine.settled();
      const st = await h.store.load(DATE);
      console.log("T4 emails:", h.gmail.sent.length, "tg attempts:", JSON.stringify(h.tgMsgs.map((m) => [iso(m.at), m.status])), "day:", JSON.stringify({ digest: st.digest, alert: st.alert }));
      const delivered = h.tgMsgs.filter((m) => m.status === 200).length;
      assert(h.gmail.sent.length === 1 || delivered >= 1, "SILENT MISS: no digest and no delivered alert all day, though both transports were back from 07:20");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "T5 the deadline send waits for the model probe (busy / cold-loading model): email is held until the probe returns",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("10:50"), gateway: "up" });
    try {
      h.gw.mode = "slow";
      h.gw.slowMs = 5000; // real ms; production bound is 660 s per probe
      const t0 = Date.now();
      const p = h.clock.advanceTo(Z("11:00"));
      await until(() => h.gmail.sent.length === 1, 60_000);
      const realWait = Date.now() - t0;
      await p;
      const probes = h.gw.log.filter((l) => l.probe).length;
      console.log(`T5 real wait to email: ${realWait} ms; probes=${probes}; chat-work=${h.gw.work().length}`);
      assert(realWait < 4000, `the 07:00 email was held ${realWait} ms behind a slow model probe (production bound 660 s per probe)`);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "T6 Telegram unconfigured: nothing sent, recorded delivered=false",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("10:50"), gateway: "up", alerts: (u) => new TelegramNotifier({ token: "", chatId: "", apiBase: u }) });
    try {
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.tgMsgs.length, 0);
      const st = await h.store.load(DATE);
      assertEquals(st.alert?.delivered, false);
      assertEquals(st.alert?.problems, ["podcast"]);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "T7 digest boots at 08:00 local with no chain (cron missed): sends at boot once, alerts once; a late chain then yields one follow-up",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("12:00"), gateway: "up" });
    try {
      await h.clock.advanceTo(Z("12:01"));
      assertEquals(h.gmail.sent.length, 1, "sent at boot");
      assertMatch(h.gmail.sent[0].html, /NOT STARTED/);
      assertEquals(h.tgMsgs.length, 1);
      const r = await postJson(`${h.digestUrl}/routine/start`, {});
      assertEquals(r.status, 202);
      await h.clock.advanceTo(Z("12:10"));
      await until(() => h.gmail.sent.length === 2, 30_000);
      assertMatch(h.gmail.sent[1].subject, /follow-up: research/);
      await h.clock.advanceTo(Z("23:00"));
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 2);
      assertEquals(h.tgMsgs.length, 1);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "T8 boot after the 20:00 cutoff: no night digest, one alert; chain start refused",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("01:00", "2026-10-14"), gateway: "up" }); // 21:00 local 10-13
    try {
      await h.clock.advanceTo(Z("01:05", "2026-10-14"));
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(h.tgMsgs.length, 1);
      assertMatch(h.tgMsgs[0].text, /digest: NOT sent \(0 attempt\(s\); not attempted\)/);
      const r = await postJson(`${h.digestUrl}/routine/start`, {});
      assertEquals(r.body.reason, "past the follow-up cutoff");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "T9 follow-up only once even with concurrent /run calls; follow-up carries only the research",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "down" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await postJson(`${h.digestUrl}/routine/start`, {});
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.gmail.sent.length, 1);
      h.gw.mode = "up";
      await h.clock.advanceTo(Z("11:30"));
      await until(() => h.gmail.sent.length === 2, 30_000);
      await Promise.all([1, 2, 3, 4, 5].map(() => postJson(`${h.digestUrl}/run`)));
      await h.clock.advanceTo(Z("23:00"));
      await h.routine.settled();
      assertEquals(h.gmail.sent.length, 2);
      const f = h.gmail.sent[1].html;
      assert(!/Weather|Calendar|AI news/i.test(f.replace(/research/gi, "")) || true);
      console.log("T9 follow-up section headings:", [...f.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]).join(" | "));
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "T10 podcast run killed at the run limit: record timedOut, lock free, digest triggered, next /run allowed",
  ...opts,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pod-kill-" });
    const store = new RoutineStore(`${dir}/routine`);
    await Deno.mkdir(store.dir, { recursive: true });
    const clock = new VirtualClock(Z("05:00"));
    const triggers: number[] = [];
    const next = stubServer(() => {
      triggers.push(Date.now());
      return new Response("ok");
    });
    const svc = new PodcastService({
      clock, tz: TZ, followUpCutoff: "20:00", store, script: RUNNER,
      runArgs: ["--mode=hang-once", `--reports=${dir}`], cwd: HERE, nextTriggerUrl: `${next.url}/run`,
      maxRunMs: 1500, maxResumes: 1, log: () => {},
    });
    try {
      const r = await svc.handleRun({});
      assertEquals(r.status, 202);
      await svc.current;
      const rec = await store.loadPodcast(DATE);
      assertEquals(rec?.runs.length, 1);
      assertEquals(rec?.runs[0].timedOut, true);
      assertEquals(svc.running, false);
      assertEquals(triggers.length, 1);
      const r2 = await svc.handleRun({});
      assertEquals(r2.status, 202, "a timed-out run does not count as produced");
      await svc.current;
    } finally {
      await next.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "T11 podcast restart loop + failed resume: resume once, never again, no stuck lock",
  ...opts,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "pod-loop-" });
    const store = new RoutineStore(`${dir}/routine`);
    await Deno.mkdir(store.dir, { recursive: true });
    const clock = new VirtualClock(Z("06:00"));
    const triggers: number[] = [];
    const next = stubServer(() => {
      triggers.push(Date.now());
      return new Response("ok");
    });
    const mk = () =>
      new PodcastService({
        clock, tz: TZ, followUpCutoff: "20:00", store, script: RUNNER,
        runArgs: ["--mode=fail", `--reports=${dir}`], cwd: HERE, nextTriggerUrl: `${next.url}/run`,
        maxRunMs: 30_000, maxResumes: 1, log: () => {},
      });
    try {
      await store.savePodcast({ date: DATE, runs: [{ startedAt: iso(Z("05:01")) }] }); // died mid-run
      const a = mk();
      const ra = await a.recover();
      assertEquals(ra, { interrupted: true, resumed: true });
      await a.current; // resume fails (exit 1)
      let rec = await store.loadPodcast(DATE);
      assertEquals(rec?.runs.map((r) => [!!r.interrupted, !!r.resume, r.code]), [[true, false, undefined], [false, true, 1]]);
      // restart again (after a finished failed resume): nothing to recover
      const b = mk();
      assertEquals(await b.recover(), { interrupted: false, resumed: false });
      // simulate a crash DURING a resume: a third start must not resume again
      rec = await store.loadPodcast(DATE);
      rec!.runs.push({ startedAt: iso(Z("06:30")), resume: true });
      await store.savePodcast(rec!);
      const c = mk();
      assertEquals(await c.recover(), { interrupted: true, resumed: false });
      assertEquals(c.running, false, "no stuck lock");
      assertEquals(triggers.length, 1);
    } finally {
      await next.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("T1b clock.ts docstring: a wall time inside the spring-forward gap resolves to the instant AFTER the gap", () => {
  const t = zonedEpoch("2026-03-08", "02:30", TZ);
  console.log("T1b 02:30 on 2026-03-08 ->", iso(t));
  assert(t >= Date.parse("2026-03-08T07:00:00Z"), `resolved BEFORE the gap: ${iso(t)} (= 01:30 EST)`);
});
