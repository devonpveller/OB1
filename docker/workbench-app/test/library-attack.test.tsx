// The tester's attack tests of attempt 1 (wt-t-lib-shell), adopted into the suite, plus the repros of D1-D4 and the cases that kill the
// mutants that survived (M8-M14). Same back end as test/library.test.tsx: the shared fake (e2e/library-fake.mjs) over e2e/docs-fake.mjs.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { App } from "../src/App";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { navigate } from "../src/lib/router";
import { resetState, getRecent, updateRecentSaved, setRecentSaved } from "../src/lib/state";
import { setFetcher as setDoor } from "../src/lib/api";
import { titles } from "../src/lib/recent";
import { createFake, PEOPLE } from "../e2e/docs-fake.mjs";
import { createLibraryFake, SRC, SRC_HIDDEN, SRC_HELD_A, CLAIM_PRIVATE_A, PRIVATE_MARKER } from "../e2e/library-fake.mjs";

type Person = "alice" | "bob";
const CPU = "documents/k-a/Hardware/cpu.md";
const docs = createFake();
const lib = createLibraryFake({ docs });
let who: Person;
let seen: { method: string; url: string; body: any; who: Person }[];
let failStates = false;
let gate: Promise<void> | null = null;

function wire() {
  setFetcher(async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, url, body, who });
    const j = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const p = url.split("?")[0];
    const me = PEOPLE[who];
    if (p === "/workbench/workspace/whoami") return j(200, { subject_sub: me.sub, actor_sub: me.sub, name: me.name });
    if (p === "/workbench/auth/me") return j(200, { mode: "forward-auth", signed_in: true, kind: "user", subject_sub: me.sub, name: me.name });
    if (p === "/workbench/contract/sessions") return j(200, { sessions: [] });
    if (p === "/workbench/intake/jobs") return j(200, { jobs: [] });
    if (p === "/workbench/contract/cleanup/sources") return j(200, { sources: [], total: 0 });
    if (p === "/workbench/contract/cleanup/reopen-candidates") return j(200, { candidates: [] });
    if (failStates && p === "/workbench/contract/source-states") return j(500, { error: "down" });
    if (gate && method === "PUT" && p.includes("library.recent")) await gate;
    const r = lib.handle(who, method, url, body) ?? docs.handle(who, method, url, body);
    if (!r) return j(404, { error: `no fake for ${method} ${url}` });
    return j(r.status, r.body);
  });
}
async function boot(path = "/library", plant?: () => void) {
  cleanup(); clearRequestLog(); resetState(); titles.clear();
  lib.reset(); docs.reset(); who = "alice"; seen = []; failStates = false; gate = null;
  plant?.();
  window.history.pushState({}, "", path);
  wire();
  render(<App />);
  if (path.startsWith("/library")) await waitFor(() => expect(screen.getByTestId("strip").getAttribute("data-ready")).toBe("true"));
}
const chips = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chip"]'));
const keys = () => chips().map((c) => c.getAttribute("data-key"));
const chip = (key: string) => chips().find((c) => c.getAttribute("data-key") === key)!;
const stored = (p: Person = "alice") => (lib.account(p)["library.recent"]?.value ?? []) as { kind: string; id: string; locked?: boolean }[];
const menu = (key: string) => { fireEvent.click(within(chip(key)).getByTestId("chip-menu")); return screen.getByTestId("chip-actions"); };
const open = async (kind: "source" | "claim", id: string) => {
  act(() => navigate(`/library?${kind}=${id}`));
  await waitFor(() => expect(keys()).toContain(`${kind}:${id}`));
};
const k = (n: number) => `source:${SRC(n)}`;

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { cleanup(); });

