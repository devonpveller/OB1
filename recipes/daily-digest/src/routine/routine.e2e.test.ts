// Morning-routine scenarios, round 3: every trigger goes through ensureToday()
// and every state's action is exercised. VIRTUAL clock; harness.ts says what is
// real. Day 2026-10-13 America/New_York (EDT): 01:00 local = 05:00Z, the 07:00
// deadline = 11:00Z, the alert check = 11:15Z, the 20:00 cutoff = 2026-10-14T00:00Z.
//
// Run: deno test --allow-all src/routine/routine.e2e.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { GmailClient, MailSendError } from "../clients/gmail.ts";
import { GoogleOAuth } from "../clients/google-oauth.ts";
import { buildDigestApp } from "../app.ts";
import { TelegramNotifier } from "./telegram.ts";
import { RoutineStore } from "./store.ts";
import { closedPort, DATE, harness, iso, tracked, Z } from "./harness.ts";
import { brainStub, fakeOAuthFiles, gatewayStub, gmailStub, postJson, telegramStub, until, VirtualClock } from "./testing.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

// ── NOT STARTED -> dependency check -> start ────────────────────────────────
Deno.test({
  name: "S1 outage 01:00-03:00: NOT STARTED -> deps down -> handed to the owner ONCE -> bounded wait -> FAILED -> retried when back -> FULL digest before 07:00, once, DONE",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "down" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      const r = await h.cron();
      assertEquals(r.body.chain, "waiting-deps");
      await h.clock.advanceTo(Z("06:59"));
      assertEquals(h.pullCalls.length, 0, "no chain step while the model is down");
      assertEquals(h.gw.work().length, 0, "no model work while down - only 1-token probes");
      assertEquals(h.gmail.sent.length, 0);
      const st = await h.store.load(DATE);
      assertEquals(st.chain.status, "failed", "the 60-min dependency wait ended -> FAILED with the reason");
      assertMatch(st.chain.reason ?? "", /dependency not operational: model/);
      assertEquals(st.chain.attempts, 1, "a dependency check that finds the model down consumes no retry attempt");
      assertEquals(h.owner.posts.length, 1, "handed to its owner once");
      assertEquals(h.owner.posts[0].at, Z("05:00"), "handed over when first seen down, not later");
      assertMatch(h.owner.posts[0].message, /dependency NOT operational: model/);
      assertMatch(h.owner.posts[0].message, /StackWatchdog/);
      assert(!/@example|Subject|Routing/.test(h.owner.posts[0].message), "hand-off is content-free");

      h.gw.mode = "up"; // 03:00 local
      await h.clock.advanceTo(Z("07:00"));
      await h.clock.advanceTo(Z("07:11"));
      assertEquals(h.pullCalls.length, 1, "the FAILED -> deps-ok -> retry started the chain once");
      assert(h.pullCalls[0] >= Z("07:00") && h.pullCalls[0] <= Z("07:10"), `resumed at ${iso(h.pullCalls[0])}`);
      await until(() => h.gmail.sent.length === 1);
      const [mail] = h.gmail.sent;
      assertEquals(mail.subject, `Open Brain Daily Digest — ${DATE}`);
      assert(mail.at < Z("11:00"));
      assertMatch(mail.html, /Key point A from research/);
      assert(!/not everything is ready|STILL RUNNING|WAITING/i.test(mail.html));
      assertEquals(mail.marker, `${DATE};digest`, "carries the Sent-folder marker");

      await h.clock.advanceTo(Z("13:00"));
      assertEquals(h.gmail.sent.length, 1, "exactly once");
      assertEquals(h.tg.messages.length, 0);
      const fin = await h.store.load(DATE);
      assertEquals(fin.state, "done");
      assertEquals(h.gw.healthGets(), 0, "LiteLLM /health never touched");
    } finally {
      await h.close();
    }
  },
});

