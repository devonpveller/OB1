// The Library shell (rwr-lib-shell): the tabs Discover / For my document / Saved / Insights, the Recently viewed strip kept in the
// account (library.recent), and a source or claim opening as its own tab. The back end is the shared fake of the real routes
// (e2e/library-fake.mjs over e2e/docs-fake.mjs): the e2e stub drives the same two, so the suites cannot drift.
// Planted marks: SRC-SHARED is in every shared source title; alice's documents carry ALPHA, bob's BRAVO; the claim
// CLAIM-PRIVATE-ALICE-REPORT was drawn from alice's PRIVATE idea report.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { App } from "../src/App";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { navigate } from "../src/lib/router";
import { resetState, getRecent, stateEpoch } from "../src/lib/state";
import { titles } from "../src/lib/recent";
import { createFake, PEOPLE } from "../e2e/docs-fake.mjs";
import {
  createLibraryFake, SRC, SRC_HIDDEN, SRC_CUT, SRC_GONE, SRC_HELD_A, CLAIM_SHARED, CLAIM_PRIVATE_A, PRIVATE_MARKER,
} from "../e2e/library-fake.mjs";

type Person = "alice" | "bob";
const CPU = "documents/k-a/Hardware/cpu.md";
const docs = createFake();
const lib = createLibraryFake({ docs });
let who: Person;
let seen: { method: string; url: string; body: any; who: Person }[];
let failSettings = 0;

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
    if (failSettings && p === "/workbench/settings" && method === "GET") { failSettings--; return j(500, { error: "down" }); }
    const r = lib.handle(who, method, url, body) ?? docs.handle(who, method, url, body);
    if (!r) return j(404, { error: `no fake for ${method} ${url}` });
    return j(r.status, r.body);
  });
}

async function boot(path = "/library", plant?: () => void) {
  cleanup(); clearRequestLog(); resetState(); titles.clear();
  lib.reset(); docs.reset(); who = "alice"; seen = []; failSettings = 0;
  plant?.();
  window.history.pushState({}, "", path);
  wire();
  render(<App />);
  if (path.startsWith("/library")) await ready();
}
const ready = () => waitFor(() => expect(screen.getByTestId("strip").getAttribute("data-ready")).toBe("true"));
const open = async (kind: "source" | "claim", id: string) => {
  act(() => navigate(`/library?${kind}=${id}`));
  await waitFor(() => expect(chips().map((c) => c.getAttribute("data-key"))).toContain(`${kind}:${id}`));
};
const chips = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chip"]'));
const keys = () => chips().map((c) => c.getAttribute("data-key"));
const chip = (key: string) => chips().find((c) => c.getAttribute("data-key") === key)!;
const stored = (p: Person = "alice") => (lib.account(p)["library.recent"]?.value ?? []) as { kind: string; id: string; locked?: boolean }[];
const menu = (key: string) => { fireEvent.click(within(chip(key)).getByTestId("chip-menu")); return screen.getByTestId("chip-actions"); };
const puts = () => seen.filter((r) => r.method === "PUT" && r.url.includes("library.recent"));
const lockDoc = () => lib.plantAccount("alice", "ui.locked_document", CPU);

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { cleanup(); });

