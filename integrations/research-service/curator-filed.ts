/**
 * curator-filed.ts - rw-curator-filed. A research run whose curator call times out or fails mid-way is
 * never silently lost: the research service LEARNS whether the curator filed it (the typed 'filed'
 * event the curator's persist writes in the filing transaction, research_job_events) and, if it did
 * not, hands the package over again - bounded, with backoff.
 *
 * Why a retry is safe: /research/persist upserts the synthesis on research_key (unique partial index),
 * so a late first attempt and a retry converge on ONE synthesis; the 'filed' event is one row per job.
 * Why a timeout is still not retried blindly: the curator may be mid-filing, so after an ambiguous
 * failure we first WAIT for the event (settle window) and only then resend.
 *
 * Pure: every seam (the hand-off, the event lookup, sleep, clock) is injected.
 */
import { curatorBackoffMs } from "./lib.ts";

export interface FiledRecord {
  synthesis_id: string;
  research_key: string;
  sources_written?: number;
  thread_id?: string | null;
  session_id?: string | null;
}

export interface CuratorFilingOptions {
  /** TOTAL hand-off attempts (CURATOR_FILE_ATTEMPTS). 1 = the pre-rw-curator-filed behaviour. */
  attempts: number;
  /** After an ambiguous failure, how long to wait for the 'filed' event before resending (CURATOR_SETTLE_MS). */
  settleMs: number;
  /** Poll interval inside the settle window. */
  pollMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export const CURATOR_FILE_ATTEMPTS_DEFAULT = 3;
export const CURATOR_SETTLE_MS_DEFAULT = 30_000;

export function curatorFileAttemptsFromEnv(raw: string | undefined | null, dflt = CURATOR_FILE_ATTEMPTS_DEFAULT): number {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(n, 10)) : dflt;
}
export function curatorSettleMsFromEnv(raw: string | undefined | null, dflt = CURATOR_SETTLE_MS_DEFAULT): number {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** A curator answer that is a final REFUSAL of this package (400/401/403/404/422...): resending cannot change it. */
export function isDefinitiveRefusal(e: unknown): boolean {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" && s >= 400 && s < 500 && s !== 408 && s !== 425 && s !== 429;
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** The reply shape the harness reads when the curator's own answer was lost but the event says it filed. */
export function recoveredReply(f: FiledRecord, attempt: number, why: string): Record<string, unknown> {
  return {
    thread_id: f.thread_id ?? null,
    persist: { synthesis_id: f.synthesis_id, sources_written: f.sources_written ?? null, session_id: f.session_id ?? null },
    // The curator's reply (claims pass included) did not reach us: the filing is proven by the event,
    // the per-claim result is not. restateFiledCredibility reads this as filed with basis "package".
    recovered: { via: "filed_event", attempt, why },
  };
}

export async function deliverToCurator(
  handOff: (pkg: Record<string, unknown>) => Promise<Record<string, unknown>>,
  findFiled: ((jobId: string) => Promise<FiledRecord | null>) | null | undefined,
  jobId: string | null,
  pkg: Record<string, unknown>,
  opts: CuratorFilingOptions,
): Promise<Record<string, unknown>> {
  const attempts = Math.max(1, Math.floor(opts.attempts) || 1);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const poll = Math.max(1, opts.pollMs ?? 2_000);
  const lookup = async (): Promise<FiledRecord | null> => {
    if (!findFiled || !jobId) return null;
    try { return await findFiled(jobId); } catch (e) { log(`curator: filed-event lookup failed: ${describe(e)}`); return null; }
  };
  const causes: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await handOff(pkg);
    } catch (e) {
      const cause = describe(e);
      causes.push(`attempt ${attempt}: ${cause}`);
      // The curator may have committed before the failure surfaced (timeout, dropped connection, a 5xx
      // after the persist): the event is the proof. Wait for it - a slow curator is still working.
      const deadline = now() + Math.max(0, opts.settleMs);
      let rec = await lookup();
      while (!rec && findFiled && jobId && now() < deadline) {
        await sleep(Math.min(poll, Math.max(1, deadline - now())));
        rec = await lookup();
      }
      if (rec) {
        log(`curator: attempt ${attempt}/${attempts} failed (${cause}) but the run is FILED (event: synthesis ${rec.synthesis_id})`);
        return recoveredReply(rec, attempt, cause);
      }
      if (isDefinitiveRefusal(e)) {
        return { error: `${cause} (a final refusal: not retried; no filed event for the job)` };
      }
      if (attempt >= attempts) {
        return {
          error: `curator hand-off failed after ${attempts} attempt(s) and no filed event exists for the job (not filed): ${causes.join("; ")}`,
        };
      }
      const wait = curatorBackoffMs(attempt, opts.backoffBaseMs, opts.backoffCapMs);
      log(`curator: attempt ${attempt}/${attempts} failed (${cause}); no filed event; resending in ${wait} ms (idempotent on research_key)`);
      await sleep(wait);
    }
  }
  return { error: `curator hand-off failed (not filed): ${causes.join("; ")}` };
}
