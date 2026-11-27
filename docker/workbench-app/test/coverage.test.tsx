// The Coverage tab of the document screen (rwr-doc-coverage), against the shared fakes: the documents back end
// (e2e/docs-fake.mjs) and the gaps back end (e2e/gaps-fake.mjs), the same two the e2e stub runs; the gaps fake copies the
// server's repo code (repo/gaps.ts) and the research-needs routes (repo/trust.ts). One describe per acceptance item of the anchor.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { App } from "../src/App";
import { DocumentScreen } from "../src/screens/documents/DocumentScreen";
import { ToastProvider } from "../src/shell/Toast";
import { parseRoute } from "../src/lib/router";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { createFake, PEOPLE, uid } from "../e2e/docs-fake.mjs";
import { createGapsFake } from "../e2e/gaps-fake.mjs";

configure({ asyncUtilTimeout: 5000 });
const NOW = Date.now();
const docs = createFake({ now: () => NOW });
const gaps = createGapsFake({ ownsDocument: (w, p) => docs.db().docs.get(p)?.owner === w.sub, now: () => NOW });
let who: "alice" | "bob" = "alice";
let bodies: { method: string; url: string; body: any; who: string }[] = [];
let failGaps = false;
const CPU = "documents/k-a/Hardware/cpu.md";
const BRAVO = "documents/k-b/bravo.md";
const href = (p: string) => "/documents/d/" + uid(p);
const A = PEOPLE.alice, B = PEOPLE.bob;
const S1 = "5e550000-0000-4000-8000-000000000001";
const S2 = "5e550000-0000-4000-8000-000000000002";
const SB = "5e550000-0000-4000-8000-0000000000b1";
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
const writes = () => bodies.filter((b) => b.method !== "GET" && b.url.startsWith("/workbench/contract/gaps"));
const rowOf = (id: string) => screen.getByTestId("gap-" + id);
const rowByText = (t: string) => within(panel()).getAllByTestId(/^gap-[0-9a-f-]{36}$/).find((r) => r.textContent?.includes(t))!;
const items = (id: string) => (screen.queryByTestId(id) ? within(screen.getByTestId(id)).getAllByRole("listitem") : []);
const idOf = (row: HTMLElement) => row.getAttribute("data-testid")!.slice(4);

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); docs.reset(); gaps.reset(); who = "alice"; failGaps = false;
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the tab reads your gaps and the count equals the open ones", () => {
  it("lists open, being-researched and covered gaps in their own sections; the tab says how many are open", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA does the socket take 165 W?" });
    gaps.plantGap(A, { path: CPU, text: "ALPHA which cooler fits?" });
    gaps.plantGap(A, { path: CPU, text: "ALPHA is the BIOS new enough?", state: "researching", job_id: "9a900000-0000-4000-8000-0000000000a1" });
    gaps.plantGap(A, { path: CPU, text: "ALPHA what is the TDP?", state: "covered" });
    gaps.plantGap(A, { path: CPU, text: "ALPHA dismissed one", state: "dismissed" });
    gaps.plantGap(A, { path: "documents/k-a/Stack/gateway.md", text: "ALPHA another document's gap" });
    await openDoc(CPU, false);
    await waitFor(() => expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage 2"));
    expect(screen.getByTestId("cov-count").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("dtab-coverage"));
    await waitFor(() => expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(2));
    expect(within(screen.getByTestId("cov-researching")).getAllByRole("listitem").length).toBe(1);
    expect(within(screen.getByTestId("cov-covered")).getAllByRole("listitem").length).toBe(1);
    expect(panel().textContent).not.toMatch(/dismissed one|another document/);
  });
  it("with no open gap there is no number on the tab (a count is never made up while loading or after a failed read)", async () => {
    await openDoc(CPU, false);
    await waitFor(() => expect(requestLog().some((r) => r.url.startsWith("/workbench/contract/gaps"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage");
    cleanup(); failGaps = true;
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-gaps-err").textContent).toMatch(/could not read/i));
    expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage");
    expect(within(panel()).getByRole("button", { name: /try again/i })).toBeTruthy();
  });
  it("the count follows an add and a removal", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "ALPHA one" } });
    fireEvent.click(screen.getByTestId("cov-add"));
    await waitFor(() => expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage 1"));
    fireEvent.click(within(rowByText("ALPHA one")).getByRole("button", { name: /^remove/i }));
    fireEvent.click(within(rowByText("ALPHA one")).getByTestId(/^gap-remove-ok-/));
    await waitFor(() => expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage"));
  });
});

