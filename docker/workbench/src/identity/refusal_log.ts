// N2 (rw-identity-harden; tester note N2 of review r-identity2): a refusal a client can cause at will (a
// refused token, Authentik headers while sign-in is off) is logged the FIRST time per reason; repeats in
// the next minute are counted, and once that minute is over one line says how many more there were. So
// a probe cannot flood the log, and nothing is dropped silently: every refusal is the first line or in
// a count. The count line is written by the next refusal of that reason after the window, or by
// flushExpiredRefusals(), which main.ts runs every minute (no timer here: a module timer would outlive
// a test).
const WINDOW_MS = 60_000;
const MAX_REASONS = 256;

interface Slot {
  until: number;
  more: number;
}
const slots = new Map<string, Slot>();

function report(reason: string): void {
  const s = slots.get(reason);
  if (!s) return;
  slots.delete(reason);
  if (s.more) console.warn(`[identity] ${reason}: ${s.more} more in the last ${WINDOW_MS / 1000} s (logged once a minute per reason)`);
}

// `reason` is the kind (it names the count line); `line` is what the first one logs.
export function logRefusal(reason: string, line: string): void {
  const now = Date.now();
  const s = slots.get(reason);
  if (s && now < s.until) {
    s.more++;
    return;
  }
  if (s) report(reason);
  if (slots.size >= MAX_REASONS) flushRefusalLog();
  slots.set(reason, { until: now + WINDOW_MS, more: 0 });
  console.warn(line);
}

// Writes the count of every window that has ended (main.ts, once a minute).
export function flushExpiredRefusals(now = Date.now()): void {
  for (const [reason, s] of [...slots]) if (now >= s.until) report(reason);
}

// Writes every pending count now (tests).
export function flushRefusalLog(): void {
  for (const reason of [...slots.keys()]) report(reason);
}
