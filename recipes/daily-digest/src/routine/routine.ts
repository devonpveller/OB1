/**
 * MorningRoutine (mr-routine-outage) - owns WHEN the morning digest goes out
 * and that it goes out at most once. Lives in openbrain-digest.
 *
 * The chain (all times LOCAL, ROUTINE_TZ, default America/New_York; the
 * containers run UTC):
 *
 *   cron 01:00 -> POST openbrain-digest /routine/start   (startChain)
 *        waits for the model (bounded backoff, until the follow-up cutoff);
 *        then POST openbrain-gmail-pull /run  -> prune -> podcast -> digest /run
 *   openbrain-digest /run                                 (onRun)
 *        not sent yet: wait for the model until the send-by deadline, then
 *        send the FULL digest; already sent with a section pending: send the
 *        ONE follow-up; otherwise: nothing new.
 *   send-by deadline 07:00 (in-process timer)            (onDeadline)
 *        not sent yet: send NOW with whatever is ready - no model probe, no
 *        wait; unfinished sections are marked (waiting / running / failed).
 *   deadline + grace (07:15)                              (checkAlert)
 *        digest not sent or podcast not produced: ONE Telegram alert,
 *        content-free.
 *   every ROUTINE_RETRY_EVERY_MIN (10) until the cutoff   (#retryPass)
 *        a digest / follow-up that DEFINITELY did not go out is sent again;
 *        an alert Telegram DEFINITELY did not take is delivered again.
 *
 * Send-once: the digest is BUILT first, then the claim file (RoutineStore.claim,
 * O_EXCL) for (local date, kind) is taken right before the transport. A
 * definite failure releases it; a maybe-sent keeps it. A forced re-send is
 * explicit: POST /run {"force":true}. State transitions run under one
 * in-process lock (never held across a model probe, a build or a transport
 * call); the claim makes it hold across processes and restarts too.
 */

import { bothClocks, Clock, localDate, localHHMM, nextDate, parseHHMM, zonedEpoch } from "./clock.ts";
import { ModelProbeResult, waitForModel } from "./model-gate.ts";
import { ClaimKind, DayState, PendingNote, PendingState, readJson, RoutineStore } from "./store.ts";
import { AlertOutcome, AlertSender, buildAlertText } from "./telegram.ts";
import { BuiltDigest, DigestOrchestrator } from "../digest.ts";
import { MailSendError } from "../clients/gmail.ts";
import type { EmailEnrichment } from "../podcast/enrichment.ts";
import type { RoutineNoticePayload } from "../sections/routine-notice.ts";

export interface RoutineConfig {
  tz: string;
  /** Send-by deadline, local "HH:MM". */
  sendBy: string;
  /** Alert check this long after the deadline. */
  alertGraceMs: number;
  /** Local "HH:MM": stop waiting for the model / retrying / starting the chain after this. */
  followUpCutoff: string;
  /** Retries of a DEFINITE send failure inside one attempt, and the gap between them. */
  sendRetries: number;
  sendRetryGapMs: number;
  /** After the alert check: how often undelivered sends / alerts are retried (until the cutoff). */
  retryEveryMs: number;
}

export function routineConfigFromEnv(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): RoutineConfig {
  const tz = get("ROUTINE_TZ") || "America/New_York";
  new Intl.DateTimeFormat("en-US", { timeZone: tz }); // throws on a bad zone: fail at boot, not at 07:00
  const sendBy = get("ROUTINE_SEND_BY") || "07:00";
  const followUpCutoff = get("ROUTINE_FOLLOWUP_CUTOFF") || "20:00";
  parseHHMM(sendBy);
  parseHHMM(followUpCutoff);
  const num = (k: string, d: number) => {
    const v = Number(get(k));
    return Number.isFinite(v) && get(k) !== undefined && get(k) !== "" ? v : d;
  };
  return {
    tz,
    sendBy,
    followUpCutoff,
    alertGraceMs: num("ROUTINE_ALERT_GRACE_MIN", 15) * 60_000,
    sendRetries: num("ROUTINE_SEND_RETRIES", 2),
    sendRetryGapMs: num("ROUTINE_SEND_RETRY_GAP_MS", 60_000),
    retryEveryMs: Math.max(60_000, num("ROUTINE_RETRY_EVERY_MIN", 10) * 60_000),
  };
}

