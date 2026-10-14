/**
 * MorningRoutine (mr-routine-outage, round 3) - ONE idempotent action,
 * ensureToday(), that every caller uses:
 *
 *   openbrain-cron 01:00 local  -> POST /routine/start        ensureToday("cron")
 *   the L14 whole-chain trigger -> POST /routine/ensure       ensureToday("l14")
 *   the podcast's chain end     -> POST /run                  ensureToday("run")
 *   the in-process timer        -> the send-by deadline (07:00), deadline+grace
 *                                  (07:15) and a re-check every
 *                                  ROUTINE_RECHECK_MIN (10)  ensureToday("deadline"|"tick")
 *   boot                                                     ensureToday("boot")
 *
 * Round 5: a start without a body of its own sends CANONICAL_CHAIN_HEAD_BODY
 * (B1); an unreadable record fails closed; a first boot after the pre-routine
 * code already produced today's digest seeds DONE (F3).
 *
 * Today (LOCAL date in ROUTINE_TZ; containers run UTC) is ONE durable record
 * (store.ts) in one of four states:
 *   NOT STARTED -> check dependencies (model, research engine, Gmail auth); a
 *                  down one is HANDED TO ITS OWNER (owner.ts) and re-checked on a
 *                  bounded timer; then start the chain (gmail-pull -> prune ->
 *                  podcast -> /run), or record FAILED with the reason.
 *   IN PROGRESS -> verify activity: the record's heartbeat, the podcast run
 *                  heartbeat, gmail-pull / prune / podcast /health. Stale with
 *                  nothing running -> FAILED (reason). A health read that fails
 *                  is UNKNOWN, never FAILED by itself.
 *   DONE        -> confirm: the digest is verified in Gmail's Sent folder when
 *                  the check is enabled (sent-check.ts); otherwise nothing.
 *   FAILED      -> check dependencies, then retry (bounded: attempts, gap, cutoff).
 * Delivery is expressed through the same record, by the same action:
 *   - the digest goes out when the chain has ended, or at the deadline with
 *     whatever is ready (unfinished sections marked), never waiting on a probe;
 *   - a send whose outcome is UNKNOWN (the request may have reached Gmail) is
 *     resolved by the Sent-folder check: found -> sent, not found -> send again,
 *     check unavailable -> stays unknown (no resend, the alert says so);
 *   - ONE follow-up delivers a section that was pending at send time;
 *   - ONE Telegram alert when, at deadline + grace, the day's promise could not
 *     be kept (digest not out / podcast not produced); an alert Telegram did not
 *     confirm is re-sent at later passes until the cutoff (a duplicate Telegram
 *     after an unknown outcome is the accepted cost; never a duplicate email).
 * The process lock + the record's file lock are held only for decisions;
 * probes, builds, transports and the Sent check run outside them.
 */

import { bothClocks, Clock, localDate, localHHMM, nextDate, parseHHMM, zonedEpoch } from "./clock.ts";
import { ModelProbeResult } from "./model-gate.ts";
import {
  DayRecord,
  DayRecordUnreadableError,
  DepFailure,
  PendingNote,
  PendingState,
  readJson,
  RoutineState,
  RoutineStore,
  SendRecord,
} from "./store.ts";
import { AlertSender, buildAlertText } from "./telegram.ts";
import { Dep, handoffText, OwnerChannel, OWNERS } from "./owner.ts";
import { markerFor, SentChecker, sentCheckDisabled } from "./sent-check.ts";
import { BuiltDigest, DigestOrchestrator } from "../digest.ts";
import { MailSendError } from "../clients/gmail.ts";
import type { EmailEnrichment } from "../podcast/enrichment.ts";
import type { RoutineNoticePayload } from "../sections/routine-notice.ts";

/**
 * Round 5 (B1): THE gmail-pull body of the morning chain - the same JSON the
 * openbrain-cron line posts. Every chain start that carries no body of its own
 * (the ROUTINE_CHAIN_START timer, boot, a FAILED -> retry tick, a resumed
 * dependency wait, an ad-hoc POST with an empty body) sends this, never `{}`
 * (gmail-pull treats `{}` as "use my CLI defaults": SENT mail, 24h, 50).
 * Override with CHAIN_HEAD_BODY (JSON); `{}` there is the explicit opt-in.
 */
export const CANONICAL_CHAIN_HEAD_BODY: Readonly<Record<string, unknown>> = Object.freeze({
  labelsPrefix: "brain/",
  window: "90d",
  limit: 500,
});

/** A caller's body counts only when it is a non-empty JSON object. */
function givenBody(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length > 0
    ? structuredClone(body as Record<string, unknown>)
    : undefined;
}

export interface RoutineConfig {
  tz: string;
  /** Local "HH:MM" the timer may start the chain on its own (cron normally does). */
  chainStart: string;
  /** Send-by deadline, local "HH:MM". */
  sendBy: string;
  /** Alert check this long after the deadline. */
  alertGraceMs: number;
  /** Local "HH:MM": no new chain starts / retries / re-sends after this. */
  followUpCutoff: string;
  /** Re-check tick, and the minimum gap between two attempts of the same thing. */
  recheckMs: number;
  /** How long one dependency wait lasts before FAILED. */
  depWaitMs: number;
  /** IN PROGRESS with no activity for this long -> FAILED. */
  staleMs: number;
  /** Chain attempts per day (first start + retries). */
  maxChainAttempts: number;
}

