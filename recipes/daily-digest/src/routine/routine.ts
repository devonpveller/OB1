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
 *        not sent yet: send now with whatever is ready; unfinished sections
 *        are marked (still running / waiting for the model / failed).
 *   deadline + grace (07:15)                              (checkAlert)
 *        digest not sent or podcast not produced: ONE Telegram alert,
 *        content-free.
 *
 * Send-once: every send first takes a claim file (RoutineStore.claim, O_EXCL)
 * for (local date, kind). A forced re-send is explicit: POST /run {"force":true}.
 * All state transitions run under one in-process lock; the claim makes it
 * hold across processes and restarts too.
 */

import { bothClocks, Clock, localDate, localHHMM, nextDate, parseHHMM, zonedEpoch } from "./clock.ts";
import { ModelProbeResult, waitForModel } from "./model-gate.ts";
import { ClaimKind, DayState, PendingNote, PendingState, readJson, RoutineStore } from "./store.ts";
import { AlertSender, buildAlertText } from "./telegram.ts";
import { DigestOrchestrator } from "../digest.ts";
import { MailSendError } from "../clients/gmail.ts";
import type { EmailEnrichment } from "../podcast/enrichment.ts";
import type { RoutineNoticePayload } from "../sections/routine-notice.ts";

export interface RoutineConfig {
  tz: string;
  /** Send-by deadline, local "HH:MM". */
  sendBy: string;
  /** Alert check this long after the deadline. */
  alertGraceMs: number;
  /** Local "HH:MM": stop waiting for the model / starting the chain after this. */
  followUpCutoff: string;
  /** Retries of a DEFINITE send failure, and the gap between them. */
  sendRetries: number;
  sendRetryGapMs: number;
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

export class MorningRoutine {
  readonly #d: MorningRoutineDeps;
  readonly #log: (m: string) => void;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #tasks = new Set<Promise<unknown>>();
  #stop: AbortController | null = null;
  #scheduler: Promise<void> | null = null;

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

  // ── scheduler: deadline + alert, every local day ──────────────────────────
  start(): void {
    if (this.#stop) return;
    this.#stop = new AbortController();
    // Not in #tasks: settled() waits for work, not for the endless scheduler.
    this.#scheduler = this.#schedule(this.#stop.signal).catch((e) => {
      if (!this.#stop?.signal.aborted) console.error(`[routine] scheduler died: ${e}`);
    });
  }
  async stop(): Promise<void> {
    this.#stop?.abort(new DOMException("stopped", "AbortError"));
    await this.#scheduler;
  }

