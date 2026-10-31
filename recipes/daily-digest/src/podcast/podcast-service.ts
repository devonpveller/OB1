/**
 * openbrain-podcast service logic (moved out of podcast-server.ts so tests run
 * the REAL service: real HTTP, real subprocess, real run record).
 *
 * POST /run spawns the link-enrich runner as a fresh subprocess, returns 202,
 * and when the subprocess ends (any exit) POSTs NEXT_TRIGGER_URL (the digest),
 * which decides whether anything is sent.
 *
 * mr-routine-outage additions:
 *  - The run lock is in memory (`running`) AND a durable run record
 *    (<ROUTINE_STATE_DIR>/<local date>.podcast.json). A service restart frees
 *    the in-memory lock by definition; on boot an unfinished record is closed
 *    as `interrupted` and ONE resume run starts (if the day is not delivered
 *    and the follow-up cutoff has not passed). Never a stuck lock, never a
 *    resume loop.
 *  - Every run is bounded (PODCAST_RUN_MAX_MS): the child is killed and the
 *    lock released.
 *  - A second /run the same local day after a successful run answers
 *    200 {started:false} (no new episode, nothing new for the digest) unless
 *    {"force":true}.
 *  - The child gets ROUTINE_DATE (local date), MODEL_WAIT_UNTIL_MS (the
 *    follow-up cutoff: how long link-enrich may wait for the model) and
 *    ROUTINE_STATE_DIR.
 */

import { Clock, localDate, zonedEpoch } from "../routine/clock.ts";
import { DayRecord, PodcastRecord, readJson, RoutineStore } from "../routine/store.ts";
import type { RenderService } from "./render-service.ts";

export interface PodcastServiceDeps {
  clock: Clock;
  tz: string;
  followUpCutoff: string;
  store: RoutineStore;
  /** The runner script (default link-enrich.ts) and its args. */
  script: string;
  runArgs: string[];
  cwd: string;
  denoPath?: string;
  nextTriggerUrl: string;
  maxRunMs: number;
  maxResumes: number;
  fetchFn?: typeof fetch;
  log?: (m: string) => void;
}

export class PodcastService {
  running = false;
  lastStartedAt: string | null = null;
  lastFinishedAt: string | null = null;
  lastCode: number | null = null;
  #current: Promise<void> | null = null;
  readonly #d: PodcastServiceDeps;
  readonly #log: (m: string) => void;

  constructor(d: PodcastServiceDeps) {
    this.#d = d;
    this.#log = d.log ?? ((m) => console.log(m));
  }

  #today(): string {
    return localDate(this.#d.clock.now(), this.#d.tz);
  }
  #iso(): string {
    return new Date(this.#d.clock.now()).toISOString();
  }

  /** The current run, if any (tests await it). */
  get current(): Promise<void> | null {
    return this.#current;
  }