export function routineConfigFromEnv(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): RoutineConfig {
  const tz = get("ROUTINE_TZ") || "America/New_York";
  new Intl.DateTimeFormat("en-US", { timeZone: tz }); // throws on a bad zone: fail at boot, not at 07:00
  const sendBy = get("ROUTINE_SEND_BY") || "07:00";
  const followUpCutoff = get("ROUTINE_FOLLOWUP_CUTOFF") || "20:00";
  const chainStart = get("ROUTINE_CHAIN_START") || "01:00";
  parseHHMM(sendBy);
  parseHHMM(followUpCutoff);
  parseHHMM(chainStart);
  const num = (k: string, d: number) => {
    const v = Number(get(k));
    return Number.isFinite(v) && get(k) !== undefined && get(k) !== "" ? v : d;
  };
  return {
    tz,
    chainStart,
    sendBy,
    followUpCutoff,
    alertGraceMs: num("ROUTINE_ALERT_GRACE_MIN", 15) * 60_000,
    recheckMs: Math.max(60_000, num("ROUTINE_RECHECK_MIN", 10) * 60_000),
    depWaitMs: num("ROUTINE_DEP_WAIT_MIN", 60) * 60_000,
    staleMs: num("ROUTINE_STALE_MIN", 15) * 60_000,
    maxChainAttempts: Math.max(1, num("ROUTINE_MAX_CHAIN_ATTEMPTS", 3)),
  };
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
  /** One bounded model probe (model-gate.ts probeModel). */
  probe: () => Promise<ModelProbeResult>;
  gateInitialMs?: number;
  gateMaxMs?: number;
  /** GET openbrain-research /health -> its model latch. null = unreachable. */
  researchHealth?: () => Promise<{ state: "up" | "down"; reason?: string } | null>;
  /** GET openbrain-podcast /health -> running? null = unreachable. */
  podcastHealth?: () => Promise<{ running: boolean } | null>;
  pullHealth?: () => Promise<StepHealth | null>;
  pruneHealth?: () => Promise<StepHealth | null>;
  /** The podcast brief artifact (podcast-brief-latest.json). */
  briefPath: string;
  alerts: AlertSender;
  owners?: OwnerChannel;
  sentCheck?: SentChecker;
  /** The chain head (openbrain-gmail-pull /run). */
  chainHeadUrl?: string;
  /** The body a chain start without one sends (default CANONICAL_CHAIN_HEAD_BODY). */
  chainHeadBody?: Record<string, unknown>;
  /** Where openbrain-digest writes its audit copies (first-boot evidence, F3). */
  reportDir?: string;
  fetchFn?: typeof fetch;
  log?: (m: string) => void;
}

export type Trigger = "cron" | "l14" | "run" | "deadline" | "tick" | "boot";

const BRIEF = "podcast_brief";
/** Another process's "sending" older than this is an UNKNOWN outcome (Gmail send times out at 120 s). */
const SEND_STALE_MS = 5 * 60_000;
const PROBE_FRESH_MS = 15 * 60_000;
const HISTORY_CAP = 60;
const PROC = crypto.randomUUID().slice(0, 8);

interface ChainView {
  briefReady: boolean;
  produced: boolean;
  nothingToDo: boolean;
  note: PendingNote | null;
  /** The podcast run of this chain attempt has ended (or its output exists). */
  ended: boolean;
  endFailure?: string;
}

export class MorningRoutine {
  readonly #d: MorningRoutineDeps;
  readonly #log: (m: string) => void;
  readonly #sent: SentChecker;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #tasks = new Set<Promise<unknown>>();
  /** What THIS process has in flight: "<date>:<what>". */
  readonly #inflight = new Set<string>();
  #stop: AbortController | null = null;
  #scheduler: Promise<void> | null = null;
  #lastProbe: { state: "up" | "down"; at: number } | null = null;
  /** "<date>:<why>" already logged as unreadable (one line per cause, not per pass). */
  readonly #unreadableLogged = new Set<string>();

