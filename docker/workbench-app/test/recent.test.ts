// lib/recent.ts (rwr-lib-shell): the Recently viewed list's rules as pure functions - what opening, locking and the five
// closes do to the stored list. The strip's size is 8 UNLOCKED chips; a locked chip is never evicted and never closed in bulk.
import { describe, it, expect } from "vitest";
import { STRIP_N, LOCKED_MAX, keyOf, openIn, lockIn, closeSet, closeIn, titleMemory } from "../src/lib/recent";
import { RECENT_CAP, recentItemProblem, type RecentItem } from "../src/lib/state";

const s = (n: number): RecentItem => ({ kind: "source", id: `s-${n}` });
const ids = (l: RecentItem[]) => l.map((x) => x.id);
const many = (n: number) => Array.from({ length: n }, (_, i) => s(i + 1));

describe("the strip's size", () => {
  it("is 8 unlocked chips, and the registry's cap of 24 leaves room for 16 locked ones", () => {
    expect(STRIP_N).toBe(8);
    expect(LOCKED_MAX).toBe(RECENT_CAP - STRIP_N);
  });
});

describe("openIn: newest first, the 9th evicts the oldest unlocked chip", () => {
  it("puts a new item first", () => {
    expect(ids(openIn([s(1)], s(2)))).toEqual(["s-2", "s-1"]);
  });
  it("opening 9 items leaves the last 8", () => {
    let l: RecentItem[] = [];
    for (let i = 1; i <= 9; i++) l = openIn(l, s(i));
    expect(ids(l)).toEqual(["s-9", "s-8", "s-7", "s-6", "s-5", "s-4", "s-3", "s-2"]);
  });
  it("a locked chip is never evicted: 9 more opened and it is still there, with the last 8 unlocked", () => {
    let l: RecentItem[] = openIn([], s(1));
    l = lockIn(l, keyOf(s(1)), true).list;
    for (let i = 2; i <= 10; i++) l = openIn(l, s(i));
    expect(l.filter((x) => !x.locked)).toHaveLength(8);
    expect(l.find((x) => x.id === "s-1")?.locked).toBe(true);
    expect(ids(l.filter((x) => !x.locked))).toEqual(["s-10", "s-9", "s-8", "s-7", "s-6", "s-5", "s-4", "s-3"]);
  });
  it("evicts the OLDEST unlocked one, not the oldest chip: an old locked chip stays, the oldest unlocked goes", () => {
    const l0: RecentItem[] = [s(5), s(4), { ...s(3), locked: true }, s(2), s(1), s(6), s(7), s(8), s(9)]; // 8 unlocked + 1 locked
    const l = openIn(l0, s(10));
    expect(ids(l)).toEqual(["s-10", "s-5", "s-4", "s-3", "s-2", "s-1", "s-6", "s-7", "s-8"]);
  });
  it("an item already in the strip keeps its place and its lock (no reorder, no duplicate)", () => {
    const l0 = [s(3), { ...s(2), locked: true }, s(1)];
    expect(openIn(l0, s(2))).toEqual(l0);
    expect(openIn(l0, s(1))).toEqual(l0);
  });
  it("returns a new list and never changes the one it was given", () => {
    const l0 = Object.freeze([s(1)]) as RecentItem[];
    expect(() => openIn(l0, s(2))).not.toThrow();
    expect(l0).toHaveLength(1);
  });
  it("what it makes is always storable: at most 24 items, each one the registry accepts", () => {
    let l: RecentItem[] = [];
    for (let i = 1; i <= 40; i++) {
      l = openIn(l, s(i));
      if (i <= 16) l = lockIn(l, keyOf(s(i)), true).list;
    }
    expect(l.length).toBeLessThanOrEqual(RECENT_CAP);
    for (const x of l) expect(recentItemProblem(x)).toBeNull();
  });
});

describe("lockIn", () => {
  it("locks and unlocks a chip; an unlocked chip carries no `locked` key", () => {
    const a = lockIn([s(1), s(2)], keyOf(s(2)), true).list;
    expect(a[1]).toEqual({ kind: "source", id: "s-2", locked: true });
    const b = lockIn(a, keyOf(s(2)), false).list;
    expect(b[1]).toEqual({ kind: "source", id: "s-2" });
    expect("locked" in b[1]).toBe(false);
  });
  it("refuses a 17th locked chip, with a reason, and changes nothing", () => {
    let l = many(17);
    for (let i = 1; i <= LOCKED_MAX; i++) l = lockIn(l, keyOf(s(i)), true).list;
    const r = lockIn(l, keyOf(s(17)), true);
    expect(r.refused).toMatch(/16/);
    expect(r.list).toEqual(l);
  });
  it("an unknown chip changes nothing", () => {
    expect(lockIn([s(1)], "source:nope", true).list).toEqual([s(1)]);
  });
});

describe("the five closes: a locked chip is never closed in bulk", () => {
  const L: RecentItem[] = [s(1), { ...s(2), locked: true }, s(3), s(4), { ...s(5), locked: true }, s(6)];
  it("one closes that chip; a locked chip does not close (unlock it first)", () => {
    expect(ids(closeIn(L, "one", keyOf(s(3))))).toEqual(["s-1", "s-2", "s-4", "s-5", "s-6"]);
    expect(closeSet(L, "one", keyOf(s(2)))).toEqual([]);
    expect(closeIn(L, "one", keyOf(s(2)))).toEqual(L);
  });
  it("left closes the unlocked chips before it", () => {
    expect(ids(closeSet(L, "left", keyOf(s(4))))).toEqual(["s-1", "s-3"]);
    expect(ids(closeIn(L, "left", keyOf(s(4))))).toEqual(["s-2", "s-4", "s-5", "s-6"]);
  });
  it("right closes the unlocked chips after it", () => {
    expect(ids(closeSet(L, "right", keyOf(s(3))))).toEqual(["s-4", "s-6"]);
    expect(ids(closeIn(L, "right", keyOf(s(3))))).toEqual(["s-1", "s-2", "s-3", "s-5"]);
  });
  it("others closes every unlocked chip but this one", () => {
    expect(ids(closeIn(L, "others", keyOf(s(3))))).toEqual(["s-2", "s-3", "s-5"]);
  });
  it("all closes every unlocked chip and keeps the locked ones", () => {
    expect(ids(closeIn(L, "all"))).toEqual(["s-2", "s-5"]);
  });
  it("closing on a chip that is not there closes nothing", () => {
    expect(closeSet(L, "left", "source:nope")).toEqual([]);
    expect(closeIn(L, "others", "source:nope")).toEqual(L);
  });
});

describe("the title memory: titles live in memory only, for the person on the page", () => {
  it("remembers a title for a kind and id, and forgets it all when the person changes", () => {
    const m = titleMemory();
    m.remember("source", "s-1", "SRC-SHARED one");
    expect(m.get("source", "s-1")).toBe("SRC-SHARED one");
    expect(m.get("claim", "s-1")).toBeNull();
    m.clear();
    expect(m.get("source", "s-1")).toBeNull();
  });
  it("keeps at most 200 characters of a title and ignores an empty one", () => {
    const m = titleMemory();
    m.remember("source", "a", "x".repeat(500));
    m.remember("source", "b", "   ");
    expect(m.get("source", "a")).toHaveLength(200);
    expect(m.get("source", "b")).toBeNull();
  });
});