// ── the deadline / follow-up / alert through the state machine ───────────────
Deno.test({
  name: "S2 outage 01:00-08:00: 07:00 digest marks the research WAITING FOR THE MODEL; ONE alert at 07:15; after 08:00 the retry runs and ONE follow-up delivers it",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "down" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await h.clock.advanceTo(Z("10:59"));
      assertEquals(h.gmail.sent.length, 0);
      await h.clock.advanceTo(Z("11:00"));
      assertEquals(h.gmail.sent.length, 1, "the deadline send");
      const d = h.gmail.sent[0];
      assertEquals(d.at, Z("11:00"));
      assertMatch(d.html, /Sent at the 07:00 deadline/);
      assertMatch(d.html, /Researched feeds &amp; podcast: WAITING FOR THE MODEL - down since 01:00 local/);
      assertMatch(d.html, /follow-up email will deliver it if it completes today/);
      assert(!/Key point A/.test(d.html));
      await h.clock.advanceTo(Z("11:15"));
      assertEquals(h.tg.messages.length, 1);
      assertMatch(h.tg.messages[0].text, /digest: sent/);
      assertMatch(h.tg.messages[0].text, /podcast: NOT produced \(waiting for the model: down since 01:00 local\)/);
      assert(!/@|http|Routing notes|Key point/i.test(h.tg.messages[0].text));

      h.gw.mode = "up"; // 08:00 local
      await h.clock.advanceTo(Z("12:00"));
      await h.clock.advanceTo(Z("12:11"));
      assertEquals(h.pullCalls.length, 1);
      await until(() => h.gmail.sent.length === 2);
      assertEquals(h.gmail.sent[1].subject, `Open Brain Daily Digest — ${DATE} (follow-up: research)`);
      assertMatch(h.gmail.sent[1].html, /Key point A from research/);
      assertEquals(h.gmail.sent[1].marker, `${DATE};followup`);

      // every later trigger: DONE -> nothing
      for (const p of ["/routine/start", "/routine/ensure", "/run"]) await postJson(`${h.digestUrl}${p}`, {});
      await h.clock.advanceTo(Z("03:00", "2026-10-14"));
      assertEquals(h.gmail.sent.length, 2);
      assertEquals(h.tg.messages.length, 1);
      assertEquals((await h.store.load(DATE)).state, "done");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S3 total failure (Gmail 500 + model down all day): one attempt per re-check, none after the cutoff, 0 emails, exactly ONE content-free alert",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "down" });
    h.gmail.mode = "fail500";
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.gmail.attempts, 3, "07:00, 07:10, 07:20");
      assertEquals(h.tg.messages.length, 1);
      const t = h.tg.messages[0].text;
      assertMatch(t, /digest: NOT sent \(2 attempt\(s\); send failed \(MailSendError 500\) retrying\)/, "07:00 + 07:10 by the 07:15 alert");
      assertMatch(t, /podcast: NOT produced/);
      assert(!/@|http|operator|Subject|backend error/i.test(t), t);
      await h.clock.advanceTo(Z("04:00", "2026-10-14"));
      assert(h.gmail.attempts <= 3 + 6 * 13, `bounded: ${h.gmail.attempts}`);
      assertEquals(h.gmail.sent.length, 0);
      assertEquals(h.tg.messages.length, 1, "still exactly one alert");
      const st = await h.store.load(DATE);
      assertEquals(st.state, "failed");
      assertEquals(st.alert.status, "delivered");
    } finally {
      await h.close();
    }
  },
});

// ── UNKNOWN send outcome -> the Sent folder decides ───────────────────────────
function ambiguousAfterDelivery(real: GmailClient, gmailUrl: string, oauth: { credentialsPath: string; tokenPath: string }) {
  // The request REACHES Gmail (the stub records it), then the connection dies: maybe-sent.
  let calls = 0;
  const g = new GmailClient({
    oauth: new GoogleOAuth(oauth),
    apiBase: gmailUrl,
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const r = await fetch(input, init);
      await r.body?.cancel();
      throw new TypeError("error sending request: client error (SendRequest): connection closed before message completed");
    }) as typeof fetch,
  });
  void real;
  return { client: g, calls: () => calls };
}