  constructor(deps: MorningRoutineDeps) {
    this.#d = deps;
    this.#log = deps.log ?? ((m) => console.log(m));
    this.#sent = deps.sentCheck ?? sentCheckDisabled;
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
  chainStartOf(date: string): number {
    return zonedEpoch(date, this.#d.cfg.chainStart, this.#d.cfg.tz);
  }
  #now(): number {
    return this.#d.clock.now();
  }
  #iso(ms = this.#now()): string {
    return new Date(ms).toISOString();
  }
  #hhmm(iso: string | undefined | null): string {
    return iso ? `${localHHMM(Date.parse(iso), this.#d.cfg.tz)} local` : "?";
  }
  #ago(iso: string | undefined | null): number {
    return iso ? this.#now() - Date.parse(iso) : Infinity;
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
  /** Resolves when every task this routine started has settled (tests). */
  async settled(): Promise<void> {
    while (this.#tasks.size) await Promise.allSettled([...this.#tasks]);
  }
  /** Mutate today's record (process lock + file lock). */
  #mutate<T>(date: string, fn: (r: DayRecord) => T | Promise<T>): Promise<T> {
    return this.#locked(() => this.#d.store.update(date, fn));
  }
  #note(r: DayRecord, trigger: string, note: string) {
    r.history.push({ at: this.#iso(), trigger, note });
    if (r.history.length > HISTORY_CAP) r.history.splice(0, r.history.length - HISTORY_CAP);
    this.#log(`[routine] ${r.date}: ${note}`);
  }
  #probe = async (): Promise<ModelProbeResult> => {
    const r = await this.#d.probe();
    this.#lastProbe = { state: r.state, at: this.#now() };
    return r;
  };

  // ── scheduler ───────────────────────────────────────────────────────────
  start(): void {
    if (this.#stop) return;
    this.#stop = new AbortController();
    this.#scheduler = this.#schedule(this.#stop.signal).catch((e) => {
      if (!this.#stop?.signal.aborted) console.error(`[routine] scheduler died: ${e}`);
    });
  }
  async stop(): Promise<void> {
    this.#stop?.abort(new DOMException("stopped", "AbortError"));
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.#scheduler, new Promise((r) => (t = setTimeout(r, 2_000)))]);
    clearTimeout(t);
  }

  async #schedule(signal: AbortSignal): Promise<void> {
    const { clock, cfg } = this.#d;
    this.#log(`[routine] scheduler up: chain ${cfg.chainStart}, send-by ${cfg.sendBy} ${cfg.tz}, alert +${cfg.alertGraceMs / 60_000} min, re-check every ${cfg.recheckMs / 60_000} min, cutoff ${cfg.followUpCutoff}.`);
    await this.#pass("boot");
    while (!signal.aborted) {
      const now = clock.now();
      const date = this.dayOf(now);
      const marks = [this.chainStartOf(date), this.deadlineOf(date), this.deadlineOf(date) + cfg.alertGraceMs, this.chainStartOf(nextDate(date))];
      const tick = Math.floor(now / cfg.recheckMs) * cfg.recheckMs + cfg.recheckMs;
      const next = Math.min(tick, ...marks.filter((m) => m > now));
      await clock.sleep(next - now, signal);
      const isDeadline = next === this.deadlineOf(this.dayOf(next));
      await this.#pass(isDeadline ? "deadline" : "tick");
    }
  }

  /** A timer pass: a failure (e.g. an unreadable record) is logged, never kills the scheduler. */
  async #pass(trigger: Trigger): Promise<void> {
    try {
      await this.ensureToday(trigger);
    } catch (e) {
      if (!(e instanceof DayRecordUnreadableError)) console.error(`[routine] ${trigger} pass failed: ${(e as Error)?.name ?? "error"}`);
    }
  }

  // ── THE action ──────────────────────────────────────────────────────────
  /**
   * Idempotent: look at today's record and do the next right thing. Returns
   * the record as it stands after the decision (actions continue in the
   * background and update it). `body` = the gmail-pull body (cron / L14).
   */
  async ensureToday(trigger: Trigger, o: { body?: unknown } = {}): Promise<DayRecord> {
    const date = this.dayOf(this.#now());
    await this.#firstLook(date, trigger);
    // Health reads happen BEFORE the locks (bounded 5 s each), never inside.
    const activity = await this.#readActivity(date);
    const view = await this.#chainView(date, activity);
    const actions: Array<() => Promise<unknown>> = [];
    const rec = await this.#mutate(date, (r) => {
      this.#decide(r, trigger, view, activity, actions, o.body);
      r.state = deriveState(r);
      return structuredClone(r);
    });
    for (const a of actions) this.#track(a()).catch((e) => console.error(`[routine] ${date}: action failed: ${e}`));
    return rec;
  }

  /**
   * Round 5 (F3). Before anything else, today's record must be readable:
   *  - unreadable -> fail closed: throw (no chain start, no send), logged once
   *    per cause; the file is left untouched for the operator.
   *  - missing, and the pre-routine code ALREADY produced today's digest (its
   *    audit copy openbrain-digest-<ISO>.md is dated today, local) -> seed the
   *    record DONE / sent and do nothing: never a second digest at first boot.
   */
  async #firstLook(date: string, trigger: Trigger): Promise<void> {
    const got = await this.#d.store.inspect(date);
    if (got.kind === "unreadable") this.#failClosed(new DayRecordUnreadableError(date, got.why), trigger);
    if (got.kind !== "missing") return;
    let evidence: { file: string; at: string } | null;
    try {
      evidence = await this.#legacyDigestOf(date);
    } catch (e) {
      this.#failClosed(e as DayRecordUnreadableError, trigger);
    }
    if (!evidence) return;
    const ev = evidence;
    await this.#mutate(date, (r) => {
      // Under the lock: seed only a record nobody has touched yet.
      if (r.history.length || r.chain.status !== "not-started" || r.digest.status !== "not-sent") return;
      r.chain = { status: "done", attempts: 1, outcome: "produced", doneAt: ev.at };
      r.digest = { status: "sent", attempts: 1, sentAt: ev.at };
      this.#note(r, trigger, `seeded DONE at first boot: today's digest was already produced at ${this.#hhmm(ev.at)} by the pre-routine code (${ev.file}) - nothing to send`);
      r.state = deriveState(r);
    });
  }

  #failClosed(err: DayRecordUnreadableError, trigger: Trigger): never {
    const key = `${err.date}:${err.why}`;
    if (!this.#unreadableLogged.has(key)) {
      this.#unreadableLogged.add(key);
      console.error(`[routine] ${err.message} (trigger ${trigger}; the operator fixes or removes ${this.#d.store.dayPath(err.date)})`);
    }
    throw err;
  }

  /** The latest openbrain-digest audit copy dated today (local), if any. */
  async #legacyDigestOf(date: string): Promise<{ file: string; at: string } | null> {
    const dir = this.#d.reportDir;
    if (!dir) return null;
    const re = /^openbrain-digest-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/;
    let best: { file: string; ms: number } | null = null;
    try {
      for await (const e of Deno.readDir(dir)) {
        const m = e.isFile ? re.exec(e.name) : null;
        if (!m) continue;
        const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
        if (!Number.isFinite(ms) || this.dayOf(ms) !== date) continue;
        if (!best || ms > best.ms) best = { file: e.name, ms };
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      // Cannot tell whether today's digest already went out: fail closed.
      throw new DayRecordUnreadableError(date, `reports dir unreadable (${(e as Error)?.name ?? "error"})`);
    }
    return best ? { file: best.file, at: this.#iso(best.ms) } : null;
  }

  /** B1: the body a start sends - the caller's, else the one this day's chain started with, else the canonical one. */
  #headBodyFor(c: DayRecord["chain"], body: unknown): Record<string, unknown> {
    const hb = givenBody(body) ?? c.headBody ?? structuredClone({ ...(this.#d.chainHeadBody ?? CANONICAL_CHAIN_HEAD_BODY) });
    c.headBody = hb;
    return hb;
  }

  #decide(
    r: DayRecord,
    trigger: Trigger,
    view: ChainView,
    act: Activity,
    actions: Array<() => Promise<unknown>>,
    body: unknown,
  ) {
    const { cfg } = this.#d;
    const now = this.#now();
    const date = r.date;
    const deadline = this.deadlineOf(date);
    const cutoff = this.cutoffOf(date);
    const c = r.chain;

    // 1. A send another process (or a dead one) left "sending" too long -> unknown.
    for (const kind of ["digest", "followup"] as const) {
      const s = kind === "digest" ? r.digest : r.followUp;
      if (s.status === "sending" && !this.#inflight.has(`${date}:${kind}`) && this.#ago(s.sendingAt) > SEND_STALE_MS) {
        s.status = "unknown";
        this.#note(r, trigger, `${kind} was 'sending' since ${this.#hhmm(s.sendingAt)} with no process finishing it -> outcome UNKNOWN`);
      }
    }

    // 2. Chain state machine.
    const startChain = (why: string) => {
      c.status = "waiting-deps";
      c.attempts += 1;
      c.startedAt = this.#iso();
      c.heartbeatAt = this.#iso();
      c.waitUntil = this.#iso(Math.min(now + cfg.depWaitMs, cutoff));
      c.reason = undefined;
      this.#note(r, trigger, `chain attempt ${c.attempts} (${why}): checking dependencies`);
      this.#inflight.add(`${date}:chain`);
      const attempt = c.attempts;
      const hb = this.#headBodyFor(c, body);
      actions.push(() => this.#runChain(date, attempt, hb).finally(() => this.#inflight.delete(`${date}:chain`)));
    };
    const fail = (reason: string) => {
      c.status = "failed";
      c.failedAt = this.#iso();
      c.reason = reason;
      this.#note(r, trigger, `chain FAILED: ${reason}`);
    };

    // The content pipeline reports its end (/run) or its end is visible.
    if (c.status !== "done" && view.ended) {
      if (view.produced || view.nothingToDo || view.briefReady) {
        c.status = "done";
        c.doneAt = this.#iso();
        c.outcome = view.nothingToDo ? "nothing-to-do" : "produced";
        this.#note(r, trigger, `chain DONE (${c.outcome})`);
      } else if (c.status === "running" && view.endFailure) {
        fail(view.endFailure);
      }
    }

    switch (c.status) {
      case "not-started": {
        const allowed = trigger === "cron" || trigger === "l14" || now >= this.chainStartOf(date);
        if (allowed && now < cutoff) startChain(trigger);
        break;
      }
      case "waiting-deps": {
        // Our own wait is in flight -> its heartbeat is the activity. A wait
        // that no process owns (restart) is resumed; one past its bound fails.
        // Another process's wait keeps the heartbeat fresh: leave it alone.
        if (!this.#inflight.has(`${date}:chain`) && this.#ago(c.heartbeatAt) > cfg.staleMs) {
          if (now >= Date.parse(c.waitUntil ?? this.#iso()) || now >= cutoff) fail("dependency wait ended with no process watching it");
          else {
            this.#note(r, trigger, "resuming the dependency wait (no process owned it)");
            this.#inflight.add(`${date}:chain`);
            const attempt = c.attempts;
            const hb = this.#headBodyFor(c, body);
            actions.push(() => this.#runChain(date, attempt, hb).finally(() => this.#inflight.delete(`${date}:chain`)));
          }
        }
        break;
      }
      case "running": {
        // A step that ENDED IN ERROR after this attempt's trigger is a failure now.
        const since = Date.parse(c.headTriggeredAt ?? c.startedAt ?? this.#iso());
        const erred = [act.pull, act.prune].find((h) => h?.last_error && h.last_run_at && Date.parse(h.last_run_at) >= since - 1_000);
        if (erred && !act.anyRunning) {
          fail(act.stopHint || "a chain step ended in error");
          break;
        }
        const fresh = this.#ago(c.heartbeatAt) <= cfg.staleMs || act.anyRunning || act.podcastBeatFresh(cfg.staleMs);
        if (!fresh) {
          const stale = this.#ago(c.heartbeatAt);
          // A health read that failed is UNKNOWN: give it twice the bound before FAILED.
          if (act.unknown.length && stale <= 2 * cfg.staleMs) break;
          fail(`no activity since ${this.#hhmm(act.lastActivityIso ?? c.heartbeatAt)}${act.unknown.length ? ` (${act.unknown.join(", ")} health unreadable)` : ""}${act.stopHint ? `; ${act.stopHint}` : ""}`);
        }
        break;
      }
      case "failed": {
        // FAILED -> check dependencies, then retry. A dependency check that finds
        // something down consumes no attempt (the model may be out all morning).
        if (
          now < cutoff && c.attempts < cfg.maxChainAttempts && !view.produced && !this.#inflight.has(`${date}:chain`) &&
          this.#ago(c.lastCheckAt ?? c.failedAt) >= cfg.recheckMs - 1_000
        ) {
          c.lastCheckAt = this.#iso();
          this.#inflight.add(`${date}:chain`);
          const seen = c.attempts;
          const hb = this.#headBodyFor(c, body);
          actions.push(() => this.#retryChain(date, seen, hb).finally(() => this.#inflight.delete(`${date}:chain`)));
        }
        break;
      }
      case "done":
        break;
    }

    // 3. Digest.
    const dg = r.digest;
    if (dg.status === "unknown" && !this.#inflight.has(`${date}:verify-digest`)) {
      this.#inflight.add(`${date}:verify-digest`);
      actions.push(() => this.#resolveUnknown(date, "digest").finally(() => this.#inflight.delete(`${date}:verify-digest`)));
    }
    const chainEnded = c.status === "done" || (c.status === "failed" && (c.attempts >= cfg.maxChainAttempts || now >= cutoff)) ||
      trigger === "run";
    const digestDue = now >= deadline || chainEnded;
    const mayTry = (s: SendRecord) =>
      (s.status === "not-sent" || (s.status === "failed" && this.#ago(s.lastAttemptAt) >= cfg.recheckMs - 1_000));
    // After the cutoff a "morning" digest helps nobody: the alert reports the miss.
    if (digestDue && mayTry(dg) && now < cutoff) {
      {
        dg.status = "sending";
        dg.sendingAt = this.#iso();
        dg.sendingBy = PROC;
        dg.lastAttemptAt = this.#iso();
        dg.attempts += 1;
        const mode: "full" | "deadline" = now < deadline ? "full" : "deadline";
        this.#inflight.add(`${date}:digest`);
        this.#note(r, trigger, `digest send attempt ${dg.attempts} (${mode})`);
        actions.push(() => this.#sendDigest(date, mode, trigger).finally(() => this.#inflight.delete(`${date}:digest`)));
      }
    }

    // 4. Follow-up: once, when a section that was pending at send time is ready.
    const fu = r.followUp;
    if (fu.status === "unknown" && !this.#inflight.has(`${date}:verify-followup`)) {
      this.#inflight.add(`${date}:verify-followup`);
      actions.push(() => this.#resolveUnknown(date, "followup").finally(() => this.#inflight.delete(`${date}:verify-followup`)));
    }
    if (
      dg.status === "sent" && (dg.pending ?? []).length > 0 && !(dg.included ?? []).includes(BRIEF) &&
      view.briefReady && mayTry(fu)
    ) {
      fu.status = "sending";
      fu.sendingAt = this.#iso();
      fu.sendingBy = PROC;
      fu.lastAttemptAt = this.#iso();
      fu.attempts += 1;
      this.#inflight.add(`${date}:followup`);
      this.#note(r, trigger, `follow-up send attempt ${fu.attempts}`);
      actions.push(() => this.#sendFollowUp(date).finally(() => this.#inflight.delete(`${date}:followup`)));
    }

    // 5. DONE: confirm the digest in the Sent folder (when the check is enabled).
    if (dg.status === "sent" && dg.verified === undefined && this.#sent.enabled && !this.#inflight.has(`${date}:confirm`)) {
      this.#inflight.add(`${date}:confirm`);
      actions.push(() => this.#confirmSent(date).finally(() => this.#inflight.delete(`${date}:confirm`)));
    }

    // 6. Alert: ONE per day, from deadline + grace, while the promise is broken.
    // A digest send starting in this very pass makes the facts stale: the alert
    // waits for the next pass (it then says "digest: sent" if it went out).
    const al = r.alert;
    const digestStarting = this.#inflight.has(`${date}:digest`);
    if (now >= deadline + cfg.alertGraceMs && this.dayOf(now) === date && !digestStarting) {
      const problems = [
        ...(dg.status === "sent" ? [] : ["digest"]),
        ...(view.produced || view.nothingToDo || c.outcome === "produced" || c.outcome === "nothing-to-do" ? [] : ["podcast"]),
      ];
      const inFlight = this.#inflight.has(`${date}:alert`);
      if (al.status === "none" && problems.length && !inFlight) {
        al.status = "pending";
        al.firstAt = this.#iso();
        al.lastAt = this.#iso(); // claims the try for every process (retry gap)
        al.problems = problems;
        this.#note(r, trigger, `alert raised (${problems.join(", ")})`);
        this.#inflight.add(`${date}:alert`);
        actions.push(() => this.#deliverAlert(date).finally(() => this.#inflight.delete(`${date}:alert`)));
      } else if (
        al.status === "pending" && !inFlight && now < cutoff && al.lastOutcome !== "unconfigured" &&
        this.#ago(al.lastAt) >= cfg.recheckMs - 1_000
      ) {
        if (!problems.length) {
          al.status = "resolved";
          this.#note(r, trigger, "alert no longer needed (resolved before it got through)");
        } else {
          al.problems = problems;
          al.lastAt = this.#iso();
          this.#inflight.add(`${date}:alert`);
          actions.push(() => this.#deliverAlert(date).finally(() => this.#inflight.delete(`${date}:alert`)));
        }
      }
    }
  }

  // ── chain start: dependency check -> hand-off -> bounded wait -> trigger ──
  async #runChain(date: string, attempt: number, body: Record<string, unknown>): Promise<void> {
    const { clock } = this.#d;
    const rec0 = await this.#d.store.load(date);
    const until = Date.parse(rec0.chain.waitUntil ?? this.#iso());
    let delay = Math.max(1, this.#d.gateInitialMs ?? 30_000);
    const cap = Math.max(delay, this.#d.gateMaxMs ?? 300_000);
    for (;;) {
      const failing = await this.#checkDeps();
      const ok = failing.length === 0;
      await this.#mutate(date, (r) => {
        if (r.chain.attempts !== attempt || r.chain.status !== "waiting-deps") return;
        r.chain.heartbeatAt = this.#iso();
        r.deps = { checkedAt: this.#iso(), ok, failing };
        const md = failing.find((f) => f.dep === "model");
        if (md && !r.chain.modelDownSince) r.chain.modelDownSince = this.#iso();
        if (!md) r.chain.modelDownSince = undefined;
      });
      if (ok) break;
      await this.#handOff(date, failing, until);
      if (clock.now() >= until) {
        await this.#mutate(date, (r) => {
          if (r.chain.attempts !== attempt || r.chain.status !== "waiting-deps") return;
          r.chain.status = "failed";
          r.chain.failedAt = this.#iso();
          r.chain.reason = `dependency not operational: ${failing.map((f) => `${f.dep} (${f.reason})`).join("; ")} - no recovery by ${this.#hhmm(this.#iso(until))}`;
          this.#note(r, "chain", `chain FAILED: ${r.chain.reason}`);
          r.state = deriveState(r);
        });
        return;
      }
      await clock.sleep(Math.min(delay, until - clock.now()), this.#stop?.signal);
      delay = Math.min(cap, delay * 2);
    }
    // Dependencies up. C4: the day may have moved on while we waited.
    const go = await this.#mutate(date, (r) => {
      if (r.chain.attempts !== attempt || r.chain.status !== "waiting-deps") return false;
      r.chain.status = "running";
      r.chain.headTriggeredAt = this.#iso(); // stamped BEFORE the trigger
      r.chain.heartbeatAt = this.#iso();
      this.#note(r, "chain", "dependencies operational -> triggering gmail-pull");
      r.state = deriveState(r);
      return true;
    });
    if (!go) return;
    await this.#triggerHead(date, attempt, body);
  }

  /** FAILED: check dependencies; all up -> a new attempt starts at once; else stay FAILED. */
  async #retryChain(date: string, seenAttempts: number, body: Record<string, unknown>): Promise<void> {
    const failing = await this.#checkDeps();
    const attempt = await this.#mutate(date, (r) => {
      r.deps = { checkedAt: this.#iso(), ok: failing.length === 0, failing };
      const md = failing.find((f) => f.dep === "model");
      if (md && !r.chain.modelDownSince) r.chain.modelDownSince = this.#iso();
      if (!md) r.chain.modelDownSince = undefined;
      if (failing.length || r.chain.status !== "failed" || r.chain.attempts !== seenAttempts) return 0;
      r.chain.attempts += 1;
      r.chain.status = "running";
      r.chain.startedAt = this.#iso();
      r.chain.headTriggeredAt = this.#iso();
      r.chain.heartbeatAt = this.#iso();
      this.#note(r, "chain", `chain attempt ${r.chain.attempts} (retry after: ${r.chain.reason ?? "failure"}): dependencies operational -> triggering gmail-pull`);
      r.chain.reason = undefined;
      r.state = deriveState(r);
      return r.chain.attempts;
    });
    if (failing.length) {
      await this.#handOff(date, failing, this.cutoffOf(date));
      return;
    }
    if (attempt) await this.#triggerHead(date, attempt, body);
  }

  async #triggerHead(date: string, attempt: number, body: Record<string, unknown>): Promise<void> {
    let status = 0;
    if (this.#d.chainHeadUrl) {
      try {
        const res = await (this.#d.fetchFn ?? fetch)(this.#d.chainHeadUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        status = res.status;
        await res.body?.cancel();
      } catch { /* status 0 */ }
    } else status = 202;
    await this.#mutate(date, (r) => {
      if (r.chain.attempts !== attempt) return;
      r.chain.headStatus = status;
      if (status === 0 || ((status < 200 || status >= 300) && status !== 409)) {
        r.chain.status = "failed";
        r.chain.failedAt = this.#iso();
        r.chain.reason = status ? `gmail-pull refused the chain trigger (HTTP ${status})` : "gmail-pull did not answer the chain trigger";
        this.#note(r, "chain", `chain FAILED: ${r.chain.reason}`);
      }
      r.state = deriveState(r);
    });
  }

  async #checkDeps(): Promise<DepFailure[]> {
    const out: DepFailure[] = [];
    const m = await this.#probe();
    if (m.state === "down") out.push({ dep: "model", reason: m.reason });
    if (this.#d.researchHealth) {
      const h = await this.#d.researchHealth().catch(() => null);
      if (!h) out.push({ dep: "research", reason: "research engine /health unreachable" });
      else if (h.state === "down") out.push({ dep: "research", reason: `research engine reports model ${h.reason ?? "down"}` });
    }
    try {
      await this.#d.digest.checkMailAuth();
    } catch (e) {
      out.push({ dep: "gmail-auth", reason: `no Gmail access token (${(e as Error)?.name ?? "error"})` });
    }
    return out;
  }

  /** Each failing dependency is handed to its owner ONCE per day. */
  async #handOff(date: string, failing: DepFailure[], until: number): Promise<void> {
    const owners = this.#d.owners;
    const st = await this.#d.store.load(date);
    for (const f of failing) {
      if ((st.handoffs ?? []).some((h) => h.dep === f.dep)) continue;
      const text = handoffText(date, f.dep as Dep, f.reason, bothClocks(this.#now(), this.#d.cfg.tz), bothClocks(until, this.#d.cfg.tz));
      const outcome = owners ? await owners.request(f.dep as Dep, text) : "unconfigured";
      await this.#mutate(date, (r) => {
        (r.handoffs ??= []).push({ dep: f.dep, owner: OWNERS[f.dep as Dep], at: this.#iso(), outcome });
        this.#note(r, "chain", `dependency ${f.dep} handed to its owner (${outcome})`);
      });
    }
  }

  // ── sends ───────────────────────────────────────────────────────────────
  async #sendDigest(date: string, mode: "full" | "deadline", trigger: Trigger) {
    const { cfg } = this.#d;
    // What to say is read NOW (after this pass's transitions), not before it.
    const view = await this.#chainView(date, await this.#readActivity(date));
    const briefReady = view.briefReady;
    const pending: PendingNote[] = view.note && !briefReady ? [view.note] : [];
    // Round 4: NO send path probes the model. A send that waited on a probe while
    // holding "sending" missed 07:00 (attempt-3 X1). The model is gated where the
    // CONTENT is made (chain start, link-enrich); the digest's own LLM lines
    // (weather brief, calendar notes) are bounded by the orchestrator's
    // per-section timeout and simply left out when the model does not answer.
    void trigger;
    const lp = this.#lastProbe;
    const modelDown = mode === "deadline" && !!lp && lp.state === "down" && this.#now() - lp.at <= PROBE_FRESH_MS;
    const notices: RoutineNoticePayload[] = [];
    if (pending.length || modelDown) {
      const lines = pending.map((p) =>
        `Researched feeds & podcast: ${p.state.toUpperCase()} - ${p.detail}. ${
          p.mayFollow ? "A short follow-up email will deliver it if it completes today." : "No follow-up will come for it today."
        }`
      );
      if (modelDown) lines.push("The model was unreachable at send time: the weather brief and calendar notes are left out.");
      notices.push({
        tone: pending.some((p) => !p.mayFollow) ? "failed" : "pending",
        title: mode === "deadline" ? `Sent at the ${cfg.sendBy} deadline - not everything is ready` : "Not everything is ready",
        lines,
      });
    }
    let built: BuiltDigest;
    try {
      built = await this.#d.digest.build({
        subject: `Open Brain Daily Digest — ${date}`,
        skipSections: briefReady ? [] : [BRIEF],
        notices,
        generatedAt: this.#iso(),
      });
    } catch (e) {
      // Nothing left the machine.
      await this.#finishSend(date, "digest", "failed", `build: ${(e as Error)?.name ?? "error"}`);
      return;
    }
    const outcome = await this.#transport(() => this.#d.digest.send(built, markerFor(date, "digest")));
    await this.#finishSend(date, "digest", outcome.status, outcome.error, { mode, pending, included: briefReady ? [BRIEF] : [] });
    // Re-evaluate at once with the outcome known (the alert was held while this send was in flight).
    this.#inflight.delete(`${date}:digest`);
    await this.ensureToday("tick");
  }

  async #sendFollowUp(date: string) {
    let built: BuiltDigest;
    try {
      built = await this.#d.digest.build({
        subject: `Open Brain Daily Digest — ${date} (follow-up: research)`,
        onlySections: [BRIEF],
        notices: [{
          tone: "info",
          title: "Follow-up to this morning's digest",
          lines: [`The research that was not ready at ${this.#d.cfg.sendBy} finished at ${localHHMM(this.#now(), this.#d.cfg.tz)} local.`],
        }],
        reportStem: "openbrain-digest-followup",
        generatedAt: this.#iso(),
      });
    } catch (e) {
      await this.#finishSend(date, "followup", "failed", `build: ${(e as Error)?.name ?? "error"}`);
      return;
    }
    const outcome = await this.#transport(() => this.#d.digest.send(built, markerFor(date, "followup")));
    await this.#finishSend(date, "followup", outcome.status, outcome.error);
  }

  /** sent | failed (definitely not sent) | unknown (may have gone out). */
  async #transport(send: () => Promise<void>): Promise<{ status: "sent" | "failed" | "unknown"; error?: string }> {
    try {
      await send();
      return { status: "sent" };
    } catch (e) {
      const definite = !(e instanceof MailSendError) || e.definite;
      const error = e instanceof MailSendError ? `${e.name}${e.status ? " " + e.status : ""}` : (e as Error)?.name ?? "error";
      return { status: definite ? "failed" : "unknown", error };
    }
  }

  async #finishSend(
    date: string,
    kind: "digest" | "followup",
    status: "sent" | "failed" | "unknown",
    error?: string,
    extra: Partial<SendRecord> = {},
  ) {
    await this.#mutate(date, (r) => {
      const s = kind === "digest" ? r.digest : r.followUp;
      s.status = status;
      s.sendingAt = undefined;
      s.sendingBy = undefined;
      if (status === "sent") {
        s.sentAt = this.#iso();
        Object.assign(s, extra);
      } else s.lastError = error;
      this.#note(r, kind, `${kind} ${status === "sent" ? "SENT" : status === "failed" ? `send FAILED (${error}; not sent)` : `send outcome UNKNOWN (${error}; may have gone out)`}`);
      r.state = deriveState(r);
    });
  }

  /** UNKNOWN -> look in the Sent folder: found = sent; not found = not sent (send again); unavailable = stays unknown. */
  async #resolveUnknown(date: string, kind: "digest" | "followup") {
    const res = await this.#sent.check(date, kind);
    await this.#mutate(date, (r) => {
      const s = kind === "digest" ? r.digest : r.followUp;
      if (s.status !== "unknown") return;
      s.verifyNote = res.note;
      if (res.result === "found") {
        s.status = "sent";
        s.sentAt ??= s.lastAttemptAt;
        s.verified = true;
        this.#note(r, "verify", `${kind}: unknown outcome resolved - FOUND in Sent`);
      } else if (res.result === "not-found") {
        s.status = "failed";
        s.lastAttemptAt = this.#iso(this.#now() - this.#d.cfg.recheckMs); // eligible at once
        s.verified = false;
        this.#note(r, "verify", `${kind}: unknown outcome resolved - NOT in Sent, will send again`);
      } else {
        s.verified = null;
      }
      r.state = deriveState(r);
    });
    // a "not-found" can be sent again right away
    if (res.result === "not-found") await this.ensureToday("tick");
  }

  async #confirmSent(date: string) {
    const res = await this.#sent.check(date, "digest");
    await this.#mutate(date, (r) => {
      if (r.digest.status !== "sent") return;
      r.digest.verified = res.result === "found" ? true : res.result === "not-found" ? false : null;
      r.digest.verifyNote = res.note;
      if (res.result === "not-found") this.#note(r, "verify", "digest: Gmail accepted it but it is NOT in Sent (no resend; check Gmail)");
    });
  }

  async #deliverAlert(date: string) {
    const { alerts } = this.#d;
    const r0 = await this.#d.store.load(date);
    const view = await this.#chainView(date, await this.#readActivity(date));
    const text = buildAlertText({
      date,
      tz: this.#d.cfg.tz,
      checkedAt: bothClocks(this.#now(), this.#d.cfg.tz),
      digest: { sent: r0.digest.status === "sent", attempts: r0.digest.attempts, state: this.#digestState(r0) },
      podcast: {
        produced: (r0.alert.problems ?? []).indexOf("podcast") < 0,
        state: view.note ? `${view.note.state}: ${view.note.detail}` : (r0.chain.reason ?? r0.chain.status),
      },
    });
    let outcome: string;
    if (!alerts.configured) {
      outcome = "unconfigured";
      console.error(`[routine] ${date}: ALERT NOT DELIVERED - Telegram is not configured (SYSADMIN_TELEGRAM_BOT_TOKEN / _CHAT_ID).`);
    } else outcome = await alerts.send(text);
    await this.#mutate(date, (r) => {
      r.alert.tries += 1;
      r.alert.lastAt = this.#iso();
      r.alert.lastOutcome = outcome;
      if (outcome === "delivered") r.alert.status = "delivered";
      // not-delivered / unknown stay "pending": re-sent at later passes until the
      // cutoff; "unconfigured" stays pending and is never retried (nothing to send to).
      this.#note(r, "alert", `Telegram alert: ${outcome}`);
      r.state = deriveState(r);
    });
  }

  #digestState(r: DayRecord): string {
    const d = r.digest;
    switch (d.status) {
      case "sent":
        return "sent";
      case "sending":
        return `sending since ${this.#hhmm(d.sendingAt)}`;
      case "unknown":
        return `send outcome unknown (${d.verifyNote ?? (this.#sent.enabled ? "Sent-folder check pending" : "Sent-folder check not enabled")})`;
      case "failed":
        return `send failed (${d.lastError ?? "error"}); retrying`;
      default:
        return "not attempted";
    }
  }

  // ── what is happening (read BEFORE the locks) ────────────────────────────
  async #readActivity(date: string): Promise<Activity> {
    const d = this.#d;
    const [pod, pull, prune, rec] = await Promise.all([
      d.podcastHealth ? d.podcastHealth().catch(() => null) : Promise.resolve(undefined),
      d.pullHealth ? d.pullHealth().catch(() => null) : Promise.resolve(undefined),
      d.pruneHealth ? d.pruneHealth().catch(() => null) : Promise.resolve(undefined),
      d.store.loadPodcast(date),
    ]);
    const unknown: string[] = [];
    if (pod === null) unknown.push("podcast");
    if (pull === null) unknown.push("gmail-pull");
    if (prune === null) unknown.push("gmail-prune");
    const run = rec?.runs.at(-1);
    const now = this.#now();
    const lastIso = [run?.heartbeatAt, run?.finishedAt, prune?.last_run_at ?? undefined, pull?.last_run_at ?? undefined]
      .filter((x): x is string => !!x).sort().at(-1);
    let stopHint = "";
    if (pull && pull.last_error) stopHint = `gmail pull failed (${this.#hhmm(pull.last_run_at)})`;
    else if (prune && prune.last_error) stopHint = `gmail prune failed (${this.#hhmm(prune.last_run_at)})`;
    return {
      podcastRunning: !!pod?.running || (!!run && !run.finishedAt && !d.podcastHealth),
      pullRunning: !!pull?.running,
      pruneRunning: !!prune?.running,
      anyRunning: !!pod?.running || !!pull?.running || !!prune?.running,
      unknown,
      run,
      pull: pull ?? null,
      prune: prune ?? null,
      lastActivityIso: lastIso,
      stopHint,
      podcastBeatFresh: (staleMs: number) => !!run && !run.finishedAt && !!run.heartbeatAt && now - Date.parse(run.heartbeatAt) <= staleMs,
    };
  }

  /** The research/podcast section as the digest and the alert describe it. */
  async #chainView(date: string, act: Activity): Promise<ChainView> {
    const { store, cfg } = this.#d;
    const r = await store.load(date);
    const c = r.chain;
    const brief = await readJson<EmailEnrichment & { routineDate?: string }>(this.#d.briefPath);
    const briefDate = brief ? (brief.routineDate ?? (brief.generatedAt ? this.dayOf(Date.parse(brief.generatedAt)) : "")) : "";
    const briefReady = !!brief && briefDate === date &&
      (!!brief.episode || brief.segments?.some((s) => s.items.length > 0) || (brief.followUps?.length ?? 0) > 0);
    const produced = briefReady && !!brief?.episode;
    const result = await store.loadResult(date);
    const run = act.run;
    const now = this.#now();
    const nothingToDo = result?.outcome === "nothing-to-do" && run?.code === 0;
    const retryLeft = c.attempts < cfg.maxChainAttempts && now < this.cutoffOf(date);
    const note = (state: PendingState, detail: string, mayFollow: boolean): PendingNote => ({ section: BRIEF, state, detail, mayFollow });

    // Did the podcast run (started after this chain's trigger) end?
    const runAfterHead = !!run && (!c.headTriggeredAt || Date.parse(run.startedAt) >= Date.parse(c.headTriggeredAt) - 1_000);
    const ended = (!!run && !!run.finishedAt && runAfterHead && !act.podcastRunning) || produced || nothingToDo;
    let endFailure: string | undefined;
    if (ended && !produced && !nothingToDo && run) {
      endFailure = result?.outcome === "model-down"
        ? `the podcast gave up waiting for the model (${this.#hhmm(result.at)})`
        : `podcast run ended without output (${run.timedOut ? "run time limit hit" : run.interrupted ? "interrupted" : `exit ${run.code ?? "?"}`}, ${this.#hhmm(run.finishedAt)})`;
    }

    if (produced) return { briefReady, produced, nothingToDo, note: null, ended, endFailure };
    if (nothingToDo) return { briefReady, produced, nothingToDo, note: null, ended, endFailure };
    if (briefReady) {
      return { briefReady, produced, nothingToDo, note: note("failed", "research is ready but the episode was not produced", false), ended, endFailure };
    }
    let n: PendingNote;
    switch (c.status) {
      case "not-started":
        n = note("not started", "the morning chain has not started today", now < this.cutoffOf(date));
        break;
      case "waiting-deps": {
        const f = r.deps?.failing ?? [];
        const md = f.find((x) => x.dep === "model");
        n = md
          ? note("waiting for the model", `down since ${this.#hhmm(c.modelDownSince ?? r.deps?.checkedAt)}`, true)
          : f.length
          ? note("waiting for a dependency", f.map((x) => x.dep).join(", "), true)
          : note("still running", "checking dependencies", true);
        break;
      }
      case "running": {
        // R9: the FURTHEST running step decides; an unreadable health is UNKNOWN.
        if (act.podcastRunning || (run && !run.finishedAt && runAfterHead)) n = note("still running", `research + episode, started ${this.#hhmm(run?.startedAt)}`, true);
        else if (act.pruneRunning) n = note("still running", "gmail prune", true);
        else if (act.pullRunning) n = note("still running", `gmail pull, started ${this.#hhmm(c.headTriggeredAt)}`, true);
        else if (act.stopHint) n = note("failed", act.stopHint, retryLeft);
        else if (act.unknown.length) n = note("status unknown", `${act.unknown.join(", ")} health unreadable; chain started ${this.#hhmm(c.headTriggeredAt)}`, true);
        else n = note("still running", `between steps, chain started ${this.#hhmm(c.headTriggeredAt)}`, true);
        break;
      }
      case "failed": {
        const f = r.deps && !r.deps.ok ? r.deps.failing : [];
        const md = f.find((x) => x.dep === "model");
        if (md && retryLeft) n = note("waiting for the model", `down since ${this.#hhmm(c.modelDownSince ?? r.deps?.checkedAt)}`, true);
        else if (f.length && retryLeft) n = note("waiting for a dependency", f.map((x) => x.dep).join(", "), true);
        else n = note("failed", `${c.reason ?? "failed"}${retryLeft ? " - it will be retried" : ""}`, retryLeft);
        break;
      }
      default:
        n = note("failed", c.reason ?? "no output", false);
    }
    return { briefReady, produced, nothingToDo, note: n, ended, endFailure };
  }

  /** Summary for GET /health. */
  async status(): Promise<Record<string, unknown>> {
    const date = this.dayOf(this.#now());
    const r = await this.#d.store.load(date);
    return {
      date,
      state: deriveState(r),
      tz: this.#d.cfg.tz,
      send_by: this.#d.cfg.sendBy,
      deadline_utc: new Date(this.deadlineOf(date)).toISOString(),
      chain: r.chain,
      digest: r.digest,
      follow_up: r.followUp,
      alert: r.alert,
      deps: r.deps ?? null,
      handoffs: r.handoffs ?? [],
      telegram_configured: this.#d.alerts.configured,
      sent_check_enabled: this.#sent.enabled,
    };
  }
}

