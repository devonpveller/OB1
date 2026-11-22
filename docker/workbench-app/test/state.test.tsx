// lib/state.ts: the account-kept UI state (rwr-ui-state-keys) against a fake of the workbench's settings routes:
// one store per identity (the server's seam), versioned PUT and versioned DELETE, a version that never goes back
// after a delete (the tombstone), the documents state / file routes. Round 2 adds the tester's adversarial cases
// (concurrent tabs, Unlock, ABA, the subject switch, 401/429, the app's mirror of the registry) and the shell wiring.
import { describe, it, expect, beforeEach } from "vitest";
import { render, renderHook, act, waitFor, cleanup, screen, fireEvent } from "@testing-library/react";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { App } from "../src/App";
import type { ShellData } from "../src/lib/shell-data";
import {
  UI_KEYS, RECENT_CAP, StaleVersion, loadUiState, saveLockedDocument, saveLastDocument, saveStartScreen, saveRecent,
  normalizeRecent, isLiveDocument, resolveDocument, useUiState, jsonbTextLength, docPathProblem, recentItemProblem,
  resetState, loadAccountState, getLockedDocument, getLastDocument, getStartScreen, getRecent, setLockedDocument,
  setLockedDocumentSaved, setRecentSaved, setStartScreenSaved, setLastDocumentSaved, stateEpoch, getAccountError, type RecentItem,
} from "../src/lib/state";

type Row = { value: unknown; version: number };
// the server, as the app sees it. The SUBJECT is the server's business (whichever identity the test says the
// browser is signed in as); no request carries an owner. Versions follow the database: a write must carry the
// current version, a DELETE is versioned and counts as a new version, and a key's version never goes back.
function fakeServer() {
  const stores = new Map<string, Map<string, Row>>(); // live rows
  const tombs = new Map<string, Map<string, number>>(); // version of a deleted key
  const docs = new Map<string, { listed: boolean; trashed: boolean; title?: string }>();
  let who = "alice";
  let down = 0;
  let docStatus = 0;
  const seen: { method: string; url: string; body?: unknown; who: string }[] = [];
  const mine = <T,>(m: Map<string, Map<string, T>>) => { if (!m.has(who)) m.set(who, new Map()); return m.get(who)!; };
  const current = (key: string) => mine(stores).get(key)?.version ?? mine(tombs).get(key) ?? 0;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, url, body, who });
    if (down) return json(down, { error: "down" });
    const u = new URL(url, "http://x");
    if (u.pathname === "/workbench/settings" && method === "GET") {
      const settings = Object.values(UI_KEYS).map((k) => ({ key: k, value: mine(stores).get(k)?.value ?? null, version: current(k) }));
      return json(200, { admin: false, settings });
    }
    const m = /^\/workbench\/settings\/(.+)$/.exec(u.pathname);
    if (m) {
      const key = decodeURIComponent(m[1]);
      if (method === "DELETE") {
        const v = u.searchParams.get("version");
        if (v !== null && Number(v) !== current(key)) return json(409, { error: `the setting changed since it was read (version ${current(key)}, not ${v})` });
        if (!mine(stores).has(key)) return json(200, { key, value: null, version: current(key) });
        const next = current(key) + 1;
        mine(stores).delete(key);
        mine(tombs).set(key, next);
        return json(200, { key, value: null, version: next });
      }
      if (method === "PUT") {
        // the real server: a document path that is not the caller's is refused 404 by the owner-scope gate
        if (typeof body.value === "string" && /^documents\//.test(body.value) && !body.value.startsWith(`documents/${who}/`)) return json(404, { error: "no such document" });
        const cur = current(key);
        if (body.version !== undefined && body.version !== cur) return json(409, { error: `the setting changed since it was read (version ${cur}, not ${body.version})` });
        mine(stores).set(key, { value: body.value, version: cur + 1 });
        mine(tombs).delete(key);
        return json(200, { key, value: body.value, version: cur + 1 });
      }
    }
    if (u.pathname === "/workbench/documents/state") {
      if (docStatus) return json(docStatus, { error: "x" });
      const d = docs.get(u.searchParams.get("path") ?? "");
      if (!d) return json(404, { error: "no such document" });
      return json(200, { listed: d.listed, trashed: d.trashed });
    }
    if (u.pathname === "/workbench/documents/file") {
      const d = docs.get(u.searchParams.get("path") ?? "");
      if (!d) return json(404, { error: "no such document" });
      return json(200, { content: `---\ntitle: ${JSON.stringify(d.title ?? "Untitled")}\n---\n\nprivate body` });
    }
    return json(404, { error: "no route" });
  };
  return {
    fetcher, seen, stores, tombs, docs, as: (s: string) => { who = s; }, down: (n: number) => { down = n; }, docStatus: (n: number) => { docStatus = n; },
    live: (path: string, title?: string) => docs.set(path, { listed: true, trashed: false, title }),
  };
}

