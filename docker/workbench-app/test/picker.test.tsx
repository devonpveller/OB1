// rwr-picker: the model, the shared search hook, and the one picker component.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import {
  ItemPicker, PickerResults, searchLibrary, searchUrl, applyFilters, countBy, sortItems, snippetParts, missingFacets, NO_FILTERS, keyOf,
  type PickerItem, type MineSearch,
} from "../src/components/picker";
import { setFetcher, requestLog, clearRequestLog, api, raw } from "../src/lib/api";

const hit = (kind: string, id: string, title: string, extra: Record<string, unknown> = {}) => ({
  kind, id, title, snippet: `about <<HL>>${title}<</HL>> here`, state: "current",
  lifecycle: kind === "source" ? "active" : null, page_class: kind === "page" ? "entity" : null, ...extra,
});
const LIB = [
  hit("source", "s1", "X299 VRM thermals"), hit("source", "s2", "Board vendor power stage"), hit("claim", "c1", "VRMs throttle under load"),
  hit("page", "p1", "Workstation hardware"), hit("source", "s3", "Held note", { lifecycle: "held", state: "held" }),
];
function libFetcher(rows: unknown[] = LIB, seen: string[] = []) {
  setFetcher(async (u) => {
    seen.push(u);
    return new Response(JSON.stringify({ query: "x", kinds: [], scope: { refinery_id: null }, count: rows.length, results: rows }), { status: 200 });
  });
  return seen;
}
const type = (v: string) => fireEvent.change(screen.getByTestId("picker-q"), { target: { value: v } });
const keys = () => [...document.querySelectorAll("[data-testid=picker-list] [role=option]")].map((e) => e.getAttribute("data-key"));
const props = { mode: "multi" as const, onConfirm: () => {}, debounceMs: 0 };
const row = (k: string) => document.querySelector(`[data-key="${k}"]`) as HTMLElement;

beforeEach(() => { cleanup(); clearRequestLog(); });