describe("T1 two browsers: queued writes after a stale refusal", () => {
  it("D1: a second close queued behind a stale-refused one must not write over the other browser's locked chip", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [1, 2, 3].map((n) => ({ kind: "source", id: SRC(n) }))));
    await waitFor(() => expect(keys()).toEqual([k(1), k(2), k(3)]));
    // the other browser locks a NEW chip S9 (its write lands first)
    lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(9), locked: true }, ...[1, 2, 3].map((n) => ({ kind: "source", id: SRC(n) }))]);
    // hold this page's PUTs so two closes queue
    let release!: () => void; gate = new Promise<void>((r) => { release = r; });
    fireEvent.click(within(menu(k(3))).getByTestId("act-close"));
    fireEvent.click(within(menu(k(2))).getByTestId("act-close"));
    release(); gate = null;
    await waitFor(() => expect(seen.filter((r) => r.method === "PUT" && r.url.includes("library.recent")).length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 300));
    const s = stored();
    console.log("T1 PUTS", JSON.stringify(seen.filter((r) => r.method === "PUT").map((r) => r.body)), "FINAL", JSON.stringify(s), "NOTE", document.querySelector('[data-testid="strip-note"]')?.textContent, "SHOWN", JSON.stringify(keys()));
    // the locked chip the other browser added must survive
    expect(s.some((x) => x.id === SRC(9) && x.locked)).toBe(true);
    // both closes were applied on top of the other browser's list; the page shows what the server holds, and says so
    expect(s).toEqual([{ kind: "source", id: SRC(9), locked: true }, { kind: "source", id: SRC(1) }]);
    expect(keys()).toEqual([`source:${SRC(9)}`, k(1)]);
    expect(document.querySelector('[data-testid="strip-note"]')?.textContent).toMatch(/another browser/);
  });
  it("D1: a lock made in the other browser survives this page's open of a new item", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]));
    lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(9), locked: true }, { kind: "source", id: SRC(1) }]);
    await open("source", SRC(2));
    await waitFor(() => expect(stored().length).toBe(3));
    expect(stored().find((x) => x.id === SRC(9))?.locked).toBe(true);
  });
  it("a change that leaves the list as it is sends nothing", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]));
    const before = seen.filter((r) => r.method === "PUT").length;
    act(() => navigate(`/library?source=${SRC(1)}`));
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.filter((r) => r.method === "PUT").length).toBe(before);
  });
});

describe("T2 failed state check after a hidden state was known", () => {
  it("a hidden source whose title this page remembers never shows the title when the re-check fails", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC_HIDDEN }, { kind: "source", id: SRC(1) }]));
    act(() => titles.remember("source", SRC_HIDDEN, "SRC-SHARED Hidden source"));
    await waitFor(() => expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed"));
    expect(chip(`source:${SRC_HIDDEN}`).textContent).not.toMatch(/SRC-SHARED/);
    failStates = true;
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(seen.filter((r) => r.url.includes("source-states")).length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 200));
    // D2: the last answer stands: still hidden, never the remembered title
    expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed");
    expect(chip(`source:${SRC_HIDDEN}`).textContent).not.toMatch(/SRC-SHARED/);
  });
  it("D2: a source never answered whose check fails is visibly 'state unknown' and shows no title", async () => {
    cleanup(); clearRequestLog(); resetState(); titles.clear(); lib.reset(); docs.reset(); who = "alice"; seen = []; gate = null;
    lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]);
    window.history.pushState({}, "", "/library");
    wire(); failStates = true;
    titles.remember("source", SRC(1), "SRC-SHARED Source 1");
    render(<App />);
    await waitFor(() => expect(chip(k(1))?.getAttribute("data-state")).toBe("unknown"));
    expect(chip(k(1)).textContent).toMatch(/state unknown/);
    expect(chip(k(1)).textContent).not.toMatch(/SRC-SHARED/);
  });
});

describe("T3 confirmation vs. a list that changes under it", () => {
  it("the close executed is the one confirmed: a new open while the confirmation is up does not widen it", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [1, 2, 3].map((n) => ({ kind: "source", id: SRC(n) }))));
    await waitFor(() => expect(keys()).toEqual([k(1), k(2), k(3)]));
    fireEvent.click(within(menu(k(2))).getByTestId("act-close-left"));
    expect(screen.getByTestId("confirm-close").textContent).toMatch(/Close 1 chip\?/);
    await open("source", SRC(7)); // the chip links / address bar are still live
    fireEvent.click(screen.getByTestId("confirm-yes"));
    await waitFor(() => expect(screen.queryByTestId("confirm-close")).toBeNull());
    await new Promise((r) => setTimeout(r, 200));
    // D3: confirmed "Close 1 chip": only S1 may go
    expect(stored().map((x) => x.id)).toEqual([SRC(7), SRC(2), SRC(3)]);
    expect(window.location.search).toBe(`?source=${SRC(7)}`);
  });
});

