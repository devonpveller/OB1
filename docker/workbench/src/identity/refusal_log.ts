// N2 (rw-identity-harden; tester note N2 of review r-identity2): a refusal a client can cause at will (a
// refused token, Authentik headers while sign-in is off) is logged the FIRST time per reason; repeats in
// the next minute are counted, and one line at the end of that minute says how many more there were. So
// a probe cannot flood the log, and nothing is dropped silently: every refusal is the first line or in
// a count.
const WINDOW_MS = 60_000;
const MAX_REASONS = 256;

interface Slot {
  until: number;
  more: number;
  timer?: ReturnType<typeof setTimeout>;
}
const slots = new Map<string, Slot>();

function report(reason: string): void {
  const s = slots.get(reason);
  if (!s) return;
  if (s.timer !== undefined) clearTimeout(s.timer);
  slots.delete(reason);
  if (s.more) console.warn(`[identity] ${reason}: ${s.more} more in the last ${WINDOW_MS / 1000} s (logged once a minute per reason)`);
}

// `reason` is the kind (it names the count line); `line` is what the first one logs.
export function logRefusal(reason: string, line: string): void {
  const now = Date.now();
  const s = slots.get(reason);
  if (s && now < s.until) {
    s.more++;
    if (s.timer === undefined) {
      // unref: a pending count never keeps the process (or a test) alive
      s.timer = setTimeout(() => report(reason), s.until - now);
      Deno.unrefTimer(s.timer as unknown as number);
    }
    return;
  }
  if (s) report(reason);
  if (slots.size >= MAX_REASONS) flushRefusalLog();
  slots.set(reason, { until: now + WINDOW_MS, more: 0 });
  console.warn(line);
}

// Writes every pending count now (tests; the end of a window does it by itself).
export function flushRefusalLog(): void {
  for (const reason of [...slots.keys()]) report(reason);
}
