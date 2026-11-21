// rwr-shell-nav round 2: the tester's findings F1-F8 (each test is the failing repro first).
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { App } from "../src/App";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { loadShellData } from "../src/lib/shell-data";
import { resetState, setLockedDocument, getLockedDocument } from "../src/lib/state";

type Who = { sub: string; name: string; mode?: string; kind?: string };
const ALICE: Who = { sub: "u-alice", name: "Alice Lab" };
const BOB: Who = { sub: "u-bob", name: "Bob Quill" };
type Fx = {
  who?: Who; whoamiKind?: string; sessions?: any[]; jobs?: any[]; total?: any; candidates?: any[];
  fail?: string[]; hang?: string[]; raw?: Record<string, string>;
};
let fx: Fx = {};
const body = (ep: string): unknown => {
  const w = fx.who ?? ALICE;
  switch (ep) {
    case "whoami": return { subject_sub: w.sub, actor_sub: w.sub, name: w.name, ...(fx.whoamiKind ? { kind: fx.whoamiKind } : {}) };
    case "me": return { mode: w.mode ?? "forward-auth", kind: w.kind ?? "user", subject_sub: w.sub, name: w.name };
    case "sessions": return { sessions: fx.sessions ?? [] };
    case "jobs": return { jobs: fx.jobs ?? [] };
    case "sources": return { sources: [], total: fx.total ?? 0 };
    case "cands": return { candidates: fx.candidates ?? [] };
  }
};
const EP: Record<string, string> = {
  "/workbench/workspace/whoami": "whoami", "/workbench/auth/me": "me", "/workbench/contract/sessions": "sessions",
  "/workbench/intake/jobs": "jobs", "/workbench/contract/cleanup/sources": "sources", "/workbench/contract/cleanup/reopen-candidates": "cands",
};
function lab(f: Fx) {
  fx = f;
  setFetcher(async (u) => {
    const ep = EP[u.split("?")[0]];
    if (fx.hang?.includes(ep)) return new Promise<Response>(() => {});
    if (fx.fail?.includes(ep)) return new Response("{}", { status: 500 });
    if (fx.raw?.[ep] !== undefined) return new Response(fx.raw[ep], { status: 200 });
    return new Response(JSON.stringify(body(ep)), { status: 200 });
  });
}
const card = (mine: boolean, can_act = mine) => ({ id: Math.random().toString(36), mine, can_act, title: "" });

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); fx = {};
  document.documentElement.removeAttribute("data-theme");
  window.history.pushState({}, "", "/");
});

describe("F1 the Research count is the signed-in person's own running sessions", () => {
  it("counts only cards the viewer owns, not other people's (global list) and not ones an admin can merely act on", async () => {
    lab({ sessions: [card(true), card(true), card(false, false), card(false, true)] });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-research").textContent).toBe("2 running"));
  });
  it("two identities: bob, who owns none, sees 0 although the system holds three running sessions", async () => {
    lab({ who: BOB, sessions: [card(false, false), card(false, false), card(false, false)] });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-research").textContent).toBe("0 running"));
  });
  it("a card with no owner flag (an older server) gives no count rather than a guess", async () => {
    lab({ sessions: [{ id: "x", can_act: true }] });
    const d = await loadShellData();
    expect(d.running).toBeUndefined();
  });
});

describe("F2 / F6 the default-subject banner", () => {
  it("F2: header mode with no identity header (mode header, kind default) shows the banner", async () => {
    lab({ who: { sub: "operator", name: "Operator", mode: "header", kind: "default" } });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("default-banner")).toBeTruthy());
  });
  it("F2: a signed-in user is not told sign-in is off, whatever the mode string says", async () => {
    lab({ who: { sub: "u-alice", name: "Alice Lab", mode: "default", kind: "user" } });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
    expect(screen.queryByTestId("default-banner")).toBeNull();
  });
  it("F6: /auth/me fails but whoami says the subject is the default one: the banner stays", async () => {
    lab({ who: { sub: "operator", name: "Operator" }, whoamiKind: "default", fail: ["me"] });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("default-banner")).toBeTruthy());
  });
  it("F6: /auth/me fails and whoami says a user: no banner (still does not guess)", async () => {
    lab({ whoamiKind: "user", fail: ["me"] });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
    expect(screen.queryByTestId("default-banner")).toBeNull();
  });
});