  /**
   * Boot recovery. An unfinished run in today's record means the service died
   * mid-run (the in-memory lock died with it). Close it as interrupted, then
   * resume once if the day still needs it.
   */
  async recover(): Promise<{ interrupted: boolean; resumed: boolean }> {
    const date = this.#today();
    const rec = await this.#d.store.loadPodcast(date);
    const last = rec?.runs.at(-1);
    if (!rec || !last || last.finishedAt) return { interrupted: false, resumed: false };
    last.finishedAt = this.#iso();
    last.interrupted = true;
    await this.#d.store.savePodcast(rec);
    this.#log(`[podcast] boot: the run started ${last.startedAt} was interrupted (service restart); lock is free.`);
    const resumes = rec.runs.filter((r) => r.resume).length;
    const day = await readJson<DayRecord>(this.#d.store.dayPath(date));
    const cutoff = zonedEpoch(date, this.#d.followUpCutoff, this.#d.tz);
    if (resumes >= this.#d.maxResumes) {
      this.#log(`[podcast] not resuming: ${resumes} resume(s) already today (max ${this.#d.maxResumes}).`);
      return { interrupted: true, resumed: false };
    }
    if (day?.state === "done") return { interrupted: true, resumed: false };
    if (this.#d.clock.now() >= cutoff) return { interrupted: true, resumed: false };
    this.#log(`[podcast] resuming today's run once.`);
    await this.#start(date, true);
    return { interrupted: true, resumed: true };
  }

  async handleRun(body: { force?: boolean }): Promise<{ status: number; body: Record<string, unknown> }> {
    if (this.running) return { status: 409, body: { started: false, reason: "already running" } };
    // C4: take the lock BEFORE the first await, so two /run calls cannot both start.
    this.running = true;
    const date = this.#today();
    try {
      if (!body.force) {
        const last = (await this.#d.store.loadPodcast(date))?.runs.at(-1);
        if (last?.finishedAt && last.code === 0 && !last.interrupted && !last.timedOut) {
          this.running = false;
          return { status: 200, body: { started: false, date, reason: "already produced today (force to re-run)" } };
        }
      }
    } catch (e) {
      this.running = false;
      throw e;
    }
    await this.#start(date, false);
    return { status: 202, body: { started: true, date } };
  }

  async #start(date: string, resume: boolean): Promise<void> {
    this.running = true;
    try {
      const rec: PodcastRecord = (await this.#d.store.loadPodcast(date)) ?? { date, runs: [] };
      rec.runs.push({ startedAt: this.#iso(), ...(resume ? { resume: true } : {}) });
      await this.#d.store.savePodcast(rec);
    } catch (e) {
      this.running = false;
      throw e;
    }
    this.#current = this.#run(date);
  }

  async #run(date: string): Promise<void> {
    const d = this.#d;
    this.lastStartedAt = this.#iso();
    const cutoff = zonedEpoch(date, d.followUpCutoff, d.tz);
    this.#log(`[podcast] run starting (${date}): deno run … ${d.script} ${d.runArgs.join(" ")}`);
    let code = -1;
    let timedOut = false;
    const kill = new AbortController();
    try {
      const child = new Deno.Command(d.denoPath ?? "deno", {
        args: ["run", "--unstable-net", "-A", d.script, ...d.runArgs],
        cwd: d.cwd,
        env: {
          ROUTINE_DATE: date,
          MODEL_WAIT_UNTIL_MS: String(cutoff),
          ROUTINE_STATE_DIR: d.store.dir,
        },
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      // C6: bounded. Real time on purpose - the child runs in real time.
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
      }, Math.max(1, d.maxRunMs));
      kill.signal.addEventListener("abort", () => clearTimeout(timer));
      // Round 3: the heartbeat the routine's IN PROGRESS check reads (a run
      // whose heartbeat goes stale with no live process is FAILED, not "running").
      const beat = setInterval(() => {
        this.#heartbeat(date).catch(() => {});
      }, 60_000);
      kill.signal.addEventListener("abort", () => clearInterval(beat));
      await this.#heartbeat(date).catch(() => {});
      code = (await child.status).code;
      kill.abort();
      this.#log(`[podcast] run finished (exit ${code}${timedOut ? ", killed at the run limit" : ""}).`);
    } catch (err) {
      code = -1;
      console.error(`[podcast] run failed to spawn: ${err}`);
    } finally {
      kill.abort();
      this.lastCode = code;
      this.lastFinishedAt = this.#iso();
      try {
        await this.#serial(async () => {
          const rec = (await d.store.loadPodcast(date)) ?? { date, runs: [{ startedAt: this.lastStartedAt! }] };
          const last = rec.runs.at(-1)!;
          Object.assign(last, { finishedAt: this.lastFinishedAt, code, ...(timedOut ? { timedOut: true } : {}) });
          await d.store.savePodcast(rec);
        });
      } catch (e) {
        console.error(`[podcast] run record write failed: ${e}`);
      }
      this.running = false;
      await this.#chainTrigger();
    }
  }

  // One writer, serialized: a heartbeat can never overwrite the finish record.
  #recTail: Promise<unknown> = Promise.resolve();
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#recTail.then(fn, fn);
    this.#recTail = run.catch(() => {});
    return run;
  }

  #heartbeat(date: string): Promise<void> {
    return this.#serial(async () => {
      const rec = await this.#d.store.loadPodcast(date);
      const last = rec?.runs.at(-1);
      if (!rec || !last || last.finishedAt) return;
      last.heartbeatAt = this.#iso();
      await this.#d.store.savePodcast(rec);
    });
  }

  async #chainTrigger(): Promise<void> {
    if (!this.#d.nextTriggerUrl) return;
    try {
      const res = await (this.#d.fetchFn ?? fetch)(this.#d.nextTriggerUrl, { method: "POST", signal: AbortSignal.timeout(30_000) });
      await res.body?.cancel();
      this.#log(`[podcast] chain → ${this.#d.nextTriggerUrl} ${res.status}`);
    } catch (err) {
      console.warn(`[podcast] chain trigger failed: ${err}`);
    }
  }

  health(): Record<string, unknown> {
    return {
      ok: true,
      running: this.running,
      lastStartedAt: this.lastStartedAt,
      lastFinishedAt: this.lastFinishedAt,
      lastCode: this.lastCode,
      service: "openbrain-podcast",
    };
  }
}

export function servePodcast(
  svc: PodcastService,
  o: { port: number; hostname?: string; signal?: AbortSignal; onListen?: (a: Deno.NetAddr) => void; render?: RenderService },
): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve({ port: o.port, hostname: o.hostname ?? "0.0.0.0", signal: o.signal, onListen: o.onListen }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return Response.json(svc.health());
    if (req.method === "POST" && url.pathname === "/run") {
      const text = await req.text().catch(() => "");
      let body: { force?: boolean } = {};
      try {
        if (text.trim()) body = JSON.parse(text);
      } catch {
        return Response.json({ started: false, reason: "bad JSON body" }, { status: 400 });
      }
      const r = await svc.handleRun({ force: body?.force === true });
      return Response.json(r.body, { status: r.status });
    }
    // P7a: render a request / transcode an archived episode (render-service.ts)
    if (o.render && req.method === "POST" && (url.pathname === "/render" || url.pathname === "/transcode")) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse((await req.text().catch(() => "")) || "{}");
      } catch {
        return Response.json({ error: "bad JSON body" }, { status: 400 });
      }
      try {
        const r = url.pathname === "/render" ? await o.render.render(body) : await o.render.transcode(body);
        return Response.json(r.body, { status: r.status });
      } catch (e) {
        return Response.json({ error: String(e).slice(0, 300) }, { status: 502 });
      }
    }
    return new Response("not found", { status: 404 });
  });
}

/** A file: URL's directory as an OS path (Linux in the container, drive paths on Windows). */
export function dirOf(importMetaUrl: string): string {
  const p = decodeURIComponent(new URL(".", importMetaUrl).pathname);
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
}