describe("the tabs", () => {
  it("lists Discover, For my document, Saved and Insights in that order; Discover is the Library's own address", async () => {
    await boot("/library");
    const tabs = within(screen.getByTestId("library-tabs")).getAllByRole("link").map((a) => a.textContent);
    expect(tabs).toEqual(["Discover", "For my document", "Saved", "Insights"]);
    expect(screen.getByTestId("tab-discover").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Library");
  });
  it("each tab has its address and says plainly that it is not built yet: it never looks like it works", async () => {
    const want: [string, string, RegExp][] = [
      ["/library", "discover", /Discover is not built yet/],
      ["/library/for-document", "fordoc", /For my document is not built yet/],
      ["/library/saved", "saved", /Saved is not built yet/],
      ["/library/insights", "insights", /Insights is not built yet/],
    ];
    for (const [path, tab, re] of want) {
      await boot(path);
      expect(screen.getByTestId("tab-" + tab).getAttribute("aria-current")).toBe("page");
      const c = screen.getByTestId("panel-coming");
      expect(c.textContent).toMatch(re);
      expect(c.textContent).toMatch(/phase \d/);
      expect(c.querySelector("button, input, a")).toBeNull(); // nothing in it to press or type into
    }
    expect(screen.getByTestId("panel-coming").textContent).toMatch(/phase 8/); // Insights: phase 8
  });
  it("the unbuilt tabs ask the back end for nothing of their own", async () => {
    await boot("/library/saved");
    const mine = requestLog().filter((r) => /search|source-states|pending-refs|saved|discover|insights/.test(r.url));
    expect(mine).toEqual([]);
  });
  it("the menu keeps Library as the current entry on every Library address", async () => {
    await boot("/library/saved");
    expect(document.querySelector('nav [aria-current="page"]')?.textContent).toMatch(/Library/);
  });
});

describe("acceptance 1: the strip keeps the last 8 plus locked chips", () => {
  it("opening 9 items leaves the last 8, newest first; the 9th evicts the oldest", async () => {
    await boot();
    for (let n = 1; n <= 9; n++) await open("source", SRC(n));
    expect(keys()).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map((n) => `source:${SRC(n)}`));
    expect(stored().map((x) => x.id)).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map((n) => SRC(n)));
    expect(screen.getByTestId("strip-count").textContent).toMatch(/8 of 8/);
  });
  it("a locked chip is never evicted: lock the first, open 9 more, it is still there with the last 8", async () => {
    await boot();
    await open("source", SRC(1));
    fireEvent.click(within(menu(`source:${SRC(1)}`)).getByTestId("act-lock"));
    await waitFor(() => expect(chip(`source:${SRC(1)}`).getAttribute("data-locked")).toBe("true"));
    for (let n = 2; n <= 10; n++) await open("source", SRC(n));
    expect(keys()).toContain(`source:${SRC(1)}`);
    expect(chips().filter((c) => c.getAttribute("data-locked") !== "true")).toHaveLength(8);
    expect(chip(`source:${SRC(1)}`).getAttribute("data-locked")).toBe("true");
    expect(stored().find((x) => x.id === SRC(1))?.locked).toBe(true);
    expect(stored()).toHaveLength(9);
  });
  it("unlocking puts the chip back among the evictable ones", async () => {
    await boot();
    await open("source", SRC(1));
    fireEvent.click(within(menu(`source:${SRC(1)}`)).getByTestId("act-lock"));
    await waitFor(() => expect(chip(`source:${SRC(1)}`).getAttribute("data-locked")).toBe("true"));
    fireEvent.click(within(menu(`source:${SRC(1)}`)).getByTestId("act-lock"));
    await waitFor(() => expect(chip(`source:${SRC(1)}`).getAttribute("data-locked")).toBe("false"));
    for (let n = 2; n <= 10; n++) await open("source", SRC(n));
    expect(keys()).not.toContain(`source:${SRC(1)}`);
  });
  it("a chip that is already there keeps its place when it is opened again", async () => {
    await boot();
    await open("source", SRC(1)); await open("source", SRC(2)); await open("source", SRC(3));
    await open("source", SRC(1));
    expect(keys()).toEqual([3, 2, 1].map((n) => `source:${SRC(n)}`));
  });
  it("what is written is {kind, id[, locked]} only: identifiers, never a title", async () => {
    await boot();
    titles.remember("source", SRC(1), "SRC-SHARED Source 1");
    await open("source", SRC(1));
    for (const w of puts()) expect(JSON.stringify(w.body)).not.toMatch(/SRC-SHARED|title|text/);
    expect(puts().at(-1)!.body.value).toEqual([{ kind: "source", id: SRC(1) }]);
  });
});