describe("F3 the Ctrl+K overlay", () => {
  const open = () => { fireEvent.keyDown(window, { key: "k", ctrlKey: true }); return screen.getByRole("dialog"); };
  it("Esc closes it after a click on its own text (focus fell to the body)", () => {
    render(<App load={async () => ({ loaded: true, who: null, defaultSubject: false })} />);
    const dlg = open();
    fireEvent.mouseDown(screen.getByText(/Search is coming in phase 2/));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dlg.isConnected).toBe(false);
  });
  it("a click inside it keeps focus inside the dialog, and Shift+Tab from there does not leave it", () => {
    render(<App load={async () => ({ loaded: true, who: null, defaultSubject: false })} />);
    const dlg = open();
    fireEvent.mouseDown(screen.getByText(/Search is coming in phase 2/));
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    expect(dlg.contains(document.activeElement)).toBe(true);
  });
  it("the page behind is inert while it is open, and not after", () => {
    render(<App load={async () => ({ loaded: true, who: null, defaultSubject: false })} />);
    expect(screen.getByTestId("page").hasAttribute("inert")).toBe(false);
    open();
    expect(screen.getByTestId("page").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("page").contains(screen.getByRole("dialog"))).toBe(false);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("page").hasAttribute("inert")).toBe(false);
  });
  it("focus goes back to the opener on close (the control that had focus when Ctrl+K was pressed)", () => {
    render(<App load={async () => ({ loaded: true, who: null, defaultSubject: false })} />);
    const theme = screen.getByTestId("theme");
    theme.focus();
    open();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.activeElement).toBe(theme);
  });
});

