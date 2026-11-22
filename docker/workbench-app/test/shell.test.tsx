// The shell (rwr-shell-nav): menu, routes, counts, Ctrl+K, banner, slot, and the small components.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";
import { ROUTES, OVERVIEW_PATH, matchRoute, activeMenuPath } from "../src/routes";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { loadShellData, type ShellData } from "../src/lib/shell-data";
import { resetState, setLockedDocument, setLastDocument, getLockedDocument } from "../src/lib/state";
import { ForDocumentBar } from "../src/shell/ForDocumentBar";
import { TypedConfirm } from "../src/shell/TypedConfirm";
import { ToastProvider, useToast } from "../src/shell/Toast";

const NONE: ShellData = { loaded: true, who: null, defaultSubject: false };
const load = (d: Partial<ShellData> = {}) => async () => ({ ...NONE, ...d });

// A fixture back end: what the shell asks, answered from a fixed set.
type Fx = { me?: any; whoami?: any; sessions?: any[]; jobs?: any[]; sources?: { total: number }; candidates?: any[]; fail?: string[] };
function fixture(f: Fx) {
  const seen: string[] = [];
  setFetcher(async (u) => {
    seen.push(u);
    const path = u.split("?")[0];
    if (f.fail?.some((x) => path.endsWith(x))) return new Response("{}", { status: 500 });
    const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (path === "/workbench/workspace/whoami") return j(f.whoami ?? { subject_sub: "u-alice", actor_sub: "u-alice", name: "Alice Lab" });
    if (path === "/workbench/auth/me") return j(f.me ?? { mode: "forward-auth", kind: "user", subject_sub: "u-alice", name: "Alice Lab" });
    if (path === "/workbench/contract/sessions") return j({ sessions: f.sessions ?? [] });
    if (path === "/workbench/intake/jobs") return j({ jobs: f.jobs ?? [] });
    if (path === "/workbench/contract/cleanup/sources") return j({ sources: [], total: f.sources?.total ?? 0 });
    if (path === "/workbench/contract/cleanup/reopen-candidates") return j({ candidates: f.candidates ?? [] });
    return new Response("{}", { status: 404 });
  });
  return seen;
}

beforeEach(() => {
  cleanup();
  clearRequestLog();
  resetState();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
});

const MENU = ROUTES.filter((r) => r.inMenu);

