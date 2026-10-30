// The reason an admin gives before impersonating a user (rw-identity; round 4, tester F3; round 5,
// tester attempt 2 F3b): it must say something - at least REASON_MIN LETTERS OR DIGITS, counted by
// Unicode category (L*, N*). Nothing else counts: format and control characters (Cf, Cc, tag
// characters), marks (Mn, Me, Mc - variation selectors, combining marks), private use and unassigned
// code points (Co, Cn), symbols (U+2800 braille blank, U+FFFC), punctuation, separators (NBSP, em
// space), and the Hangul fillers, which Unicode files as letters (U+115F, U+1160, U+3164, U+FFA0). The workspace applies the same
// rule before it sends (wiki-viewer/workspace/src/lib/auth.ts); init-identity.sql keeps a coarser CHECK.
export const REASON_MIN = 8;
export const REASON_MAX = 1000;

const COUNTED = /[\p{L}\p{N}]/u;
const FILLERS = new Set(["\u115f", "\u1160", "\u3164", "\uffa0"]);

// how many letters and digits `s` holds (the count the rule reads)
export function visibleLength(s: string): number {
  let n = 0;
  for (const ch of s.normalize("NFC")) if (COUNTED.test(ch) && !FILLERS.has(ch)) n++;
  return n;
}

// null = acceptable; else why not
export function reasonProblem(raw: string): string | null {
  const s = raw.trim();
  if (s.length > REASON_MAX) return `the reason is longer than ${REASON_MAX} characters`;
  if (visibleLength(s) < REASON_MIN) return `a reason is required (at least ${REASON_MIN} letters or digits)`;
  return null;
}
