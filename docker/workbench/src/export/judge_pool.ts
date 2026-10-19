// The credential judging of ONE export's long texts, in parallel (rw-p6a-resolve2 attempt 2). Cost, not
// meaning: each text is judged by the same function (credentials.ts judgeSecret, in judge_worker.ts) with
// the same deadline; verify.ts reads the verdicts in the order the sequential check made them, so the first
// offence it reports is the one the sequential check reported (verify.ts Budget.settle).
//
// The pool belongs to one verification: its workers start when its first long text is queued (at most
// VERIFY_WORKERS of them) and are terminated when the verification ends - served, refused or failed - so
// no worker, and none of its memory, outlives an export.
import type { Verdict } from "./credentials.ts";

// One core is left to the workbench's own thread; at most 8 workers.
export const VERIFY_WORKERS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 2) - 1));
// A worker's heap keeps what its judgings left until a full collection, which V8 puts off while it can:
// six workers sharing the 120 content streams of a 400 KB note's PDF held about 1 GB. A worker is retired
// (terminated, its memory returned) once it has judged RECYCLE_CHARS characters (about two content
// streams), and a fresh one (about 15 MB, started in tens of milliseconds) takes the next text; the peak
// memory of a verification follows the texts being judged at once, not everything judged before.
export const RECYCLE_CHARS = 100_000;

interface Job { text: string; secrets: string[]; deadline: number; resolve: (v: Verdict | null) => void; reject: (e: unknown) => void }

export class JudgePool {
  private all: Worker[] = [];
  private idle: Worker[] = [];
  private judged = new Map<Worker, number>();
  private queue: Job[] = [];
  private closed = false;
  constructor(private max = VERIFY_WORKERS) {}

  // the verdict on `text`, judged in a worker; `deadline` as judgeSecret's (performance.now() ms)
  judge(text: string, secrets: string[], deadline: number): Promise<Verdict | null> {
    const p = new Promise<Verdict | null>((resolve, reject) => {
      this.queue.push({ text, secrets, deadline, resolve, reject });
      this.pump();
    });
    p.catch(() => {}); // read in order by verify.ts; a later one failing first is not unhandled
    return p;
  }

  private pump() {
    while (this.queue.length && !this.closed) {
      let w = this.idle.pop();
      if (!w && this.all.length < this.max) {
        w = new Worker(new URL("./judge_worker.ts", import.meta.url).href, { type: "module" });
        this.all.push(w);
      }
      if (!w) return;
      this.run(w, this.queue.shift()!);
    }
  }

  private run(w: Worker, job: Job) {
    w.onmessage = (e: MessageEvent) => {
      const d = e.data as { verdict?: Verdict | null; error?: string };
      const n = (this.judged.get(w) ?? 0) + job.text.length;
      if (n >= RECYCLE_CHARS) this.retire(w);
      else {
        this.judged.set(w, n);
        this.idle.push(w);
      }
      if (d.error !== undefined) job.reject(new Error(d.error));
      else job.resolve(d.verdict ?? null);
      this.pump();
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.retire(w);
      job.reject(new Error(`the credential check stopped: ${e.message}`));
      this.pump();
    };
    w.postMessage({ text: job.text, secrets: job.secrets, at: Number.isFinite(job.deadline) ? performance.timeOrigin + job.deadline : null });
  }

  private retire(w: Worker) {
    this.all = this.all.filter((x) => x !== w);
    this.judged.delete(w);
    try {
      w.terminate();
    } catch { /* gone */ }
  }

  // every worker terminated; a job still queued or running is never answered (its reader has gone)
  close() {
    this.closed = true;
    this.queue = [];
    for (const w of this.all) {
      try {
        w.terminate();
      } catch { /* gone */ }
    }
    this.all = [];
    this.idle = [];
    this.judged.clear();
  }
}