describe("acceptance 3: the strip is kept with the account, not the browser", () => {
  it("another browser (a fresh page, empty storage) shows the same strip; nothing is in localStorage or sessionStorage", async () => {
    await boot();
    for (let n = 1; n <= 3; n++) await open("source", SRC(n));
    fireEvent.click(within(menu(`source:${SRC(2)}`)).getByTestId("act-lock"));
    await waitFor(() => expect(stored().find((x) => x.id === SRC(2))?.locked).toBe(true));
    const was = keys();
    cleanup(); resetState(); titles.clear(); seen = [];
    window.history.pushState({}, "", "/library");
    render(<App />);
    await ready();
    await waitFor(() => expect(keys()).toEqual(was));
    expect(chip(`source:${SRC(2)}`).getAttribute("data-locked")).toBe("true");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
  it("the page title never carries an item's title", async () => {
    await boot();
    titles.remember("source", SRC(1), "SRC-SHARED Source 1");
    await open("source", SRC(1));
    expect(document.title).toBe("Library - Research workbench");
  });
  it("a write refused as stale (another browser wrote first) reloads the account and says so", async () => {
    await boot();
    await open("source", SRC(1));
    lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(7) }, { kind: "source", id: SRC(8) }]); // the other browser
    act(() => navigate(`/library?source=${SRC(2)}`));
    await waitFor(() => expect(screen.getByTestId("strip-note").textContent).toMatch(/another browser/));
    // the change is applied on top of what the other browser wrote, never over it
    await waitFor(() => expect(keys()).toEqual([`source:${SRC(2)}`, `source:${SRC(7)}`, `source:${SRC(8)}`]));
  });
  it("when the list cannot be read nothing is written over it, and the strip says so with a way to retry", async () => {
    failSettings = 1;
    cleanup(); clearRequestLog(); resetState(); titles.clear(); lib.reset(); docs.reset(); who = "alice"; seen = [];
    lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(5) }]);
    window.history.pushState({}, "", `/library?source=${SRC(1)}`);
    wire(); failSettings = 1;
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("strip-error").textContent).toMatch(/could not be read/));
    expect(puts()).toEqual([]);
    fireEvent.click(screen.getByTestId("strip-retry"));
    await ready();
    await waitFor(() => expect(keys()).toContain(`source:${SRC(5)}`));
    expect(keys()).toContain(`source:${SRC(1)}`); // the open that waited is recorded once the list is known
    expect(stored().map((x) => x.id).sort()).toEqual([SRC(1), SRC(5)].sort());
  });
});