let srv: ReturnType<typeof fakeServer>;
const A1 = "documents/alice/one.md", A2 = "documents/alice/two.md", A3 = "documents/alice/three.md";
beforeEach(() => {
  cleanup();
  clearRequestLog();
  resetState();
  window.localStorage.clear();
  window.sessionStorage.clear();
  srv = fakeServer();
  setFetcher(srv.fetcher);
});
const ready = (h: { result: { current: { loading: boolean } } }) => waitFor(() => expect(h.result.current.loading).toBe(false));

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
      [UI_KEYS.recent, { value: [{ kind: "document", id: "documents/a/a.md" }, { kind: "Bad", id: "b" }, { kind: "source", id: "c1", locked: true }, "x"], version: 2 }],
    ]));
    const s = await loadUiState();
    expect(s.startScreen).toEqual({ value: null, version: 3 });
    expect(s.recent.value).toEqual([{ kind: "document", id: "documents/a/a.md" }, { kind: "source", id: "c1", locked: true }]);
  });
  it("normalizeRecent caps the list", () => {
    const many = Array.from({ length: RECENT_CAP + 5 }, (_, i) => ({ kind: "source", id: `s${i}` }));
    expect(normalizeRecent(many)).toHaveLength(RECENT_CAP);
    expect(normalizeRecent("x")).toBeNull();
  });
});

describe("writing (versioned PUT and versioned DELETE; only /workbench/settings/<key>, never an owner)", () => {
  it("PUTs value + the version read; the answer's version comes back", async () => {
    expect(await saveLockedDocument(A1, 0)).toEqual({ value: A1, version: 1 });
    expect((await saveLockedDocument(A2, 1)).version).toBe(2);
    expect(srv.seen.filter((r) => r.method === "PUT").map((r) => r.body)).toEqual([{ value: A1, version: 0 }, { value: A2, version: 1 }]);
    expect(requestLog().every((r) => r.url.startsWith("/workbench/settings/ui.locked_document"))).toBe(true);
  });
  it("null is a DELETE that CARRIES the version (?version=N) and the version keeps counting", async () => {
    await saveStartScreen("library", 0);
    expect(await saveStartScreen(null, 1)).toEqual({ value: null, version: 2 });
    expect(srv.seen.at(-1)).toMatchObject({ method: "DELETE", url: `/workbench/settings/ui.start_screen?version=1` });
    expect((await loadUiState()).startScreen.version).toBe(2);
  });
  it("a stale version is refused as StaleVersion and changes nothing", async () => {
    await saveLastDocument(A1, 0);
    await expect(saveLastDocument(A2, 0)).rejects.toBeInstanceOf(StaleVersion);
    expect((await loadUiState()).lastDocument).toEqual({ value: A1, version: 1 });
  });
  it("F3: a stale tab's Unlock is refused and the newer lock another tab wrote stays", async () => {
    await saveLockedDocument(A1, 0); // v1
    await saveLockedDocument(A2, 1); // v2 (tab 2)
    await expect(saveLockedDocument(null, 1)).rejects.toBeInstanceOf(StaleVersion); // tab 1 still holds v1
    expect((await loadUiState()).lockedDocument).toEqual({ value: A2, version: 2 });
  });
  it("F3: ABA - after an Unlock and a new lock, a tab still holding the old version is refused", async () => {
    await saveLockedDocument(A1, 0); // v1
    const afterUnlock = await saveLockedDocument(null, 1); // v2 (deleted)
    expect(afterUnlock.version).toBe(2);
    await saveLockedDocument(A2, afterUnlock.version); // v3
    await expect(saveLockedDocument(A3, 1)).rejects.toBeInstanceOf(StaleVersion); // never saw A2
    expect((await loadUiState()).lockedDocument).toEqual({ value: A2, version: 3 });
  });
  it("a list of the cap is accepted, locked flags kept", async () => {
    const items: RecentItem[] = Array.from({ length: RECENT_CAP }, (_, i) => ({ kind: "source", id: `s${i}`, ...(i === 0 ? { locked: true } : {}) }));
    expect((await saveRecent(items, 0)).version).toBe(1);
    expect((await loadUiState()).recent.value).toEqual(items);
  });
});