describe("T4 crafted library.recent values", () => {
  it("duplicates, foreign keys, 30 items, a title field: nothing crafted is shown as a title; at most 24 shown; no duplicate chips", async () => {
    const v: any[] = [{ kind: "source", id: SRC(1), title: "INJECTED-TITLE" }, { kind: "source", id: SRC(2) }, { kind: "source", id: SRC(2) }];
    for (let i = 0; i < 30; i++) v.push({ kind: "topic", id: "t" + i });
    await boot("/library", () => lib.plantAccount("alice", "library.recent", v));
    await waitFor(() => expect(chips().length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain("INJECTED-TITLE");
    expect(chips().length).toBeLessThanOrEqual(24);
    expect(new Set(keys()).size).toBe(keys().length);
  });
  it("24 locked chips planted by another client: opening a new source says it was not kept (not silent)", async () => {
    const v = Array.from({ length: 24 }, (_, i) => ({ kind: "topic", id: "t" + i, locked: true }));
    await boot("/library", () => lib.plantAccount("alice", "library.recent", v));
    await waitFor(() => expect(chips().length).toBe(24));
    act(() => navigate(`/library?source=${SRC(1)}`));
    await new Promise((r) => setTimeout(r, 400));
    const inList = stored().some((x) => x.id === SRC(1));
    const said = /not kept|locked|full|unlock/i.test(document.querySelector('[data-testid="strip"]')!.textContent ?? "");
    expect(inList || said).toBe(true);
  });
  it("a value that is not a list (another client) shows an empty strip and a later open writes a well-formed list", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", { a: 1 } as any));
    await open("source", SRC(1));
    expect(stored()).toEqual([{ kind: "source", id: SRC(1) }]);
  });
});

describe("T5 lock limit and boundaries", () => {
  it("16 locked then a 17th is refused with the reason; close left on the first and right on the last are off", async () => {
    const v = Array.from({ length: 16 }, (_, i) => ({ kind: "topic", id: "t" + i, locked: true }));
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }, ...v, { kind: "source", id: SRC(2) }]));
    await waitFor(() => expect(chips().length).toBe(18));
    fireEvent.click(within(menu(k(1))).getByTestId("act-lock"));
    expect(screen.getByTestId("strip-lock-note").textContent).toMatch(/At most 16/);
    expect(stored().find((x) => x.id === SRC(1))?.locked).toBeUndefined();
    const m1 = menu(k(1)); // still open from the click above? reopen
    void m1;
    const first = chips()[0].getAttribute("data-key")!;
    fireEvent.click(within(chip(first)).getByTestId("chip-menu"));
    if (!screen.queryByTestId("chip-actions")) fireEvent.click(within(chip(first)).getByTestId("chip-menu"));
    expect((within(screen.getByTestId("chip-actions")).getByTestId("act-close-left") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("T6 claim guard", () => {
  it("bob: ?claim=<alice private> with a remembered strip entry of it in HIS account shows no words, offers nothing", async () => {
    await boot(`/library?claim=${CLAIM_PRIVATE_A}`, () => { who = "bob"; lib.plantAccount("bob", "library.recent", [{ kind: "claim", id: CLAIM_PRIVATE_A }]); });
    await waitFor(() => expect(screen.getByTestId("item")).toBeTruthy());
    lib.plantAccount("bob", "ui.locked_document", "documents/k-b/x.md");
    expect(document.body.textContent).not.toContain(PRIVATE_MARKER);
    expect((screen.getByTestId("item-add") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("add-all") as HTMLButtonElement).disabled).toBe(true);
    expect(seen.filter((r) => r.url.includes("pending-refs"))).toEqual([]);
  });
  it("Home: a claim hit does not open as a tab nor put its words in memory", async () => {
    await boot("/");
    fireEvent.change(await screen.findByTestId("ask-input"), { target: { value: "CLAIM-PRIVATE" } });
    fireEvent.click(screen.getByTestId("ask-go"));
    const hit = await screen.findByTestId("hit");
    expect(hit.textContent).toMatch(/CLAIM-PRIVATE/); // the shared search returns it today: a server gap (findings)
    fireEvent.click(hit);
    await waitFor(() => expect(window.location.pathname).toBe("/library"));
    expect(window.location.search).toBe("");
    expect(titles.get("claim", CLAIM_PRIVATE_A)).toBeNull();
    await waitFor(() => expect(screen.getByTestId("strip")).toBeTruthy());
    expect(document.body.textContent).not.toContain(PRIVATE_MARKER);
  });
  it("a held source id typed by hand is not recorded and says no longer available", async () => {
    await boot(`/library?source=${SRC_HELD_A}`);
    await waitFor(() => expect(screen.getByTestId("item-title").textContent).toMatch(/no longer available/));
    await new Promise((r) => setTimeout(r, 200));
    expect(stored()).toEqual([]);
    expect(seen.filter((r) => r.method === "PUT")).toEqual([]);
  });
  it("closing the tab of an unrecorded item writes nothing", async () => {
    await boot(`/library?source=${SRC_HELD_A}`);
    await waitFor(() => expect(screen.getByTestId("item-title").textContent).toMatch(/no longer available/));
    fireEvent.click(screen.getByTestId("item-close"));
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.filter((r) => r.method === "PUT")).toEqual([]);
  });
  it("an upper-cased copy of an id already in the strip is not a second chip", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]));
    act(() => navigate(`/library?source=${SRC(1).toUpperCase()}`));
    await new Promise((r) => setTimeout(r, 400));
    expect(stored().length).toBe(1);
  });
});

