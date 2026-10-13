// Test harness for the morning-routine scenarios (mr-routine-outage round 3).
// NOT production code. What is real: the openbrain-digest service exactly as
// send-digest.ts builds it (src/app.ts), the REAL GmailClient against a stub
// Gmail API (send + Sent folder), the REAL TelegramNotifier against a stub Bot
// API, the REAL MattermostOwnerChannel against a stub Mattermost, the REAL
// GmailSentChecker, the REAL model probe against a stub gateway serving the
// 2026-10-13 502 body, and the REAL PodcastService (HTTP, run lock, run record,
// heartbeat, a real subprocess). Stand-ins: gmail-pull/prune (a stub that
// records the trigger and fires the podcast, as prune does; its /health answers
// like the real services) and the podcast runner (fixtures/fake-runner.ts; the
// real link-enrich runs in link-enrich.e2e.test.ts).
// guardNetwork(): any non-loopback fetch throws.

import { assert } from "jsr:@std/assert@1";
import { buildDigestApp } from "../app.ts";
import { GmailClient, MailTransport } from "../clients/gmail.ts";
import { GoogleOAuth } from "../clients/google-oauth.ts";
import { startServer } from "../server.ts";
import { dirOf, PodcastService, servePodcast } from "../podcast/podcast-service.ts";
import { RoutineStore } from "./store.ts";
import { AlertSender, TelegramNotifier } from "./telegram.ts";
import { MattermostOwnerChannel } from "./owner.ts";
import { GmailSentChecker, sentCheckDisabled } from "./sent-check.ts";
import {
  activity,
  brainStub,
  fakeOAuthFiles,
  gatewayStub,
  GatewayMode,
  gmailStub,
  guardNetwork,
  ownerStub,
  postJson,
  researchHealthStub,
  stubServer,
  telegramStub,
  VirtualClock,
} from "./testing.ts";

guardNetwork();

export const TZ = "America/New_York";
export const DATE = "2026-10-13";
export const Z = (hhmm: string, date = DATE) => Date.parse(`${date}T${hhmm}:00Z`);
export const iso = (ms: number) => new Date(ms).toISOString();
const HERE = dirOf(import.meta.url);
const RUNNER = `${HERE}fixtures/fake-runner.ts`;

/** Real outbound calls the virtual clock must wait for (Windows refuses a loopback connect in ~2 s real). */
export function tracked<T>(p: Promise<T>): Promise<T> {
  activity.inFlight++;
  return p.finally(() => {
    activity.inFlight--;
    activity.ticks++;
  });
}

/** A loopback port nothing listens on: the REAL connect-refused error. */
export function closedPort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

export interface HarnessOptions {
  start: number;
  gateway: GatewayMode;
  runnerMode?: "produce" | "fail" | "hang-once";
  mail?: (real: MailTransport, oauth: { credentialsPath: string; tokenPath: string }, gmailUrl: string) => MailTransport;
  alerts?: (tgUrl: string) => AlertSender;
  /** gmail-pull "fails": its /health reports last_error and nothing chains on. */
  pullFails?: boolean;
  pullBehaviour?: "chain" | "noop";
  pullHealth?: () => Response;
  pruneHealth?: () => Response;
  /** Enable the Sent-folder check (a read-capable token). */
  sentCheck?: boolean;
  /** The Sent folder answers 403 (a gmail.send-only token) from the start. */
  sentReadForbidden?: boolean;
  /** Research engine /health stub reporting this model state. */
  research?: "up" | "down";
  env?: Record<string, string>;
  pre?: (store: RoutineStore) => Promise<void>;
  /** Do not start the scheduler (drive ensureToday by hand). */
  noScheduler?: boolean;
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function harness(o: HarnessOptions) {
  const dir = await Deno.makeTempDir({ prefix: "routine-r3-" });
  const reports = `${dir}/reports`;
  const stateDir = `${reports}/routine`;
  const clock = new VirtualClock(o.start);
  const gw = gatewayStub(o.gateway);
  const gmail = gmailStub(clock);
  gmail.readForbidden = !!o.sentReadForbidden;
  const tg = telegramStub(clock);
  const owner = ownerStub(clock);
  const research = researchHealthStub();
  research.state = o.research ?? "up";
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
    if (o.pullFails) {
      health.pull = { running: false, last_run_at: t, last_error: "Gmail API error 500" };
    } else {
      health.pull = { running: false, last_run_at: t, last_error: null };
      health.prune = { running: false, last_run_at: t, last_error: null };
      if ((o.pullBehaviour ?? "chain") === "chain") setTimeout(() => postJson(`${podcastUrl}/run`).catch(() => {}), 0);
    }
    return Response.json({ started: true }, { status: 202 });
  });

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
    RESEARCH_HEALTH_URL: `${research.url}/health`,
    ROUTINE_TZ: TZ,
    ROUTINE_STATE_DIR: stateDir,
    MODEL_GATE_INITIAL_MS: "30000",
    MODEL_GATE_MAX_MS: "300000",
    ...(o.env ?? {}),
  };
  const app = buildDigestApp({
    env: (k) => env[k],
    scriptDir: `${dir}/oauth/`,
    clock,
    mail: o.mail ? o.mail(realGmail, oauth, gmail.url) : realGmail,
    alerts: o.alerts ? o.alerts(tg.url) : new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: tg.url }),
    owners: new MattermostOwnerChannel({ url: owner.url, token: "mm-fake", channelId: "sysadmin" }),
    sentCheck: o.sentCheck ? new GmailSentChecker({ oauth: new GoogleOAuth(oauth), apiBase: gmail.url }) : sentCheckDisabled,
  });
  const digestSrv = startServer({ routine: app.routine, port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} });
  digestUrl = `http://127.0.0.1:${digestSrv.addr.port}`;
  if (!o.noScheduler) app.routine.start();
  await clock.settle();

  return {
    clock,
    gw,
    gmail,
    tg,
    owner,
    research,
    health,
    pullCalls,
    digestUrl,
    podcastUrl,
    svc,
    store,
    dir,
    routine: app.routine,
    emails: () => gmail.sent.filter((m) => !/follow-up/.test(m.subject)),
    followUps: () => gmail.sent.filter((m) => /follow-up/.test(m.subject)),
    async cron() {
      const r = await postJson(`${digestUrl}/routine/start`, { labelsPrefix: "brain/", window: "90d", limit: 500 });
      await clock.settle();
      return r;
    },
    async close() {
      await app.routine.stop();
      await clock.settle().catch(() => {});
      await svc.current?.catch(() => {});
      activity.busy.length = 0;
      ac.abort();
      await Promise.allSettled([digestSrv.finished, podcastSrv.finished]);
      await Promise.all([gw.close(), gmail.close(), tg.close(), owner.close(), research.close(), brain.close(), pull.close()]);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}
