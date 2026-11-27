// Attempt-3 attack tests (tester wt-t-doc-refs3, evidence attempt3/attack-refs3.test.tsx), adopted and tightened: N9 (every copy of the token is
// removed), N10 (a replaced text means nothing is placed), T2b (the token is gone: nothing requeued; kills M36/M38), P5 (M34: typing AT the cursor).
// Attempt-1 attack tests for the References tab (tester wt-t-doc-refs, evidence attempt1/attack-refs.test.tsx), adopted and tightened:
// D1-D7 and the two surviving mutants (M9, M17) each have a case here. Same stub as test/doc-refs.test.tsx.
// (original header) The References tab of the document screen (rwr-doc-refs), against the shared fake back end (e2e/refs-fake.mjs: the same
// one the e2e stub runs; it copies the workbench's pending-refs, references, candidates, diff-check and quality routes).
// One describe per acceptance item of the anchor, then the house rules (a change of person, storage, selects, honesty).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { App } from "../src/App";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { uid } from "../e2e/docs-fake.mjs";
import { CPU, createRefsFake, PEOPLE, REF_SOCKET, S_NEW } from "../e2e/refs-fake.mjs";

configure({ asyncUtilTimeout: 5000 });
const fake = createRefsFake({ now: () => Date.now() });
let who: "alice" | "bob" = "alice";
let bodies: { method: string; url: string; body: any; who: string }[] = [];
let failPendingGet = false;
let diffGate: Promise<void> | null = null;
let placeGate: Promise<void> | null = null;
let failHolders = false;
let putGate: Promise<void> | null = null;
let diffHook: (() => void) | null = null;
let flipAfterHolders = false;
const settings = new Map<string, { value: unknown; version: number }>();
const href = (p: string) => "/documents/d/" + uid(p);

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
    if (path === "/workbench/settings") return j({ settings: [...settings].map(([key, v]) => ({ key, ...v })) });
    const sm = /^\/workbench\/settings\/(.+)$/.exec(path);
    if (sm) {
      const k = decodeURIComponent(sm[1]);
      const n = (settings.get(k)?.version ?? 0) + 1;
      if (method === "DELETE") { settings.set(k, { value: null, version: n }); return j({ key: k, value: null, version: n }); }
      settings.set(k, { value: body.value, version: n });
      return j({ key: k, value: body.value, version: n });
    }
    if (flipAfterHolders && method === "GET" && path === "/workbench/documents/references") { const r1 = fake.handle(who, method, u, body ?? {})!; flipAfterHolders = false; who = "bob"; return j(r1.body, r1.status); }
    if (failHolders && method === "GET" && path === "/workbench/documents/references") return j({ error: "internal" }, 500);
    if (failPendingGet && method === "GET" && path === "/workbench/contract/documents/pending-refs") return j({ error: "internal" }, 500);
    if (diffGate && method === "POST" && path === "/workbench/contract/diff-check") {
      const r = fake.handle(who, method, u, body ?? {})!;
      const g = diffGate; await g;
      return j(r.body, r.status);
    }
    if (putGate && method === "PUT" && path === "/workbench/documents/file") { await putGate; }
    if (method === "POST" && path === "/workbench/contract/diff-check" && diffHook) { const r1 = fake.handle(who, method, u, body ?? {})!; const h = diffHook; diffHook = null; const res = j(r1.body, r1.status); h(); return res; }
    if (placeGate && method === "POST" && path.endsWith("/place")) { const r0 = fake.handle(who, method, u, body ?? {})!; await placeGate; return j(r0.body, r0.status); }
    const r = fake.handle(who, method, u, body ?? {});
    if (r) return j(r.body, r.status);
    if (path === "/workbench/contract/sessions") return j({ sessions: [] });
    if (path === "/workbench/intake/jobs") return j({ jobs: [] });
    if (path === "/workbench/contract/cleanup/sources") return j({ sources: [], total: 0 });
    if (path === "/workbench/contract/cleanup/reopen-candidates") return j({ candidates: [] });
    return j({ error: "not found" }, 404);
  });
}

const openDoc = async (p = CPU) => {
  window.history.pushState({}, "", href(p));
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId("doc-version").textContent).toMatch(/^v\d/));
};
const openRefs = async () => {
  await openDoc();
  await waitFor(() => expect(screen.getByTestId("cited-list")).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId("toplace-list")).toBeTruthy());
};
const view = () => EditorView.findFromDOM(screen.getByTestId("doc-editor").querySelector(".cm-editor") as HTMLElement)!;
const text = () => view().state.doc.toString();
const cursorAfter = (s: string) => act(() => { const v = view(); const at = v.state.doc.toString().indexOf(s) + s.length; v.dispatch({ selection: { anchor: at } }); });
const rowsOf = (list: string, row: string) => within(screen.getByTestId(list)).queryAllByTestId(row);
const queued = () => rowsOf("toplace-list", "toplace-row").map((r) => r.getAttribute("data-id")!);
const sent = (re: RegExp, method = "POST") => bodies.filter((b) => b.method === method && re.test(b.url));
const pendingIds = (person: "alice" | "bob" = "alice") => [...fake.state().pending.values()].filter((r) => r.owner === PEOPLE[person].sub);
const queueRow = (pred: (r: { source_id: string | null; claim_id: string | null }) => boolean) => pendingIds().find(pred)!;

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); fake.reset(); settings.clear(); who = "alice"; failPendingGet = false; diffGate = null; placeGate = null; failHolders = false; putGate = null; diffHook = null; flipAfterHolders = false;
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));