describe("T7 person switch mid add-all", () => {
  it("alice's add-all stops when bob arrives; nothing is posted under bob", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await boot("/library", () => { lib.plantAccount("alice", "ui.locked_document", CPU); lib.plantAccount("alice", "library.recent", [1, 2, 3, 4, 5, 6].map((n) => ({ kind: "source", id: SRC(n) }))); });
      await waitFor(() => expect((screen.getByTestId("add-all") as HTMLButtonElement).disabled).toBe(false));
      await waitFor(() => expect(screen.getByTestId("add-all").textContent).toMatch(/ALPHA/));
      fireEvent.click(screen.getByTestId("add-all"));
      who = "bob";
      await act(async () => { await vi.advanceTimersByTimeAsync(30500); });
      await waitFor(() => expect(screen.getByTestId("avatar").textContent).toBe("BB"));
      console.log("T7", JSON.stringify(seen.filter((r) => r.url.includes("pending-refs")).map((r) => [r.who, r.body?.source_id?.slice(-2)])), JSON.stringify(lib.pendingRows().map((r) => [r.owner, r.path])));
      // the page learns of the switch only at the 30 s refresh, so a cite still in flight may go out as the new person: it must add nothing for him
      expect(lib.pendingRows().filter((r) => r.owner === PEOPLE.bob.sub)).toEqual([]);
      expect(document.body.textContent).not.toMatch(/ALPHA|SRC-SHARED/);
      expect(getRecent()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe("M12 add all stops at a person change", () => {
  it("once another person is on the page no further cite goes out", async () => {
    await boot("/library", () => { lib.plantAccount("alice", "ui.locked_document", CPU); lib.plantAccount("alice", "library.recent", [1, 2, 3].map((n) => ({ kind: "source", id: SRC(n) }))); });
    await waitFor(() => expect((screen.getByTestId("add-all") as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(screen.getByTestId("add-all").textContent).toMatch(/ALPHA/));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let posts = 0;
    setDoor(async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("pending-refs")) { posts++; await held; return new Response(JSON.stringify({ error: "x" }), { status: 404 }); }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const r = lib.handle(who, method, url, body) ?? docs.handle(who, method, url, body);
      return new Response(JSON.stringify(r?.body ?? {}), { status: r?.status ?? 404 });
    });
    fireEvent.click(screen.getByTestId("add-all"));
    await waitFor(() => expect(posts).toBe(1));
    act(() => resetState()); // another person arrives (the shell does exactly this)
    release();
    await new Promise((r) => setTimeout(r, 300));
    expect(posts).toBe(1); // the one already in flight; the other two never went out
  });
});

describe("M9 titles do not outlive the person who read them", () => {
  it("after a person change the page remembers no title", async () => {
    await boot("/library");
    titles.remember("source", SRC(1), "SRC-SHARED Source 1");
    expect(titles.get("source", SRC(1))).toBe("SRC-SHARED Source 1");
    act(() => resetState());
    expect(titles.get("source", SRC(1))).toBeNull();
  });
});

describe("M8 an id that is not in the shared library is never recorded", () => {
  it("an unknown id (absent from source-states, like a held one) leaves the strip and the account untouched", async () => {
    await boot("/library?source=b3000000-0000-4000-8000-0000000000ee");
    await waitFor(() => expect(screen.getByTestId("item-title").textContent).toMatch(/no longer available/));
    await new Promise((r) => setTimeout(r, 200));
    expect(keys()).toEqual([]);
    expect(seen.filter((r) => r.method === "PUT")).toEqual([]);
  });
});

describe("M11 the document picker offers documents only", () => {
  it("a search word that matches shared sources lists none of them", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]));
    await waitFor(() => expect((screen.getByTestId("add-all") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("add-all"));
    await screen.findByTestId("picker");
    fireEvent.change(screen.getByTestId("picker-q"), { target: { value: "SRC-SHARED" } });
    await waitFor(() => expect(screen.getByTestId("picker-empty")).toBeTruthy());
    expect(within(screen.getByTestId("picker-list")).queryAllByRole("option")).toEqual([]);
  });
});

describe("D4 the picker is not a complementary landmark inside main", () => {
  it("the tray is a labelled group, not an aside", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]));
    await waitFor(() => expect((screen.getByTestId("add-all") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("add-all"));
    const picker = await screen.findByTestId("picker");
    expect(picker.querySelector("aside")).toBeNull();
    expect(within(picker).getByRole("group", { name: "Selected" })).toBeTruthy();
  });
});