Deno.test({
  name: "S4 unknown outcome, Sent check ENABLED, the mail IS in Sent -> resolved as sent, never resent, DONE",
  ...opts,
  async fn() {
    let amb: ReturnType<typeof ambiguousAfterDelivery> | null = null;
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      runnerMode: "fail",
      sentCheck: true,
      mail: (real, oauth, url) => (amb = ambiguousAfterDelivery(real as GmailClient, url, oauth)).client,
    });
    try {
      await h.clock.advanceTo(Z("11:30"));
      assertEquals(amb!.calls(), 1, "never resent");
      assertEquals(h.gmail.sent.length, 1, "it did go out once");
      const st = await h.store.load(DATE);
      assertEquals(st.digest.status, "sent");
      assertEquals(st.digest.verified, true);
      assertMatch(st.digest.verifyNote ?? "", /found in Sent/);
      assert(h.gmail.reads > 0, "the Sent folder was read");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S5 unknown outcome, Sent check ENABLED, NOT in Sent -> sent again ONCE (no duplicate in the mailbox)",
  ...opts,
  async fn() {
    let first = true;
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      runnerMode: "fail",
      sentCheck: true,
      mail: (real) => ({
        sendHtml: (a) => {
          if (first) {
            first = false;
            return Promise.reject(new MailSendError("no answer - may or may not have been sent", false));
          }
          return real.sendHtml(a);
        },
        checkAuth: () => Promise.resolve(),
      }),
    });
    try {
      await h.clock.advanceTo(Z("11:30"));
      assertEquals(h.gmail.sent.length, 1, "exactly one in the mailbox");
      const st = await h.store.load(DATE);
      assertEquals(st.digest.status, "sent");
      assertEquals(st.digest.attempts, 2);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S6 unknown outcome with the Sent check NOT enabled (the deployed gmail.send-only token): no resend all day; the alert says why",
  ...opts,
  async fn() {
    let amb: ReturnType<typeof ambiguousAfterDelivery> | null = null;
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      runnerMode: "fail",
      mail: (real, oauth, url) => (amb = ambiguousAfterDelivery(real as GmailClient, url, oauth)).client,
    });
    try {
      await h.clock.advanceTo(Z("04:00", "2026-10-14"));
      assertEquals(amb!.calls(), 1);
      assertEquals(h.tg.messages.length, 1);
      assertMatch(h.tg.messages[0].text, /send outcome unknown \(Sent-folder check not enabled/);
      assertEquals((await h.store.load(DATE)).digest.status, "unknown");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S7 Sent check configured but the token is send-only (403): unavailable -> stays unknown, no resend",
  ...opts,
  async fn() {
    let amb: ReturnType<typeof ambiguousAfterDelivery> | null = null;
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      runnerMode: "fail",
      sentCheck: true,
      sentReadForbidden: true,
      mail: (real, oauth, url) => (amb = ambiguousAfterDelivery(real as GmailClient, url, oauth)).client,
    });
    try {
      await h.clock.advanceTo(Z("12:00"));
      assertEquals(amb!.calls(), 1);
      const st = await h.store.load(DATE);
      assertEquals(st.digest.status, "unknown");
      assertMatch(st.digest.verifyNote ?? "", /403 \(token lacks a read scope\)/);
    } finally {
      await h.close();
    }
  },
});

