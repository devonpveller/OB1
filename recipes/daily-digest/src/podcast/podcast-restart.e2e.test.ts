// Podcast service restart mid-run (mr-routine-outage, acceptance "a podcast
// service restart mid-run leaves no stuck lock and no duplicate send").
//
// Real processes, real time: the REAL podcast-server.ts entry point is started
// as a subprocess, a run is started, the server process is KILLED mid-run
// (SIGKILL - what a container restart does to it), and a fresh server is
// started on the same state directory. The digest is the REAL openbrain-digest
// service (src/app.ts) with the REAL GmailClient against a stub Gmail API.
// The runner is fixtures/fake-runner.ts in hang-once mode (first run hangs and
// is the one interrupted; the resume produces).
//
// Run: deno test --allow-all src/podcast/podcast-restart.e2e.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildDigestApp } from "../app.ts";
import { GmailClient } from "../clients/gmail.ts";
import { GoogleOAuth } from "../clients/google-oauth.ts";
import { startServer } from "../server.ts";
import { realClock } from "../routine/clock.ts";
import { RoutineStore } from "../routine/store.ts";
import { TelegramNotifier } from "../routine/telegram.ts";
import { brainStub, fakeOAuthFiles, gatewayStub, gmailStub, guardNetwork, postJson, telegramStub, until } from "../routine/testing.ts";
import { dirOf } from "./podcast-service.ts";

guardNetwork();
const RECIPE = dirOf(new URL("../../podcast-server.ts", import.meta.url).href);
const RUNNER = `${dirOf(import.meta.url)}../routine/fixtures/fake-runner.ts`;

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const p = (l.addr as Deno.NetAddr).port;
  l.close();
  return p;
}

Deno.test({
  name: "A5 podcast service killed mid-run: lock freed, ONE resume on restart, ONE digest, no resume loop",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "podcast-restart-" });
    const reports = `${dir}/reports`;
    const stateDir = `${reports}/routine`;
    const gw = gatewayStub("up");
    const gmail = gmailStub(realClock);
    const tg = telegramStub(realClock);
    const brain = brainStub();
    const ac = new AbortController();
    const procs: Deno.ChildProcess[] = [];
    try {
      const oauth = await fakeOAuthFiles(`${dir}/oauth`);
      const env: Record<string, string> = {
        DIGEST_TO: "operator@example.test",
        DIGEST_REPORT_DIR: reports,
        OPEN_BRAIN_URL: brain.url,
        LOCAL_LLM_BASE: `${gw.url}/v1`,
        LOCAL_EMBED_BASE: `${gw.url}/v1`,
        CONSIDERATIONS_SYNTH: "false",
        ROUTINE_SEND_BY: "23:59", // keep "before the deadline" whatever time the test runs
        ROUTINE_FOLLOWUP_CUTOFF: "23:59",
        ROUTINE_STATE_DIR: stateDir,
      };
      const app = buildDigestApp({
        env: (k) => env[k],
        scriptDir: `${dir}/oauth/`,
        mail: new GmailClient({ oauth: new GoogleOAuth(oauth), apiBase: gmail.url }),
        alerts: new TelegramNotifier({ token: "1:fake", chatId: "42", apiBase: tg.url }),
      });
      const digest = startServer({ routine: app.routine, port: 0, hostname: "127.0.0.1", signal: ac.signal });
      const digestUrl = `http://127.0.0.1:${digest.addr.port}`;

      const port = freePort();
      const podcastUrl = `http://127.0.0.1:${port}`;
      const startPodcast = () => {
        const p = new Deno.Command("deno", {
          args: ["run", "-A", "podcast-server.ts"],
          cwd: RECIPE,
          env: {
            PORT: String(port),
            PODCAST_RUN_SCRIPT: RUNNER,
            PODCAST_RUN_ARGS: `--mode=hang-once --reports=${reports}`,
            NEXT_TRIGGER_URL: `${digestUrl}/run`,
            ROUTINE_STATE_DIR: stateDir,
            ROUTINE_FOLLOWUP_CUTOFF: "23:59",
            REPORTS_DIR: reports,
          },
          stdout: "null",
          stderr: "null",
        }).spawn();
        procs.push(p);
        return p;
      };
      const health = async () => {
        try {
          return await (await fetch(`${podcastUrl}/health`)).json() as { running: boolean };
        } catch {
          return null;
        }
      };

      // 1. server #1, start a run, it hangs
      const p1 = startPodcast();
      await until(async () => (await health()) !== null, 30_000);
      assertEquals((await postJson(`${podcastUrl}/run`)).status, 202);
      await until(async () => {
        try {
          return (await Deno.readTextFile(`${reports}/runner-count`)) === "1";
        } catch {
          return false;
        }
      }, 30_000);
      assertEquals((await postJson(`${podcastUrl}/run`)).status, 409, "the lock holds while the run is alive");

      // 2. kill it mid-run (container restart)
      p1.kill("SIGKILL");
      await p1.status;
      const date = (await new RoutineStore(stateDir).loadPodcast(app.routine.dayOf(Date.now())))!;
      assert(!date.runs.at(-1)!.finishedAt, "the record shows a run that never finished");

      // 3. server #2 on the same state: closes the run as interrupted, resumes ONCE
      const p2 = startPodcast();
      await until(() => gmail.sent.length === 1, 60_000);
      await until(async () => (await health())?.running === false, 30_000);
      const rec = (await new RoutineStore(stateDir).loadPodcast(app.routine.dayOf(Date.now())))!;
      assertEquals(rec.runs.length, 2);
      assert(rec.runs[0].interrupted, "first run closed as interrupted");
      assertEquals(rec.runs[1].resume, true);
      assertEquals(rec.runs[1].code, 0);
      assert(/Key point A from research/.test(gmail.sent[0].html), "the resumed run's research is in the digest");

      // 4. no stuck lock: /run answers (and refuses a produced day) instead of 409
      const again = await postJson(`${podcastUrl}/run`);
      assertEquals(again.status, 200);
      // 5. restart again: nothing unfinished -> no resume (no loop), no new send
      p2.kill("SIGKILL");
      await p2.status;
      startPodcast();
      await until(async () => (await health()) !== null, 30_000);
      await new Promise((r) => setTimeout(r, 1_500));
      assertEquals((await health())?.running, false, "no resume loop");
      await postJson(`${digestUrl}/run`);
      await new Promise((r) => setTimeout(r, 1_000));
      await app.routine.settled();
      assertEquals(gmail.sent.length, 1, "exactly one digest across the restart");
      assertEquals((await new RoutineStore(stateDir).loadPodcast(app.routine.dayOf(Date.now())))!.runs.length, 2);
    } finally {
      for (const p of procs) {
        try {
          p.kill("SIGKILL");
        } catch { /* gone */ }
        await p.status.catch(() => {});
      }
      ac.abort();
      await Promise.all([gw.close(), gmail.close(), tg.close(), brain.close()]);
      // the orphaned first runner may still sleep; it writes nothing
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