describe("adding a gap: the box, and from selected text with a link to the passage", () => {
  it("the box adds a gap as the caller's own (origin user) for this document, and clears; nothing is sent for a blank box", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    expect((screen.getByTestId("cov-add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "  " } });
    expect((screen.getByTestId("cov-add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "ALPHA does the socket take 165 W?" } });
    fireEvent.click(screen.getByTestId("cov-add"));
    await waitFor(() => expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1));
    expect(gapPosts().map((b) => b.body)).toEqual([{ path: CPU, text: "ALPHA does the socket take 165 W?", origin: "user" }]);
    expect((screen.getByTestId("cov-box") as HTMLTextAreaElement).value).toBe("");
  });
  it("Add as a gap from selected text adds the passage with origin selection; Show in the text selects that passage again", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(true);
    const text = view().state.doc.toString();
    const from = text.indexOf("body of the CPU plan");
    select(from, from + "body of the CPU plan".length);
    await waitFor(() => expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cov-add-sel"));
    await waitFor(() => expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1));
    expect(gapPosts().map((b) => b.body)).toEqual([{ path: CPU, text: "body of the CPU plan", origin: "selection" }]);
    // move the selection elsewhere, then follow the link back
    select(0, 0);
    const row = rowByText("body of the CPU plan");
    fireEvent.click(within(row).getByRole("button", { name: /show in the text/i }));
    const r = view().state.selection.main;
    expect(view().state.sliceDoc(r.from, r.to)).toBe("body of the CPU plan");
  });
  it("a passage that has since been edited out says so; nothing is selected and nothing looks like it worked", async () => {
    gaps.plantGap(A, { path: CPU, text: "a passage nobody wrote", origin: "selection" });
    await openDoc();
    const row = await waitFor(() => rowByText("a passage nobody wrote"));
    fireEvent.click(within(row).getByRole("button", { name: /show in the text/i }));
    expect(within(row).getByRole("status").textContent).toMatch(/no longer in the text/i);
  });
  it("a selection longer than 2000 characters is refused in words, never cut; a gap typed by hand has no 'Show in the text'", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA typed by hand" });
    await openDoc();
    const row = await waitFor(() => rowByText("typed by hand"));
    expect(within(row).queryByRole("button", { name: /show in the text/i })).toBeNull();
    act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: " " + "x".repeat(2100) } }); });
    select(0, view().state.doc.length);
    await waitFor(() => expect((screen.getByTestId("cov-add-sel") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("cov-add-sel"));
    await waitFor(() => expect(screen.getByTestId("cov-err").textContent).toMatch(/2000 characters/));
    expect(gapPosts()).toEqual([]);
  });
  it("the same text twice is refused by the server and the tab says it is already there, naming nothing it was not told", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA is it enough?" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "alpha IS it enough" } });
    fireEvent.click(screen.getByTestId("cov-add"));
    await waitFor(() => expect(screen.getByTestId("cov-err").textContent).toMatch(/already on your list/i));
    expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1);
    expect((screen.getByTestId("cov-box") as HTMLTextAreaElement).value).toBe("alpha IS it enough"); // the draft is kept
  });
  it("a text over 2000 characters in the box is refused before anything is sent", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "y".repeat(2001) } });
    expect((screen.getByTestId("cov-add") as HTMLButtonElement).disabled).toBe(true);
    expect(panel().textContent).toMatch(/2000/);
    expect(gapPosts()).toEqual([]);
  });
});