describe("the app refuses what the registry refuses, before any request (F4, F6, F7)", () => {
  const refuses = (f: () => unknown) => { clearRequestLog(); expect(f).toThrow(RangeError); expect(requestLog()).toEqual([]); };
  it("values the registry refuses: bad screen, empty / control / over-long document paths, a text list, extra fields, kinds outside the set", () => {
    refuses(() => saveStartScreen("nowhere" as never, 0));
    refuses(() => saveLockedDocument("a\nb", 0));
    refuses(() => saveLockedDocument("", 0));
    refuses(() => saveLockedDocument("notes/a.md", 0)); // not a documents/ path
    refuses(() => saveLockedDocument("documents/a/../../etc/x.md", 0));
    refuses(() => saveRecent(Array.from({ length: RECENT_CAP + 1 }, (_, i) => ({ kind: "source", id: `s${i}` })), 0));
    refuses(() => saveRecent([{ kind: "source", id: "a", title: "private text" } as unknown as RecentItem], 0));
    refuses(() => saveRecent([{ kind: "Source", id: "a" } as never], 0));
    refuses(() => saveRecent([{ kind: "secret_diagnosis_is_cancer", id: "a" } as never], 0));
    refuses(() => saveRecent([{ kind: "source", id: "my doctor said the biopsy came back positive" }], 0)); // prose is not an id
  });
  it("F4: credential-shaped ids and paths are refused (sk-, ghp_, eyJ, xox, AKIA ...), like the string keys", () => {
    for (const id of ["sk-0123456789abcdef0123456789", "ghp_0123456789abcdef0123456789abcd", "eyJhbGciOiJIUzI1NiJ9", "xoxb-123-456", "AKIA0123456789ABCDEF", "a:sk-0123456789abcdef", "ya29.abc"]) {
      refuses(() => saveRecent([{ kind: "source", id }], 0));
    }
    refuses(() => saveLockedDocument("documents/alice/sk-0123456789abcdef0123456789.md", 0));
    expect(recentItemProblem({ kind: "source", id: "9b2f3c1e-1111-4222-8333-444455556666" })).toBeNull(); // a uuid is fine
  });
  it("F6: bidi, zero-width, dot segments, backslashes are refused in ids and paths", () => {
    for (const bad of ["a‮b", "a​b", "a⁦b", "a﻿b", "a\u0085b", "a\u0000b", "a\\b"]) {
      refuses(() => saveLockedDocument(`documents/alice/${bad}.md`, 0));
      refuses(() => saveRecent([{ kind: "document", id: `documents/alice/${bad}.md` }], 0));
    }
    refuses(() => saveRecent([{ kind: "source", id: "a..b" }], 0));
    expect(docPathProblem("documents/alice/a/../b.md")).toBeTruthy();
    expect(docPathProblem("documents/alice/my notes.md")).toBeNull(); // spaces are ordinary in a file name
  });
  it("F7: C1 controls (U+0085) are refused, and the largest list the per-item rules allow fits the database's 4096-character cap", () => {
    refuses(() => saveRecent([{ kind: "document", id: "documents/a/ab.md" }], 0));
    const biggest = Array.from({ length: RECENT_CAP }, (_, i) => ({ kind: "document" as const, id: "documents/x/" + String(i).padStart(2, "0") + "y".repeat(100) + ".md", locked: true }));
    expect(biggest.every((x) => recentItemProblem(x) === null)).toBe(true);
    expect(jsonbTextLength(biggest)).toBeLessThanOrEqual(4096);
    // the jsonb text format: ": " and ", ", object keys by length
    expect(jsonbTextLength([{ kind: "source", id: "a", locked: true }])).toBe('[{"id": "a", "kind": "source", "locked": true}]'.length);
    expect(jsonbTextLength("x".repeat(5000))).toBeGreaterThan(4096);
  });
});

