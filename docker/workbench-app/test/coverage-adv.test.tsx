// The Coverage tab of the document screen (rwr-doc-coverage), against the shared fakes: the documents back end
// (e2e/docs-fake.mjs) and the gaps back end (e2e/gaps-fake.mjs), the same two the e2e stub runs; the gaps fake copies the
// server's repo code (repo/gaps.ts) and the research-needs routes (repo/trust.ts). One describe per acceptance item of the anchor.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { App } from "../src/App";
import { DocumentScreen } from "../src/screens/documents/DocumentScreen";
import { ToastProvider } from "../src/shell/Toast";
import { parseRoute } from "../src/lib/router";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { createFake, PEOPLE, uid } from "../e2e/docs-fake.mjs";
import { createGapsFake } from "../e2e/gaps-fake.mjs";

configure({ asyncUtilTimeout: 5000 });
const NOW = Date.now();
const docs = createFake({ now: () => NOW });
const gaps = createGapsFake({ ownsDocument: (w, p) => docs.db().docs.get(p)?.owner === w.sub, isListed: (_w, p) => docs.db().docs.has(p), now: () => NOW });
let who: "alice" | "bob" = "alice";
let bodies: { method: string; url: string; body: any; who: string }[] = [];
let failGaps = false;
let override: null | ((m: string, u: string, b: any) => { status: number; body: any } | Promise<{ status: number; body: any } | null> | null) = null;
const CPU = "documents/k-a/Hardware/cpu.md";
const href = (p: string) => "/documents/d/" + uid(p);
const A = PEOPLE.alice, B = PEOPLE.bob;
const S1 = "5e550000-0000-4000-8000-000000000001";
const S2 = "5e550000-0000-4000-8000-000000000002";
const MARK = "PRIVATE-GAP-MARKER-7731";

function stub() {
  bodies = [];
  setFetcher(async (u, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push({ method, url: u, body, who });
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    const path = u.split("?")[0];
    const me = PEOPLE[who];
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: me.sub, actor_sub: me.sub, name: me.name });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth", kind: "user", subject_sub: me.sub });
    if (path === "/workbench/settings") return j({ settings: [] });
    if (failGaps && path === "/workbench/contract/gaps" && method === "GET") return j({ error: "internal" }, 500);
    if (override) { const o = await override(method, u, body); if (o) return j(o.body, o.status); }
    const g = gaps.handle(me, method, u, body ?? {});
    if (g) return j(g.body, g.status);
    const r = docs.handle(who, method, u, body ?? {});
    if (r) return j(r.body, r.status);
    if (path === "/workbench/contract/sessions") return j({ sessions: [] });
    if (path === "/workbench/intake/jobs") return j({ jobs: [] });
    if (path === "/workbench/contract/cleanup/sources") return j({ sources: [], total: 0 });
    if (path === "/workbench/contract/cleanup/reopen-candidates") return j({ candidates: [] });
    return j({ error: "not found" }, 404);
  });
}
const view = () => EditorView.findFromDOM(screen.getByTestId("doc-editor").querySelector(".cm-editor") as HTMLElement)!;
const select = (from: number, to: number) => act(() => { view().dispatch({ selection: { anchor: from, head: to } }); });
const openDoc = async (p = CPU, tab = true) => {
  window.history.pushState({}, "", href(p));
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId("doc-version").textContent).toMatch(/^v\d/));
  if (tab) fireEvent.click(screen.getByTestId("dtab-coverage"));
};
const panel = () => screen.getByTestId("dpanel-coverage");
const gapPosts = () => bodies.filter((b) => b.method === "POST" && b.url === "/workbench/contract/gaps");
const rowOf = (id: string) => screen.getByTestId("gap-" + id);
const rowByText = (t: string) => within(panel()).getAllByTestId(/^gap-[0-9a-f-]{36}$/).find((r) => r.textContent?.includes(t))!;
const items = (id: string) => (screen.queryByTestId(id) ? within(screen.getByTestId(id)).getAllByRole("listitem") : []);

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); docs.reset(); gaps.reset(); who = "alice"; failGaps = false; override = null;
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });


