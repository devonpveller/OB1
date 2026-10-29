// The reason an admin gives before impersonating a user (rw-identity; round 4, tester F3): it must say
// something - at least REASON_MIN VISIBLE characters, one of them a letter or digit. Zero-width
// characters, joiners, soft hyphens, BOMs and white space do not count. The workspace applies the same
// rule before it sends (wiki-viewer/workspace/src/lib/auth.ts); init-identity.sql keeps a coarser CHECK.
export const REASON_MIN = 8;
export const REASON_MAX = 1000;

// default-ignorable and invisible code points, plus white space
const INVISIBLE = /[\s­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;

export function visibleLength(s: string): number {
  return [...s.replace(INVISIBLE, "")].length;
}

// null = acceptable; else why not
export function reasonProblem(raw: string): string | null {
  const s = raw.trim();
  if (s.length > REASON_MAX) return `the reason is longer than ${REASON_MAX} characters`;
  const visible = s.replace(INVISIBLE, "");
  if ([...visible].length < REASON_MIN || !/[\p{L}\p{N}]/u.test(visible)) {
    return `a reason is required (at least ${REASON_MIN} visible characters, with a letter or digit)`;
  }
  return null;
}