const breakSave = () => { const d = fake.db().docs.get(CPU)!; d.body = d.body + "\nOTHER BROWSER EDIT\n"; delete d.raw; };
const citeAfterBoard = () => /The board fits it\.\[@ref:/.test(text());
const gatePut = () => { let open: () => void = () => {}; putGate = new Promise<void>((r) => { open = r; }); return () => open(); };


const gatePlace = () => { let open: () => void = () => {}; placeGate = new Promise<void>((r) => { open = r; }); return () => open(); };
const BOARD = "The board fits it.";
const flightPlace = async (prep: () => void) => {
  await openRefs();
  const row = queueRow((r) => r.source_id === S_NEW);
  cursorAfter(BOARD);
  const open = gatePlace();
  fireEvent.click(screen.getByTestId(`place-${row.id}`));
  await wait(100);
  act(prep);
  open();
  await waitFor(() => expect(queued()).not.toContain(row.id));
  await wait(400);
  return row;
};

describe("ATTEMPT3 ATTACKS: mapPos", () => {
  it("P1 an edit SPANNING the cursor (replace a range around it)", async () => {
    await flightPlace(() => { const v = view(); const at = text().indexOf(BOARD); v.dispatch({ changes: { from: at + 4, to: at + 12, insert: "XX" } }); });
    const t = text(); 
    expect(t).toContain("The XXts it.");
    expect(t).toMatch(/The XXts it\.\[@ref:|The XX\[@ref:/);
  });
  it("P2 delete the text that holds the cursor (the whole sentence)", async () => {
    await flightPlace(() => { const v = view(); const at = text().indexOf(BOARD); v.dispatch({ changes: { from: at, to: at + BOARD.length } }); });
    const t = text(); 
    expect(t).not.toContain(BOARD);
    expect(t.includes("[@ref:")).toBe(true);
  });
  it("P3 undo during flight", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    act(() => { view().dispatch({ changes: { from: 0, insert: "ZZZ " }, userEvent: "input.type" }); });
    cursorAfter(BOARD);
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    act(() => { undo(view()); });
    expect(text().startsWith("ZZZ")).toBe(false);
    open();
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(400);
    const t = text(); 
    expect(t).toMatch(/The board fits it\.\[@ref:/);
  });
  it("P3b redo during flight", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    act(() => { view().dispatch({ changes: { from: 0, insert: "ZZZ " }, userEvent: "input.type" }); });
    act(() => { undo(view()); });
    cursorAfter(BOARD);
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    act(() => { redo(view()); });
    expect(text().startsWith("ZZZ")).toBe(true);
    open();
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(400);
    const t = text(); 
    expect(t).toMatch(/The board fits it\.\[@ref:/);
  });
  it("P4 two places in flight: the second Place button is disabled, no second request", async () => {
    await openRefs();
    const rows = pendingIds();
    const a = rows.find((r) => r.source_id === S_NEW)!;
    const other = rows.find((r) => r.id !== a.id)!;
    cursorAfter(BOARD);
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${a.id}`));
    await wait(100);
    const b2 = screen.getByTestId(`place-${other.id}`) as HTMLButtonElement;
    expect(b2.disabled).toBe(true);
    fireEvent.click(b2);
    await wait(100);
    open();
    await wait(600);
    expect(sent(/\/place$/).length).toBe(1);
  });
  it("P4b two places one after the other: the second lands at ITS cursor", async () => {
    await openRefs();
    const rows = pendingIds();
    const a = rows.find((r) => r.source_id === S_NEW)!;
    cursorAfter(BOARD);
    fireEvent.click(screen.getByTestId(`place-${a.id}`));
    await waitFor(() => expect(queued()).not.toContain(a.id));
    await wait(500);
    const left = queued();
    expect(left.length).toBeGreaterThan(0);
    await wait(700); (document.activeElement as HTMLElement | null)?.blur(); await wait(300);
    act(() => { const v = view(); const at = v.state.doc.toString().indexOf("## Power") + 8; v.dispatch({ selection: { anchor: at } }); });
    fireEvent.click(screen.getByTestId(`place-${left[0]}`));
    await wait(1500);
    const t = text(); 
    expect(t).toMatch(/## Power(\[@ref:|\{\{ref)/);
  });
  it("P5 typing AT the cursor during flight", async () => {
    await flightPlace(() => { const v = view(); const at = text().indexOf(BOARD) + BOARD.length; v.dispatch({ changes: { from: at, insert: " TYPED" } }); });
    const t = text(); 
    expect(t).toContain("TYPED");
    // M34: the citation is where the person pointed (the cursor is carried with association before the typed text)
    expect(t).toMatch(/The board fits it\.\[@ref:[0-9a-f-]{36}\] TYPED/);
  });
});

describe("ATTEMPT3 ATTACKS: token revert", () => {
  const fail = async (prep: () => void) => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter(BOARD);
    breakSave();
    const open = gatePut();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(citeAfterBoard()).toBe(true));
    await wait(150);
    act(prep);
    open();
    await wait(1000);
    return row;
  };
  const newTokens = () => (text().match(/\[@ref:[0-9a-f-]{36}\]/g) ?? []).filter((x) => !x.includes(REF_SOCKET));
  it("T1 the token is DUPLICATED (copy-paste) while the save is in flight and fails", async () => {
    await fail(() => { const t = text(); const m = /The board fits it\.(\[@ref:[0-9a-f-]{36}\])/.exec(t)!; const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\nPASTED " + m[1] } }); });
    const n = pendingIds().filter((r) => r.source_id === S_NEW).length;
    expect(newTokens().length).toBe(0);
    expect(n).toBe(1);
    expect(screen.getByTestId("refs-msg").textContent).toMatch(/back in To place/);
  });
  it("T2 the token is edited (typing inside it)", async () => {
    await fail(() => { const t = text(); const at = t.indexOf("[@ref:", t.indexOf(BOARD)); view().dispatch({ changes: { from: at + 8, insert: "Q" } }); });
    const n = pendingIds().filter((r) => r.source_id === S_NEW).length;
    const t = text();
    expect(citeAfterBoard() && n > 0).toBe(false);
    expect(/\[@ref:[0-9a-f-]*Q/.test(t)).toBe(false);
  });
  it("T2b the token is deleted by the person while the save is in flight", async () => {
    await fail(() => { const t = text(); const at = t.indexOf("[@ref:", t.indexOf(BOARD)); view().dispatch({ changes: { from: at, to: at + 43 } }); });
    const msg = screen.queryByTestId("refs-msg")?.textContent ?? "";
    expect(citeAfterBoard()).toBe(false);
    expect(pendingIds().filter((r) => r.source_id === S_NEW).length).toBe(0); // the token is gone: NOT requeued (kills M36 / M38)
    expect(msg).toMatch(/no longer in the text/);
  });
  it("T3 the document is replaced wholesale while the place (no save problem) is in flight", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter(BOARD);
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    act(() => { const v = view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Other\n\nTheir version of the text, entirely different.\n" } }); });
    open();
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(500);
    const msg = screen.queryByTestId("refs-msg")?.textContent ?? "";
    expect(newTokens().length).toBe(0);
    expect(msg).toMatch(/^Not placed/);
    expect(msg).not.toMatch(/at the cursor/);
    expect(pendingIds().filter((r) => r.source_id === S_NEW).length).toBe(1);
  });
  it("T4 reloaded while the failing save is in flight: revert still finds the token", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter(BOARD);
    breakSave();
    const open = gatePut();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(citeAfterBoard()).toBe(true));
    await wait(150);
    act(() => { const v = view(); const t = v.state.doc.toString(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t.replace("# CPU plan", "# CPU plan RELOADED") } }); });
    open();
    await wait(1000);
    const n = pendingIds().filter((r) => r.source_id === S_NEW).length;
    expect(citeAfterBoard() && n > 0).toBe(false);
  });
});

describe("requeue 409: already waiting vs the queue is full", () => {
  it("N6 the queue fills up (200) in another browser while the failing save is in flight: it says the queue is full, not 'already waiting'", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter(BOARD);
    breakSave();
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    const rows = fake.state().pending;
    for (let i = 0; i < 200; i++) {
      const id = "9e000000-0000-4000-8000-" + String(900000 + i).padStart(12, "0");
      rows.set(id, { id, owner: "u-alice", path: CPU, source_id: null, claim_id: "c1000000-0000-4000-8000-0000000000a1", section: "", quote: "q" + i, added_from: "chat", created_at: "2026-11-27T10:00:00.000Z" });
    }
    open();
    await wait(1500);
    const msg = screen.getByTestId("refs-msg").textContent ?? "";
    expect(msg).toMatch(/queue for this document is full/);
    expect(msg).not.toMatch(/already waiting/);
    expect(citeAfterBoard()).toBe(false);
  });
});
