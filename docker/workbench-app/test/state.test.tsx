// lib/state.ts: the account-kept UI state (rwr-ui-state-keys) against a fake of the workbench's settings
// routes: one store per identity (the server's seam), versioned writes, the documents state route.
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import {
  UI_KEYS, RECENT_CAP, StaleVersion, loadUiState, saveLockedDocument, saveLastDocument, saveStartScreen, saveRecent,
  normalizeRecent, isLiveDocument, useUiState, type RecentItem,
} from "../src/lib/state";

type Row = { value: unknown; version: number };
// the server, as the app sees it: the SUBJECT is the server's business (here: whichever identity the test says
// the browser is signed in as); no request carries an owner.
function fakeServer() {
  const stores = new Map<string, Map<string, Row>>();
  const docs = new Map<string, { listed: boolean; trashed: boolean }>(); // by path, for every user (the fake owns them all)
  let who = "alice";
  let down = false;
  const seen: { method: string; url: string; body?: unknown; who: string }[] = [];
  const store = () => {
    if (!stores.has(who)) stores.set(who, new Map());
    return stores.get(who)!;
  };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, url, body, who });
    if (down) return json(503, { error: "down" });
    const u = new URL(url, "http://x");
    if (u.pathname === "/workbench/settings" && method === "GET") {
      const mine = store();
      const settings = Object.values(UI_KEYS).map((k) => ({ key: k, value: mine.get(k)?.value ?? null, version: mine.get(k)?.version ?? 0 }));
      return json(200, { admin: false, settings });
    }
    const m = /^\/workbench\/settings\/(.+)$/.exec(u.pathname);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const mine = store();
      if (method === "DELETE") {
        mine.delete(key);
        return json(200, { key, value: null, version: 0 });
      }
      if (method === "PUT") {
        const cur = mine.get(key)?.version ?? 0;
        if (body.version !== undefined && body.version !== cur) return json(409, { error: `the setting changed since it was read (version ${cur}, not ${body.version})` });
        mine.set(key, { value: body.value, version: cur + 1 });
        return json(200, { key, value: body.value, version: cur + 1 });
      }
    }
    if (u.pathname === "/workbench/documents/state") {
      const d = docs.get(u.searchParams.get("path") ?? "");
      if (!d) return json(404, { error: "no such document" });
      return json(200, { path: u.searchParams.get("path"), ...d });
    }
    return json(404, { error: "no route" });
  };
  return { fetcher, seen, stores, docs, as: (s: string) => { who = s; }, down: (b: boolean) => { down = b; } };
}

let srv: ReturnType<typeof fakeServer>;
beforeEach(() => {
  cleanup();
  clearRequestLog();
  window.localStorage.clear();
  window.sessionStorage.clear();
  srv = fakeServer();
  setFetcher(srv.fetcher);
});

describe("reading", () => {
  it("one GET of /workbench/settings yields the four keys, defaults when nothing is stored", async () => {
    const s = await loadUiState();
    expect(s.lockedDocument).toEqual({ value: null, version: 0 });
    expect(s.recent).toEqual({ value: null, version: 0 });
    expect(requestLog().map((r) => `${r.method} ${r.url}`)).toEqual(["GET /workbench/settings"]);
  });
  it("a start screen the app does not know is read as none; a malformed list keeps only its good items", async () => {
    srv.stores.set("alice", new Map<string, Row>([
      [UI_KEYS.startScreen, { value: "bogus", version: 3 }],
      [UI_KEYS.recent, { value: [{ kind: "document", id: "a" }, { kind: "Bad", id: "b" }, { kind: "source", id: "c", locked: true }, "x"], version: 2 }],
    ]));
    const s = await loadUiState();
    expect(s.startScreen).toEqual({ value: null, version: 3 });
    expect(s.recent.value).toEqual([{ kind: "document", id: "a" }, { kind: "source", id: "c", locked: true }]);
  });
  it("normalizeRecent caps the list", () => {
    const many = Array.from({ length: RECENT_CAP + 5 }, (_, i) => ({ kind: "document", id: `d${i}` }));
    expect(normalizeRecent(many)).toHaveLength(RECENT_CAP);
    expect(normalizeRecent("x")).toBeNull();
  });
});