describe("model", () => {
  const items: PickerItem[] = [
    { kind: "source", id: "a", title: "Bravo", snippet: "", state: "current", lifecycle: "active", type: null, date: "2026-11-10", quality: "High", citedBy: 3, topics: ["Cooling"] },
    { kind: "source", id: "b", title: "Alpha", snippet: "", state: "current", lifecycle: "active", type: null, date: "2025-02-01", quality: "Low", citedBy: 9, topics: ["Cooling", "Firmware"], private: true },
    { kind: "claim", id: "c", title: "Charlie", snippet: "", state: "current", lifecycle: null, type: null, date: null, quality: "Medium", citedBy: 0 },
  ];
  const ctx = { now: Date.parse("2026-11-20"), linked: new Set(["claim:c"]) };
  const ids = (f: Partial<typeof NO_FILTERS>) => applyFilters(items, { ...NO_FILTERS, ...f }, ctx).map((i) => i.id);
  it("filters by every facet", () => {
    expect(ids({ kinds: ["source"] })).toEqual(["a", "b"]);
    expect(ids({ topics: ["Firmware"] })).toEqual(["b"]);
    expect(ids({ date: "d30" })).toEqual(["a"]);
    expect(ids({ date: "older" })).toEqual(["b"]);
    expect(ids({ quality: "medium" })).toEqual(["a", "c"]);
    expect(ids({ quality: "high" })).toEqual(["a"]);
    expect(ids({ visibility: "private" })).toEqual(["b"]);
    expect(ids({ visibility: "shared" })).toEqual(["a", "c"]);
    expect(ids({ hideLinked: true })).toEqual(["a", "b"]);
  });
  it("counts live per option, each facet counted with every OTHER filter applied", () => {
    const f = { ...NO_FILTERS, quality: "medium" as const };
    expect(countBy(items, f, ctx, "kinds", (i) => [i.kind])).toEqual([
      { value: "claim", label: "claim", count: 1 }, { value: "source", label: "source", count: 1 },
    ]);
    // the facet's own selection does not zero its siblings
    const f2 = { ...NO_FILTERS, kinds: ["claim"] };
    expect(countBy(items, f2, ctx, "kinds", (i) => [i.kind]).map((o) => o.count)).toEqual([1, 2]);
  });
  it("sorts; the search's own order is Best match", () => {
    expect(sortItems(items, "match").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(sortItems(items, "title").map((i) => i.id)).toEqual(["b", "a", "c"]);
    expect(sortItems(items, "newest").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(sortItems(items, "cited").map((i) => i.id)).toEqual(["b", "a", "c"]);
  });
  it("names the filters the results cannot serve", () => {
    expect(missingFacets([{ kind: "source", id: "x", title: "t", snippet: "", state: null, lifecycle: null, type: null }])).toEqual(["topic", "date", "quality"]);
    expect(missingFacets(items)).toEqual([]);
  });
  it("turns the route's markers into text parts, never HTML", () => {
    expect(snippetParts("a <<HL>>b<</HL>> <img src=x onerror=1> c")).toEqual([
      { text: "a ", hl: false }, { text: "b", hl: true }, { text: " <img src=x onerror=1> c", hl: false },
    ]);
  });
});

describe("the shared search (the one the Ctrl+K overlay is built on)", () => {
  it("is ONE request to the contract search route, all kinds, through the door", async () => {
    const seen = libFetcher();
    const r = await searchLibrary({ q: " vrm ", scope: { kind: "library" } });
    expect(r.map(keyOf)).toEqual(["source:s1", "source:s2", "claim:c1", "page:p1", "source:s3"]);
    expect(seen).toEqual(["/workbench/contract/search?q=vrm&limit=50"]);
    expect(searchUrl({ q: "vrm", scope: { kind: "document", label: "d", topics: ["t"], refineryId: "r-1" } })).toBe("/workbench/contract/search?q=vrm&limit=50&refinery_id=r-1");
  });
  it("a smaller limit (Home's ask box asks for 10) is clamped to 1..the route's ceiling", () => {
    const u = (limit?: number) => searchUrl({ q: "vrm", scope: { kind: "library" }, limit });
    expect([u(10), u(), u(0), u(500), u(Number.NaN)]).toEqual(["10", "50", "1", "50", "50"].map((l) => `/workbench/contract/search?q=vrm&limit=${l}`));
  });
  it("marks a held source private", async () => {
    libFetcher();
    const r = await searchLibrary({ q: "vrm", scope: { kind: "library" } });
    expect(r.find((i) => i.id === "s3")?.private).toBe(true);
    expect(r.find((i) => i.id === "s1")?.private).toBe(false);
  });
});

describe("the picker", () => {
  it("asks nothing until two letters; then one request; filters add none and return a subset of the search's own answer", async () => {
    libFetcher();
    render(<ItemPicker {...props} />);
    expect(requestLog()).toEqual([]);
    type("v");
    expect(screen.getByTestId("picker-count").textContent).toMatch(/at least two/);
    expect(requestLog()).toEqual([]);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    expect(requestLog().map((r) => r.url)).toEqual(["/workbench/contract/search?q=vrm&limit=50"]);
    const direct = (await searchLibrary({ q: "vrm", scope: { kind: "library" } })).map(keyOf);
    expect(keys()).toEqual(direct); // no filter: identical to the search, in its order
    clearRequestLog();
    fireEvent.click(screen.getByRole("button", { name: /^claim/ }));
    expect(keys()).toEqual(["claim:c1"]);
    expect(keys().every((k) => direct.includes(k!))).toBe(true);
    expect(requestLog()).toEqual([]);
  });
  it("shows live counts per option and says which filters the search does not serve yet", async () => {
    libFetcher();
    render(<ItemPicker {...props} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    const kind = within(screen.getByRole("group", { name: "Kind" }));
    expect(kind.getByRole("button", { name: /^source/ }).textContent).toMatch(/3$/);
    expect(screen.getByTestId("picker-missing").textContent).toBe("Filters by topic, date, quality appear when the search returns them.");
    expect(screen.queryByRole("group", { name: "Topics (any of)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Newest" }).hasAttribute("disabled")).toBe(true);
  });
  it("renders optional fields and their filters when the search returns them", async () => {
    libFetcher([
      hit("source", "r1", "Rich", { topics: ["Cooling"], date: "2026-11-15", quality: "High", cited_by: 4, author: "Gamers Nexus" }),
      hit("source", "r2", "Plain", { topics: ["Firmware"], date: "2024-01-01", quality: "Low", cited_by: 0 }),
    ]);
    render(<ItemPicker {...props} now={Date.parse("2026-11-20")} />);
    type("ri");
    await waitFor(() => expect(keys().length).toBe(2));
    expect(screen.queryByTestId("picker-missing")).toBeNull();
    expect(row("source:r1").textContent).toMatch(/Gamers Nexus/);
    expect(row("source:r1").textContent).toMatch(/in 4 of your documents/);
    fireEvent.click(screen.getByRole("button", { name: /^Firmware/ }));
    expect(keys()).toEqual(["source:r2"]);
    fireEvent.click(screen.getByRole("button", { name: /Clear all filters/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Last 30 days/ }));
    expect(keys()).toEqual(["source:r1"]);
    fireEvent.click(screen.getByRole("button", { name: "Most cited" }));
    fireEvent.click(screen.getByRole("button", { name: /Clear all filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Most cited" }));
    expect(keys()).toEqual(["source:r1", "source:r2"]);
  });
  it("the selected tray survives changes to the filters and to the search", async () => {
    libFetcher();
    const changes: string[][] = [];
    render(<ItemPicker {...props} onChange={(s) => changes.push(s.map(keyOf))} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    fireEvent.click(row("source:s1"));
    fireEvent.click(row("claim:c1"));
    fireEvent.click(screen.getByRole("button", { name: /^topic page/ })); // a filter that hides both
    expect(keys()).toEqual(["page:p1"]);
    expect(screen.getByTestId("picker-nsel").textContent).toBe("Selected (2)");
    expect([...document.querySelectorAll("[data-testid=picker-tray] li")].map((e) => e.getAttribute("data-key"))).toEqual(["source:s1", "claim:c1"]);
    libFetcher([hit("source", "zz", "unrelated")]);
    type("another");
    await waitFor(() => expect(keys()).toEqual([]));
    expect(screen.getByTestId("picker-nsel").textContent).toBe("Selected (2)");
    fireEvent.click(screen.getByRole("button", { name: "Remove X299 VRM thermals" }));
    expect(screen.getByTestId("picker-nsel").textContent).toBe("Selected (1)");
    expect(changes.at(-1)).toEqual(["claim:c1"]);
  });
  it("single mode holds one: picking another replaces it", async () => {
    libFetcher();
    const done: string[][] = [];
    render(<ItemPicker {...props} mode="single" onConfirm={(s) => done.push(s.map(keyOf))} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    fireEvent.click(row("source:s1"));
    fireEvent.click(row("source:s2"));
    expect(screen.getByTestId("picker-nsel").textContent).toBe("Selected (1)");
    fireEvent.click(screen.getByTestId("picker-ok"));
    expect(done).toEqual([["source:s2"]]);
  });
  it("hide-already-linked marks, then hides", async () => {
    libFetcher();
    render(<ItemPicker {...props} alreadyLinked={new Set(["source:s1"])} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    expect(row("source:s1").textContent).toMatch(/already linked/);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(keys()).not.toContain("source:s1");
  });
  it("is fully keyboard-usable: arrows move, Enter picks, Ctrl+Enter confirms, Esc cancels", async () => {
    libFetcher();
    const done: string[][] = [];
    let cancelled = 0;
    render(<ItemPicker {...props} onConfirm={(s) => done.push(s.map(keyOf))} onCancel={() => cancelled++} />);
    const q = screen.getByTestId("picker-q");
    expect(document.activeElement).toBe(q);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    expect(q.getAttribute("role")).toBe("combobox");
    fireEvent.keyDown(q, { key: "ArrowDown" });
    fireEvent.keyDown(q, { key: "ArrowDown" });
    expect(q.getAttribute("aria-activedescendant")).toBe(document.querySelectorAll("[role=option]")[2].id);
    fireEvent.keyDown(q, { key: "Enter" }); // claim:c1
    fireEvent.keyDown(q, { key: "ArrowUp" });
    fireEvent.keyDown(q, { key: "Enter" }); // source:s2
    expect(document.querySelectorAll("[role=option][aria-selected=true]").length).toBe(2);
    fireEvent.keyDown(q, { key: "Enter", ctrlKey: true });
    expect(done.length).toBe(1);
    expect([...done[0]].sort()).toEqual(["claim:c1", "source:s2"]);
    fireEvent.keyDown(q, { key: "Escape" });
    expect(cancelled).toBe(1);
  });
  it("a document scope narrows only where topics come back; otherwise it says it shows the library", async () => {
    libFetcher();
    render(<ItemPicker {...props} scope={{ kind: "document", label: "My doc", topics: ["Cooling"] }} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    expect(screen.getByTestId("picker-scope-note").textContent).toMatch(/whole library/);
  });
  it("quick scope chips switch the scope", async () => {
    const seen = libFetcher();
    render(<ItemPicker {...props} scopes={[{ kind: "library" }, { kind: "document", label: "My doc", topics: [], refineryId: "r-9" }]} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    fireEvent.click(screen.getByRole("button", { name: "From My doc" }));
    await waitFor(() => expect(seen).toContain("/workbench/contract/search?q=vrm&limit=50&refinery_id=r-9"));
  });
  it("library+mine without the own-thoughts search says so and still shows the library", async () => {
    libFetcher();
    render(<ItemPicker {...props} scope={{ kind: "library+mine" }} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    expect(screen.getByTestId("picker-mine-note")).toBeTruthy();
  });
  it("a failed search shows an alert, not a crash", async () => {
    setFetcher(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    render(<ItemPicker {...props} />);
    type("vrm");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/boom/));
  });
});

describe("the contract's new hit fields light the filters and sorts up (no picker change)", () => {
  const NOW = Date.parse("2026-11-20");
  const rich = [
    hit("source", "r1", "Rich vrm one", { topics: ["cooling", "vrm"], date: "2026-11-15T10:00:00.000Z", quality: 0.8, cited_by: 3, author: "Ada Lovelace" }),
    hit("source", "r2", "Plain vrm two", { topics: ["firmware"], date: "2024-01-01T00:00:00.000Z", quality: 0.3, cited_by: 0, author: null }),
    hit("claim", "r3", "Mid vrm claim", { topics: ["cooling"], date: "2026-06-01T00:00:00.000Z", quality: 0.6, cited_by: null, author: null }),
    hit("page", "r4", "Bare vrm page", { topics: [], date: null, quality: null, cited_by: null, author: null }),
  ];
  it("topic, when and quality groups appear, the missing-filters note does not, and each filter and sort works", async () => {
    libFetcher(rich);
    render(<ItemPicker {...props} now={NOW} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(4));
    expect(screen.queryByTestId("picker-missing")).toBeNull();
    for (const g of ["Topics (any of)", "When", "Quality"]) expect(screen.getByRole("group", { name: g })).toBeTruthy();
    expect(row("source:r1").textContent).toMatch(/Ada Lovelace/);
    expect(row("source:r1").textContent).toMatch(/High/);
    expect(row("source:r1").textContent).toMatch(/in 3 of your documents/);
    expect(row("source:r2").textContent).toMatch(/Low/);
    expect(row("claim:r3").textContent).toMatch(/Medium/);
    // topics (any of), with live counts
    const topics = within(screen.getByRole("group", { name: "Topics (any of)" }));
    expect(topics.getByRole("button", { name: /^cooling/ }).textContent).toMatch(/2$/);
    fireEvent.click(topics.getByRole("button", { name: /^firmware/ }));
    expect(keys()).toEqual(["source:r2"]);
    fireEvent.click(screen.getByRole("button", { name: /Clear all filters/ }));
    // date
    fireEvent.click(screen.getByRole("button", { name: /^Last 30 days/ }));
    expect(keys()).toEqual(["source:r1"]);
    fireEvent.click(screen.getByRole("button", { name: /Clear all filters/ }));
    // quality bands from the 0..1 number: 0.8 High, 0.6 Medium, 0.3 Low
    fireEvent.click(screen.getByRole("button", { name: /^Medium or better/ }));
    expect(keys()).toEqual(["source:r1", "claim:r3"]);
    fireEvent.click(screen.getByRole("button", { name: /^High only/ }));
    expect(keys()).toEqual(["source:r1"]);
    fireEvent.click(screen.getByRole("button", { name: /Clear all filters/ }));
    // sorts
    expect(screen.getByRole("button", { name: "Newest" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Newest" }));
    expect(keys()).toEqual(["source:r1", "claim:r3", "source:r2", "page:r4"]);
    fireEvent.click(screen.getByRole("button", { name: "Most cited" }));
    expect(keys()).toEqual(["source:r1", "source:r2", "claim:r3", "page:r4"]);
  });
  it("a document scope narrows by the returned topics (case-insensitive)", async () => {
    libFetcher(rich);
    render(<ItemPicker {...props} scope={{ kind: "document", label: "My doc", topics: ["Cooling"] }} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(3));
    expect(keys()).toEqual(["source:r1", "claim:r3", "page:r4"]); // r2 (firmware) out; r4 has no topics: kept (degrades)
    expect(screen.getByTestId("picker-scope-note").textContent).not.toMatch(/whole library/);
  });
});

describe("the browser keeps nothing of a search answer (round 3)", () => {
  it("every read through the door, and the picker's search, asks for cache: no-store", async () => {
    const inits: (RequestInit | undefined)[] = [];
    setFetcher(async (_u, i) => { inits.push(i); return new Response(JSON.stringify({ results: [] }), { status: 200 }); });
    await searchLibrary({ q: "vrm", scope: { kind: "library" } });
    await api("GET", "/workbench/x");
    await raw("/workbench/y");
    expect(inits.map((i) => i?.cache)).toEqual(["no-store", "no-store", "no-store"]);
  });
  it("a LIBRARY-level cache leaks across identities: B must not get A's held source (fails if search.ts keeps answers)", async () => {
    const held = hit("source", "held-A", "HELD-A idea note", { lifecycle: "held", state: "held" });
    const scope = { kind: "document" as const, label: "d", topics: [], refineryId: "refinery-a" };
    // identity A: the library answers with A's own held source for A's refinery id
    setFetcher(async () => new Response(JSON.stringify({ results: [hit("source", "s1", "shared vrm"), held] }), { status: 200 }));
    const a = render(<ItemPicker {...props} scope={scope} />);
    type("vrm");
    await waitFor(() => expect(keys()).toContain("source:held-A"));
    a.unmount();
    cleanup();
    // identity B: the SAME url, the library answers with the shared rows only (another user's refinery scopes nothing)
    setFetcher(async () => new Response(JSON.stringify({ results: [hit("source", "s1", "shared vrm")] }), { status: 200 }));
    const b = render(<ItemPicker {...props} scope={scope} />);
    type("vrm");
    await waitFor(() => expect(keys()).toContain("source:s1"));
    expect(keys()).not.toContain("source:held-A");
    expect(b.container.textContent).not.toMatch(/HELD-A/);
  });
});

describe("keyboard focus after removing a tray item (round 3)", () => {
  const pickTwo = async () => {
    libFetcher();
    render(<ItemPicker {...props} />);
    type("vrm");
    await waitFor(() => expect(keys().length).toBe(5));
    fireEvent.click(row("source:s1"));
    fireEvent.click(row("source:s2"));
    fireEvent.click(row("claim:c1"));
  };
  const removeBtns = () => [...document.querySelectorAll("[data-testid=picker-tray] button")] as HTMLElement[];
  it("removing a tray item moves focus to the next tray item, then the previous, then the tray heading", async () => {
    await pickTwo();
    removeBtns()[0].focus();
    fireEvent.click(removeBtns()[0]); // remove s1 -> focus the item now first (s2)
    await waitFor(() => expect(document.activeElement).toBe(removeBtns()[0]));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove Board vendor power stage");
    removeBtns()[1].focus();
    fireEvent.click(removeBtns()[1]); // remove the LAST (c1) -> focus the previous item
    await waitFor(() => expect(document.activeElement).toBe(removeBtns()[0]));
    fireEvent.click(removeBtns()[0]); // remove the only one -> the tray heading
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("picker-nsel")));
    expect(document.activeElement).not.toBe(document.body);
  });
  it("Clear all moves focus to the tray heading too", async () => {
    await pickTwo();
    const clear = screen.getByRole("button", { name: "Clear" });
    clear.focus();
    fireEvent.click(clear);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("picker-nsel")));
  });
});

describe("two identities (privacy)", () => {
  const th = (id: string, title: string) => ({ kind: "thought", id, title, snippet: "", state: "current", lifecycle: null, type: null }) as PickerItem;
  const mineFor = (rows: PickerItem[]): MineSearch => async () => rows;
  const A = [th("ta1", "A-SECRET-PLAN alpha")];
  const B = [th("tb1", "B-OWN note bravo")];

  it("B is never offered, counted or able to infer A's private items; each sees their own, marked private", async () => {
    libFetcher();
    const a = render(<ItemPicker {...props} scope={{ kind: "library+mine" }} mineSearch={mineFor(A)} />);
    type("plan");
    await waitFor(() => expect(keys()).toContain("thought:ta1"));
    expect(row("thought:ta1").querySelector("[data-testid=private-tag]")?.textContent).toBe("private");
    fireEvent.click(row("thought:ta1")); // A holds one in the tray, then leaves
    a.unmount();
    cleanup();

    libFetcher();
    clearRequestLog();
    const b = render(<ItemPicker {...props} scope={{ kind: "library+mine" }} mineSearch={mineFor(B)} />);
    type("plan");
    await waitFor(() => expect(keys()).toContain("thought:tb1"));
    expect(b.container.textContent).not.toMatch(/A-SECRET/);
    expect(keys()).not.toContain("thought:ta1");
    expect(screen.getByTestId("picker-nsel").textContent).toBe("Selected (0)");
    // counts hold only B's own (1) and the library's held source (1), never A's
    const vis = within(screen.getByRole("group", { name: "Who can see it" }));
    expect(vis.getByRole("button", { name: /Private to me/ }).textContent).toMatch(/2$/);
    expect(vis.getByRole("button", { name: /Everything I can see/ }).textContent).toMatch(/6$/);
    expect(JSON.stringify(requestLog())).not.toMatch(/A-SECRET|ta1/);
  });

  it("an item the own-thoughts search returns is private even if the row says otherwise", async () => {
    libFetcher();
    render(<ItemPicker {...props} scope={{ kind: "library+mine" }} mineSearch={mineFor([{ ...th("tx", "mine x"), private: false }])} />);
    type("mine");
    await waitFor(() => expect(keys()).toContain("thought:tx"));
    expect(row("thought:tx").querySelector("[data-testid=private-tag]")).toBeTruthy();
  });

  it("writes nothing private anywhere: no browser storage, no cookie, no URL change", async () => {
    libFetcher();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookieSet = vi.fn();
    Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: cookieSet });
    const href = window.location.href;
    render(<ItemPicker {...props} scope={{ kind: "library+mine" }} mineSearch={mineFor(A)} />);
    type("plan");
    await waitFor(() => expect(keys()).toContain("thought:ta1"));
    fireEvent.click(row("thought:ta1"));
    fireEvent.click(screen.getByRole("button", { name: /Private to me/ }));
    expect(setItem).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });
});

// rwr-picker attempt 4 (the tester's probe, made permanent): EVERY view the picker exports marks a private result.
describe("the private marker on every view the picker exports", () => {
  const HELD = [hit("source", "s3", "HELD-A note", { lifecycle: "held", state: "held" }), hit("source", "s1", "Shared note")];
  const DOC = { kind: "document" as const, label: "My doc", topics: [], refineryId: "r-9" };
  const marker = (li: Element | null) => li?.querySelector("[data-testid=private-tag]")?.textContent ?? null;
  it("ItemPicker: the held source's row says private, the shared one does not", async () => {
    libFetcher(HELD);
    render(<ItemPicker {...props} scope={DOC} />);
    type("note");
    await waitFor(() => expect(keys()).toEqual(["source:s3", "source:s1"]));
    expect([marker(row("source:s3")), marker(row("source:s1"))]).toEqual(["private", null]);
  });
  it("PickerResults (document scope with a refinery id): the held source's row says private, the shared one does not", async () => {
    const seen = libFetcher(HELD);
    render(<PickerResults query="note" scope={DOC} label="r" open={(_i, c) => <a href="/x">{c}</a>} />);
    await waitFor(() => expect(screen.getByText("HELD-A note")).toBeTruthy());
    expect(seen).toEqual(["/workbench/contract/search?q=note&limit=50&refinery_id=r-9"]);
    expect([marker(screen.getByText("HELD-A note").closest("li")), marker(screen.getByText("Shared note").closest("li"))]).toEqual(["private", null]);
  });
});

// rwr-picker-r2 F1: a 200 that is not the expected JSON (an expired sign-in page, a proxy page, a wrong shape) is a
// FAILED search in every view, never an empty result. F2: the private marker is the picker's, beside what a screen renders.
describe("a failed search never looks like an empty result (r2 F1)", () => {
  const signIn = () => setFetcher(async () => new Response("<html>please sign in</html>", { status: 200 }));
  it("searchLibrary throws when the answer has no results array", async () => {
    signIn();
    await expect(searchLibrary({ q: "vrm", scope: { kind: "library" } })).rejects.toThrow(/results/);
    setFetcher(async () => new Response(JSON.stringify({ results: "nope" }), { status: 200 }));
    await expect(searchLibrary({ q: "vrm", scope: { kind: "library" } })).rejects.toThrow(/results/);
    setFetcher(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    await expect(searchLibrary({ q: "vrm", scope: { kind: "library" } })).resolves.toEqual([]);
  });
  it("ItemPicker shows its error line, not 'Nothing matches'", async () => {
    signIn();
    render(<ItemPicker {...props} />);
    type("vrm");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/did not answer/));
    expect(screen.queryByTestId("picker-empty")).toBeNull();
  });
  it("PickerResults shows its failed line, not 'Nothing in the library matches'", async () => {
    signIn();
    render(<PickerResults query="vrm" label="r" testId="t" open={(_i, c) => <a href="/x">{c}</a>} />);
    await waitFor(() => expect(screen.getByTestId("t-failed")).toBeTruthy());
    expect(screen.queryByTestId("t-none")).toBeNull();
  });
});

describe("the private marker cannot be dropped by a consuming screen (r2 F2)", () => {
  it("a screen whose open() ignores the content it is handed still shows the marker on the private row only", async () => {
    libFetcher([hit("source", "s3", "HELD-A note", { lifecycle: "held", state: "held" }), hit("source", "s1", "Shared note")]);
    render(<PickerResults query="note" scope={{ kind: "document", label: "d", topics: [], refineryId: "r-9" }} label="r"
      open={(i) => <a href="/x">{i.title}</a>} />);
    await waitFor(() => expect(screen.getByText("HELD-A note")).toBeTruthy());
    const tag = (t: string) => screen.getByText(t).closest("li")?.querySelector("[data-testid=private-tag]")?.textContent ?? null;
    expect([tag("HELD-A note"), tag("Shared note")]).toEqual(["private", null]);
  });
});