describe("a document that is not live is 'no document locked', never an error", () => {
  it("404 and 410, listed:false and trashed:true are all 'not live'; a live one is live", async () => {
    expect(await isLiveDocument(A1)).toBe(false); // 404
    srv.docStatus(410);
    expect(await isLiveDocument(A1)).toBe(false);
    srv.docStatus(0);
    srv.docs.set(A1, { listed: false, trashed: false });
    expect(await isLiveDocument(A1)).toBe(false);
    srv.docs.set(A1, { listed: true, trashed: true });
    expect(await isLiveDocument(A1)).toBe(false);
    srv.live(A1);
    expect(await isLiveDocument(A1)).toBe(true);
  });
  it("F5: 401, 403, 429 and 5xx are NOT proof the document is gone: thrown, never 'no document locked'", async () => {
    srv.live(A1);
    for (const s of [401, 403, 408, 429, 500, 502, 503]) {
      srv.docStatus(s);
      await expect(isLiveDocument(A1), String(s)).rejects.toThrow();
    }
  });
  it("resolveDocument gives the shell's DocRef: id from the account, the title read from the document (never stored)", async () => {
    srv.live(A1, "My plan");
    expect(await resolveDocument(A1)).toEqual({ id: A1, title: "My plan" });
    srv.docs.set(A2, { listed: true, trashed: true });
    expect(await resolveDocument(A2)).toBeNull();
  });
});