describe("writing (versioned; only /workbench/settings/<key>, never an owner)", () => {
  it("PUTs value + the version read; the answer's version comes back", async () => {
    const v = await saveLockedDocument("documents/alice/a.md", 0);
    expect(v).toEqual({ value: "documents/alice/a.md", version: 1 });
    expect((await saveLockedDocument("documents/alice/b.md", 1)).version).toBe(2);
    expect(srv.seen.filter((r) => r.method === "PUT").map((r) => r.body)).toEqual([
      { value: "documents/alice/a.md", version: 0 }, { value: "documents/alice/b.md", version: 1 },
    ]);
    expect(requestLog().every((r) => r.url.startsWith("/workbench/settings/ui.locked_document"))).toBe(true);
  });
  it("null is a DELETE (nothing stored again)", async () => {
    await saveStartScreen("library", 0);
    expect(await saveStartScreen(null, 1)).toEqual({ value: null, version: 0 });
    expect(srv.seen.at(-1)?.method).toBe("DELETE");
  });
  it("a stale version is refused as StaleVersion and changes nothing", async () => {
    await saveLastDocument("documents/alice/a.md", 0);
    await expect(saveLastDocument("documents/alice/b.md", 0)).rejects.toBeInstanceOf(StaleVersion);
    expect((await loadUiState()).lastDocument).toEqual({ value: "documents/alice/a.md", version: 1 });
  });
  it("a value the registry would refuse fails before any request is made", () => {
    clearRequestLog();
    expect(() => saveStartScreen("nowhere" as never, 0)).toThrow(RangeError);
    expect(() => saveLockedDocument("a\nb", 0)).toThrow(RangeError);
    expect(() => saveLockedDocument("", 0)).toThrow(RangeError);
    expect(() => saveRecent(Array.from({ length: RECENT_CAP + 1 }, (_, i) => ({ kind: "document", id: `d${i}` })), 0)).toThrow(RangeError);
    // text does not ride in the list: an item with any other field is refused
    expect(() => saveRecent([{ kind: "document", id: "a", title: "private text" } as unknown as RecentItem], 0)).toThrow(RangeError);
    expect(() => saveRecent([{ kind: "Document", id: "a" }], 0)).toThrow(RangeError);
    expect(requestLog()).toEqual([]);
  });
  it("a list of the cap is accepted, locked flags kept", async () => {
    const items: RecentItem[] = Array.from({ length: RECENT_CAP }, (_, i) => ({ kind: "document", id: `d${i}`, ...(i === 0 ? { locked: true } : {}) }));
    expect((await saveRecent(items, 0)).version).toBe(1);
    expect((await loadUiState()).recent.value).toEqual(items);
  });
});

describe("two identities: each browser sees only its subject's state", () => {
  it("B never reads A's values; the answer for B is the answer for a user with nothing", async () => {
    srv.as("alice");
    await saveLockedDocument("documents/alice/secret-plan.md", 0);
    await saveLastDocument("documents/alice/other.md", 0);
    await saveStartScreen("podcasts", 0);
    await saveRecent([{ kind: "document", id: "documents/alice/secret-plan.md", locked: true }], 0);
    srv.as("bob");
    const b = await loadUiState();
    srv.as("nobody");
    expect(b).toEqual(await loadUiState());
    expect(b.lockedDocument.value).toBeNull();
    // every request of the app is subject-free: nothing in any URL or body names an owner
    const all = JSON.stringify(srv.seen.map((r) => [r.url, r.body]));
    expect(all).not.toMatch(/owner|sub=|bob/);
    // B's write does not touch A's
    srv.as("bob");
    await saveStartScreen("chat", 0);
    srv.as("alice");
    expect((await loadUiState()).startScreen.value).toBe("podcasts");
  });
});