export interface PodcastView {
  /** Today's brief (research) is ready to include. */
  briefReady: boolean;
  /** Today's episode exists (what "podcast produced" means for the alert). */
  produced: boolean;
  state: PendingState | "produced" | "nothing-to-do";
  detail: string;
  /** The section is still coming: a follow-up is expected. */
  followUpExpected: boolean;
}

export interface RunOutcome {
  action: "sent" | "followup" | "none" | "failed" | "unconfirmed";
  reason?: string;
  date: string;
}

/** GET /health of gmail-pull / gmail-prune (pull-gmail.ts / prune-short-term.ts). */
export interface StepHealth {
  running: boolean;
  last_run_at: string | null;
  last_error: string | null;
}

export interface MorningRoutineDeps {
  cfg: RoutineConfig;
  clock: Clock;
  store: RoutineStore;
  digest: DigestOrchestrator;
  /** One bounded model probe (src/routine/model-gate.ts probeModel). */
  probe: () => Promise<ModelProbeResult>;
  gateInitialMs?: number;
  gateMaxMs?: number;
  /** GET openbrain-podcast /health -> running? null = unreachable. */
  podcastHealth?: () => Promise<{ running: boolean } | null>;
  /** GET gmail-pull / gmail-prune /health; null = unreachable. */
  pullHealth?: () => Promise<StepHealth | null>;
  pruneHealth?: () => Promise<StepHealth | null>;
  /** The podcast brief artifact (podcast-brief-latest.json). */
  briefPath: string;
  alerts: AlertSender;
  /** The chain head (openbrain-gmail-pull /run). */
  chainHeadUrl?: string;
  fetchFn?: typeof fetch;
  log?: (m: string) => void;
}

const BRIEF_SECTION = "podcast_brief";
const PENDING_STATES: ReadonlySet<string> = new Set(["waiting for the model", "still running", "interrupted"]);
/** A gap between chain steps longer than this means the chain stopped. */
const STEP_GAP_MS = 5 * 60_000;
/** A model-down observation this old still counts for the deadline notice. */
const PROBE_FRESH_MS = 15 * 60_000;

type SendResult = { ok: boolean; attempts: number; error?: string; unconfirmed: boolean };

export class MorningRoutine {
  readonly #d: MorningRoutineDeps;
  readonly #log: (m: string) => void;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #tasks = new Set<Promise<unknown>>();
  #stop: AbortController | null = null;
  #scheduler: Promise<void> | null = null;
  #lastProbe: { state: "up" | "down"; at: number } | null = null;

  constructor(deps: MorningRoutineDeps) {
    this.#d = deps;
    this.#log = deps.log ?? ((m) => console.log(m));
  }