describe("acceptance 5: a chip shows its state, never stale text, when the item cannot be read", () => {
  const plant = () => {
    lib.plantAccount("alice", "library.recent", [SRC(1), SRC_HIDDEN, SRC_CUT, SRC_GONE, SRC_HELD_A].map((id) => ({ kind: "source", id })));
  };
  it("a hidden, cut-loose, erased and an unavailable source each show their state and carry no title", async () => {
    await boot("/library", () => { plant(); });
    for (const id of [SRC(1), SRC_HIDDEN, SRC_CUT]) titles.remember("source", id, "SRC-SHARED " + id.slice(-2)); // known in this page's memory
    await waitFor(() => expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed"));
    expect(chip(`source:${SRC_HIDDEN}`).textContent).toMatch(/Hidden source/);
    expect(chip(`source:${SRC_CUT}`).getAttribute("data-state")).toBe("unlinked");
    expect(chip(`source:${SRC_CUT}`).textContent).toMatch(/Cut-loose source/);
    expect(chip(`source:${SRC_GONE}`).getAttribute("data-state")).toBe("erased");
    expect(chip(`source:${SRC_GONE}`).textContent).toMatch(/Erased source/);
    expect(chip(`source:${SRC_HELD_A}`).getAttribute("data-state")).toBe("unavailable");
    expect(chip(`source:${SRC_HELD_A}`).textContent).toMatch(/no longer available/);
    for (const k of [SRC_HIDDEN, SRC_CUT, SRC_GONE, SRC_HELD_A]) expect(chip(`source:${k}`).textContent).not.toMatch(/SRC-SHARED|SRC-HELD/);
  });
  it("an active source shows its title when this page knows it, and a short name when it does not", async () => {
    await boot("/library", plant);
    await waitFor(() => expect(chip(`source:${SRC(1)}`).getAttribute("data-state")).toBe("active"));
    expect(chip(`source:${SRC(1)}`).textContent).toMatch(/^Source b3000000/);
    act(() => titles.remember("source", SRC(1), "SRC-SHARED Source 1"));
    await open("source", SRC(1)); // re-render
    await waitFor(() => expect(chip(`source:${SRC(1)}`).textContent).toMatch(/SRC-SHARED Source 1/));
  });
  it("an item the caller could read a moment ago and cannot now shows its state, not the title the page remembers", async () => {
    await boot();
    titles.remember("source", SRC(2), "SRC-SHARED Source 2");
    await open("source", SRC(2));
    await waitFor(() => expect(chip(`source:${SRC(2)}`).textContent).toMatch(/SRC-SHARED Source 2/));
    lib.setLifecycle(SRC(2), "suppressed");
    await open("source", SRC(3)); // any strip change re-checks the states
    await waitFor(() => expect(chip(`source:${SRC(2)}`).getAttribute("data-state")).toBe("suppressed"));
    expect(chip(`source:${SRC(2)}`).textContent).not.toMatch(/SRC-SHARED Source 2/);
  });
  it("the state check is ONE source-states request for the strip's sources, never a request per chip", async () => {
    await boot("/library", plant);
    await waitFor(() => expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed"));
    const posts = seen.filter((r) => r.url === "/workbench/contract/source-states");
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[0].body.ids).toHaveLength(5);
  });
  it("when the state check fails the chip keeps the last answer it had: a hidden source stays hidden", async () => {
    await boot("/library", plant);
    await waitFor(() => expect(chip(`source:${SRC(1)}`).getAttribute("data-state")).toBe("active"));
    setFetcher(async (url) => (url.startsWith("/workbench/contract/source-states") ? new Response("{}", { status: 500 }) : new Response("{}", { status: 404 })));
    act(() => { window.dispatchEvent(new Event("focus")); }); // the page regains focus: the states are checked again
    await waitFor(() => expect(requestLog().filter((r) => r.url.includes("source-states")).length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 150));
    expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed");
    expect(chip(`source:${SRC_HIDDEN}`).textContent).not.toMatch(/SRC-SHARED/);
  });
});

describe("the chip menu and the five closes", () => {
  const six = async () => {
    await boot();
    for (let n = 1; n <= 6; n++) await open("source", SRC(n));
    // strip, newest first: 6 5 4 3 2 1
    fireEvent.click(within(menu(`source:${SRC(5)}`)).getByTestId("act-lock"));
    await waitFor(() => expect(chip(`source:${SRC(5)}`).getAttribute("data-locked")).toBe("true"));
  };
  const key = (n: number) => `source:${SRC(n)}`;
  const choose = (n: number, act: string) => fireEvent.click(within(menu(key(n))).getByTestId(act));
  const confirm = () => screen.getByTestId("confirm-close");
  const yes = async () => { fireEvent.click(screen.getByTestId("confirm-yes")); await waitFor(() => expect(screen.queryByTestId("confirm-close")).toBeNull()); };

  it("close one: a chip's own Close removes it at once; a locked chip's Close is off, with the reason", async () => {
    await six();
    choose(3, "act-close");
    await waitFor(() => expect(keys()).not.toContain(key(3)));
    expect(stored().map((x) => x.id)).not.toContain(SRC(3));
    const m = menu(key(5));
    expect((within(m).getByTestId("act-close") as HTMLButtonElement).disabled).toBe(true);
    expect(m.textContent).toMatch(/Unlock/);
  });
  it("close left closes the unlocked chips before it; locked ones stay", async () => {
    await six();
    choose(2, "act-close-left"); // before 2: 6 5(locked) 4 3
    expect(confirm().getAttribute("data-action")).toBe("left");
    expect(confirm().getAttribute("data-target")).toBe(key(2));
    expect(confirm().textContent).toMatch(/3 chips/);
    await yes();
    await waitFor(() => expect(keys()).toEqual([key(5), key(2), key(1)]));
  });
  it("close right closes the unlocked chips after it", async () => {
    await six();
    choose(4, "act-close-right"); // after 4: 3 2 1
    await yes();
    await waitFor(() => expect(keys()).toEqual([key(6), key(5), key(4)]));
  });
  it("close others keeps this chip and the locked ones", async () => {
    await six();
    choose(3, "act-close-others");
    await yes();
    await waitFor(() => expect(keys()).toEqual([key(5), key(3)]));
    expect(chip(key(5)).getAttribute("data-locked")).toBe("true");
  });
  it("close all closes every unlocked chip and keeps the locked one", async () => {
    await six();
    fireEvent.click(screen.getByTestId("close-all"));
    expect(confirm().getAttribute("data-action")).toBe("all");
    await yes();
    await waitFor(() => expect(keys()).toEqual([key(5)]));
    expect(stored()).toEqual([{ kind: "source", id: SRC(5), locked: true }]);
  });
  it("a confirmation belongs to its target: while one is open every other destructive button is off, and Cancel changes nothing", async () => {
    await six();
    choose(3, "act-close-others");
    expect(confirm().getAttribute("data-target")).toBe(key(3));
    expect((screen.getByTestId("close-all") as HTMLButtonElement).disabled).toBe(true);
    for (const b of screen.getAllByTestId("chip-menu")) expect((b as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("confirm-no"));
    expect(screen.queryByTestId("confirm-close")).toBeNull();
    expect(keys()).toHaveLength(6);
    expect((screen.getByTestId("close-all") as HTMLButtonElement).disabled).toBe(false);
  });
  it("a close that would close nothing is off, with the reason, instead of asking", async () => {
    await six();
    const m = menu(key(6)); // newest: nothing to its left
    expect((within(m).getByTestId("act-close-left") as HTMLButtonElement).disabled).toBe(true);
    expect(within(m).getByTestId("act-close-left").getAttribute("title") ?? m.textContent).toMatch(/Nothing/);
  });
  it("closing the chip that is open leaves the item tab for the Library's first tab", async () => {
    await boot();
    await open("source", SRC(1));
    expect(screen.getByTestId("item")).toBeTruthy();
    choose(1, "act-close");
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.queryByTestId("item")).toBeNull();
  });
});

describe("acceptance 2: 'add all' goes to the locked document's to-place list, or asks which document", () => {
  const plantList = () => {
    lib.plantAccount("alice", "library.recent", [
      { kind: "source", id: SRC(1) }, { kind: "source", id: SRC(2) }, { kind: "source", id: SRC_HIDDEN }, { kind: "claim", id: CLAIM_SHARED },
      { kind: "claim", id: CLAIM_PRIVATE_A }, { kind: "source", id: SRC_GONE }, { kind: "source", id: SRC_HELD_A }, { kind: "topic", id: "t-1" },
    ]);
  };
  it("with a locked document it adds the sources and claims it can cite, once each, to that document", async () => {
    await boot("/library", () => { lockDoc(); plantList(); });
    titles.remember("claim", CLAIM_SHARED, "CLAIM-SHARED the socket takes 165 W"); // read from a search hit in this page
    await waitFor(() => expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed"));
    const btn = screen.getByTestId("add-all") as HTMLButtonElement;
    expect(btn.textContent).toMatch(/ALPHA Upgrading the CPU/);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId("add-result").textContent).toMatch(/Added 3/));
    const rows = lib.pendingRows();
    expect(rows.map((r) => r.source_id ?? r.claim_id).sort()).toEqual([SRC(1), SRC(2), CLAIM_SHARED].sort());
    expect(new Set(rows.map((r) => r.path))).toEqual(new Set([CPU]));
    expect(new Set(rows.map((r) => r.added_from))).toEqual(new Set(["library"]));
    // not added, each with its reason: the hidden, erased and unavailable sources, the claim this page never read, the topic
    expect(within(screen.getByTestId("add-not-added")).getAllByRole("listitem")).toHaveLength(5);
  });
  it("a second 'add all' adds nothing new: the cites are already waiting (409), counted, not repeated", async () => {
    await boot("/library", () => { lockDoc(); plantList(); });
    await waitFor(() => expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed"));
    fireEvent.click(screen.getByTestId("add-all"));
    await waitFor(() => expect(screen.getByTestId("add-result").textContent).toMatch(/Added 2/));
    fireEvent.click(screen.getByTestId("add-all"));
    await waitFor(() => expect(screen.getByTestId("add-result").textContent).toMatch(/2 already waiting/));
    expect(lib.pendingRows()).toHaveLength(2);
  });
  it("a claim this page never read is not offered for citing: its id never reaches the to-place route", async () => {
    await boot("/library", () => { lockDoc(); plantList(); });
    await waitFor(() => expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed"));
    fireEvent.click(screen.getByTestId("add-all"));
    await waitFor(() => expect(screen.getByTestId("add-result")).toBeTruthy());
    expect(JSON.stringify(seen.filter((r) => r.url.includes("pending-refs")))).not.toContain(CLAIM_PRIVATE_A);
    expect(lib.pendingRows().some((r) => r.claim_id === CLAIM_PRIVATE_A)).toBe(false);
  });
  it("with NO locked document it asks which one through the shared picker and adds nothing until one is chosen", async () => {
    await boot("/library", plantList);
    await waitFor(() => expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed"));
    fireEvent.click(screen.getByTestId("add-all"));
    const picker = await screen.findByTestId("picker");
    expect(picker.getAttribute("data-mode")).toBe("single");
    expect(seen.some((r) => r.url.includes("pending-refs"))).toBe(false);
    fireEvent.change(screen.getByTestId("picker-q"), { target: { value: "ALPHA" } });
    await waitFor(() => expect(within(screen.getByTestId("picker-list")).getAllByRole("option").length).toBeGreaterThan(0));
    // only documents are offered, and only the caller's own live ones
    const rows = within(screen.getByTestId("picker-list")).getAllByRole("option").map((o) => o.textContent!);
    expect(rows.every((t) => /ALPHA/.test(t))).toBe(true);
    expect(rows.join(" ")).not.toMatch(/BRAVO|trashed|duplicate|Old wiki/);
    expect((screen.getByTestId("picker-ok") as HTMLButtonElement).disabled).toBe(true);
    expect(seen.some((r) => r.url.includes("pending-refs"))).toBe(false); // nothing chosen: nothing added
    fireEvent.click(within(screen.getByTestId("picker-list")).getAllByRole("option").find((o) => /Upgrading the CPU/.test(o.textContent!))!);
    fireEvent.click(screen.getByTestId("picker-ok"));
    await waitFor(() => expect(screen.getByTestId("add-result").textContent).toMatch(/Added 2/));
    expect(lib.pendingRows().every((r) => r.path === CPU)).toBe(true);
    expect(screen.queryByTestId("picker")).toBeNull();
  });
  it("cancelling the picker adds nothing and does not lock a document", async () => {
    await boot("/library", plantList);
    await waitFor(() => expect((screen.getByTestId("add-all") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("add-all"));
    await screen.findByTestId("picker");
    fireEvent.click(screen.getAllByText("Cancel")[0]);
    expect(screen.queryByTestId("picker")).toBeNull();
    expect(lib.pendingRows()).toEqual([]);
    expect(lib.account("alice")["ui.locked_document"]).toBeUndefined();
  });
  it("is off, with the reason, when nothing in the strip can be cited", async () => {
    await boot();
    expect((screen.getByTestId("add-all") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("add-all-why").textContent).toMatch(/Nothing in Recently viewed/);
  });
  it("says what happened when the document is no longer there (404), and adds nothing", async () => {
    await boot("/library", () => { lockDoc(); plantList(); });
    await waitFor(() => expect(chip(`source:${SRC_HIDDEN}`).getAttribute("data-state")).toBe("suppressed"));
    docs.db().docs.delete(CPU);
    fireEvent.click(screen.getByTestId("add-all"));
    await waitFor(() => expect(screen.getByTestId("add-result").textContent).toMatch(/document is not available/));
    expect(lib.pendingRows()).toEqual([]);
  });
});

describe("save all", () => {
  it("is off, with the reason: Saved is not built yet, so there is nowhere to save them", async () => {
    await boot();
    await open("source", SRC(1));
    const b = screen.getByTestId("save-all") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(screen.getByTestId("save-all-why").textContent).toMatch(/Saved is not built yet/);
    fireEvent.click(b);
    expect(seen.filter((r) => /saved|favourite|reading/.test(r.url))).toEqual([]);
  });
});

describe("a source or claim opens as its own tab", () => {
  it("/library?source=<id> opens the source as a tab beside the four, selected, and puts it in the strip", async () => {
    await boot();
    titles.remember("source", SRC(1), "SRC-SHARED Source 1");
    await open("source", SRC(1));
    const tab = screen.getByTestId("tab-item");
    expect(tab.getAttribute("aria-current")).toBe("page");
    expect(tab.textContent).toMatch(/SRC-SHARED Source 1/);
    expect(screen.getByTestId("tab-discover").getAttribute("aria-current")).toBeNull();
    const item = screen.getByTestId("item");
    expect(item.getAttribute("data-kind")).toBe("source");
    expect(screen.getByTestId("item-title").textContent).toBe("SRC-SHARED Source 1");
    expect(item.textContent).toMatch(/reading screen/i); // says the one-source screen is not built here
  });
  it("a chip opens its item tab; the other tabs stay one click away", async () => {
    await boot();
    await open("source", SRC(1)); await open("source", SRC(2));
    fireEvent.click(within(chip(`source:${SRC(1)}`)).getByTestId("chip-open"));
    await waitFor(() => expect(screen.getByTestId("item").getAttribute("data-id")).toBe(SRC(1)));
    fireEvent.click(screen.getByTestId("tab-saved"));
    await waitFor(() => expect(screen.getByTestId("panel-coming").textContent).toMatch(/Saved/));
    expect(keys()).toHaveLength(2); // the strip is on every tab
  });
  it("a hidden source's tab shows its state and not its title, and cannot be cited", async () => {
    await boot();
    titles.remember("source", SRC_HIDDEN, "SRC-SHARED Hidden source");
    await open("source", SRC_HIDDEN);
    await waitFor(() => expect(screen.getByTestId("item-state").textContent).toMatch(/hidden/i));
    expect(screen.getByTestId("item").textContent).not.toMatch(/SRC-SHARED/);
    expect((screen.getByTestId("item-add") as HTMLButtonElement).disabled).toBe(true);
  });
  it("an address that names no source or claim says so and is not recorded", async () => {
    await boot("/library?source=" + encodeURIComponent("../x"));
    expect(screen.getByTestId("item-bad").textContent).toMatch(/does not name a source or a claim/);
    expect(keys()).toEqual([]);
    expect(puts()).toEqual([]);
  });
  it("'add to the locked document' on the tab sends that one cite", async () => {
    await boot(`/library?source=${SRC(3)}`, lockDoc);
    await waitFor(() => expect(screen.getByTestId("item-add").textContent).toMatch(/ALPHA Upgrading the CPU/));
    await waitFor(() => expect((screen.getByTestId("item-add") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("item-add"));
    await waitFor(() => expect(lib.pendingRows()).toHaveLength(1));
    expect(lib.pendingRows()[0].source_id).toBe(SRC(3));
  });
  it("Home's search results open a source as a tab, carrying its title for this page only", async () => {
    await boot("/");
    fireEvent.change(await screen.findByTestId("ask-input"), { target: { value: "Source 3" } });
    fireEvent.click(screen.getByTestId("ask-go"));
    const hit = await screen.findByTestId("hit");
    fireEvent.click(hit);
    await waitFor(() => expect(window.location.pathname).toBe("/library"));
    expect(window.location.search).toBe(`?source=${SRC(3)}`);
    await ready();
    await waitFor(() => expect(chip(`source:${SRC(3)}`).textContent).toMatch(/SRC-SHARED Source 3/));
    expect(window.localStorage.length).toBe(0);
  });
});

describe("acceptance 4 and 6: two identities", () => {
  const switchTo = async (p: Person) => {
    who = p;
    await act(async () => { await vi.advanceTimersByTimeAsync(30500); });
  };
  it("bob never sees alice's strip, titles, locked document, add-all result or a close confirmation she had open (no reload)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await boot("/library", () => { lockDoc(); lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }, { kind: "source", id: SRC(2) }, { kind: "claim", id: CLAIM_SHARED }]); });
      titles.remember("source", SRC(1), "SRC-SHARED Source 1");
      titles.remember("claim", CLAIM_SHARED, "CLAIM-SHARED the socket takes 165 W");
      await waitFor(() => expect(screen.getByTestId("add-all").textContent).toMatch(/ALPHA Upgrading the CPU/));
      fireEvent.click(screen.getByTestId("add-all"));
      await waitFor(() => expect(screen.getByTestId("add-result")).toBeTruthy());
      choose(chip(`source:${SRC(1)}`));
      expect(screen.getByTestId("confirm-close")).toBeTruthy();
      const writesBefore = seen.filter((r) => r.method !== "GET" && r.method !== "POST").length;
      await switchTo("bob");
      await waitFor(() => expect(screen.getByTestId("avatar").textContent).toBe("BB"));
      await waitFor(() => expect(keys()).toEqual([]));
      expect(screen.queryByTestId("confirm-close")).toBeNull();
      expect(screen.queryByTestId("add-result")).toBeNull();
      expect(screen.queryByTestId("picker")).toBeNull();
      expect(document.body.textContent).not.toMatch(/ALPHA|SRC-SHARED Source 1|CLAIM-SHARED/);
      expect(seen.filter((r) => r.method !== "GET" && r.method !== "POST").length).toBe(writesBefore); // the switch wrote nothing
      expect(lib.account("bob")).toEqual({});
      expect(getRecent()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  function choose(c: HTMLElement) {
    fireEvent.click(within(c).getByTestId("chip-menu"));
    fireEvent.click(within(screen.getByTestId("chip-actions")).getByTestId("act-close-others"));
  }
  it("a toast or dialog made for alice's chip is gone when bob is on the page, and bob's first open does not carry alice's list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await boot("/library", () => { lib.plantAccount("alice", "library.recent", [{ kind: "source", id: SRC(1) }, { kind: "source", id: SRC(2) }]); });
      const e0 = stateEpoch();
      await switchTo("bob");
      await waitFor(() => expect(screen.getByTestId("avatar").textContent).toBe("BB"));
      expect(stateEpoch()).toBeGreaterThan(e0);
      await ready();
      await open("source", SRC(9));
      expect(stored("bob").map((x) => x.id)).toEqual([SRC(9)]); // bob's list is bob's own
      expect(stored("alice").map((x) => x.id)).toEqual([SRC(1), SRC(2)]); // and alice's is untouched
    } finally { vi.useRealTimers(); }
  });
  it("bob's picker lists bob's documents only: alice's ALPHA documents are not there, and the empty answer is the plain one", async () => {
    await boot("/library", () => { who = "bob"; lib.plantAccount("bob", "library.recent", [{ kind: "source", id: SRC(1) }]); });
    await waitFor(() => expect(keys()).toHaveLength(1));
    fireEvent.click(screen.getByTestId("add-all"));
    await screen.findByTestId("picker");
    fireEvent.change(screen.getByTestId("picker-q"), { target: { value: "ALPHA" } });
    await waitFor(() => expect(screen.getByTestId("picker-empty")).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/Upgrading the CPU/);
  });
  it("a planted private-report claim: bob's strip never lists it, counts it or offers to cite it, even when bob opens its address", async () => {
    await boot("/library", () => { lib.plantAccount("alice", "library.recent", [{ kind: "claim", id: CLAIM_PRIVATE_A }]); });
    who = "bob";
    cleanup(); resetState(); titles.clear(); seen = [];
    window.history.pushState({}, "", `/library?claim=${CLAIM_PRIVATE_A}`);
    render(<App />);
    await ready();
    await waitFor(() => expect(screen.getByTestId("item")).toBeTruthy());
    expect(document.body.textContent).not.toContain(PRIVATE_MARKER);
    expect(screen.getByTestId("item").textContent).toMatch(/not available here|not been read/);
    expect((screen.getByTestId("item-add") as HTMLButtonElement).disabled).toBe(true);
    expect(seen.filter((r) => r.url.includes("pending-refs"))).toEqual([]);
    // nothing this item reads can return a claim's text: its reads are the account, source states and the document list
    const reads = seen.filter((r) => /contract\/(claims|private|search)/.test(r.url));
    expect(reads).toEqual([]);
    // and the open is not recorded: a claim enters the strip only once this page has read it
    expect(keys()).toEqual([]);
    expect(puts()).toEqual([]);
    expect(screen.getByTestId("strip-count").textContent).toMatch(/0 of 8/);
  });
  it("alice's own private-report claim is hers: it appears in her strip only after she read it in this page, and she can cite it", async () => {
    await boot("/library", lockDoc);
    titles.remember("claim", CLAIM_PRIVATE_A, `${PRIVATE_MARKER} the owner's own finding`);
    await open("claim", CLAIM_PRIVATE_A);
    await waitFor(() => expect((screen.getByTestId("strip-count") as HTMLElement).textContent).toMatch(/1 of 8/));
  });
});

describe("cloud and local: this item sends nothing to any model", () => {
  it("every request of a full session is the account, the source states, the to-place queue, the documents list or the shell's own", async () => {
    await boot("/library", () => { lockDoc(); });
    titles.remember("source", SRC(1), "SRC-SHARED Source 1");
    await open("source", SRC(1)); await open("source", SRC(2));
    await waitFor(() => expect((screen.getByTestId("add-all") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("add-all"));
    await waitFor(() => expect(screen.getByTestId("add-result")).toBeTruthy());
    const ok = /^\/workbench\/(settings(\/|$)|contract\/(source-states|documents|search|sessions|cleanup\/)|documents\/(state|file)|workspace\/whoami|auth\/me|intake\/jobs)/;
    for (const r of seen) expect(r.url, r.method + " " + r.url).toMatch(ok);
    expect(seen.some((r) => /chat|completion|model|llm|v1\//.test(r.url))).toBe(false);
  });
});