  async #schedule(signal: AbortSignal): Promise<void> {
    const { clock, cfg } = this.#d;
    let date = this.dayOf(clock.now());
    this.#log(`[routine] scheduler up: send-by ${cfg.sendBy} ${cfg.tz}, alert +${cfg.alertGraceMs / 60_000} min, cutoff ${cfg.followUpCutoff}; today ${date}.`);
    while (!signal.aborted) {
      const deadline = this.deadlineOf(date);
      const alertAt = deadline + cfg.alertGraceMs;
      if (clock.now() < deadline) await clock.sleep(deadline - clock.now(), signal);
      // Booted after the cutoff: a "morning" digest at night helps nobody; the
      // alert check below still reports the miss.
      if (clock.now() < this.cutoffOf(date)) await this.onDeadline(date);
      if (clock.now() < alertAt) await clock.sleep(alertAt - clock.now(), signal);
      await this.checkAlert(date);
      date = nextDate(date);
    }
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
    const w = await waitForModel({
      probe: this.#d.probe,
      clock,
      until: this.cutoffOf(date),
      initialMs: this.#d.gateInitialMs,
      maxMs: this.#d.gateMaxMs,
      label: `routine ${date} chain`,
      log: this.#log,
      signal: this.#stop?.signal,
      onDown: (since) => this.#update(date, (s) => {
        if (s.chain) s.chain.modelDownSince = this.#iso(since);
      }).then(() => {}),
    });
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
    if (o.force) return this.#locked(() => this.#sendDigest(date, { forced: true }));

    const early = await this.#locked(async () =>
      (await this.#d.store.hasClaim(date, "digest")) ? await this.#maybeFollowUp(date) : null
    );
    if (early) return early;

    // Not sent yet. Before the deadline: no degraded run - wait for the model
    // (bounded by the deadline; at the deadline the scheduler sends).
    const deadline = this.deadlineOf(date);
    if (clock.now() < deadline) {
      const w = await waitForModel({
        probe: this.#d.probe,
        clock,
        until: deadline,
        initialMs: this.#d.gateInitialMs,
        maxMs: this.#d.gateMaxMs,
        label: `routine ${date} digest`,
        log: this.#log,
        signal: this.#stop?.signal,
      });
      if (!w.up) {
        return { action: "none", date, reason: "model down until the deadline; the deadline send covers it" };
      }
    }
    // C4: re-check the marker after the wait - the deadline may have sent it.
    return this.#locked(async () =>
      (await this.#d.store.hasClaim(date, "digest")) ? await this.#maybeFollowUp(date) : await this.#sendDigest(date, {})
    );
  }

  // ── deadline + alert ────────────────────────────────────────────────────────
  onDeadline(date: string): Promise<RunOutcome> {
    return this.#locked(async () => {
      if (await this.#d.store.hasClaim(date, "digest")) return { action: "none" as const, date, reason: "already sent" };
      this.#log(`[routine] ${date}: send-by deadline ${this.#d.cfg.sendBy} reached and the digest is not out; sending what is ready.`);
      return await this.#sendDigest(date, {});
    });
  }

  checkAlert(date: string): Promise<{ alerted: boolean; delivered?: boolean; reason?: string }> {
    return this.#locked(async () => {
      const { store, alerts, clock } = this.#d;
      const st = await store.load(date);
      const view = await this.podcastView(date, st);
      const digestOk = !!st.digest?.sentAt;
      const podcastOk = view.produced || view.state === "nothing-to-do";
      if (digestOk && podcastOk) return { alerted: false, reason: "all delivered" };
      if (!(await store.claim(date, "alert"))) return { alerted: false, reason: "already alerted" };
      const text = buildAlertText({
        date,
        tz: this.#d.cfg.tz,
        checkedAt: this.#at(clock.now()),
        digest: {
          sent: digestOk,
          attempts: st.digest?.attempts ?? 0,
          state: st.digest?.unconfirmed ? "send unconfirmed" : st.digest?.lastError ? "send failed" : "not attempted",
        },
        podcast: { produced: podcastOk, state: `${view.state}${view.detail ? ": " + view.detail : ""}` },
      });
      const problems = [...(digestOk ? [] : ["digest"]), ...(podcastOk ? [] : ["podcast"])];
      let delivered = false;
      if (!alerts.configured) {
        console.error(`[routine] ${date}: ALERT NOT DELIVERED - Telegram is not configured (SYSADMIN_TELEGRAM_BOT_TOKEN / _CHAT_ID). Problems: ${problems.join(", ")}`);
      } else {
        for (let i = 0; i < 3 && !delivered; i++) {
          delivered = await alerts.send(text);
          if (!delivered && i < 2) await clock.sleep(30_000);
        }
        this.#log(`[routine] ${date}: Telegram alert ${delivered ? "sent" : "FAILED to deliver"} (${problems.join(", ")}).`);
      }
      await store.update(date, (s) => {
        s.alert = { at: this.#iso(), delivered, problems };
      });
      return { alerted: true, delivered };
    });
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
      return view("failed", `podcast run ended without output (${why}, ${this.#hhmm(last.finishedAt!)})`);
    }
    const c = st.chain;
    if (c?.gaveUpAt) return view("failed", `the model stayed down until the ${this.#d.cfg.followUpCutoff} cutoff`);
    if (c?.modelDownSince && !c.modelUpAt) return view("waiting for the model", `down since ${this.#hhmm(c.modelDownSince)}`);
    if (c?.headTriggeredAt) {
      if (this.#d.podcastHealth && (await this.#d.podcastHealth().catch(() => null)) === null) {
        return view("failed", "the podcast service is unreachable");
      }
      return view("still running", `gmail pull/prune, started ${this.#hhmm(c.headTriggeredAt)}`);
    }
    if (c?.startedAt) return view("still running", `chain started ${this.#hhmm(c.startedAt)}`);
    return view("not started", "the morning chain did not start today");
  }

  #hhmm(iso: string): string {
    return `${localHHMM(Date.parse(iso), this.#d.cfg.tz)} local`;
  }

  // ── sends (always called under the lock) ──────────────────────────────────
  async #sendDigest(date: string, o: { forced?: boolean }): Promise<RunOutcome> {
    const { store, clock, cfg } = this.#d;
    const now = clock.now();
    const st = await store.load(date);
    const view = await this.podcastView(date, st);
    const mode: "full" | "deadline" = now < this.deadlineOf(date) ? "full" : "deadline";

    const pending: PendingNote[] = [];
    if (!view.briefReady && view.state !== "nothing-to-do" && view.state !== "produced") {
      pending.push({ section: BRIEF_SECTION, state: view.state as PendingState, detail: view.detail });
    }
    // Only probe when it changes what we say: at/after the deadline the model
    // may be down, and weather/calendar then go without their LLM lines.
    let modelDown = false;
    if (mode === "deadline") modelDown = (await this.#d.probe()).state === "down";

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

    if (o.forced) {
      await store.claim(date, "digest", { forced: true }); // so the deadline does not send again
    } else if (!(await store.claim(date, "digest", { mode }))) {
      return { action: "none", date, reason: "already sent (marker)" };
    }

    const included = view.briefReady ? [BRIEF_SECTION] : [];
    const outcome = await this.#attemptSend(date, "digest", () =>
      this.#d.digest.run({
        subject: `Open Brain Daily Digest — ${date}`,
        skipSections: view.briefReady ? [] : [BRIEF_SECTION],
        notices,
        generatedAt: this.#iso(),
      }), { keepClaimOnFail: !!o.forced });
    await store.update(date, (s) => {
      const d = s.digest ?? { attempts: 0 };
      d.attempts += outcome.attempts;
      if (outcome.ok) {
        Object.assign(d, { sentAt: this.#iso(), mode, included, pending, modelDownAtSend: modelDown, unconfirmed: false });
      } else {
        d.lastError = outcome.error;
        d.unconfirmed = outcome.unconfirmed;
      }
      s.digest = d;
      if (o.forced) (s.forced ??= []).push({ at: this.#iso(), kind: "digest", ok: outcome.ok });
    });
    this.#log(
      `[routine] ${date}: digest ${outcome.ok ? "SENT" : outcome.unconfirmed ? "send UNCONFIRMED" : "send FAILED"} ` +
        `(${mode}${o.forced ? ", forced" : ""}; pending: ${pending.map((p) => `${p.section}=${p.state}`).join(", ") || "none"}).`,
    );
    return { action: outcome.ok ? "sent" : outcome.unconfirmed ? "unconfirmed" : "failed", date };
  }

  async #maybeFollowUp(date: string): Promise<RunOutcome> {
    const { store } = this.#d;
    const st = await store.load(date);
    if (!st.digest?.sentAt) {
      return { action: "none", date, reason: st.digest?.unconfirmed ? "digest send unconfirmed" : "digest send in progress or failed" };
    }
    if (st.digest.included?.includes(BRIEF_SECTION)) return { action: "none", date, reason: "digest already complete" };
    const view = await this.podcastView(date, st);
    if (!view.briefReady) return { action: "none", date, reason: "nothing new to deliver" };
    if (!(await store.claim(date, "followup"))) return { action: "none", date, reason: "follow-up already sent (marker)" };
    const outcome = await this.#attemptSend(date, "followup", () =>
      this.#d.digest.run({
        subject: `Open Brain Daily Digest — ${date} (follow-up: research)`,
        onlySections: [BRIEF_SECTION],
        notices: [{
          tone: "info",
          title: `Follow-up to this morning's digest`,
          lines: [`The research that was not ready at ${this.#d.cfg.sendBy} finished at ${localHHMM(this.#d.clock.now(), this.#d.cfg.tz)} local.`],
        }],
        reportStem: "openbrain-digest-followup",
        generatedAt: this.#iso(),
      }), { keepClaimOnFail: false });
    await store.update(date, (s) => {
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
   * out) is retried up to cfg.sendRetries times and then releases the claim;
   * an AMBIGUOUS one (may have gone out) stops at once and keeps the claim.
   */
  async #attemptSend(
    date: string,
    kind: ClaimKind,
    send: () => Promise<unknown>,
    o: { keepClaimOnFail: boolean },
  ): Promise<{ ok: boolean; attempts: number; error?: string; unconfirmed: boolean }> {
    const { cfg, clock, store } = this.#d;
    let attempts = 0;
    let error = "";
    for (let i = 0; i <= cfg.sendRetries; i++) {
      attempts++;
      try {
        await send();
        return { ok: true, attempts, unconfirmed: false };
      } catch (e) {
        const definite = !(e instanceof MailSendError) || e.definite;
        error = e instanceof MailSendError ? `${e.name}${e.status ? " " + e.status : ""}` : (e as Error)?.name ?? "error";
        this.#log(`[routine] ${date}: ${kind} send attempt ${attempts} failed (${error}; ${definite ? "not sent" : "MAY have been sent"}).`);
        if (!definite) return { ok: false, attempts, error, unconfirmed: true };
        if (i < cfg.sendRetries) await clock.sleep(cfg.sendRetryGapMs);
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
