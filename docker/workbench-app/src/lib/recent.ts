// The Recently viewed list's rules (rwr-lib-shell), as pure functions over the stored list: what opening an item, locking
// a chip and the five closes do to it. The list itself is the account's (state.ts: key library.recent, identifiers only,
// newest first); nothing here touches the network or the browser's storage.
//
//  - The strip shows at most STRIP_N (8) UNLOCKED chips. Opening a new item puts it first; the 9th evicts the OLDEST
//    unlocked chip. A LOCKED chip is never evicted, and never closed by a bulk close (it has to be unlocked first).
//  - The registry holds 24 items (RECENT_CAP), so at most 16 chips can be locked (LOCKED_MAX): 8 + 16 always fits.
//  - An item already in the strip keeps its place and its lock when it is opened again (the strip does not shuffle
//    under a person who is clicking through it).
//
// Titles are NOT part of the list. A title is read from a search hit when the person opens the item and lives in
// titleMemory() for as long as the same person is on the page; it is never stored, logged or put in the page title.
import { RECENT_CAP, sameItem, stateEpoch, type RecentItem } from "./state";

export const STRIP_N = 8;
export const LOCKED_MAX = RECENT_CAP - STRIP_N;

export type ChipRef = { kind: string; id: string };
// ids are compared lower-cased (a uuid typed in upper case is the same item); a document id is a path and stays as it is
export const keyOf = (x: ChipRef) => `${x.kind}:${x.kind === "document" ? x.id : x.id.toLowerCase()}`;

const plain = (x: RecentItem): RecentItem => (x.locked ? { kind: x.kind, id: x.id, locked: true } : { kind: x.kind, id: x.id });

// the oldest unlocked chip is the LAST unlocked one (the list is newest first)
function dropOldestUnlocked(l: RecentItem[]): boolean {
  for (let i = l.length - 1; i >= 0; i--) if (!l[i].locked) { l.splice(i, 1); return true; }
  return false;
}

export function openIn(list: readonly RecentItem[], item: ChipRef): RecentItem[] {
  if (list.some((x) => sameItem(x, item))) return list.map(plain);
  const out = [{ kind: item.kind, id: item.id } as RecentItem, ...list.map(plain)];
  while (out.filter((x) => !x.locked).length > STRIP_N) dropOldestUnlocked(out);
  // a stored list that already holds more than the registry allows (all locked): the new chip is the one that does not fit
  while (out.length > RECENT_CAP) if (!dropOldestUnlocked(out)) { out.shift(); break; }
  return out;
}

export function lockIn(list: readonly RecentItem[], key: string, locked: boolean): { list: RecentItem[]; refused?: string } {
  const at = list.findIndex((x) => keyOf(x) === key);
  const same = list.map(plain);
  if (at < 0) return { list: same };
  if (locked && !list[at].locked && list.filter((x) => x.locked).length >= LOCKED_MAX) {
    return { list: same, refused: `At most ${LOCKED_MAX} chips can be locked. Unlock one first.` };
  }
  const out = list.map(plain);
  out[at] = locked ? { kind: list[at].kind, id: list[at].id, locked: true } : { kind: list[at].kind, id: list[at].id };
  return { list: out };
}

export type CloseScope = "one" | "left" | "right" | "others" | "all";

// the chips a close WOULD close (locked ones never are; a locked chip has to be unlocked before it can be closed)
export function closeSet(list: readonly RecentItem[], scope: CloseScope, key?: string): RecentItem[] {
  const at = key === undefined ? -1 : list.findIndex((x) => keyOf(x) === key);
  if (scope !== "all" && at < 0) return [];
  const pick = (f: (i: number) => boolean) => list.filter((x, i) => f(i) && !x.locked).map(plain);
  switch (scope) {
    case "one": return pick((i) => i === at);
    case "left": return pick((i) => i < at);
    case "right": return pick((i) => i > at);
    case "others": return pick((i) => i !== at);
    case "all": return pick(() => true);
  }
}

// Close exactly these chips (the ones a confirmation named), if they are still unlocked: whatever else is in the list now stays.
export function closeKeys(list: readonly RecentItem[], keys: readonly string[]): RecentItem[] {
  const gone = new Set(keys);
  return list.filter((x) => x.locked === true || !gone.has(keyOf(x))).map(plain);
}

export function closeIn(list: readonly RecentItem[], scope: CloseScope, key?: string): RecentItem[] {
  const gone = new Set(closeSet(list, scope, key).map(keyOf));
  return list.filter((x) => !gone.has(keyOf(x))).map(plain);
}

// ── titles, in memory only ──
export function titleMemory(epochOf: () => number = stateEpoch) {
  let titles = new Map<string, string>();
  let epoch = epochOf();
  // a different person on the page (state.ts bumps its epoch): every title of the previous person is gone
  const fresh = () => { const e = epochOf(); if (e !== epoch) { epoch = e; titles = new Map(); } };
  return {
    remember(kind: string, id: string, title: string) {
      fresh();
      const t = String(title ?? "").trim().slice(0, 200);
      if (t) titles.set(`${kind}:${id}`, t);
    },
    get(kind: string, id: string): string | null { fresh(); return titles.get(`${kind}:${id}`) ?? null; },
    clear() { titles = new Map(); },
  };
}
export const titles = titleMemory();