describe("found by research: shown with their run, never added without a click", () => {
  const plant = () => {
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, created_at: "2026-11-20T10:00:00.000Z",
      needs: [{ need: "ALPHA price of the 7950X", status: "open" }, { need: "ALPHA socket wattage", status: "answered" }, { need: "ALPHA BIOS support", status: "partial" }, { need: "ALPHA cooler list", status: "search_failed" }],
      gaps: ["ALPHA thermal paste choice"] });
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S2, created_at: "2026-11-22T10:00:00.000Z", needs: [{ need: "ALPHA RAM kits", status: "open" }] });
  };
  it("lists the unanswered needs (open, partial, search failed) and the run's own gaps, each with the run it came from; answered ones are not offered", async () => {
    plant();
    await openDoc();
    const found = await waitFor(() => screen.getByTestId("cov-found"));
    await waitFor(() => expect(within(found).getAllByRole("listitem").length).toBe(5));
    expect(found.textContent).toMatch(/ALPHA price of the 7950X/);
    expect(found.textContent).toMatch(/ALPHA thermal paste choice/);
    expect(found.textContent).not.toMatch(/socket wattage/);
    const item = within(found).getAllByRole("listitem").find((l) => l.textContent?.includes("RAM kits"))!;
    expect(item.textContent).toMatch(/run of 22 Nov 2026/i);
    expect(within(item).getByTestId("need-run").getAttribute("data-run")).toBe(S2);
  });
  it("FAILS if any appears in the gap list without a click: the list and the server's rows stay empty until 'Add to my gaps' is pressed", async () => {
    plant();
    await openDoc();
    await waitFor(() => expect(within(screen.getByTestId("cov-found")).getAllByRole("listitem").length).toBe(5));
    await new Promise((r) => setTimeout(r, 100));
    expect(items("cov-mine").length).toBe(0);
    expect(gaps.rows()).toEqual([]);
    expect(gapPosts()).toEqual([]);
    const item = within(screen.getByTestId("cov-found")).getAllByRole("listitem").find((l) => l.textContent?.includes("price of the 7950X"))!;
    fireEvent.click(within(item).getByRole("button", { name: /add to my gaps/i }));
    await waitFor(() => expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1));
    expect(gapPosts().map((b) => b.body)).toEqual([{ path: CPU, text: "ALPHA price of the 7950X", origin: "research" }]);
    // once on the list the need says so and offers nothing twice
    const again = within(screen.getByTestId("cov-found")).getAllByRole("listitem").find((l) => l.textContent?.includes("price of the 7950X"))!;
    expect(within(again).queryByRole("button", { name: /add to my gaps/i })).toBeNull();
    expect(again.textContent).toMatch(/on your list/i);
  });
  it("a failed read of the runs says so and leaves your own gaps working", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA mine" });
    plant();
    const real = gaps.handle;
    vi.spyOn(gaps, "handle").mockImplementation((w, m, u, b) => (u.includes("/documents/coverage") ? { status: 500, body: { error: "internal" } } : real(w, m, u, b)));
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-found-err").textContent).toMatch(/could not read/i));
    expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1);
  });
});

describe("research the ticked gaps in one run", () => {
  it("the button names how many are ticked and is disabled for none; ticking two sends ONE request with both ids and both move to being researched under one run", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    const g2 = gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    gaps.plantGap(A, { path: CPU, text: "ALPHA third" });
    await openDoc();
    await waitFor(() => expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(3));
    const btn = () => screen.getByTestId("cov-research") as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    expect(btn().textContent).toBe("Research the 1 ticked gap (one run)");
    fireEvent.click(screen.getByTestId("gap-tick-" + g2.id));
    expect(btn().textContent).toBe("Research the 2 ticked gaps (one run)");
    fireEvent.click(btn());
    fireEvent.click(btn()); // a second press while the first is out sends nothing
    await waitFor(() => expect(within(screen.getByTestId("cov-researching")).getAllByRole("listitem").length).toBe(2));
    const sent = bodies.filter((b) => b.method === "POST" && b.url === "/workbench/contract/gaps/research");
    expect(sent.length).toBe(1);
    expect(new Set(sent[0].body.ids)).toEqual(new Set([g1.id, g2.id]));
    expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1);
    expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage 1");
    const runs = within(screen.getByTestId("cov-researching")).getAllByTestId("gap-run").map((e) => e.getAttribute("data-run"));
    expect(new Set(runs).size).toBe(1);
    expect(btn().disabled).toBe(true);
  });
  it("when the research service says no, the tab says it and the gaps stay open and ticked-able; no 'started' message", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    gaps.setQueue("off");
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("gap-tick-" + g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(screen.getByTestId("cov-err").textContent).toMatch(/research is not available/i));
    expect(screen.queryAllByTestId("toast").length).toBe(0);
    expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1);
    expect(items("cov-researching").length).toBe(0);
  });
  it("a gap that changed elsewhere (409) or is gone (404) re-reads the list and says so", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("gap-tick-" + g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    gaps.rows().length = 0; // gone on the server
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(screen.getByTestId("cov-err").textContent).toMatch(/no longer there/i));
    await waitFor(() => expect(items("cov-mine").length).toBe(0));
    expect((screen.getByTestId("cov-research") as HTMLButtonElement).disabled).toBe(true);
  });
  it("rotating out: a finished run that covered a gap moves it to covered on the next check; the others come back to open", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    const g2 = gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("gap-tick-" + g1.id)).toBeTruthy());
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    fireEvent.click(screen.getByTestId("gap-tick-" + g2.id));
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(within(screen.getByTestId("cov-researching")).getAllByRole("listitem").length).toBe(2));
    expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage");
    const job = gaps.rows()[0].job_id!;
    gaps.finishRun(job, { covers: [g1.id] });
    fireEvent.click(screen.getByTestId("cov-recheck"));
    await waitFor(() => expect(within(screen.getByTestId("cov-covered")).getAllByRole("listitem").length).toBe(1));
    expect(within(screen.getByTestId("cov-covered")).getAllByRole("listitem")[0].textContent).toMatch(/first/);
    expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1);
    expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage 1");
  });
  it("Mark covered and Reopen use PATCH on the one gap", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    const row = await waitFor(() => rowOf(g1.id));
    fireEvent.click(within(row).getByRole("button", { name: /mark covered/i }));
    await waitFor(() => expect(within(screen.getByTestId("cov-covered")).getAllByRole("listitem").length).toBe(1));
    expect(writes().map((b) => [b.method, b.url, b.body])).toEqual([["PATCH", `/workbench/contract/gaps/${g1.id}`, { state: "covered" }]]);
    fireEvent.click(within(screen.getByTestId("cov-covered")).getByRole("button", { name: /reopen/i }));
    await waitFor(() => expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1));
    expect(gaps.rows()[0].state).toBe("open");
  });
});