// ── IN PROGRESS -> verify activity ────────────────────────────────────────────
Deno.test({
  name: "S8 IN PROGRESS: prune RUNNING while pull reads 'never ran' -> still in progress, no false FAILED (R9); stale with nothing running -> FAILED with the reason",
  ...opts,
  async fn() {
    let pruneRunning = true;
    const h = await harness({
      start: Z("04:59"),
      gateway: "up",
      pullBehaviour: "noop",
      pullHealth: () => Response.json({ running: false, last_run_at: null, last_error: null }),
      pruneHealth: () => Response.json({ running: pruneRunning, last_run_at: null, last_error: null }),
      env: { ROUTINE_MAX_CHAIN_ATTEMPTS: "1" },
    });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await h.clock.advanceTo(Z("06:30"));
      let st = await h.store.load(DATE);
      assertEquals(st.chain.status, "running", "prune is running: active");
      await h.clock.advanceTo(Z("11:01"));
      assertMatch(h.gmail.sent[0].html, /STILL RUNNING - gmail prune/);
      pruneRunning = false; // prune dies silently at 07:01
      await h.clock.advanceTo(Z("11:40"));
      st = await h.store.load(DATE);
      assertEquals(st.chain.status, "failed");
      assertMatch(st.chain.reason ?? "", /no activity since/);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S9 health endpoints unreadable (500) while the chain runs: STATUS UNKNOWN, not FAILED (C5)",
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
      await h.cron();
      await h.clock.advanceTo(Z("05:20"));
      assertEquals((await h.store.load(DATE)).chain.status, "running", "unknown is not failed inside 2x the bound");
      await h.clock.advanceTo(Z("11:01"));
      const n = /Researched feeds &amp; podcast: [^<]*/.exec(h.gmail.sent[0].html)?.[0] ?? "";
      assert(!/FAILED - gmail/.test(n), n);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S10 pull dies (last_error): IN PROGRESS -> FAILED -> retries until attempts run out -> 07:00 says FAILED, no follow-up promised, ONE alert",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "up", pullFails: true });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.pullCalls.length, 3, "3 attempts, then no more");
      const d = h.gmail.sent[0].html;
      assertMatch(d, /Researched feeds &amp; podcast: FAILED - gmail pull failed \(\d\d:\d\d local\)/);
      assertMatch(d, /No follow-up will come/);
      assertEquals(h.tg.messages.length, 1);
    } finally {
      await h.close();
    }
  },
});

// ── FAILED -> deps -> retry; DONE -> nothing ──────────────────────────────────
Deno.test({
  name: "S11 the podcast fails before 07:00: digest goes out saying FAILED (retrying); retries are bounded; ONE alert",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "up", runnerMode: "fail" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await until(() => h.gmail.sent.length === 1);
      assertMatch(h.gmail.sent[0].html, /Researched feeds &amp; podcast: FAILED - podcast run ended without output \(exit 1/);
      await h.clock.advanceTo(Z("11:20"));
      assertEquals(h.pullCalls.length, 3, "first start + 2 retries");
      assertEquals(h.gmail.sent.length, 1);
      assertEquals(h.tg.messages.length, 1);
      assertMatch(h.tg.messages[0].text, /podcast: NOT produced \(failed/);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S12 re-runs after DONE: cron, L14 ensure and /run all do nothing new; the podcast refuses a produced day",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:59"), gateway: "up" });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await until(() => h.gmail.sent.length === 1);
      await h.clock.settle();
      for (const p of ["/routine/start", "/routine/ensure", "/run"]) {
        const r = await postJson(`${h.digestUrl}${p}`, {});
        assertEquals(r.body.state, "done", p);
      }
      assertEquals((await postJson(`${h.podcastUrl}/run`)).status, 200);
      await h.clock.advanceTo(Z("12:00"));
      assertEquals(h.gmail.sent.length, 1);
      assertEquals(h.pullCalls.length, 1);
      assertEquals(h.tg.messages.length, 0);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S13 L14 trigger before 01:00: NOT STARTED -> starts; a second call while IN PROGRESS starts nothing more",
  ...opts,
  async fn() {
    const h = await harness({ start: Z("04:30"), gateway: "up", pullBehaviour: "noop", noScheduler: true }); // 00:30 local
    try {
      const a = await postJson(`${h.digestUrl}/routine/ensure`, { labelsPrefix: "brain/" });
      await h.clock.settle();
      const b = await postJson(`${h.digestUrl}/routine/ensure`, { labelsPrefix: "brain/" });
      await h.clock.settle();
      await h.routine.settled();
      assertEquals(a.body.chain, "waiting-deps");
      assertEquals(b.body.chain, "running");
      assertEquals(h.pullCalls.length, 1);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S14 dependency hand-off: research engine reports model down and Gmail auth is broken -> each handed to its owner once; the chain waits",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("04:59"),
      gateway: "up",
      research: "down",
      mail: (_real, oauth, url) => {
        Deno.removeSync(oauth.tokenPath); // no token at all
        return new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: url });
      },
    });
    try {
      await h.clock.advanceTo(Z("05:00"));
      await h.cron();
      await h.clock.advanceTo(Z("05:40"));
      const deps = h.owner.posts.map((p) => /dependency NOT operational: (\S+)/.exec(p.message)?.[1]).sort();
      assertEquals(deps, ["gmail-auth", "research"]);
      assertEquals(h.pullCalls.length, 0);
      assertMatch(h.owner.posts.find((p) => /gmail-auth/.test(p.message))!.message, /owner: operator \(re-consent/);
      h.research.state = "up";
      await h.clock.advanceTo(Z("06:40"));
      assertEquals(h.owner.posts.length, 2, "still once per dependency per day");
    } finally {
      await h.close();
    }
  },
});

