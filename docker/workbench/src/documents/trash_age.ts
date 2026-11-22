// The trash's keep window and the explicit confirm (rwr-docs-lifecycle-api; operator decision Q9,
// 2026-11-20: a trashed document is kept 30 days). Pure - the clock is always a parameter, so a test
// can put a document 29 or 31 days into the trash without waiting.
export const TRASH_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

const valid = (d: Date | null | undefined): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

// Removed only when trashed MORE than `days` days before `now`. A trash date nobody could determine
// is never removed: the failure is a document that stays, not one that goes.
export function expired(trashedAt: Date | null | undefined, now: Date, days = TRASH_KEEP_DAYS): boolean {
  if (!valid(trashedAt) || !valid(now)) return false;
  return now.getTime() - trashedAt.getTime() > days * DAY_MS;
}

// The LATER of two known dates (the listing's record of the trash move and the trash commit's committer
// date): a clock that is skewed behind can then never make a document look older than it is. One known
// date stands alone; none = null (never removed by age).
export function later(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  const x = valid(a) ? a : null;
  const y = valid(b) ? b : null;
  if (x && y) return x.getTime() >= y.getTime() ? x : y;
  return x ?? y;
}

// Delete forever and empty trash cannot be undone: the request must say so with confirm: true, the
// boolean. A string, a number or a missing field is a refusal.
export function confirmed(body: Record<string, unknown>): boolean {
  return body.confirm === true;
}