interface Activity {
  podcastRunning: boolean;
  pullRunning: boolean;
  pruneRunning: boolean;
  anyRunning: boolean;
  unknown: string[];
  run: import("./store.ts").PodcastRun | undefined;
  pull: StepHealth | null;
  prune: StepHealth | null;
  lastActivityIso?: string;
  stopHint: string;
  podcastBeatFresh: (staleMs: number) => boolean;
}

/**
 * The four states. DONE = the digest is out and nothing is owed (no pending
 * section, or its follow-up is out). FAILED = the last attempt at something
 * failed and nothing is running. IN PROGRESS = something is running.
 */
export function deriveState(r: DayRecord): RoutineState {
  const owed = (r.digest.pending ?? []).length > 0 && r.followUp.status !== "sent";
  if (r.digest.status === "sent" && !owed) return "done";
  const active = r.chain.status === "waiting-deps" || r.chain.status === "running" ||
    r.digest.status === "sending" || r.followUp.status === "sending";
  if (active) return "in-progress";
  const failed = r.chain.status === "failed" || r.digest.status === "failed" || r.digest.status === "unknown" ||
    r.followUp.status === "failed" || r.followUp.status === "unknown";
  if (failed) return "failed";
  if (r.digest.status === "sent") return "in-progress"; // out, a follow-up owed and coming
  return r.chain.status === "done" ? "in-progress" : "not-started";
}