const readsOf = () => bodies.filter((b) => b.method === "GET" && b.url.startsWith("/workbench/contract/gaps?"));
describe("ADV", () => {
  it("T1 check again after a failed re-read says something", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA one" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage 1"));
    failGaps = true;
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(readsOf().length).toBe(2));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId("cov-gaps-err") || screen.queryByTestId("cov-err")).toBeTruthy();
  });
  it("T2 badge after failed re-read is not a stale number", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA one" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage 1"));
    failGaps = true;
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(readsOf().length).toBe(2));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage");
  });
  it("T3 confirmation clears when its gap is removed elsewhere, and buttons unlock", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    const g2 = gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /^remove/i }));
    const idx = gaps.rows().findIndex((r) => r.id === g1.id); gaps.rows().splice(idx, 1);
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(screen.queryByTestId("gap-" + g1.id)).toBeNull());
    expect((within(rowOf(g2.id)).getByRole("button", { name: /^remove/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(rowOf(g2.id)).getByRole("button", { name: /^remove/i }));
    expect(screen.getByTestId("gap-remove-ok-" + g2.id)).toBeTruthy();
  });
  it("T3b confirmation open, gap sent to research elsewhere: ok button must not remain live", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /^remove/i }));
    gaps.plantGap(A, { path: CPU, text: "ALPHA dummy", state: "researching", job_id: "9a900000-0000-4000-8000-0000000000a1" }); const row = gaps.rows().find((r) => r.id === g1.id)!; row.state = "researching"; row.job_id = "9a900000-0000-4000-8000-0000000000a1";
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(screen.getByTestId("cov-researching")).toBeTruthy());
    expect(screen.queryByTestId("gap-remove-ok-" + g1.id)).toBeNull();
  });
  it("T4 ticked gap removed elsewhere: the label and the request follow", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    const g2 = gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id)); fireEvent.click(screen.getByTestId("gap-tick-" + g2.id));
    gaps.rows().splice(gaps.rows().findIndex((r) => r.id === g1.id), 1);
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(screen.getByTestId("cov-research").textContent).toBe("Research the 1 ticked gap (one run)"));
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(gaps.rows()[0].state).toBe("researching"));
    expect(bodies.filter((b) => b.url.endsWith("/gaps/research")).map((b) => b.body.ids)).toEqual([[g2.id]]);
  });
  it("T5 research in flight, person changes: no toast to the next person", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    window.history.pushState({}, "", href(CPU));
    const route = () => ({ route: parseRoute(window.location.pathname), params: { ref: uid(CPU) }, whoAnswered: true });
    const ui = (subject: string) => <ToastProvider><DocumentScreen {...route()} subject={subject} /></ToastProvider>;
    const r = render(ui(A.sub));
    await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dtab-coverage"));
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    let release!: () => void; const hold = new Promise<void>((res) => { release = res; });
    override = async (_m, u) => { if (u.endsWith("/gaps/research")) { await hold; } return null; };
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(bodies.some((b) => b.url.endsWith("/gaps/research"))).toBe(true));
    who = "bob"; act(() => resetState()); r.rerender(ui(B.sub));
    await waitFor(() => expect(screen.getByTestId("doc-gone")).toBeTruthy());
    release();
    await new Promise((x) => setTimeout(x, 200));
    console.log("T5 BODY:", (document.body.textContent||"").match(/Research started[^.]*\./)?.[0]); expect(document.body.textContent).not.toMatch(/Research started/);
  });
  it("T6 PATCH conflict is not reported as success", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    override = (m) => (m === "PATCH" ? { status: 409, body: { error: "the gap changed while it was being updated; look again" } } : null);
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /mark covered/i }));
    await waitFor(() => expect(screen.getByTestId("cov-err").textContent).toMatch(/changed/));
    expect(items("cov-covered").length).toBe(0);
  });
  it("T6b DELETE 409 says so and does not lock", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    override = (m) => (m === "DELETE" ? { status: 409, body: { error: "x" } } : null);
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /^remove/i }));
    fireEvent.click(screen.getByTestId("gap-remove-ok-" + g1.id));
    await waitFor(() => expect(screen.getByTestId("cov-err").textContent).toMatch(/changed/));
    expect(items("cov-mine").length).toBe(1);
    expect((within(rowOf(g1.id)).getByRole("button", { name: /^remove/i }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("T7 show in text where the words are twice", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\n\nSECOND: twin words here\n\nTHIRD: twin words here" } }); });
    const t2 = view().state.doc.toString();
    const second = t2.lastIndexOf("twin words here");
    select(second, second + "twin words here".length);
    await waitFor(() => expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cov-add-sel"));
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
    select(0, 0);
    fireEvent.click(within(rowByText("twin words here")).getByRole("button", { name: /show in the text/i }));
    const r = view().state.selection.main;
    console.log("T7 SHOWN AT", r.from, "FIRST", t2.indexOf("twin words here"), "LAST", second, "NOTE:", within(rowByText("twin words here")).queryByRole("status")?.textContent);
    expect(r.from).toBe(second);
  });
  it("T8 double click Add sends one POST", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "ALPHA dbl" } });
    fireEvent.click(screen.getByTestId("cov-add")); fireEvent.click(screen.getByTestId("cov-add"));
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
    expect(gapPosts().length).toBe(1);
  });
  it("T9 astral chars counted as code points; 2000 emoji ok", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "\u{1F600}".repeat(2000) } });
    expect((screen.getByTestId("cov-add") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("cov-add"));
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
  });
  it("T10 found: dedupe across runs, only newest 10 runs read", async () => {
    for (let i = 0; i < 12; i++) gaps.plantSession({ owner_sub: A.sub, path: CPU, id: `5e550000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, created_at: `2026-11-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`, needs: [{ need: "ALPHA need " + i, status: "open" }, { need: "Shared need.", status: "open" }] });
    await openDoc();
    const found = await waitFor(() => screen.getByTestId("cov-found"));
    await waitFor(() => expect(within(found).getAllByRole("listitem").length).toBe(11));
    const shared = within(found).getAllByRole("listitem").find((l) => l.textContent?.includes("Shared need"))!;
    expect(within(shared).getByTestId("need-run").getAttribute("data-run")).toBe("5e550000-0000-4000-8000-000000000111");
  });
  it("T12 covered gap and the same need offered again", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA cov", state: "covered" });
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: "ALPHA cov", status: "open" }] });
    await openDoc();
    const found = await waitFor(() => screen.getByTestId("cov-found"));
    await waitFor(() => expect(within(found).getAllByRole("listitem").length).toBe(1));
    console.log("T12 covered-need text:", within(found).getAllByRole("listitem")[0].textContent);
  });
  it("T13 poll re-reads every 20s while a run is out", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first", state: "researching", job_id: "9a900000-0000-4000-8000-0000000000a1" });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval"] });
    try {
      await openDoc();
      await waitFor(() => expect(items("cov-researching").length).toBe(1));
      const n = readsOf().length;
      gaps.finishRun("9a900000-0000-4000-8000-0000000000a1", { covers: [g1.id] });
      await act(async () => { vi.advanceTimersByTime(20_500); });
      await waitFor(() => expect(items("cov-covered").length).toBe(1));
      expect(readsOf().length).toBeGreaterThan(n);
    } finally { vi.useRealTimers(); }
  });
  it("T14 no poll when nothing is researching", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval"] });
    try {
      await openDoc();
      await waitFor(() => expect(items("cov-mine").length).toBe(1));
      const n = readsOf().length;
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(readsOf().length).toBe(n);
    } finally { vi.useRealTimers(); }
  });
});

// ---- attempt 2: the tester's defects D1-D4 and the guards the mutation run showed were unpinned ----
import { DocEditor } from "../src/screens/document-editor/DocEditor";
import { readGaps, gapProblem, runDate, normalizeGapText, cleanText, chars } from "../src/screens/document-editor/coverage-data";
import { ApiError } from "../src/lib/api";

const hold = () => { let release!: () => void; const p = new Promise<void>((res) => { release = res; }); return { p, release }; };
const tabText = () => screen.getByTestId("dtab-coverage").textContent;
const J1 = "9a900000-0000-4000-8000-0000000000a1";
const TWINS = "\n\ntwin words here\n\ntwin words here\n\ntwin words here";

describe("attempt 2: failed re-reads, late answers, the passage, the poll", () => {
  it("D1: a failed re-read says so, keeps the list (marked out of date) and shows no number; a later good read clears it", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA one" });
    await openDoc();
    await waitFor(() => expect(tabText()).toBe("Coverage 1"));
    failGaps = true;
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(screen.getByTestId("cov-gaps-err").textContent).toMatch(/may be out of date/));
    expect(tabText()).toBe("Coverage");
    expect(items("cov-mine").length).toBe(1); // what is useful is kept
    failGaps = false;
    fireEvent.click(within(screen.getByTestId("cov-gaps-err")).getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(tabText()).toBe("Coverage 1"));
    expect(screen.queryByTestId("cov-gaps-err")).toBeNull();
  });
  it("D1: the 20 s poll fails the same way", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA first", state: "researching", job_id: J1 });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval"] });
    try {
      await openDoc();
      await waitFor(() => expect(items("cov-researching").length).toBe(1));
      failGaps = true;
      await act(async () => { vi.advanceTimersByTime(20_500); });
      await waitFor(() => expect(screen.getByTestId("cov-gaps-err")).toBeTruthy());
    } finally { vi.useRealTimers(); }
  });
  it("D4: the Remove question for a gap that another browser sent to research is closed on the next read", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /^remove/i }));
    const row = gaps.rows().find((r) => r.id === g1.id)!; row.state = "researching"; row.job_id = J1;
    gaps.plantGap(A, { path: CPU, text: "ALPHA x", state: "researching", job_id: J1 });
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(items("cov-researching").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("gap-remove-ok-" + g1.id)).toBeNull();
  });
  it("D3: a gap added from the second of three identical passages shows THAT one, with no note; after a reload it says which of N it shows and cycles", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: TWINS } }); });
    const doc = view().state.doc.toString();
    const second = doc.indexOf("twin words here", doc.indexOf("twin words here") + 1);
    select(second, second + 15);
    await waitFor(() => expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cov-add-sel"));
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
    select(0, 0);
    fireEvent.click(within(rowByText("twin words here")).getByRole("button", { name: /show in the text/i }));
    expect(view().state.selection.main.from).toBe(second);
    expect(within(rowByText("twin words here")).queryByRole("status")).toBeNull();
    // a fresh page (no memory of where it came from): the first place, a plain note, and the next press goes on
    cleanup(); await openDoc();
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: TWINS } }); });
    const row = await waitFor(() => rowByText("twin words here"));
    const places = [...view().state.doc.toString().matchAll(/twin words here/g)].map((m) => m.index!);
    fireEvent.click(within(row).getByRole("button", { name: /show in the text/i }));
    expect(view().state.selection.main.from).toBe(places[0]);
    const n = places.length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(within(row).getByRole("status").textContent).toMatch(new RegExp(`${n} times in the text.*1 of ${n}`));
    act(() => (document.activeElement as HTMLElement | null)?.blur()); // happy-dom reports the DOM selection while CodeMirror updates: let go of the editor first
    fireEvent.click(within(row).getByRole("button", { name: /show in the text/i }));
    expect(view().state.selection.main.from).toBe(places[1]);
    expect(within(row).getByRole("status").textContent).toMatch(new RegExp(`2 of ${n}`));
  });
  it("Show in the text: a passage with regexp characters, and re-wrapped white space, is found; the dispatch scrolls to it and the editor takes the focus", async () => {
    gaps.plantGap(A, { path: CPU, text: "f(x)+1.5 [a]", origin: "selection" });
    gaps.plantGap(A, { path: CPU, text: "alpha beta gamma", origin: "selection" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\n\nSee f(x)+1.5 [a] here and alpha\n   beta\ngamma." } }); });
    const spy = vi.spyOn(view(), "dispatch");
    const focus = vi.spyOn(EditorView.prototype, "focus");
    fireEvent.click(within(rowByText("f(x)+1.5")).getByRole("button", { name: /show in the text/i }));
    expect(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to)).toBe("f(x)+1.5 [a]");
    expect(spy.mock.calls.some((c: any[]) => c[0]?.scrollIntoView === true)).toBe(true);
    expect(focus).toHaveBeenCalled();
    fireEvent.click(within(rowByText("alpha beta gamma")).getByRole("button", { name: /show in the text/i }));
    expect(view().state.sliceDoc(view().state.selection.main.from, view().state.selection.main.to)).toBe("alpha\n   beta\ngamma");
  });
  it("Check again also re-reads what research found", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-found-none")).toBeTruthy());
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: "ALPHA brand new need", status: "open" }] });
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(screen.getByTestId("cov-found").textContent).toMatch(/brand new need/));
  });
  it("more than 10 runs: the tab says only the newest 10 are read", async () => {
    for (let i = 0; i < 12; i++) gaps.plantSession({ owner_sub: A.sub, path: CPU, id: `5e550000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`, created_at: `2026-11-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`, needs: [{ need: "ALPHA n" + i, status: "open" }] });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-found-capped").textContent).toMatch(/newest 10 of 12.*2 older ones/));
  });
  it("a run that could not be read is counted in a notice", async () => {
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: "ALPHA a", status: "open" }] });
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S2, created_at: "2020-01-01T00:00:00.000Z", needs: [{ need: "ALPHA b", status: "open" }] });
    override = (_m, u) => (u.includes(`/sessions/${S2}/coverage`) ? { status: 500, body: { error: "internal" } } : null);
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-found-partial").textContent).toMatch(/One research run could not be read/));
    expect(within(screen.getByTestId("cov-found")).getAllByRole("listitem").length).toBe(1);
  });
  it("research on a document that is not saved yet has its own words (the fake models the server's 409), and the gap stays open", async () => {
    gaps.plantGap(A, { path: "documents/k-a/unsaved-new.md", text: "ALPHA on an unsaved page" });
    expect(gaps.handle(A, "POST", "/workbench/contract/gaps/research", { ids: [gaps.rows()[0].id] })).toEqual({ status: 409, body: { error: "the document is not listed yet; save it first", detail: {} } });
    expect(gaps.rows()[0].state).toBe("open");
    expect(gapProblem(new ApiError(409, { error: "the document is not listed yet; save it first" }), "research")).toMatch(/has not been saved yet/);
    expect(gapProblem(new ApiError(409, { error: "only open gaps can be researched" }), "research")).toMatch(/A gap changed/);
  });
  it("the words for each refusal", () => {
    expect(gapProblem(new ApiError(409, {}), "add")).toBe("That is already on your list.");
    expect(gapProblem(new ApiError(503, {}), "research")).toMatch(/Research is not available/);
    expect(gapProblem(new ApiError(404, {}), "research")).toMatch(/One of the ticked gaps is no longer there/);
    expect(gapProblem(new ApiError(404, {}), "change")).toMatch(/^That gap is no longer there/);
    expect(gapProblem(new ApiError(404, {}), "add")).toMatch(/not available to add a gap to/);
    expect(gapProblem(new ApiError(500, {}), "remove")).toBe("Could not remove that gap. Nothing was changed.");
    expect(gapProblem(new ApiError(422, {}), "add")).toMatch(/not accepted/);
  });
  it("data: the path is URL-encoded, the limit is asked for, counts are numbers, a wrong shape is a failure; dates are UTC; text keys", async () => {
    const seen: string[] = [];
    setFetcher(async (u) => { seen.push(u); return new Response(JSON.stringify({ gaps: [], counts: { open: "3", researching: 1, covered: 0, dismissed: 0 } }), { status: 200 }); });
    const r = await readGaps("documents/k-a/Q&A/x y.md");
    expect(seen[0]).toBe("/workbench/contract/gaps?path=documents%2Fk-a%2FQ%26A%2Fx%20y.md&limit=500");
    expect(r.counts.open).toBe(3);
    setFetcher(async () => new Response(JSON.stringify({ gaps: [{ id: 1 }], counts: {} }), { status: 200 }));
    await expect(readGaps("documents/k-a/x.md")).rejects.toThrow();
    const tz = process.env.TZ; process.env.TZ = "Pacific/Auckland";
    try { expect(runDate("2026-11-22T23:30:00.000Z")).toBe("22 Nov 2026"); } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
    expect(runDate("nope")).toBe("an unknown date");
    expect(normalizeGapText("  “Is it ENOUGH?”. ")).toBe("is it enough");
    expect(normalizeGapText("Ａbc​d")).toBe("abcd");
    expect(cleanText("a\u0001b\u007Fc ")).toBe("a b c");
    expect(chars("\u{1F600}\u{1F600}")).toBe(2);
  });
  it("a need that matches a gap by the server's rule (case, punctuation) says it is on your list; a COVERED gap does not hide it", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA is it enough?" });
    gaps.plantGap(A, { path: CPU, text: "ALPHA was covered", state: "covered" });
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: "alpha IS it enough.", status: "open" }, { need: "ALPHA was covered", status: "open" }] });
    await openDoc();
    const found = await waitFor(() => screen.getByTestId("cov-found"));
    await waitFor(() => expect(within(found).getAllByRole("listitem").length).toBe(2));
    const [a, b] = within(found).getAllByRole("listitem");
    const on = (li: HTMLElement) => /On your list/.test(li.textContent ?? "");
    expect([on(a), on(b)].sort()).toEqual([false, true]);
    const covered = within(found).getAllByRole("listitem").find((l) => l.textContent?.includes("was covered"))!;
    expect(within(covered).getByRole("button", { name: /add to my gaps/i })).toBeTruthy();
  });
  it("row buttons: a researching gap has no Remove, a covered gap has Reopen and no Mark covered; an open one has both", async () => {
    const o = gaps.plantGap(A, { path: CPU, text: "ALPHA open one" });
    const r = gaps.plantGap(A, { path: CPU, text: "ALPHA going one", state: "researching", job_id: J1 });
    const c = gaps.plantGap(A, { path: CPU, text: "ALPHA done one", state: "covered" });
    await openDoc();
    await waitFor(() => expect(rowOf(o.id)).toBeTruthy());
    const names = (id: string) => within(rowOf(id)).queryAllByRole("button").map((b) => b.textContent);
    expect(names(o.id)).toEqual(["Mark covered", "Remove"]);
    expect(names(r.id)).toEqual(["Mark covered"]);
    expect(names(c.id)).toEqual(["Reopen", "Remove"]);
  });
  it("Research is off while a Remove question is open, even with a gap ticked", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    const g2 = gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g2.id));
    expect((screen.getByTestId("cov-research") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /^remove/i }));
    expect((screen.getByTestId("cov-research") as HTMLButtonElement).disabled).toBe(true);
  });
  it("same-tick double fire: two clicks in one batch make ONE add and ONE research request", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "ALPHA dbl" } });
    const add = screen.getByTestId("cov-add");
    act(() => { add.click(); add.click(); });
    await waitFor(() => expect(items("cov-mine").length).toBe(2));
    expect(gapPosts().length).toBe(1);
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    const go = screen.getByTestId("cov-research");
    act(() => { go.click(); go.click(); });
    await waitFor(() => expect(items("cov-researching").length).toBe(1));
    expect(bodies.filter((b) => b.url.endsWith("/gaps/research")).length).toBe(1);
  });
  it("while a write is out the ticks wait; the question closes at once on Remove; the box keeps a draft that cannot be sent", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    const g2 = gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    const h = hold();
    override = async (m) => { if (m === "DELETE") await h.p; return null; };
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /^remove/i }));
    fireEvent.click(screen.getByTestId("gap-remove-ok-" + g1.id));
    await waitFor(() => expect(bodies.some((b) => b.method === "DELETE")).toBe(true));
    expect(screen.queryByTestId("gap-remove-ok-" + g1.id)).toBeNull(); // closed before the answer
    expect((screen.getByTestId("gap-tick-" + g2.id) as HTMLInputElement).disabled).toBe(true);
    h.release();
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
    expect((screen.getByTestId("gap-tick-" + g2.id) as HTMLInputElement).disabled).toBe(false);
    // control characters only: nothing is sent and the draft stays
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "\u0001\u0002" } });
    fireEvent.click(screen.getByTestId("cov-add"));
    await new Promise((r) => setTimeout(r, 80));
    expect(gapPosts()).toEqual([]);
    expect((screen.getByTestId("cov-box") as HTMLTextAreaElement).value).toBe("\u0001\u0002");
  });
  it("a selection with a control character is sent with a space in its place", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\nodd\u0001word here" } }); });
    const d = view().state.doc.toString(); const from = d.indexOf("odd");
    select(from, from + "odd\u0001word".length);
    await waitFor(() => expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cov-add-sel"));
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
    expect(gapPosts()[0].body.text).toBe("odd word");
  });
  it("the start-of-run toast counts what the server says it started", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    const g2 = gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id)); fireEvent.click(screen.getByTestId("gap-tick-" + g2.id));
    override = (_m, u) => (u.endsWith("/gaps/research") ? { status: 202, body: { job_id: J1, gaps: [g1] } } : null);
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(screen.getByTestId("toasts").textContent).toMatch(/Research started on 1 gap in one run\./));
  });
  it("after research the ticks are cleared even when the next read fails (no stale 'ticked' button)", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    override = (_m, u) => { if (u.endsWith("/gaps/research")) failGaps = true; return null; };
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(screen.getByTestId("cov-gaps-err")).toBeTruthy());
    expect(screen.getByTestId("cov-research").textContent).toBe("Research the ticked gaps (one run)");
    expect((screen.getByTestId("gap-tick-" + g1.id) as HTMLInputElement).checked).toBe(false);
  });
  it("a late read of the list from an earlier request never replaces a newer one", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA one" });
    await openDoc();
    await waitFor(() => expect(tabText()).toBe("Coverage 1"));
    const h = hold(); let first = true;
    override = async (m, u) => { if (m === "GET" && u.startsWith("/workbench/contract/gaps?") && first) { first = false; const old = gaps.handle(A, m, u, {}); await h.p; return old; } return null; };
    fireEvent.click(screen.getByTestId("cov-recheck")); // read 2 starts (held, with the old snapshot)
    await waitFor(() => expect(readsOf().length).toBe(2));
    gaps.plantGap(A, { path: CPU, text: "ALPHA two" });
    override = null;
    fireEvent.click(screen.getByTestId("cov-recheck")); // read 3 (fresh)
    await waitFor(() => expect(tabText()).toBe("Coverage 2"));
    h.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(tabText()).toBe("Coverage 2");
    expect(items("cov-mine").length).toBe(2);
  });
});

describe("attempt 2: the person changes while the DocEditor stays mounted (the hook reacts to the subject by itself)", () => {
  const ui = (subject: string) => <ToastProvider><DocEditor path={CPU} docRef={uid(CPU)} subject={subject} /></ToastProvider>;
  it("state, message and reads start over for the new person: no old error, the gaps and the research runs are read again under him", async () => {
    gaps.plantGap(A, { path: CPU, text: `ALPHA ${MARK} first` });
    gaps.setQueue("off");
    const r = render(ui(A.sub));
    await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dtab-coverage"));
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
    fireEvent.click(screen.getByTestId("gap-tick-" + gaps.rows()[0].id));
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(screen.getByTestId("cov-err")).toBeTruthy());
    const nGaps = readsOf().length, nRuns = bodies.filter((b) => b.url.includes("/documents/coverage")).length;
    who = "bob"; act(() => resetState());
    r.rerender(ui(B.sub));
    await waitFor(() => expect(readsOf().length).toBeGreaterThan(nGaps));
    await waitFor(() => expect(bodies.filter((b) => b.url.includes("/documents/coverage")).length).toBeGreaterThan(nRuns));
    expect(screen.queryByTestId("cov-err")).toBeNull();
    expect(document.body.innerHTML).not.toMatch(new RegExp(MARK));
  });
  it("an answer to alice's reads that arrives after the change is dropped (the list and the research-found list)", async () => {
    gaps.plantGap(A, { path: CPU, text: `ALPHA ${MARK} first` });
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: `ALPHA ${MARK} a need`, status: "open" }] });
    const hg = hold(), hf = hold();
    let gapsHeld = false, foundHeld = false;
    const r = render(ui(A.sub));
    await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
    await waitFor(() => expect(tabText()).toBe("Coverage 1"));
    fireEvent.click(screen.getByTestId("dtab-coverage"));
    await waitFor(() => expect(screen.getByTestId("cov-found")).toBeTruthy());
    // alice asks again; both answers are held and come back with HER data after the change
    override = async (m, u) => {
      if (u.startsWith("/workbench/contract/gaps?") && who === "alice" && !gapsHeld) { gapsHeld = true; const old = gaps.handle(A, m, u, {}); await hg.p; return old; }
      if (u.includes("/documents/coverage") && who === "alice" && !foundHeld) { foundHeld = true; const old = gaps.handle(A, m, u, {}); await hf.p; return old; }
      return null;
    };
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(gapsHeld && foundHeld).toBe(true));
    who = "bob"; act(() => resetState());
    r.rerender(ui(B.sub));
    await waitFor(() => expect(screen.queryByTestId("cov-found")).toBeNull());
    hg.release(); hf.release();
    await new Promise((x) => setTimeout(x, 150));
    expect(document.body.innerHTML).not.toMatch(new RegExp(MARK));
  });
});

describe("attempt 2 (mutation round 2): ticks, whitespace selections, wrapping, nothing of the last person while the next is read", () => {
  it("a ticked gap that is sent to research elsewhere is un-ticked on the next read (the label and the request follow)", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    expect(screen.getByTestId("cov-research").textContent).toBe("Research the 1 ticked gap (one run)");
    gaps.plantGap(A, { path: CPU, text: "ALPHA run holder", state: "researching", job_id: J1 }); // registers the run as still out
    const row = gaps.rows().find((r) => r.id === g1.id)!; row.state = "researching"; row.job_id = J1;
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(items("cov-researching").length).toBe(2));
    expect(screen.getByTestId("cov-research").textContent).toBe("Research the ticked gaps (one run)");
    expect((screen.getByTestId("cov-research") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a selection of only white space does not turn Add as a gap on", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "x     y" } }); });
    const d = view().state.doc.toString(); const at = d.indexOf("x     y") + 1;
    select(at, at + 5);
    await waitFor(() => expect(screen.getByTestId("cov-add-sel").getAttribute("title")).toMatch(/Select some text/));
    expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(true);
  });
  it("pressing Show in the text past the last place wraps round to the first", async () => {
    gaps.plantGap(A, { path: CPU, text: "twin words here", origin: "selection" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: TWINS } }); });
    const places = [...view().state.doc.toString().matchAll(/twin words here/g)].map((m) => m.index!);
    const row = rowByText("twin words here");
    const press = () => { act(() => (document.activeElement as HTMLElement | null)?.blur()); fireEvent.click(within(row).getByRole("button", { name: /show in the text/i })); return view().state.selection.main.from; };
    const seen = Array.from({ length: places.length + 1 }, press);
    expect(seen).toEqual([...places, places[0]]);
  });
  it("nothing of the last person is on screen while the next person's reads are still out (list and research-found list)", async () => {
    gaps.plantGap(A, { path: CPU, text: `ALPHA ${MARK} first` });
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: `ALPHA ${MARK} a need`, status: "open" }] });
    const h = hold();
    const ui = (subject: string) => <ToastProvider><DocEditor path={CPU} docRef={uid(CPU)} subject={subject} /></ToastProvider>;
    const r = render(ui(A.sub));
    await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dtab-coverage"));
    await waitFor(() => expect(screen.getByTestId("cov-found")).toBeTruthy());
    fireEvent.click(screen.getByTestId("cov-recheck")); // a re-read happened once: the research-found list is not "first load" any more
    await waitFor(() => expect(readsOf().length).toBe(2));
    override = async (_m, u) => { if (who === "bob" && (u.startsWith("/workbench/contract/gaps?") || u.includes("/documents/coverage"))) await h.p; return null; };
    who = "bob"; act(() => resetState());
    r.rerender(ui(B.sub));
    await new Promise((x) => setTimeout(x, 50));
    expect(document.body.innerHTML).not.toMatch(new RegExp(MARK));
    expect(screen.queryByTestId("cov-found")).toBeNull();
    expect(items("cov-mine").length).toBe(0);
    h.release();
  });
});

// ---- attempt 3 (reviewer R1 and the tester's G1/G2): the remembered place follows the edits ----
describe("attempt 3: Show in the text follows edits (R1), found-list ordering (G1/G2), the 500 cap, run labels", () => {
  const P3 = "twin words here";
  const sleep3 = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const addSecondOfThree = async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: `\n\n${P3} / a\n${P3} / b\n${P3} / c` } }); });
    const d = view().state.doc.toString();
    const first = d.indexOf(P3), second = d.indexOf(P3, first + 1);
    select(second, second + P3.length);
    await waitFor(() => expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cov-add-sel"));
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
    return { first, second };
  };
  const press = () => {
    act(() => (document.activeElement as HTMLElement | null)?.blur()); // happy-dom reports the DOM selection while CodeMirror updates
    fireEvent.click(within(rowByText(P3)).getByRole("button", { name: /show in the text/i }));
    return view().state.selection.main.from;
  };
  const note = () => within(rowByText(P3)).queryByRole("status")?.textContent ?? null;
  it("R1: after an EARLIER identical copy is deleted, Show in the text still goes to the passage the gap was taken from, with no note", async () => {
    const { first, second } = await addSecondOfThree();
    act(() => { const v = view(); v.dispatch({ changes: { from: first, to: first + (`${P3} / a\n`).length } }); }); // the first copy goes
    const d = view().state.doc.toString();
    const wanted = d.indexOf(`${P3} / b`);
    expect(wanted).toBe(second - (`${P3} / a\n`).length);
    expect(press()).toBe(wanted);
    expect(note()).toBeNull();
  });
  it("R1: after an identical copy is INSERTED above, the same", async () => {
    await addSecondOfThree();
    act(() => { const v = view(); v.dispatch({ changes: { from: 0, insert: `${P3} / new copy at the top\n` } }); });
    const wanted = view().state.doc.toString().indexOf(`${P3} / b`);
    expect(press()).toBe(wanted);
    expect(note()).toBeNull();
  });
  it("R1: when the remembered passage itself was edited (no copy starts there any more) it is honest: the first copy and the N-times note", async () => {
    await addSecondOfThree();
    const d = view().state.doc.toString();
    const at = d.indexOf(`${P3} / b`);
    act(() => { const v = view(); v.dispatch({ changes: { from: at, to: at + 4, insert: "TWAIN" } }); }); // "twin" -> "TWAIN" at the remembered place
    const first = view().state.doc.toString().indexOf(P3);
    expect(press()).toBe(first);
    expect(note()).toMatch(/2 times in the text.*1 of 2/);
  });
  it("G1: an older, slower research-found read never overwrites a newer one", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-found-none")).toBeTruthy());
    const h = hold(); let n = 0;
    override = async (m, u) => {
      if (u.includes("/documents/coverage")) { n++; if (n === 1) { const old = gaps.handle(A, m, u, {}); await h.p; return old; } }
      return null;
    };
    fireEvent.click(screen.getByTestId("cov-recheck")); await waitFor(() => expect(n).toBe(1));
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: "ALPHA fresh need", status: "open" }] });
    fireEvent.click(screen.getByTestId("cov-recheck")); await waitFor(() => expect(n).toBe(2));
    await waitFor(() => expect(screen.getByTestId("cov-found")).toBeTruthy());
    h.release(); await sleep3(200);
    expect(screen.queryByTestId("cov-found")).toBeTruthy(); expect(panel().textContent).toMatch(/ALPHA fresh need/);
  });
  it("G2: an older, slower FAILED found read never turns a newer good list into an error", async () => {
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: "ALPHA fresh need", status: "open" }] });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-found")).toBeTruthy());
    const h = hold(); let n = 0;
    override = async (_m, u) => { if (u.includes("/documents/coverage")) { n++; if (n === 1) { await h.p; return { status: 500, body: { error: "x" } }; } } return null; };
    fireEvent.click(screen.getByTestId("cov-recheck")); await waitFor(() => expect(n).toBe(1));
    fireEvent.click(screen.getByTestId("cov-recheck")); await waitFor(() => expect(n).toBe(2));
    await sleep3(100); h.release(); await sleep3(200);
    expect(screen.queryByTestId("cov-found-err")).toBeNull(); expect(panel().textContent).toMatch(/ALPHA fresh need/);
  });
  it("more gaps than the 500 read: a notice says so, using the server's total, and the tab number stays the server's open count", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA one" });
    override = (m, u) => {
      if (m === "GET" && u.startsWith("/workbench/contract/gaps?")) {
        const r = gaps.handle(A, m, u, {})!;
        return { status: 200, body: { ...r.body, total: 612, counts: { ...r.body.counts, open: 600 } } };
      }
      return null;
    };
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-gaps-capped").textContent).toMatch(/newest 1 of your 612 gaps/));
    expect(tabText()).toBe("Coverage 600");
    override = null;
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(screen.queryByTestId("cov-gaps-capped")).toBeNull());
  });
  it("two research runs on one day read differently: the time and a short run id are in the label", async () => {
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, created_at: "2026-11-22T09:05:00.000Z", needs: [{ need: "ALPHA morning need", status: "open" }] });
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S2, created_at: "2026-11-22T16:40:00.000Z", needs: [{ need: "ALPHA evening need", status: "open" }] });
    await openDoc();
    const found = await waitFor(() => screen.getByTestId("cov-found"));
    await waitFor(() => expect(within(found).getAllByTestId("need-run").length).toBe(2));
    const labels = within(found).getAllByTestId("need-run").map((e) => e.textContent);
    expect(new Set(labels).size).toBe(2);
    expect(labels.join("|")).toMatch(/Run of 22 Nov 2026 16:40 UTC \(run 5e550000\)/);
    expect(labels.join("|")).toMatch(/Run of 22 Nov 2026 09:05 UTC \(run 5e550000\)/);
  });
});

describe("attempt 3 (mutation round): where a remembered start sits", () => {
  const P4 = "twin words here";
  const setup = async (leading: string) => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: `\n\n${P4} / a\n${P4} / b\n${P4} / c` } }); });
    const d = view().state.doc.toString();
    const second = d.indexOf(P4, d.indexOf(P4) + 1);
    select(second - leading.length, second + P4.length);
    await waitFor(() => expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cov-add-sel"));
    await waitFor(() => expect(items("cov-mine").length).toBe(1));
    return second;
  };
  const show = () => { act(() => (document.activeElement as HTMLElement | null)?.blur()); fireEvent.click(within(rowByText(P4)).getByRole("button", { name: /show in the text/i })); };
  it("text typed right at the start of the remembered passage goes before it: the passage is still the one shown, with no note", async () => {
    const second = await setup("");
    act(() => { const v = view(); v.dispatch({ changes: { from: second, insert: "NEW " } }); });
    show();
    expect(view().state.selection.main.from).toBe(second + 4);
    expect(within(rowByText(P4)).queryByRole("status")).toBeNull();
  });
  it("a selection that starts with white space remembers where the WORDS start", async () => {
    const second = await setup("\n");
    show();
    expect(view().state.selection.main.from).toBe(second);
    expect(within(rowByText(P4)).queryByRole("status")).toBeNull();
  });
});