describe("destructive confirmations are keyed per gap and lock the other destructive buttons", () => {
  it("Remove asks first for THAT gap; while it is open the other Remove buttons are disabled; Keep closes it and nothing is deleted", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    const g2 = gaps.plantGap(A, { path: CPU, text: "ALPHA second" });
    await openDoc();
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /^remove/i }));
    expect(screen.getByTestId("gap-remove-ok-" + g1.id)).toBeTruthy();
    expect(screen.queryByTestId("gap-remove-ok-" + g2.id)).toBeNull();
    expect((within(rowOf(g2.id)).getByRole("button", { name: /^remove/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toEqual([]);
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /keep/i }));
    expect(screen.queryByTestId("gap-remove-ok-" + g1.id)).toBeNull();
    expect((within(rowOf(g2.id)).getByRole("button", { name: /^remove/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(writes()).toEqual([]);
    fireEvent.click(within(rowOf(g2.id)).getByRole("button", { name: /^remove/i }));
    fireEvent.click(screen.getByTestId("gap-remove-ok-" + g2.id));
    await waitFor(() => expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1));
    expect(writes().map((b) => [b.method, b.url])).toEqual([["DELETE", `/workbench/contract/gaps/${g2.id}`]]);
  });
});

describe("two identities: bob never sees alice's gaps or needs, counts, totals or messages", () => {
  const plant = () => {
    gaps.plantGap(A, { path: CPU, text: `ALPHA ${MARK} what is the TDP?` });
    gaps.plantGap(A, { path: CPU, text: `ALPHA ${MARK} researching one`, state: "researching", job_id: "9a900000-0000-4000-8000-0000000000a1" });
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: `ALPHA ${MARK} need`, status: "open" }] });
    gaps.plantGap(B, { path: BRAVO, text: "BRAVO own gap" });
    gaps.plantSession({ owner_sub: B.sub, path: BRAVO, id: SB, needs: [{ need: "BRAVO own need", status: "open" }] });
  };
  it("bob on his own document sees only his own gap and need, a count of his own, and no trace of alice's marker anywhere on the page or in what was sent", async () => {
    plant(); who = "bob";
    await openDoc(BRAVO);
    await waitFor(() => expect(screen.getByTestId("dtab-coverage").textContent).toBe("Coverage 1"));
    await waitFor(() => expect(within(screen.getByTestId("cov-found")).getAllByRole("listitem").length).toBe(1));
    expect(panel().textContent).toMatch(/BRAVO own gap/);
    expect(document.body.innerHTML).not.toMatch(new RegExp(`${MARK}|ALPHA`));
    expect(JSON.stringify(bodies.filter((b) => b.who === "bob").map((b) => b.url))).not.toContain("k-a");
  });
  it("the server side the tab relies on: another user's gap, a missing one and a malformed id are the same bytes; research with a foreign id is the same refusal as a missing one", () => {
    plant();
    const foreign = gaps.rows().find((r) => r.owner_sub === A.sub)!.id;
    const missing = "9a900000-0000-4000-8000-00000000ffff";
    for (const [m, body] of [["GET", undefined], ["PATCH", { state: "covered" }], ["DELETE", undefined]] as const) {
      expect(gaps.handle(B, m, `/workbench/contract/gaps/${foreign}`, body)).toEqual(gaps.handle(B, m, `/workbench/contract/gaps/${missing}`, body));
      expect(gaps.handle(B, m, `/workbench/contract/gaps/${foreign}`, body)).toEqual(gaps.handle(B, m, `/workbench/contract/gaps/not-an-id`, body));
    }
    expect(gaps.handle(B, "POST", "/workbench/contract/gaps/research", { ids: [foreign] })).toEqual(gaps.handle(B, "POST", "/workbench/contract/gaps/research", { ids: [missing] }));
    expect(gaps.handle(B, "POST", "/workbench/contract/gaps/research", { ids: [foreign, gaps.rows().find((r) => r.owner_sub === B.sub)!.id] })).toEqual(gaps.handle(B, "POST", "/workbench/contract/gaps/research", { ids: [missing] }));
    expect(gaps.handle(B, "GET", `/workbench/contract/sessions/${S1}/coverage`)).toEqual(gaps.handle(B, "GET", `/workbench/contract/sessions/${"5e550000-0000-4000-8000-0000000000ff"}/coverage`));
    expect(gaps.handle(B, "GET", `/workbench/contract/documents/coverage?path=${CPU}`)).toEqual(gaps.handle(B, "GET", `/workbench/contract/documents/coverage?path=documents/k-c/none.md`));
    expect(gaps.handle(B, "POST", "/workbench/contract/gaps", { path: CPU, text: "x" })).toEqual(gaps.handle(B, "POST", "/workbench/contract/gaps", { path: "documents/k-a/none.md", text: "x" }));
    const list = gaps.handle(B, "GET", "/workbench/contract/gaps")!;
    expect(JSON.stringify(list.body)).not.toContain(MARK);
    expect(list.body.total).toBe(1);
    expect(list.body.counts).toEqual({ open: 1, researching: 0, covered: 0, dismissed: 0 });
    // the 409 names only the caller's OWN gap, even when alice has the same text on the same path
    gaps.handle(B, "POST", "/workbench/contract/gaps", { path: "documents/k-b/bravo.md", text: "same words" });
    const dup = gaps.handle(B, "POST", "/workbench/contract/gaps", { path: "documents/k-b/bravo.md", text: "same words" })!;
    expect(dup.status).toBe(409);
    expect(dup.body.detail.existing.id).toBe(gaps.rows().find((r) => r.owner_sub === B.sub && r.text === "same words")!.id);
  });
  it("bob opening alice's document gets the one missing-document sentence, no gap request carries her path, and the tab never mounts", async () => {
    plant(); who = "bob";
    window.history.pushState({}, "", href(CPU));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("doc-gone")).toBeTruthy());
    expect(screen.queryByTestId("in-this-doc")).toBeNull();
    expect(bodies.some((b) => b.url.includes("contract/gaps") || b.url.includes("coverage"))).toBe(false);
  });
  it("when the person changes without a reload, the draft, the open Remove question, the messages and the ticks are gone, and nothing of alice is asked under bob", async () => {
    const g1 = gaps.plantGap(A, { path: CPU, text: `ALPHA ${MARK} first` });
    gaps.plantGap(A, { path: CPU, text: `ALPHA ${MARK} second` });
    gaps.setQueue("off");
    window.history.pushState({}, "", href(CPU));
    const route = () => ({ route: parseRoute(window.location.pathname), params: { ref: uid(CPU) }, whoAnswered: true });
    const ui = (subject: string) => <ToastProvider><DocumentScreen {...route()} subject={subject} /></ToastProvider>;
    const r = render(ui("u-alice"));
    await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dtab-coverage"));
    await waitFor(() => expect(rowOf(g1.id)).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: `ALPHA ${MARK} unsent draft` } });
    fireEvent.click(screen.getByTestId("gap-tick-" + g1.id));
    fireEvent.click(screen.getByTestId("cov-research")); // fails: an error message is up
    await waitFor(() => expect(screen.getByTestId("cov-err")).toBeTruthy());
    fireEvent.click(within(rowOf(g1.id)).getByRole("button", { name: /^remove/i })); // a confirmation is open
    expect(screen.getByTestId("gap-remove-ok-" + g1.id)).toBeTruthy();
    who = "bob";
    const n = bodies.length;
    act(() => resetState());
    r.rerender(ui("u-bob"));
    await waitFor(() => expect(screen.getByTestId("doc-gone")).toBeTruthy());
    expect(document.body.innerHTML).not.toMatch(new RegExp(`${MARK}|ALPHA`));
    expect(bodies.slice(n).some((b) => b.method !== "GET" && b.url.includes("contract/gaps"))).toBe(false);
    expect(JSON.stringify(bodies.slice(n))).not.toContain(MARK);
    expect(gaps.rows().filter((x) => x.owner_sub === B.sub)).toEqual([]);
  });
  it("a write after a silent change of person sends nothing under the new session and says so", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: "ALPHA draft" } });
    who = "bob"; // the session is bob's; this page has not been told
    fireEvent.click(screen.getByTestId("cov-add"));
    await waitFor(() => expect(screen.getByTestId("cov-err").textContent).toMatch(/could not confirm that you are still/i));
    expect(gapPosts()).toEqual([]);
  });
});