// ── transports ───────────────────────────────────────────────────────────────
Deno.test({
  name: "S15 blip: Gmail + Telegram connect REFUSED 07:00-07:20 (real error) -> digest sent ONCE and alert delivered ONCE after it heals",
  ...opts,
  async fn() {
    let down = true;
    const port = closedPort();
    const h = await harness({
      start: Z("10:50"),
      gateway: "up",
      runnerMode: "fail",
      env: { ROUTINE_CHAIN_START: "23:00" }, // no chain: the blip hits the 07:00 send itself
      mail: (real, oauth) => {
        const bad = new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: `http://127.0.0.1:${port}` });
        return { sendHtml: (a) => tracked((down ? bad : real).sendHtml(a)), checkAuth: () => Promise.resolve() };
      },
      alerts: (u) => {
        const good = new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: u });
        const bad = new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: `http://127.0.0.1:${port}` });
        return { configured: true, send: (t) => tracked((down ? bad : good).send(t)) };
      },
    });
    try {
      await h.clock.advanceTo(Z("11:19"));
      assertEquals(h.gmail.sent.length, 0);
      assertEquals((await h.store.load(DATE)).digest.status, "failed", "refused = definitely not sent");
      down = false;
      await h.clock.advanceTo(Z("11:45"));
      assertEquals(h.gmail.sent.length, 1);
      assertEquals(h.tg.messages.length, 1);
      await h.clock.advanceTo(Z("03:00", "2026-10-14"));
      assertEquals(h.gmail.sent.length, 1);
      assertEquals(h.tg.messages.length, 1);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S16 the deadline send never waits on a probe: a 5 s-slow gateway does not delay the 07:00 email",
  ...opts,
  async fn() {
    // no chain this morning: the 07:00 tick itself is the send under test
    const h = await harness({ start: Z("10:50"), gateway: "up", runnerMode: "fail", env: { ROUTINE_CHAIN_START: "23:00" } });
    try {
      h.gw.mode = "slow";
      h.gw.slowMs = 5000;
      const t0 = Date.now();
      const p = h.clock.advanceTo(Z("11:00"));
      await until(() => h.gmail.sent.length === 1, 60_000);
      assert(Date.now() - t0 < 4000, `held ${Date.now() - t0} ms`);
      await p;
    } finally {
      await h.close();
    }
  },
});