describe("the shell seam: the page's copy follows the account", () => {
  it("lock, then 'another browser profile' (reset + load, same subject) shows it locked, with the title", async () => {
    srv.live(A1, "My plan");
    setLockedDocument({ id: A1, title: "My plan" });
    await waitFor(() => expect(srv.stores.get("alice")?.get(UI_KEYS.lockedDocument)?.value).toBe(A1));
    resetState(); // a fresh page: nothing local
    window.localStorage.clear();
    expect(getLockedDocument()).toBeNull();
    await loadAccountState();
    expect(getLockedDocument()).toEqual({ id: A1, title: "My plan" });
    expect(getAccountError()).toBeNull();
  });
  it("the start screen and the Recently viewed list follow the account too", async () => {
    expect(await setStartScreenSaved("ideas")).toBe(true);
    expect(await setRecentSaved([{ kind: "claim", id: "c-1", locked: true }])).toBe(true);
    resetState();
    await loadAccountState();
    expect([getStartScreen(), getRecent()]).toEqual(["ideas", [{ kind: "claim", id: "c-1", locked: true }]]);
  });
  it("two identities: B never sees A's lock, last document, start screen or list", async () => {
    srv.live(A1, "Alice private");
    await setLockedDocumentSaved({ id: A1, title: "Alice private" });
    await setLastDocumentSaved({ id: A2, title: "x" });
    await setStartScreenSaved("podcasts");
    await setRecentSaved([{ kind: "source", id: "s-1" }]);
    resetState(); // B signs in on this page: the page forgets A at once
    srv.as("bob");
    await loadAccountState();
    expect([getLockedDocument(), getLastDocument(), getStartScreen(), getRecent()]).toEqual([null, null, null, []]);
    const all = JSON.stringify(srv.seen.filter((r) => r.who === "bob").map((r) => [r.url, r.body]));
    expect(all).not.toMatch(/alice|owner|sub=/i);
  });
  it("F8: sequential and concurrent setter calls use the refreshed version (no self-refusal)", async () => {
    const r = await Promise.all([setRecentSaved([{ kind: "source", id: "x1" }]), setRecentSaved([{ kind: "source", id: "y1" }]), setRecentSaved([{ kind: "source", id: "z1" }])]);
    expect(r).toEqual([true, true, true]);
    expect(srv.stores.get("alice")?.get(UI_KEYS.recent)).toEqual({ value: [{ kind: "source", id: "z1" }], version: 3 });
    expect(await setStartScreenSaved("chat")).toBe(true);
    expect(await setStartScreenSaved("home")).toBe(true);
  });
  it("Unlock then Undo on one page works against the account (the DELETE and the re-lock carry the versions)", async () => {
    srv.live(A1, "Plan");
    await setLockedDocumentSaved({ id: A1, title: "Plan" }); // v1
    await setLockedDocumentSaved(null); // v2 deleted
    expect(await setLockedDocumentSaved({ id: A1, title: "Plan" })).toBe(true); // v3
    expect(srv.stores.get("alice")?.get(UI_KEYS.lockedDocument)).toEqual({ value: A1, version: 3 });
  });
  it("a stale tab: its write is refused (false), the page reloads to what the other browser wrote, and the lock is not erased", async () => {
    srv.live(A1, "One"); srv.live(A2, "Two");
    await setLockedDocumentSaved({ id: A1, title: "One" });
    await loadAccountState();
    // another browser locks A2 (v2)
    await saveLockedDocument(A2, 1);
    expect(await setLockedDocumentSaved(null)).toBe(false); // this tab's Unlock carries v1: refused
    expect(srv.stores.get("alice")?.get(UI_KEYS.lockedDocument)?.value).toBe(A2);
    expect(getLockedDocument()).toEqual({ id: A2, title: "Two" }); // reloaded
  });
  it("resetState clears ONLY the local copy: no request, nothing written to the account (not even null)", async () => {
    srv.live(A1, "Plan");
    await setLockedDocumentSaved({ id: A1, title: "Plan" });
    const before = srv.seen.length;
    resetState();
    expect(getLockedDocument()).toBeNull();
    expect(srv.seen.length).toBe(before);
    expect(srv.stores.get("alice")?.get(UI_KEYS.lockedDocument)?.value).toBe(A1);
  });
  it("a write queued by the previous person never runs after a reset; a read in flight cannot repopulate the page", async () => {
    srv.live(A1, "Plan");
    const slow = loadAccountState(); // alice's read in flight
    setLockedDocument({ id: A1, title: "Plan" }); // queued behind nothing, but...
    const e = stateEpoch();
    resetState();
    srv.as("bob");
    await slow;
    expect(stateEpoch()).toBe(e + 1);
    expect(getLockedDocument()).toBeNull();
    await Promise.resolve();
    expect(srv.stores.get("bob")?.size ?? 0).toBe(0);
  });
  it("an account that cannot be read keeps nothing invented and reports an error", async () => {
    srv.down(503);
    await loadAccountState();
    expect(getLockedDocument()).toBeNull();
    expect(getAccountError()).toBeTruthy();
  });
  it("keeps nothing in the browser: no localStorage, no sessionStorage", async () => {
    srv.live(A1, "Plan");
    await setLockedDocumentSaved({ id: A1, title: "Plan" });
    await setRecentSaved([{ kind: "document", id: A1 }]);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("useUiState", () => {
  it("reads at mount; setters answer true/false; a locked document that was trashed shows as none with no error", async () => {
    srv.stores.set("alice", new Map<string, Row>([[UI_KEYS.lockedDocument, { value: A1, version: 4 }]]));
    const h = renderHook(() => useUiState());
    await ready(h);
    expect(h.result.current.locked).toBeNull();
    expect(h.result.current.error).toBeNull();
    expect(h.result.current.versions[UI_KEYS.lockedDocument]).toBe(4);
    srv.live(A2, "Two");
    await act(async () => { expect(await h.result.current.setLockedDocument({ id: A2, title: "Two" })).toBe(true); });
    expect(h.result.current.locked).toEqual({ id: A2, title: "Two" });
  });
  it("F8: two quick setters from one hook (a double click) both land", async () => {
    const h = renderHook(() => useUiState());
    await ready(h);
    let r: boolean[] = [];
    await act(async () => { r = await Promise.all([h.result.current.setRecent([{ kind: "source", id: "x1" }]), h.result.current.setRecent([{ kind: "source", id: "y1" }])]); });
    expect(r).toEqual([true, true]);
  });
});

// ── the shell itself reads and writes the account (the item's consumer) ──
const ALICE = { subject: "alice", name: "Alice" }, BOB = { subject: "bob", name: "Bob" };
function shellWith(who: { current: { subject: string; name: string } }) {
  return async (): Promise<ShellData> => ({ loaded: true, who: who.current, defaultSubject: false, running: { n: 0, more: false }, failedJobs: { n: 0, more: false }, cleanup: { n: 0, more: false } });
}
describe("the shell wiring (rwr-shell-nav's App over this module)", () => {
  it("the shell reads the locked document from the account at start (another browser profile, same subject)", async () => {
    srv.live(A1, "Plan from the account");
    srv.stores.set("alice", new Map<string, Row>([[UI_KEYS.lockedDocument, { value: A1, version: 1 }]]));
    const who = { current: ALICE };
    render(<App load={shellWith(who)} />);
    await waitFor(() => expect(screen.getByTestId("lock-chip").textContent).toContain("Plan from the account"));
  });
  it("a locked document that is trashed shows as 'no document locked', not an error", async () => {
    srv.stores.set("alice", new Map<string, Row>([[UI_KEYS.lockedDocument, { value: A1, version: 1 }]])); // no such live document
    const who = { current: ALICE };
    render(<App load={shellWith(who)} />);
    await waitFor(() => expect(srv.seen.some((r) => r.url === "/workbench/settings")).toBe(true));
    await waitFor(() => expect(requestLog().some((r) => r.url.startsWith("/workbench/documents/state"))).toBe(true));
    expect(screen.queryByTestId("lock-chip")).toBeNull();
    expect(document.body.textContent).not.toMatch(/error|could not/i);
  });
  it("Unlock sends a versioned DELETE; Undo re-locks with the next version", async () => {
    srv.live(A1, "Plan");
    srv.stores.set("alice", new Map<string, Row>([[UI_KEYS.lockedDocument, { value: A1, version: 1 }]]));
    const who = { current: ALICE };
    render(<App load={shellWith(who)} />);
    await waitFor(() => expect(screen.getByTestId("lock-chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("lock-chip").querySelector("button")!);
    await waitFor(() => expect(srv.seen.some((r) => r.method === "DELETE" && r.url.endsWith("?version=1"))).toBe(true));
    await waitFor(() => expect(screen.getByTestId("toast-undo")).toBeTruthy());
    fireEvent.click(screen.getByTestId("toast-undo"));
    await waitFor(() => expect(srv.stores.get("alice")?.get(UI_KEYS.lockedDocument)).toEqual({ value: A1, version: 3 }));
  });
  it("an Unlock's Undo after the person on the page changed restores nothing and writes nothing", async () => {
    srv.live(A1, "Alice plan");
    srv.stores.set("alice", new Map<string, Row>([[UI_KEYS.lockedDocument, { value: A1, version: 1 }]]));
    const who = { current: ALICE };
    const { vi } = await import("vitest");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App load={shellWith(who)} />);
      await waitFor(() => expect(screen.getByTestId("lock-chip")).toBeTruthy());
      fireEvent.click(screen.getByTestId("lock-chip").querySelector("button")!);
      await waitFor(() => expect(screen.getByTestId("toast-undo")).toBeTruthy());
      fireEvent.mouseEnter(screen.getByTestId("toast")); // the pointer rests on the toast: it stays while the next refresh lands
      // bob signs in on this page: the next refresh of who-am-I says so
      who.current = BOB; srv.as("bob");
      await act(async () => { await vi.advanceTimersByTimeAsync(30500); });
      await waitFor(() => expect(screen.getByTestId("avatar").textContent).toBe("B"));
      const writes = srv.seen.length;
      fireEvent.click(screen.getByTestId("toast-undo"));
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(getLockedDocument()).toBeNull();
      expect(screen.queryByTestId("lock-chip")).toBeNull();
      expect(srv.seen.slice(writes).filter((r) => r.method !== "GET")).toEqual([]); // nothing written for bob
      expect(srv.stores.get("bob")?.size ?? 0).toBe(0);
      // and the switch itself wrote nothing to alice's account either
      expect(srv.seen.filter((r) => r.who === "bob" && r.method !== "GET")).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