describe("T8 sign out mid-session", () => {
  it("after sign-out a close is not silently lost: the strip says it was not saved, and nothing is written", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [1, 2].map((n) => ({ kind: "source", id: SRC(n) }))));
    await waitFor(() => expect(keys()).toEqual([k(1), k(2)]));
    who = undefined as any; // the fake answers 401 "sign in" for every route of its own
    const before = JSON.stringify(stored());
    fireEvent.click(within(menu(k(2))).getByTestId("act-close"));
    await waitFor(() => expect(screen.getByTestId("strip-note").textContent).toMatch(/not saved/));
    who = "alice";
    expect(JSON.stringify(stored())).toBe(before);
  });
});

describe("review 1: the notes say what happened (F1)", () => {
  it("F1: a lock the other browser has made impossible (16 locked there) is refused with its reason, not reported as applied on top", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]));
    await waitFor(() => expect(keys()).toEqual([k(1)]));
    lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }, ...Array.from({ length: 16 }, (_, i) => ({ kind: "topic", id: "t" + i, locked: true }))]);
    fireEvent.click(within(menu(k(1))).getByTestId("act-lock"));
    await waitFor(() => expect(screen.getByTestId("strip-lock-note").textContent).toMatch(/At most 16/));
    expect(document.querySelector('[data-testid="strip-note"]')?.textContent ?? "").not.toMatch(/applied on top/);
    expect(stored().find((x) => x.id === SRC(1))?.locked).toBeUndefined();
  });
  it("F1: a close the other browser already made says there was nothing left to do", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [1, 2].map((n) => ({ kind: "source", id: SRC(n) }))));
    await waitFor(() => expect(keys()).toEqual([k(1), k(2)]));
    lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]); // the other browser closed S2
    fireEvent.click(within(menu(k(2))).getByTestId("act-close"));
    await waitFor(() => expect(screen.getByTestId("strip-note").textContent).toMatch(/nothing left/));
    expect(screen.getByTestId("strip-note").textContent).not.toMatch(/applied on top/);
    expect(stored().map((x) => x.id)).toEqual([SRC(1)]);
  });
});

describe("review 1: the two recent primitives (F2, R3)", () => {
  it("F2: a change that edits the list in place is still written, and the page shows what the server holds", async () => {
    await boot("/library", () => lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }]));
    await waitFor(() => expect(keys()).toEqual([k(1)]));
    const r = await updateRecentSaved((l) => { l.unshift({ kind: "source", id: SRC(2) }); return l; });
    expect(r).toBe("saved");
    expect(stored().map((x) => x.id)).toEqual([SRC(2), SRC(1)]);
    await waitFor(() => expect(keys()).toEqual([k(2), k(1)]));
  });
  it("R3: a whole-list write is what a later change starts from", async () => {
    await boot("/library");
    expect(await setRecentSaved([{ kind: "source", id: SRC(5) }, { kind: "source", id: SRC(1) }])).toBe(true);
    const r = await updateRecentSaved((l) => l.filter((x) => x.id !== SRC(1)));
    expect(r).toBe("saved");
    expect(stored().map((x) => x.id)).toEqual([SRC(5)]);
  });
});
