/**
 * Clock + time-zone helpers for the morning routine (mr-routine-outage).
 *
 * The containers run in UTC; the operator's send-by time is LOCAL
 * (America/New_York by default). Every routine decision converts through
 * these helpers, so a DST change moves the UTC instant, never the local time.
 *
 * `Clock` is injected so the 01:00-08:00 scenarios run on a virtual clock in
 * tests (src/routine/virtual-clock.ts); production uses `realClock`.
 */

export interface Clock {
  now(): number;
  /** Resolves after `ms` (clamped >= 0). Rejects with the signal's reason if aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

// setTimeout overflows above 2^31-1 ms (~24.8 days) and fires at once.
const MAX_TIMER_MS = 2_147_000_000;

export const realClock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.min(MAX_TIMER_MS, Math.max(0, ms)));
      const onAbort = () => {
        clearTimeout(t);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string): Record<string, number> {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `tz` from UTC at instant `ms`, in ms (EDT = -4h). */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (ms % 1000));
}

/** The local calendar date (YYYY-MM-DD) of instant `ms` in `tz`. */
export function localDate(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "HH:MM" local time of `ms` in `tz`. */
export function localHHMM(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "HH:MM local (HH:MMZ)" - both clocks, for logs and alerts. */
export function bothClocks(ms: number, tz: string): string {
  const d = new Date(ms);
  const z = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
  return `${localHHMM(ms, tz)} ${tz} (${z})`;
}

/** Parse "HH:MM" (24 h). Throws on garbage so a bad env value fails at boot. */
export function parseHHMM(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`bad HH:MM time: ${JSON.stringify(s)}`);
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`bad HH:MM time: ${JSON.stringify(s)}`);
  return { h, m: mi };
}

/**
 * The UTC instant of local wall time `hhmm` on local date `date` in `tz`.
 * A wall time inside the spring-forward gap (02:00-03:00 on the March change)
 * does not exist; it resolves to the instant AFTER the gap (02:30 -> 07:30Z =
 * 03:30 EDT), never before it. A repeated wall time on the fall-back day takes
 * the first candidate that reads back as that wall time.
 */
export function zonedEpoch(date: string, hhmm: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const { h, m } = parseHHMM(hhmm);
  const wall = Date.UTC(y, mo - 1, d, h, m, 0);
  const a = wall - tzOffsetMs(wall, tz);
  const b = wall - tzOffsetMs(a, tz);
  const want = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  for (const c of [b, a]) if (localHHMM(c, tz) === want && localDate(c, tz) === date) return c;
  return Math.max(a, b); // inside the spring-forward gap: the instant after it
}

/** The calendar date after `date` (YYYY-MM-DD), DST-free (pure date math). */
export function nextDate(date: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + 1));
  return t.toISOString().slice(0, 10);
}