describe("every menu entry opens its route (acceptance 1)", () => {
  it("lists Everywhere and Housekeeping in the planned order", () => {
    render(<App load={load()} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const labels = within(nav).getAllByRole("link").map((a) => a.textContent);
    expect(labels).toEqual(["Home", "Research", "Chat", "Documents", "Ideas", "Podcasts", "Library",
      "Imports", "Removals and trail", "Cleanup", "Settings", "What moved where"]);
    expect(MENU.filter((r) => r.group === "everywhere").map((r) => r.label)).toEqual(["Home", "Research", "Chat", "Documents", "Ideas", "Podcasts", "Library"]);
    expect(MENU.filter((r) => r.group === "housekeeping").map((r) => r.label)).toEqual(["Imports", "Removals and trail", "Cleanup", "Settings"]);
  });
  for (const r of MENU.filter((m) => m.path !== "/" && m.path !== "/settings")) { // Home and Settings are real screens now: home.test.tsx, settings.test.tsx
    it(`${r.label}: click opens ${r.path}, a heading and a plain "coming in phase ${r.phase}" state`, () => {
      render(<App load={load()} />);
      fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByText(r.label));
      expect(window.location.pathname).toBe(r.path);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(r.label);
      expect(screen.getByTestId("coming").textContent).toBe(`This screen is coming in phase ${r.phase}.`);
      expect(screen.getByTestId("main").textContent!.length).toBeGreaterThan(20);
      expect(document.title).toBe(`${r.label} - Research workbench`);
      expect(screen.getByRole("link", { name: r.label, current: "page" })).toBeTruthy();
    });
  }
  it("What moved where opens the Overview (static content, no placeholder)", () => {
    render(<App load={load()} />);
    fireEvent.click(screen.getByTestId("nav-overview"));
    expect(window.location.pathname).toBe(OVERVIEW_PATH);
    expect(screen.getByTestId("overview")).toBeTruthy();
    expect(screen.queryByTestId("placeholder")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What moved where");
    expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
  });
  it("deep links: /documents/x and /research/start show their phase; an unknown path says so, never blank", () => {
    window.history.pushState({}, "", "/documents/some-id");
    render(<App load={load()} />);
    expect(screen.getByTestId("coming").textContent).toMatch(/phase 1/);
    expect(screen.getByRole("link", { name: "Documents", current: "page" })).toBeTruthy();
    act(() => { window.history.pushState({}, "", "/research/start"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Start research");
    act(() => { window.history.pushState({}, "", "/nope/at/all"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(screen.getByTestId("not-found").textContent).toMatch(/nothing at/);
    expect(matchRoute("/nope")).toBeNull();
    expect(activeMenuPath("/research/start")).toBe("/research");
  });
  it("+ Start research opens its route from every screen", () => {
    render(<App load={load()} />);
    fireEvent.click(screen.getByTestId("start-research"));
    expect(window.location.pathname).toBe("/research/start");
  });
});

describe("the counts match the reads (acceptance 2)", () => {
  it("shows what the fixture holds: 2 running, 1 failed of 4 jobs, 3 sources + 1 candidate with evidence", async () => {
    const seen = fixture({
      sessions: [{ id: "a", mine: true }, { id: "b", mine: true }],
      jobs: [{ detail: { actions: ["retry"] } }, { detail: { actions: ["cancel"] } }, { detail: { actions: ["cancel"] } }, { detail: { actions: [] } }],
      sources: { total: 3 },
      candidates: [{ evidence: [{}] }, { evidence: [] }],
    });
    window.history.pushState({}, "", "/research"); // not Home: Home makes its own reads (home.test.tsx)
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-research").textContent).toBe("2 running"));
    expect(screen.getByTestId("count-imports").textContent).toBe("1 failed");
    expect(screen.getByTestId("count-cleanup").textContent).toBe("4 to review");
    // exactly these reads, GET only, all through the one door
    expect(seen.map((u) => u.split("?")[0]).sort()).toEqual([
      "/workbench/auth/me", "/workbench/contract/cleanup/reopen-candidates", "/workbench/contract/cleanup/sources",
      "/workbench/contract/sessions", "/workbench/intake/jobs", "/workbench/settings", "/workbench/workspace/whoami"]);
    expect(requestLog().every((r) => r.method === "GET" && r.url.startsWith("/workbench/"))).toBe(true);
  });
  it("zero is shown as zero; a read that fails shows no count (never an invented one)", async () => {
    fixture({ fail: ["/intake/jobs"] });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-research").textContent).toBe("0 running"));
    expect(screen.queryByTestId("count-imports")).toBeNull();
    expect(screen.getByTestId("count-cleanup").textContent).toBe("0 to review");
  });
  it("cleanup needs both of its reads", async () => {
    fixture({ sources: { total: 5 }, fail: ["/reopen-candidates"] });
    const d = await loadShellData();
    expect(d.cleanup).toBeUndefined();
  });
});

describe("Ctrl+K (acceptance 3)", () => {
  for (const r of [...MENU, { path: OVERVIEW_PATH, label: "overview" }]) {
    it(`opens and Esc closes an empty overlay over ${r.path}`, () => {
      window.history.pushState({}, "", r.path);
      render(<App load={load()} />);
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      const dlg = screen.getByRole("dialog", { name: "Search" });
      expect(dlg.getAttribute("aria-modal")).toBe("true");
      expect(within(dlg).queryAllByRole("listitem")).toHaveLength(0);
      fireEvent.keyDown(dlg, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  }
  it("the search box and Cmd+K open it too; Close and the backdrop close it; focus returns", () => {
    render(<App load={load()} />);
    const box = screen.getByTestId("search-box");
    box.focus();
    fireEvent.click(box);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("search-close"));
    fireEvent.click(screen.getByTestId("search-close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("search-overlay-back"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("Tab stays inside the open overlay", () => {
    render(<App load={load()} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const close = screen.getByTestId("search-close");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });
});

describe("keyboard (acceptance 4)", () => {
  it("every menu item and the top bar controls are plain links or buttons in the tab order", () => {
    render(<App load={load()} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const a of within(nav).getAllByRole("link")) {
      expect(a.getAttribute("href")).toMatch(/^\//);
      expect(a.getAttribute("tabindex")).toBeNull();
    }
    for (const id of ["search-box", "start-research", "theme"]) expect(screen.getByTestId(id).getAttribute("tabindex")).toBeNull();
  });
  it("a visible focus ring is defined for links, buttons and inputs (the browser suite checks it renders)", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/button:focus-visible, a:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--focus\)/);
    expect(css).not.toMatch(/outline:\s*none[^}]*\}\s*\.nav/);
  });
  it("the skip link moves focus to the screen", () => {
    render(<App load={load()} />);
    fireEvent.click(screen.getByText("Skip to the screen"));
    expect(document.activeElement).toBe(screen.getByTestId("main"));
  });
});

describe("the default-subject banner (acceptance 6)", () => {
  it("shows when the server reports the default identity", async () => {
    fixture({ me: { mode: "default", kind: "default", subject_sub: "operator", name: "operator" } });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("default-banner").textContent).toMatch(/Sign-in is not switched on/));
  });
  it("is hidden when signed in, and while nothing is known yet", async () => {
    fixture({});
    render(<App />);
    expect(screen.queryByTestId("default-banner")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
    expect(screen.queryByTestId("default-banner")).toBeNull();
  });
  it("is hidden when the identity read fails (it does not guess)", async () => {
    fixture({ fail: ["/auth/me"] });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
    expect(screen.queryByTestId("default-banner")).toBeNull();
  });
});

describe("own data only, nothing kept on a shared surface (acceptance 7)", () => {
  it("the avatar is the signed-in subject's: initials and name from whoami", async () => {
    fixture({ whoami: { subject_sub: "u-bob", name: "Bob Builder" } });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("avatar").textContent).toBe("BB"));
    expect(screen.getByTestId("avatar").getAttribute("aria-label")).toBe("Signed in as Bob Builder");
  });
  it("no avatar and no counts before the reads answer; a subject that cannot be read shows none", async () => {
    fixture({ fail: ["/workspace/whoami"] });
    render(<App />);
    expect(screen.queryByTestId("avatar")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("count-research")).toBeTruthy());
    expect(screen.queryByTestId("avatar")).toBeNull();
  });
  it("what was read and the documents shown are not written to storage, console or the page title", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    fixture({ whoami: { subject_sub: "u-alice", name: "Alice Secretname" }, sessions: [{ id: "s1", mine: true, title: "Private research Z" }] });
    setLockedDocument({ id: "d1", title: "Private Locked Title" });
    setLastDocument({ id: "d2", title: "Private Last Title" });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
    fireEvent.click(screen.getByTestId("lock-unlock"));
    const stored = JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }, document.title, document.cookie]);
    for (const secret of ["Alice", "Secretname", "u-alice", "Private"]) expect(stored).not.toContain(secret);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
  it("every read asks the browser not to cache (cache: no-store)", async () => {
    const inits: (RequestInit | undefined)[] = [];
    setFetcher(async (_u, i) => { inits.push(i); return new Response("{}"); });
    await loadShellData();
    expect(inits.length).toBe(6);
    expect(inits.every((i) => i?.cache === "no-store" && i?.credentials === "same-origin" && i?.method === "GET")).toBe(true);
  });
  it("the shell sends no user name, id or document of its own in any request", async () => {
    fixture({});
    setLockedDocument({ id: "d1", title: "Mine" });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
    for (const r of requestLog()) expect(r.url).not.toMatch(/alice|Mine|d1|subject|user/i);
  });
});

describe("the Last / Locked document slot", () => {
  it("empty: says no document opened yet", () => {
    render(<App load={load()} />);
    expect(screen.getByTestId("doc-slot-title").textContent).toBe("Last document");
    expect(screen.getByTestId("doc-slot-empty")).toBeTruthy();
    expect(screen.queryByTestId("lock-chip")).toBeNull();
  });
  it("a last document is a link to it", () => {
    setLastDocument({ id: "a b", title: "Upgrading the workstation CPU" });
    render(<App load={load()} />);
    const l = screen.getByTestId("doc-slot");
    expect(l.textContent).toBe("Upgrading the workstation CPU");
    expect(l.getAttribute("href")).toBe("/documents/a%20b");
    fireEvent.click(l);
    expect(window.location.pathname).toBe("/documents/a%20b");
  });
  it("a locked document shows the amber chip in the top bar and the Locked slot; Unlock offers Undo", () => {
    setLastDocument({ id: "x", title: "Other" });
    setLockedDocument({ id: "d1", title: "Locked one" });
    render(<App load={load()} />);
    expect(screen.getByTestId("doc-slot-title").textContent).toBe("Locked document");
    expect(screen.getByTestId("doc-slot").textContent).toBe("Locked one");
    expect(screen.getByTestId("lock-chip").textContent).toContain("Locked: Locked one");
    expect(screen.getByTestId("lock-swap").getAttribute("href")).toBe("/documents");
    fireEvent.click(screen.getByTestId("lock-unlock"));
    expect(getLockedDocument()).toBeNull();
    expect(screen.queryByTestId("lock-chip")).toBeNull();
    expect(screen.getByTestId("doc-slot").textContent).toBe("Other");
    fireEvent.click(screen.getByTestId("toast-undo"));
    expect(getLockedDocument()).toEqual({ id: "d1", title: "Locked one" });
    expect(screen.getByTestId("lock-chip")).toBeTruthy();
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});

describe("the For document bar", () => {
  it("names the document and has a way back", () => {
    render(<ForDocumentBar title="My plan" backTo="/documents/p1" />);
    expect(screen.getByTestId("for-document-title").textContent).toBe("My plan");
    expect(screen.getByText("For document")).toBeTruthy();
    const back = screen.getByTestId("for-document-back");
    expect(back.getAttribute("href")).toBe("/documents/p1");
    expect(screen.getByRole("region", { name: "Working for a document" })).toBeTruthy();
  });
  it("way back navigates in the app", () => {
    render(<ForDocumentBar title="T" backTo="/documents/p1" backLabel="Back to T" />);
    fireEvent.click(screen.getByText("Back to T"));
    expect(window.location.pathname).toBe("/documents/p1");
  });
});

describe("the typed-word confirm", () => {
  it("the button works only after the exact word is typed", () => {
    const ok = vi.fn(), cancel = vi.fn();
    render(<TypedConfirm word="DELETE" prompt="This cannot be undone." confirmLabel="Delete forever" onConfirm={ok} onCancel={cancel} />);
    const btn = screen.getByTestId("typed-ok") as HTMLButtonElement;
    const input = screen.getByLabelText(/Type DELETE to continue/);
    expect(btn.disabled).toBe(true);
    for (const wrong of ["", "delete", "DELET", "DELETE!", "xDELETE"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(btn.disabled, wrong).toBe(true);
      fireEvent.submit(screen.getByTestId("typed-confirm"));
    }
    expect(ok).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " DELETE " } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(ok).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("typed-cancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("the toast with Undo", () => {
  function Fire({ onUndo, ms }: { onUndo?: () => void; ms?: number }) {
    const t = useToast();
    return <button onClick={() => t({ message: "Moved to trash.", onUndo, ms })}>fire</button>;
  }
  it("announces politely, Undo runs once and dismisses", () => {
    const undo = vi.fn();
    render(<ToastProvider><Fire onUndo={undo} /></ToastProvider>);
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getByTestId("toasts").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("toast").textContent).toContain("Moved to trash.");
    fireEvent.click(screen.getByTestId("toast-undo"));
    fireEvent.click(screen.queryByTestId("toast-undo") ?? document.body);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("toast")).toBeNull();
  });
  it("goes away on its own after its time, unless held by hover or focus", () => {
    vi.useFakeTimers();
    try {
      render(<ToastProvider><Fire onUndo={() => {}} ms={1000} /></ToastProvider>);
      fireEvent.click(screen.getByText("fire"));
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.queryByTestId("toast")).not.toBeNull();
      fireEvent.mouseEnter(screen.getByTestId("toast"));
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.queryByTestId("toast")).not.toBeNull();
      fireEvent.mouseLeave(screen.getByTestId("toast"));
      act(() => { vi.advanceTimersByTime(1100); });
      expect(screen.queryByTestId("toast")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("without an Undo function there is no Undo button, only Dismiss", () => {
    render(<ToastProvider><Fire /></ToastProvider>);
    fireEvent.click(screen.getByText("fire"));
    expect(screen.queryByTestId("toast-undo")).toBeNull();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});

describe("the shell stays in its lane", () => {
  it("makes its reads only through lib/api.ts (no fetch, XHR or storage in src/shell or src/lib/shell-data.ts)", () => {
    for (const f of ["src/App.tsx", "src/lib/shell-data.ts", "src/lib/state.ts", "src/routes.ts", "src/shell/TopBar.tsx", "src/shell/Rail.tsx",
      "src/shell/Toast.tsx", "src/shell/SearchOverlay.tsx", "src/shell/Overview.tsx", "src/shell/Placeholder.tsx"]) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|console\./);
    }
  });
});