  // ── time ────────────────────────────────────────────────────────────────
  dayOf(ms: number): string {
    return localDate(ms, this.#d.cfg.tz);
  }
  deadlineOf(date: string): number {
    return zonedEpoch(date, this.#d.cfg.sendBy, this.#d.cfg.tz);
  }
  cutoffOf(date: string): number {
    return zonedEpoch(date, this.#d.cfg.followUpCutoff, this.#d.cfg.tz);
  }
  #iso(ms = this.#d.clock.now()): string {
    return new Date(ms).toISOString();
  }
  #at(ms: number): string {
    return bothClocks(ms, this.#d.cfg.tz);
  }
  #hhmm(iso: string | undefined | null): string {
    return iso ? `${localHHMM(Date.parse(iso), this.#d.cfg.tz)} local` : "?";
  }

  // ── plumbing ────────────────────────────────────────────────────────────
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.catch(() => {});
    return run;
  }
  #track<T>(p: Promise<T>): Promise<T> {
    this.#tasks.add(p);
    p.finally(() => this.#tasks.delete(p)).catch(() => {});
    return p;
  }
  /** Resolves when every background task this routine started has settled (tests). */
  async settled(): Promise<void> {
    while (this.#tasks.size) await Promise.allSettled([...this.#tasks]);
  }
  #update(date: string, fn: (s: DayState) => void): Promise<DayState> {
    return this.#locked(() => this.#d.store.update(date, fn));
  }
  /** Every model probe goes through here, so the deadline notice can use the
   *  latest observation instead of probing (and waiting) at 07:00. */
  #probe = async (): Promise<ModelProbeResult> => {
    const r = await this.#d.probe();
    this.#lastProbe = { state: r.state, at: this.#d.clock.now() };
    return r;
  };
  #waitModel(date: string, until: number, label: string, onDown?: (since: number) => Promise<void>) {
    return waitForModel({
      probe: this.#probe,
      clock: this.#d.clock,
      until,
      initialMs: this.#d.gateInitialMs,
      maxMs: this.#d.gateMaxMs,
      label: `routine ${date} ${label}`,
      log: this.#log,
      signal: this.#stop?.signal,
      onDown,
    });
  }

  // ── scheduler: deadline + alert + retries, every local day ─────────────────
  start(): void {
    if (this.#stop) return;
    this.#stop = new AbortController();
    // Not in #tasks: settled() waits for work, not for the endless scheduler.
    this.#scheduler = this.#schedule(this.#stop.signal).catch((e) => {
      if (!this.#stop?.signal.aborted) console.error(`[routine] scheduler died: ${e}`);
    });
  }
  /** Stop the scheduler. Waits (bounded, real time) for it to wind down; a
   *  send already in flight finishes on its own. */
  async stop(): Promise<void> {
    this.#stop?.abort(new DOMException("stopped", "AbortError"));
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.#scheduler, new Promise((r) => (t = setTimeout(r, 2_000)))]);
    clearTimeout(t);
  }

  async #schedule(signal: AbortSignal): Promise<void> {
    const { clock, cfg } = this.#d;
    let date = this.dayOf(clock.now());
    this.#log(`[routine] scheduler up: send-by ${cfg.sendBy} ${cfg.tz}, alert +${cfg.alertGraceMs / 60_000} min, cutoff ${cfg.followUpCutoff}; today ${date}.`);
    while (!signal.aborted) {
      const deadline = this.deadlineOf(date);
      const alertAt = deadline + cfg.alertGraceMs;
      const cutoff = this.cutoffOf(date);
      if (clock.now() < deadline) await clock.sleep(deadline - clock.now(), signal);
      // Booted after the cutoff: a "morning" digest at night helps nobody; the
      // alert check below still reports the miss.
      if (clock.now() < cutoff) await this.onDeadline(date);
      if (clock.now() < alertAt) await clock.sleep(alertAt - clock.now(), signal);
      await this.checkAlert(date);
      // Round 2: a blip that heals is followed by a delivery the same day.
      while (!signal.aborted && clock.now() < cutoff && (await this.#retryPending(date))) {
        await clock.sleep(Math.min(cfg.retryEveryMs, cutoff - clock.now()), signal);
        await this.#retryPass(date);
      }
      date = nextDate(date);
    }
  }

  /** Is anything left that a later pass could still deliver? */
  async #retryPending(date: string): Promise<boolean> {
    const st = await this.#d.store.load(date);
    const claimHeld = await this.#d.store.hasClaim(date, "digest");
    if (!st.digest?.sentAt && !claimHeld) return true; // digest definitely not out
    const a = st.alert;
    if (a && !a.delivered && a.outcome === "not-delivered") return true; // alert definitely not out
    if (st.digest?.sentAt && !dayComplete(st)) {
      // a follow-up may still come (section pending) or is waiting for a retry
      return !(await this.#d.store.hasClaim(date, "followup"));
    }
    return false;
  }

  async #retryPass(date: string): Promise<void> {
    const { store } = this.#d;
    const st = await store.load(date);
    if (!st.digest?.sentAt && !(await store.hasClaim(date, "digest"))) {
      this.#log(`[routine] ${date}: retry pass - the digest is not out yet; sending.`);
      await this.#sendDigest(date, { retries: 0 });
    } else if (st.digest?.sentAt) {
      await this.#maybeFollowUp(date, { retries: 0 });
    }
    await this.checkAlert(date);
  }

  // ── chain head (cron) ─────────────────────────────────────────────────────
  startChain(body: unknown, o: { force?: boolean } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.#locked(async () => {
      const now = this.#d.clock.now();
      const date = this.dayOf(now);
      const st = await this.#d.store.load(date);
      if (!o.force) {
        if (dayComplete(st)) return { status: 200, body: { started: false, date, reason: "already delivered today" } };
        if (now >= this.cutoffOf(date)) return { status: 200, body: { started: false, date, reason: "past the follow-up cutoff" } };
        if (st.chain?.startedAt && !st.chain.finishedAt && !st.chain.gaveUpAt) {
          return { status: 409, body: { started: false, date, reason: "chain already started today" } };
        }
      }
      await this.#d.store.update(date, (s) => {
        s.chain = { startedAt: this.#iso(now) };
      });
      this.#log(`[routine] ${date}: chain start at ${this.#at(now)}${o.force ? " (forced)" : ""}; checking the model first.`);
      this.#track(this.#runChain(date, body)).catch((e) => console.error(`[routine] chain task failed: ${e}`));
      return { status: 202, body: { started: true, date } };
    });
  }

  async #runChain(date: string, body: unknown): Promise<void> {
    const { clock } = this.#d;
    const w = await this.#waitModel(date, this.cutoffOf(date), "chain", (since) =>
      this.#update(date, (s) => {
        if (s.chain) s.chain.modelDownSince = this.#iso(since);
      }).then(() => {}));
    if (!w.up) {
      await this.#update(date, (s) => {
        if (s.chain) Object.assign(s.chain, { gaveUpAt: this.#iso(), probes: w.probes });
      });
      return;
    }
    // C4: the day may have been completed while we waited (forced send, a
    // fallback run). Re-check before starting any work.
    const st = await this.#locked(() => this.#d.store.load(date));
    if (dayComplete(st)) {
      this.#log(`[routine] ${date}: model is up but the day is already delivered; not starting the chain.`);
      return;
    }
    let status = 0;
    if (this.#d.chainHeadUrl) {
      try {
        const res = await (this.#d.fetchFn ?? fetch)(this.#d.chainHeadUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(30_000),
        });
        status = res.status;
        await res.body?.cancel();
      } catch (e) {
        this.#log(`[routine] ${date}: chain head trigger failed (${(e as Error).name}); the ${this.#d.cfg.sendBy} deadline send still covers the digest.`);
      }
    }
    this.#log(`[routine] ${date}: model up at ${this.#at(clock.now())}; chain head -> ${status || "no answer"}.`);
    await this.#update(date, (s) => {
      if (s.chain) Object.assign(s.chain, { modelUpAt: this.#iso(), probes: w.probes, headTriggeredAt: this.#iso(), headStatus: status });
    });
  }

  // ── chain tail: POST /run ──────────────────────────────────────────────────
  onRun(o: { force?: boolean } = {}): Promise<RunOutcome> {
    return this.#track(this.#onRun(o));
  }

  async #onRun(o: { force?: boolean }): Promise<RunOutcome> {
    const { clock } = this.#d;
    const date = this.dayOf(clock.now());
    await this.#update(date, (s) => {
      if (s.chain && !s.chain.finishedAt) s.chain.finishedAt = this.#iso();
    });
    if (o.force) return this.#sendDigest(date, { forced: true });

    if (await this.#d.store.hasClaim(date, "digest")) return this.#maybeFollowUp(date, {});

    // Not sent yet. Before the deadline: no degraded run - wait for the model
    // (bounded by the deadline; at the deadline the scheduler sends).
    const deadline = this.deadlineOf(date);
    if (clock.now() < deadline) {
      const w = await this.#waitModel(date, deadline, "digest");
      if (!w.up) return { action: "none", date, reason: "model down until the deadline; the deadline send covers it" };
    }
    // C4: re-check the marker after the wait - the deadline may have sent it.
    if (await this.#d.store.hasClaim(date, "digest")) return this.#maybeFollowUp(date, {});
    return this.#sendDigest(date, {});
  }

  // ── deadline + alert ────────────────────────────────────────────────────────
  async onDeadline(date: string): Promise<RunOutcome> {
    if (await this.#d.store.hasClaim(date, "digest")) return { action: "none", date, reason: "already sent" };
    this.#log(`[routine] ${date}: send-by deadline ${this.#d.cfg.sendBy} reached and the digest is not out; sending what is ready.`);
    return this.#sendDigest(date, {});
  }

  /** What the alert says about the digest. C5: never "not attempted" when a send was claimed. */
  async #digestState(date: string, st: DayState): Promise<string> {
    const d = st.digest;
    if (d?.sentAt) return "sent";
    if (d?.unconfirmed) return "send unconfirmed (may have gone out)";
    const claimHeld = await this.#d.store.hasClaim(date, "digest");
    if (claimHeld) {
      return d?.claimedAt
        ? `claimed ${this.#hhmm(d.claimedAt)}, send outcome unknown (stopped mid-send?)`
        : "claimed, send outcome unknown (stopped mid-send?)";
    }
    if (d?.lastError) return "send failed";
    if (d?.phase === "building") return `built from ${this.#hhmm(d.buildStartedAt)} but never sent`;
    return "not attempted";
  }

  /**
   * At most ONE alert per day. Raised once (claim); if Telegram DEFINITELY did
   * not take it, later passes deliver it again (fresh facts) until the cutoff;
   * an unknown outcome is never repeated.
   */
  async checkAlert(date: string): Promise<{ alerted: boolean; delivered?: boolean; reason?: string }> {
    const { store, alerts, clock } = this.#d;
    const plan = await this.#locked(async () => {
      const st = await store.load(date);
      const view = await this.podcastView(date, st);
      const digestOk = !!st.digest?.sentAt;
      const podcastOk = view.produced || view.state === "nothing-to-do";
      const problems = [...(digestOk ? [] : ["digest"]), ...(podcastOk ? [] : ["podcast"])];
      if (st.alert) {
        if (st.alert.delivered) return { skip: "already alerted" };
        if (st.alert.outcome !== "not-delivered") return { skip: `alert outcome ${st.alert.outcome}` };
        if (!problems.length) return { skip: "resolved before the alert got through" };
      } else {
        if (!problems.length) return { skip: "all delivered" };
        if (!(await store.claim(date, "alert"))) return { skip: "already alerted" };
      }
      const text = buildAlertText({
        date,
        tz: this.#d.cfg.tz,
        checkedAt: this.#at(clock.now()),
        digest: { sent: digestOk, attempts: st.digest?.attempts ?? 0, state: await this.#digestState(date, st) },
        podcast: { produced: podcastOk, state: `${view.state}${view.detail ? ": " + view.detail : ""}` },
      });
      return { text, problems, first: !st.alert };
    });
    if ("skip" in plan) return { alerted: false, reason: plan.skip };

    let outcome: AlertOutcome | "unconfigured" = "unconfigured";
    let tries = 0;
    if (!alerts.configured) {
      console.error(`[routine] ${date}: ALERT NOT DELIVERED - Telegram is not configured (SYSADMIN_TELEGRAM_BOT_TOKEN / _CHAT_ID). Problems: ${plan.problems!.join(", ")}`);
    } else {
      // Outside the lock: a slow Bot API never holds up a send.
      for (let i = 0; i < (plan.first ? 3 : 1); i++) {
        tries++;
        outcome = await alerts.send(plan.text!);
        if (outcome !== "not-delivered") break;
        if (i < 2 && plan.first) await clock.sleep(30_000);
      }
      this.#log(`[routine] ${date}: Telegram alert ${outcome} (${plan.problems!.join(", ")}).`);
    }
    await this.#update(date, (s) => {
      s.alert = {
        at: s.alert?.at ?? this.#iso(),
        delivered: outcome === "delivered",
        problems: plan.problems!,
        outcome,
        tries: (s.alert?.tries ?? 0) + tries,
        lastTryAt: this.#iso(),
      };
    });
    return { alerted: true, delivered: outcome === "delivered" };
  }

  // ── what the podcast step is doing (for notices and the alert) ─────────────
  async podcastView(date: string, st?: DayState): Promise<PodcastView> {
    const { store } = this.#d;
    st ??= await store.load(date);
    const brief = await readJson<EmailEnrichment & { routineDate?: string }>(this.#d.briefPath);
    const briefDate = brief ? (brief.routineDate ?? (brief.generatedAt ? this.dayOf(Date.parse(brief.generatedAt)) : "")) : "";
    const briefReady = !!brief && briefDate === date &&
      (!!brief.episode || brief.segments?.some((s) => s.items.length > 0) || (brief.followUps?.length ?? 0) > 0);
    const produced = briefReady && !!brief?.episode;
    if (produced) return { briefReady, produced, state: "produced", detail: "", followUpExpected: false };

    const result = await store.loadResult(date);
    const rec = await store.loadPodcast(date);
    const last = rec?.runs.at(-1);
    const view = (state: PodcastView["state"], detail: string): PodcastView => ({
      briefReady,
      produced,
      state,
      detail,
      followUpExpected: PENDING_STATES.has(state),
    });

    if (last && !last.finishedAt) {
      const h = await this.#d.podcastHealth?.().catch(() => null) ?? null;
      if (h?.running || !this.#d.podcastHealth) return view("still running", `research + episode, started ${this.#hhmm(last.startedAt)}`);
      return view("interrupted", `the podcast service stopped mid-run (started ${this.#hhmm(last.startedAt)}); it resumes once on restart`);
    }
    if (result?.outcome === "nothing-to-do" && last?.code === 0) return view("nothing-to-do", "no items to research today");
    if (briefReady) return view("failed", "research is ready but the episode was not produced");
    if (result?.outcome === "model-down") return view("failed", `gave up waiting for the model (${this.#hhmm(result.at)})`);
    if (last) {
      const why = last.timedOut ? "run time limit hit" : last.interrupted ? "interrupted" : `exit ${last.code ?? "?"}`;
      return view("failed", `podcast run ended without output (${why}, ${this.#hhmm(last.finishedAt)})`);
    }
    const c = st.chain;
    if (c?.gaveUpAt) return view("failed", `the model stayed down until the ${this.#d.cfg.followUpCutoff} cutoff`);
    if (c?.modelDownSince && !c.modelUpAt) return view("waiting for the model", `down since ${this.#hhmm(c.modelDownSince)}`);
    if (c?.headTriggeredAt) return await this.#chainStepView(c.headTriggeredAt, c.headStatus ?? 0, view);
    if (c?.startedAt) return view("still running", `chain started ${this.#hhmm(c.startedAt)}`);
    return view("not started", "the morning chain did not start today");
  }

  /** The chain is between the pull trigger and the podcast start: which step
   *  is running, or which one stopped it (round 2: never promise a follow-up
   *  that cannot come). */
  async #chainStepView(
    since: string,
    headStatus: number,
    view: (s: PodcastView["state"], d: string) => PodcastView,
  ): Promise<PodcastView> {
    const now = this.#d.clock.now();
    if (this.#d.chainHeadUrl && headStatus === 0) return view("failed", "gmail pull did not answer the chain trigger");
    if (headStatus && (headStatus < 200 || headStatus >= 300) && headStatus !== 409) {
      return view("failed", `gmail pull refused the chain trigger (HTTP ${headStatus})`);
    }
    if (this.#d.podcastHealth && (await this.#d.podcastHealth().catch(() => null)) === null) {
      return view("failed", "the podcast service is unreachable");
    }
    if (!this.#d.pullHealth) return view("still running", `gmail pull/prune, started ${this.#hhmm(since)}`);
    const pull = await this.#d.pullHealth().catch(() => null);
    if (!pull) return view("failed", "the gmail pull service is unreachable");
    if (pull.running) return view("still running", `gmail pull, started ${this.#hhmm(since)}`);
    if (!pull.last_run_at || pull.last_run_at < since) return view("failed", "gmail pull stopped without finishing (service restarted?)");
    if (pull.last_error) return view("failed", `gmail pull failed (${this.#hhmm(pull.last_run_at)})`);
    const pullDone = Date.parse(pull.last_run_at);
    if (!this.#d.pruneHealth) return view("still running", `gmail prune, after pull ${this.#hhmm(pull.last_run_at)}`);
    const prune = await this.#d.pruneHealth().catch(() => null);
    if (!prune) return view("failed", "the gmail prune service is unreachable");
    if (prune.running) return view("still running", `gmail prune, after pull ${this.#hhmm(pull.last_run_at)}`);
    if (!prune.last_run_at || prune.last_run_at < pull.last_run_at) {
      return now - pullDone > STEP_GAP_MS
        ? view("failed", `the chain stopped after gmail pull (${this.#hhmm(pull.last_run_at)}); prune never ran`)
        : view("still running", "between gmail pull and prune");
    }
    if (prune.last_error) return view("failed", `gmail prune failed (${this.#hhmm(prune.last_run_at)})`);
    return now - Date.parse(prune.last_run_at) > STEP_GAP_MS
      ? view("failed", `the chain stopped after gmail prune (${this.#hhmm(prune.last_run_at)}); the podcast never started`)
      : view("still running", "starting the podcast");
  }

  // ── sends ───────────────────────────────────────────────────────────────────
  /**
   * Build, then claim, then send. Never holds the lock across the build or
   * the transport; never probes the model (the deadline send goes out now).
   */
  async #sendDigest(date: string, o: { forced?: boolean; retries?: number }): Promise<RunOutcome> {
    const { store, clock, cfg } = this.#d;

    // A: decide what to say (lock).
    const prep = await this.#locked(async () => {
      if (!o.forced && (await store.hasClaim(date, "digest"))) return null;
      const now = clock.now();
      const st = await store.load(date);
      const view = await this.podcastView(date, st);
      const mode: "full" | "deadline" = now < this.deadlineOf(date) ? "full" : "deadline";
      const pending: PendingNote[] = [];
      if (!view.briefReady && view.state !== "nothing-to-do" && view.state !== "produced") {
        pending.push({ section: BRIEF_SECTION, state: view.state as PendingState, detail: view.detail });
      }
      // The latest probe the routine already made - never a new probe here.
      const lp = this.#lastProbe;
      const modelDown = mode === "deadline" && !!lp && lp.state === "down" && now - lp.at <= PROBE_FRESH_MS;
      await store.update(date, (s) => {
        s.digest = { attempts: 0, ...s.digest, phase: "building", buildStartedAt: this.#iso(now) };
      });
      return { mode, pending, modelDown, briefReady: view.briefReady };
    });
    if (!prep) return { action: "none", date, reason: "already sent (marker)" };
    const { mode, pending, modelDown, briefReady } = prep;

    const notices: RoutineNoticePayload[] = [];
    if (pending.length || modelDown) {
      const lines: string[] = [];
      for (const p of pending) {
        const follow = PENDING_STATES.has(p.state)
          ? "A short follow-up email will deliver it when it completes."
          : "No follow-up will come for it today.";
        lines.push(`Researched feeds & podcast: ${p.state.toUpperCase()} - ${p.detail}. ${follow}`);
      }
      if (modelDown) lines.push("The model was unreachable at send time: the weather brief and calendar notes are left out.");
      notices.push({
        tone: pending.some((p) => !PENDING_STATES.has(p.state)) ? "failed" : "pending",
        title: mode === "deadline" ? `Sent at the ${cfg.sendBy} deadline - not everything is ready` : "Not everything is ready",
        lines,
      });
    }

    // B: build (no lock, no claim - a restart here leaves the day sendable).
    let built: BuiltDigest;
    try {
      built = await this.#d.digest.build({
        subject: `Open Brain Daily Digest — ${date}`,
        skipSections: briefReady ? [] : [BRIEF_SECTION],
        notices,
        generatedAt: this.#iso(),
      });
    } catch (e) {
      await this.#update(date, (s) => {
        Object.assign(s.digest ??= { attempts: 0 }, { phase: "failed", lastError: `build: ${(e as Error)?.name ?? "error"}` });
      });
      this.#log(`[routine] ${date}: digest BUILD failed (${(e as Error)?.message}); nothing sent.`);
      return { action: "failed", date, reason: "build failed" };
    }

    // C: claim right before the transport (lock).
    const claimed = await this.#locked(async () => {
      if (o.forced) await store.claim(date, "digest", { forced: true, at: this.#iso() });
      else if (!(await store.claim(date, "digest", { mode, at: this.#iso() }))) return false;
      await store.update(date, (s) => {
        Object.assign(s.digest ??= { attempts: 0 }, { phase: "sending", claimedAt: this.#iso() });
      });
      return true;
    });
    if (!claimed) return { action: "none", date, reason: "already sent (marker)" };

    // D: send (no lock).
    const outcome = await this.#attemptSend(date, "digest", () => this.#d.digest.send(built), {
      keepClaimOnFail: !!o.forced,
      retries: o.retries ?? cfg.sendRetries,
    });
    const included = briefReady ? [BRIEF_SECTION] : [];
    await this.#update(date, (s) => {
      const d = s.digest ??= { attempts: 0 };
      d.attempts += outcome.attempts;
      if (outcome.ok) {
        Object.assign(d, { phase: "sent", sentAt: this.#iso(), mode, included, pending, modelDownAtSend: modelDown, unconfirmed: false });
      } else {
        Object.assign(d, { phase: outcome.unconfirmed ? "unconfirmed" : "failed", lastError: outcome.error, unconfirmed: outcome.unconfirmed });
      }
      if (o.forced) (s.forced ??= []).push({ at: this.#iso(), kind: "digest", ok: outcome.ok });
    });
    this.#log(
      `[routine] ${date}: digest ${outcome.ok ? "SENT" : outcome.unconfirmed ? "send UNCONFIRMED" : "send FAILED"} ` +
        `(${mode}${o.forced ? ", forced" : ""}; pending: ${pending.map((p) => `${p.section}=${p.state}`).join(", ") || "none"}).`,
    );
    return { action: outcome.ok ? "sent" : outcome.unconfirmed ? "unconfirmed" : "failed", date };
  }

  async #maybeFollowUp(date: string, o: { retries?: number }): Promise<RunOutcome> {
    const { store } = this.#d;
    const st = await store.load(date);
    if (!st.digest?.sentAt) {
      return { action: "none", date, reason: st.digest?.unconfirmed ? "digest send unconfirmed" : "digest send in progress or failed" };
    }
    if (st.digest.included?.includes(BRIEF_SECTION)) return { action: "none", date, reason: "digest already complete" };
    if (await store.hasClaim(date, "followup")) return { action: "none", date, reason: "follow-up already sent (marker)" };
    const view = await this.podcastView(date, st);
    if (!view.briefReady) return { action: "none", date, reason: "nothing new to deliver" };
    const built = await this.#d.digest.build({
      subject: `Open Brain Daily Digest — ${date} (follow-up: research)`,
      onlySections: [BRIEF_SECTION],
      notices: [{
        tone: "info",
        title: `Follow-up to this morning's digest`,
        lines: [`The research that was not ready at ${this.#d.cfg.sendBy} finished at ${localHHMM(this.#d.clock.now(), this.#d.cfg.tz)} local.`],
      }],
      reportStem: "openbrain-digest-followup",
      generatedAt: this.#iso(),
    });
    if (!(await this.#locked(() => store.claim(date, "followup", { at: this.#iso() })))) {
      return { action: "none", date, reason: "follow-up already sent (marker)" };
    }
    const outcome = await this.#attemptSend(date, "followup", () => this.#d.digest.send(built), {
      keepClaimOnFail: false,
      retries: o.retries ?? this.#d.cfg.sendRetries,
    });
    await this.#update(date, (s) => {
      const f = s.followUp ?? { attempts: 0 };
      f.attempts += outcome.attempts;
      if (outcome.ok) Object.assign(f, { sentAt: this.#iso(), unconfirmed: false });
      else Object.assign(f, { lastError: outcome.error, unconfirmed: outcome.unconfirmed });
      s.followUp = f;
    });
    this.#log(`[routine] ${date}: follow-up ${outcome.ok ? "SENT" : outcome.unconfirmed ? "UNCONFIRMED" : "FAILED"}.`);
    return { action: outcome.ok ? "followup" : outcome.unconfirmed ? "unconfirmed" : "failed", date };
  }

  /**
   * Run `send` with the claim already held. A DEFINITE failure (nothing went
   * out: a connect-phase error or an error answer) is retried up to `retries`
   * times and then releases the claim; an AMBIGUOUS one (may have gone out)
   * stops at once and keeps the claim.
   */
  async #attemptSend(
    date: string,
    kind: ClaimKind,
    send: () => Promise<unknown>,
    o: { keepClaimOnFail: boolean; retries: number },
  ): Promise<SendResult> {
    const { cfg, clock, store } = this.#d;
    let attempts = 0;
    let error = "";
    for (let i = 0; i <= o.retries; i++) {
      attempts++;
      try {
        await send();
        return { ok: true, attempts, unconfirmed: false };
      } catch (e) {
        const definite = !(e instanceof MailSendError) || e.definite;
        error = e instanceof MailSendError ? `${e.name}${e.status ? " " + e.status : ""}` : (e as Error)?.name ?? "error";
        this.#log(`[routine] ${date}: ${kind} send attempt ${attempts} failed (${error}; ${definite ? "not sent" : "MAY have been sent"}).`);
        if (!definite) return { ok: false, attempts, error, unconfirmed: true };
        if (i < o.retries) await clock.sleep(cfg.sendRetryGapMs);
      }
    }
    if (!o.keepClaimOnFail) await store.release(date, kind);
    return { ok: false, attempts, error, unconfirmed: false };
  }

  /** Summary for GET /health. */
  async status(): Promise<Record<string, unknown>> {
    const now = this.#d.clock.now();
    const date = this.dayOf(now);
    const st = await this.#d.store.load(date);
    return {
      date,
      tz: this.#d.cfg.tz,
      send_by: this.#d.cfg.sendBy,
      deadline_utc: new Date(this.deadlineOf(date)).toISOString(),
      chain: st.chain ?? null,
      digest: st.digest ? { ...st.digest } : null,
      follow_up: st.followUp ?? null,
      alert: st.alert ?? null,
      telegram_configured: this.#d.alerts.configured,
    };
  }
}

/**
 * The day needs nothing more: the digest went out with nothing missing, or
 * the follow-up went out. A digest sent with a section still running OR
 * failed is not complete - a later run may still deliver the follow-up (once).
 */
export function dayComplete(st: DayState): boolean {
  if (!st.digest?.sentAt) return false;
  return (st.digest.pending ?? []).length === 0 || !!st.followUp?.sentAt;
}