describe("nothing private in the browser or on shared surfaces", () => {
  it("after reading, adding, researching and removing, the browser holds no marker, no gap text, and the page title is the app's", async () => {
    gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, needs: [{ need: `ALPHA ${MARK} need`, status: "open" }] });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    fireEvent.change(screen.getByTestId("cov-box"), { target: { value: `ALPHA ${MARK} typed` } });
    fireEvent.click(screen.getByTestId("cov-add"));
    await waitFor(() => expect(within(screen.getByTestId("cov-mine")).getAllByRole("listitem").length).toBe(1));
    const id = idOf(within(screen.getByTestId("cov-mine")).getAllByRole("listitem")[0]);
    fireEvent.click(screen.getByTestId("gap-tick-" + id));
    fireEvent.click(screen.getByTestId("cov-research"));
    await waitFor(() => expect(within(screen.getByTestId("cov-researching")).getAllByRole("listitem").length).toBe(1));
    const keep = (s: Storage) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join("\n");
    expect(keep(window.localStorage) + keep(window.sessionStorage)).not.toMatch(new RegExp(`${MARK}|ALPHA|gap`, "i"));
    expect(document.title).not.toMatch(new RegExp(`${MARK}|ALPHA`));
    // the only settings keys written are the account's ui-state keys (the screen's own Last document; none by this tab)
    const keys = bodies.filter((b) => b.method !== "GET" && b.url.startsWith("/workbench/settings")).map((b) => decodeURIComponent(b.url.split("/").pop()!));
    expect(keys.filter((k) => !["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"].includes(k))).toEqual([]);
  });
  it("the tab's source keeps nothing in the browser and uses no select or datalist", () => {
    const src = ["CoverageTab.tsx", "coverage-data.ts", "coverage.css"].map((f) => readFileSync(`src/screens/document-editor/${f}`, "utf8")).join("\n");
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.title|<select|<datalist|document\.cookie/);
  });
  it("the panel holds no select or datalist when rendered", async () => {
    gaps.plantGap(A, { path: CPU, text: "ALPHA first" });
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("cov-box")).toBeTruthy());
    expect(panel().querySelector("select, datalist")).toBeNull();
  });
});

describe("the tab strip", () => {
  it("other tabs still say they are not built yet; Coverage is built and its panel is the tab's own", async () => {
    await openDoc(CPU, false);
    const strip = screen.getByTestId("in-this-doc");
    fireEvent.click(within(strip).getByRole("tab", { name: "Topics" }));
    expect(within(strip).getByRole("tabpanel").textContent).toMatch(/Topics is not built yet/);
    fireEvent.click(within(strip).getByRole("tab", { name: /Coverage/ }));
    expect(within(strip).getByRole("tabpanel").textContent).not.toMatch(/not built yet/);
  });
});
