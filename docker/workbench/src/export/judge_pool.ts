// The credential judging of the export's texts, off the export's thread (rw-p6a-resolve2 attempt 2;
// rw-p6a-followups). Cost, not meaning: each text is judged by the same function (credentials.ts
// judgeSecret, in judge_worker.ts) with the same deadline; verify.ts reads the verdicts in the order the
// sequential check made them, so the first offence it reports is the one the sequential check reported
// (verify.ts Budget.settle).
//
// rw-p6a-followups (the reviewer's R3-2): ONE pool for the process, and ONE verification at a time.
// Before, every render built its own Budget and pool (render.ts), so N concurrent large exports ran up to
// 8N workers, used about N x 1.2 GB and slowed each other into `verification-budget`. Now:
//   - VERIFY_SLOTS (1) verifications hold the pool at once (verificationSlot); an export beyond it WAITS
//     for the slot, and its budget does not run while it waits (verify.ts takes the slot before it starts
//     the clock), so a note is never refused `verification-budget` because it queued; a wait longer than
//     VERIFY_WAIT_MS is answered 503 `verification-busy` (stated, never a 200 that skipped verification);
//   - the pool runs at most VERIFY_WORKERS workers in the whole process (sharedPool), so peak memory
//     follows the bound, not the number of exports. Measured (tester, rw-p6a-resolve2 attempt 2,
//     fresh process, VmHWM): one 400 KB note's verification adds +1.17 GB for its DOCX and +1.02 GB for
//     its PDF; N concurrent exports of it peak at about the same (findings rw-p6a-followups, N=1,2,4).
// A worker ends when the pool has nothing queued or running, when its verification ends (a job of a
// closed session is dropped; a worker still judging one is terminated) or when it is retired; no worker,
// and none of its memory, outlives the exports using it.
import type { Verdict } from "./credentials.ts";

// One core is left to the workbench's own thread; at most 8 workers - in the whole process.
export const VERIFY_WORKERS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 2) - 1));
// How many verifications run at once (each uses the whole pool), and how long one may wait for its turn.
export const VERIFY_SLOTS = 1;
export const VERIFY_WAIT_MS = 300_000;
// A worker's heap keeps what its judgings left until a full collection, which V8 puts off while it can:
// six workers sharing the 120 content streams of a 400 KB note's PDF held about 1 GB. A worker is retired
// (terminated, its memory returned) once it has judged RECYCLE_CHARS characters (about two content
// streams), and a fresh one (about 15 MB, started in tens of milliseconds) takes the next text; the peak
// memory of a verification follows the texts being judged at once, not everything judged before.
export const RECYCLE_CHARS = 100_000;

// ── the slot: one verification at a time ───────────────────────────────────────────────────────
export class VerifyBusy extends Error {
  constructor(public waitedMs: number, public ahead: number) {
    super(`${ahead} other export(s) were being checked; it waited ${Math.round(waitedMs / 1000)} s for its turn (one at a time, at most ${VERIFY_WAIT_MS / 1000} s)`);
  }
}
export class Slots {
  private held = 0;
  private waiting: { go: () => void }[] = [];
  constructor(private max = VERIFY_SLOTS, public waitMs = VERIFY_WAIT_MS) {}
  get busy() {
    return this.held;
  }
  get queued() {
    return this.waiting.length;
  }
  // resolves with the release once the caller holds a slot; VerifyBusy after waitMs
  acquire(): Promise<() => void> {
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next) next.go();
      else this.held--;
    };
    if (this.held < this.max) {
      this.held++;
      return Promise.resolve(release);
    }
    const ahead = this.held + this.waiting.length;
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const w = {
        go: () => {
          clearTimeout(timer);
          resolve(release); // the slot passes to this waiter (held unchanged)
        },
      };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((x) => x !== w);
        reject(new VerifyBusy(performance.now() - t0, ahead));
      }, this.waitMs);
      this.waiting.push(w);
    });
  }
}
export const verificationSlot = new Slots();