// ── a crash mid-send ───────────────────────────────────────────────────────────
Deno.test({
  name: "S17 a process died mid-send ('sending', no result): after the stale bound it is UNKNOWN; with the Sent check the mail is found -> no resend",
  ...opts,
  async fn() {
    const h = await harness({
      start: Z("11:01"),
      gateway: "up",
      runnerMode: "fail",
      sentCheck: true,
      pre: async (s) => {
        await s.update(DATE, (r) => {
          Object.assign(r.digest, { status: "sending", sendingAt: iso(Z("11:00")), sendingBy: "dead", attempts: 1, lastAttemptAt: iso(Z("11:00")) });
        });
      },
    });
    // the dead process's mail did reach Gmail
    h.gmail.sent.push({ subject: `Open Brain Daily Digest — ${DATE}`, to: "x", html: "", at: Z("11:00"), marker: `${DATE};digest` });
    try {
      await h.clock.advanceTo(Z("11:03"));
      assertEquals((await h.store.load(DATE)).digest.status, "sending", "inside the stale bound: still in flight");
      await h.clock.advanceTo(Z("11:30"));
      const st = await h.store.load(DATE);
      assertEquals(st.digest.status, "sent");
      assertEquals(st.digest.verified, true);
      assertEquals(h.gmail.sent.length, 1, "no resend");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S18 two digest processes on one state dir hit the deadline together: ONE email, ONE alert (the record lock + 'sending by' decide)",
  ...opts,
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
      // (no settled(): each routine's chain task legitimately waits for the down model)
      await Promise.all([a.ensureToday("deadline"), b.ensureToday("deadline")]);
      await until(() => gmail.sent.length >= 1);
      await clock.settle();
      await Promise.all([a.ensureToday("tick"), b.ensureToday("tick")]);
      await clock.settle();
      assertEquals(gmail.sent.length, 1);
      await clock.advanceTo(Z("11:15"));
      tg.delayMs = 800; // a's alert is still in flight when b decides
      await Promise.all([a.ensureToday("tick"), b.ensureToday("tick")]);
      await new Promise((r) => setTimeout(r, 200));
      await Promise.all([a.ensureToday("tick"), b.ensureToday("tick")]);
      await until(() => tg.messages.length >= 1);
      await clock.settle();
      assertEquals(tg.messages.length, 1);
      await Promise.all([a.stop(), b.stop()]);
    } finally {
      await Promise.all([gw.close(), gmail.close(), tg.close(), brain.close()]);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "S19 the record lock: 20 concurrent read-modify-writes from two store instances lose no update",
  ...opts,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "routine-lock-" });
    try {
      const a = new RoutineStore(dir), b = new RoutineStore(dir);
      await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).update(DATE, (r) => {
        r.history.push({ at: String(i), trigger: "t", note: "n" });
      })));
      assertEquals((await a.load(DATE)).history.length, 20);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── round 4 ────────────────────────────────────────────────────────────────────
Deno.test({
  name: "S20 NO send path calls the model probe: a pre-deadline /run send, the 07:00 send and a follow-up make ZERO 1-token probes",
  ...opts,
  async fn() {
    // No chain is started by the timer (pin), so no dependency check runs: every
    // probe the gateway sees would have come from a send path.
    let probes = 0;
    const h = await harness({
      start: Z("10:30"),
      gateway: "up",
      env: { ROUTINE_CHAIN_START: "23:00" },
      fetchWrap: (_clock, f) =>
        ((input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "POST" && /\/chat\/completions$/.test(String(input)) && JSON.parse(String(init.body)).max_tokens === 1) probes++;
          return f(input, init);
        }) as typeof fetch,
    });
    try {
      // 06:35: a stray /run (pre-deadline FULL send path)
      await h.clock.advanceTo(Z("10:35"));
      await postJson(`${h.digestUrl}/run`, {});
      await until(() => h.gmail.sent.length === 1);
      assertEquals(probes, 0, "the pre-deadline send probed the model");
      // the research arrives later (podcast run by hand) -> the follow-up send path
      await postJson(`${h.podcastUrl}/run`, {});
      await h.clock.advanceTo(Z("11:20"));
      await until(() => h.gmail.sent.length === 2);
      assertMatch(h.gmail.sent[1].subject, /follow-up/);
      assertEquals(probes, 0, "a send path probed the model");
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "S21 X1 shape, own copy: the chain ends at 06:55 and the model probe would take 10 VIRTUAL min - the digest still leaves before 07:00",
  ...opts,
  async fn() {
    let n = 0;
    const h = await harness({
      start: Z("10:55"),
      gateway: "up",
      fetchWrap: (clock, f) =>
        (async (input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "POST" && /\/chat\/completions$/.test(String(input)) && JSON.parse(String(init.body)).max_tokens === 1) {
            if (++n >= 2) await clock.sleep(10 * 60_000); // every probe after the chain-start check spans 07:00
          }
          return f(input, init);
        }) as typeof fetch,
    });
    try {
      await h.clock.advanceTo(Z("11:30"));
      assertEquals(h.gmail.sent.length, 1);
      assert(h.gmail.sent[0].at < Z("11:00"), `digest at ${iso(h.gmail.sent[0].at)}`);
    } finally {
      await h.close();
    }
  },
});