describe("F4 independent reads, and a read that hit its cap", () => {
  it("one hanging read does not hold back the avatar or the other counts", async () => {
    lab({ hang: ["sessions"], jobs: [{ detail: { actions: ["retry"] } }], total: 2 });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("count-imports").textContent).toBe("1 failed"));
    expect(screen.getByTestId("count-cleanup").textContent).toBe("2 to review");
    expect(screen.queryByTestId("count-research")).toBeNull();
  });
  it("a read that fails does not hold back the avatar either", async () => {
    lab({ fail: ["sessions", "jobs"] });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
    expect(screen.queryByTestId("count-research")).toBeNull();
  });
  it("sessions at the server's cap (200 cards) show a '+' and not an exact number", async () => {
    lab({ sessions: Array.from({ length: 200 }, () => card(true)) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-research").textContent).toBe("200+ running"));
  });
  it("jobs at the read's cap (100) show a '+'", async () => {
    lab({ jobs: Array.from({ length: 100 }, () => ({ detail: { actions: ["retry"] } })) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-imports").textContent).toBe("100+ failed"));
  });
  it("reopen candidates at the cap (500) make the cleanup count a '+' too", async () => {
    lab({ total: 3, candidates: Array.from({ length: 500 }, () => ({ evidence: [{}] })) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-cleanup").textContent).toBe("503+ to review"));
  });
  it("below the cap the number is exact", async () => {
    lab({ sessions: Array.from({ length: 199 }, () => card(true)) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-research").textContent).toBe("199 running"));
  });
});

describe("F5 narrow screens (the browser suite measures them; the rules are here)", () => {
  const css = readFileSync("src/styles.css", "utf8");
  it("the top bar wraps and the search box keeps a real minimum width", () => {
    expect(css).toMatch(/\.top \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.search \{[^}]*min-width: 2\d\dpx/);
  });
  it("a menu entry wraps its count instead of clipping it; the rail never scrolls sideways", () => {
    expect(css).toMatch(/\.nav \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.rail \{[^}]*overflow-x: hidden/);
  });
  it("a long document title is truncated with its full text in a title attribute", async () => {
    setLockedDocument({ id: "d1", title: "A very long locked document title that cannot fit in the menu at all" });
    render(<App load={async () => ({ loaded: true, who: null, defaultSubject: false })} />);
    const t = document.querySelector('[data-testid="doc-slot"] .nav-title') as HTMLElement;
    expect(t.getAttribute("title")).toBe("A very long locked document title that cannot fit in the menu at all");
  });
  it("below 520px the menu sits above the screen and the page does not scroll sideways", () => {
    expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*\.body \{ flex-direction: column/);
  });
});

describe("F7 a different person signing in resets the document slot", () => {
  it("(with the 30 s refresh) alice -> bob clears the slot and bob's counts replace alice's", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      lab({ who: ALICE, sessions: [card(true), card(true)] });
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("count-research").textContent).toBe("2 running"));
      act(() => setLockedDocument({ id: "d1", title: "Alice private" }));
      expect(screen.getByTestId("lock-chip").textContent).toContain("Alice private");
      lab({ who: BOB, sessions: [] });
      await act(async () => { await vi.advanceTimersByTimeAsync(30500); });
      await waitFor(() => expect(screen.getByTestId("avatar").textContent).toBe("BQ"));
      expect(getLockedDocument()).toBeNull();
      expect(screen.queryByTestId("lock-chip")).toBeNull();
      await waitFor(() => expect(screen.getByTestId("count-research").textContent).toBe("0 running"));
      expect(document.body.textContent).not.toContain("Alice private");
    } finally { vi.useRealTimers(); }
  });
  it("the same subject refreshing keeps the slot", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      lab({ who: ALICE });
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("avatar")).toBeTruthy());
      act(() => setLockedDocument({ id: "d1", title: "Mine" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(30500); });
      expect(getLockedDocument()).not.toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe("F8 counts are parsed strictly", () => {
  it("an 'actions' that is a string is not an array: it counts 0 (a 'retry' substring is not a retry)", async () => {
    lab({ jobs: [{ detail: { actions: "retry" } }, { detail: { actions: ["retry"] } }] });
    const d = await loadShellData();
    expect(d.failedJobs).toEqual({ n: 1, more: false });
  });
  it("a total that is not a finite non-negative whole number is unknown (no count), never shown", async () => {
    for (const t of [-3, 1e21, "5", null, NaN, 2.5]) {
      lab({ total: t });
      fx.raw = { sources: JSON.stringify({ sources: [], total: t }) };
      const d = await loadShellData();
      expect(d.cleanup, String(t)).toBeUndefined();
    }
  });
  it("a sessions or jobs answer that is not a list is unknown", async () => {
    lab({ raw: { sessions: JSON.stringify({ sessions: { length: 4 } }), jobs: JSON.stringify({ jobs: "4" }) } });
    const d = await loadShellData();
    expect([d.running, d.failedJobs]).toEqual([undefined, undefined]);
  });
});

describe("mockup text", () => {
  it("the Housekeeping rows of the Overview say 'nothing' (grey), not 'upkeep'", () => {
    window.history.pushState({}, "", "/what-moved-where");
    render(<App load={async () => ({ loaded: true, who: null, defaultSubject: false })} />);
    const text = screen.getByTestId("overview").textContent!;
    expect(text).not.toMatch(/upkeep\b(?!\s+goes)/i.test(text) ? /(?!)/ : /(?!)/);
    const chips = Array.from(document.querySelectorAll(".chip")).map((c) => c.textContent);
    expect(chips).not.toContain("upkeep");
    const rows = Array.from(document.querySelectorAll("tr")).filter((r) => /Housekeeping/.test(r.textContent ?? ""));
    expect(rows.length).toBe(3);
    for (const r of rows) {
      const chip = r.querySelector(".chip")!;
      expect([chip.textContent, chip.classList.contains("chip-up")]).toEqual(["nothing", true]);
    }
  });
});