// ── the pool: at most VERIFY_WORKERS workers in the process ────────────────────────────────────
interface Job { session: number; op?: "offence"; text: string; secrets: string[]; deadline: number; resolve: (v: Verdict | null) => void; reject: (e: unknown) => void }

export class JudgePool {
  private all: Worker[] = [];
  private idle: Worker[] = [];
  private judged = new Map<Worker, number>();
  private running = new Map<Worker, Job>();
  private queue: Job[] = [];
  private sessions = 0;
  // the most workers alive at once since resetPeak (tests and the findings' measurement read it)
  peak = 0;
  constructor(private max = VERIFY_WORKERS) {}

  get live() {
    return this.all.length;
  }
  resetPeak() {
    this.peak = this.all.length;
  }

  // a verification's handle: its jobs, and close() when it ends
  open(): Session {
    const id = ++this.sessions;
    return {
      judge: (text, secrets, deadline) => this.judge(id, text, secrets, deadline),
      // the MD output's re-parse (markdown.ts markdownOffence): the offence, or null
      offence: (md) => this.judge(id, md, [], Infinity, "offence") as unknown as Promise<string | null>,
      close: () => this.closeSession(id),
    };
  }

  // the verdict on `text`, judged in a worker; `deadline` as judgeSecret's (performance.now() ms)
  private judge(session: number, text: string, secrets: string[], deadline: number, op?: "offence"): Promise<Verdict | null> {
    const p = new Promise<Verdict | null>((resolve, reject) => {
      this.queue.push({ session, op, text, secrets, deadline, resolve, reject });
      this.pump();
    });
    p.catch(() => {}); // read in order by verify.ts; a later one failing first is not unhandled
    return p;
  }

  private pump() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w && this.all.length < this.max) {
        w = new Worker(new URL("./judge_worker.ts", import.meta.url).href, { type: "module" });
        this.all.push(w);
        this.peak = Math.max(this.peak, this.all.length);
      }
      if (!w) return;
      this.run(w, this.queue.shift()!);
    }
    if (!this.running.size) this.drain(); // nothing queued or running: no worker is kept
  }

  private run(w: Worker, job: Job) {
    this.running.set(w, job);
    w.onmessage = (e: MessageEvent) => {
      this.running.delete(w);
      const d = e.data as { verdict?: Verdict | null; offence?: string | null; error?: string };
      const n = (this.judged.get(w) ?? 0) + job.text.length;
      if (n >= RECYCLE_CHARS) this.retire(w);
      else {
        this.judged.set(w, n);
        this.idle.push(w);
      }
      if (d.error !== undefined) job.reject(new Error(d.error));
      else job.resolve((job.op === "offence" ? d.offence : d.verdict) as Verdict | null ?? null);
      this.pump();
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.running.delete(w);
      this.retire(w);
      job.reject(new Error(`the credential check stopped: ${e.message}`));
      this.pump();
    };
    w.postMessage({ op: job.op, text: job.text, secrets: job.secrets, at: Number.isFinite(job.deadline) ? performance.timeOrigin + job.deadline : null });
  }

  private retire(w: Worker) {
    this.all = this.all.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
    this.judged.delete(w);
    try {
      w.terminate();
    } catch { /* gone */ }
  }
  private drain() {
    for (const w of [...this.idle]) this.retire(w);
  }

  // a verification ended: its queued jobs are dropped and a worker still judging one is terminated (its
  // reader has gone); a job of a closed session is never answered
  private closeSession(id: number) {
    this.queue = this.queue.filter((j) => j.session !== id);
    for (const [w, j] of [...this.running]) {
      if (j.session !== id) continue;
      this.running.delete(w);
      this.retire(w);
    }
    this.pump();
  }
}
export interface Session {
  judge(text: string, secrets: string[], deadline: number): Promise<Verdict | null>;
  offence(md: string): Promise<string | null>;
  close(): void;
}
export const sharedPool = new JudgePool();