describe("a document that is not live is 'no document locked', never an error", () => {
  const P = "documents/alice/a.md";
  it("404 (trashed or deleted or not mine), listed:false and trashed:true are all 'not live'; a live one is live", async () => {
    expect(await isLiveDocument(P)).toBe(false); // 404
    srv.docs.set(P, { listed: false, trashed: false });
    expect(await isLiveDocument(P)).toBe(false);
    srv.docs.set(P, { listed: true, trashed: true });
    expect(await isLiveDocument(P)).toBe(false);
    srv.docs.set(P, { listed: true, trashed: false });
    expect(await isLiveDocument(P)).toBe(true);
  });
  it("a server error is NOT read as 'gone' (it is thrown, so the caller keeps what it had)", async () => {
    srv.down(true);
    await expect(isLiveDocument(P)).rejects.toThrow();
  });
});

describe("useUiState", () => {
  const P = "documents/alice/a.md";
  it("lock, then 'another browser profile' (a fresh hook, same subject) still shows it locked", async () => {
    srv.docs.set(P, { listed: true, trashed: false });
    const first = renderHook(() => useUiState());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.locked).toBeNull();
    await act(async () => { expect(await first.result.current.setLockedDocument(P)).toBe(true); });
    expect(first.result.current.locked).toBe(P);
    first.unmount();
    window.localStorage.clear(); // a different browser profile has none of this one's storage
    const second = renderHook(() => useUiState());
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.locked).toBe(P);
    expect(second.result.current.state.lockedDocument.version).toBe(1);
  });
  it("the same account in another browser with a different subject sees nothing", async () => {
    srv.docs.set(P, { listed: true, trashed: false });
    const a = renderHook(() => useUiState());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await act(async () => { await a.result.current.setLockedDocument(P); await a.result.current.setStartScreen("ideas"); });
    srv.as("bob");
    const b = renderHook(() => useUiState());
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(b.result.current.locked).toBeNull();
    expect(b.result.current.state.startScreen.value).toBeNull();
  });
  it("a locked document that was trashed shows as no document locked, with no error", async () => {
    srv.stores.set("alice", new Map<string, Row>([[UI_KEYS.lockedDocument, { value: P, version: 4 }]]));
    const h = renderHook(() => useUiState());
    await waitFor(() => expect(h.result.current.loading).toBe(false));
    expect(h.result.current.locked).toBeNull();
    expect(h.result.current.error).toBeNull();
    expect(h.result.current.state.lockedDocument.value).toBe(P); // stored as it was; unlocking is the user's act
  });
  it("a write from a stale tab is refused: false, the state reloaded to what the other browser wrote", async () => {
    srv.docs.set(P, { listed: true, trashed: false });
    const tab = renderHook(() => useUiState());
    await waitFor(() => expect(tab.result.current.loading).toBe(false));
    // another browser writes first
    await saveStartScreen("research", 0);
    let ok = true;
    await act(async () => { ok = await tab.result.current.setStartScreen("library"); });
    expect(ok).toBe(false);
    expect(tab.result.current.state.startScreen).toEqual({ value: "research", version: 1 });
    // the stored value is the other browser's, unchanged by the refused write
    expect((await loadUiState()).startScreen.value).toBe("research");
    // deciding again with the reloaded version succeeds
    await act(async () => { ok = await tab.result.current.setStartScreen("library"); });
    expect(ok).toBe(true);
  });
  it("a server error on read is reported, not thrown, and nothing is invented", async () => {
    srv.down(true);
    const h = renderHook(() => useUiState());
    await waitFor(() => expect(h.result.current.loading).toBe(false));
    expect(h.result.current.error).toBeTruthy();
    expect(h.result.current.locked).toBeNull();
  });
  it("keeps nothing in the browser: no localStorage, no sessionStorage", async () => {
    srv.docs.set(P, { listed: true, trashed: false });
    const h = renderHook(() => useUiState());
    await waitFor(() => expect(h.result.current.loading).toBe(false));
    await act(async () => { await h.result.current.setLockedDocument(P); await h.result.current.setRecent([{ kind: "document", id: P }]); });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
