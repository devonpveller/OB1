// Attempt-4 attack tests (tester wt-t-doc-refs4, evidence attempt4/attack-refs4.test.tsx), adopted: R1 (N11: the whole text replaced with the cursor
// at the very end), R2 decided (a REPLACEMENT that ends at the cursor places nothing), plus the guard that a plain deletion ending at the cursor and
// typing at it still place.
// Attempt-1 attack tests for the References tab (tester wt-t-doc-refs, evidence attempt1/attack-refs.test.tsx), adopted and tightened:
// D1-D7 and the two surviving mutants (M9, M17) each have a case here. Same stub as test/doc-refs.test.tsx.
// (original header) The References tab of the document screen (rwr-doc-refs), against the shared fake back end (e2e/refs-fake.mjs: the same
// one the e2e stub runs; it copies the workbench's pending-refs, references, candidates, diff-check and quality routes).
// One describe per acceptance item of the anchor, then the house rules (a change of person, storage, selects, honesty).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
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
const newTokens = () => (text().match(/\[@ref:[0-9a-f-]{36}\]/g) ?? []).filter((x) => !x.includes(REF_SOCKET));
const rowsNew = () => pendingIds().filter((r) => r.source_id === S_NEW).length;
const msgNow = () => screen.queryByTestId("refs-msg")?.textContent ?? "";
const failFlight = async (prep: () => void) => {
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
  await wait(1200);
  return row;
};
const pasteTok = () => /The board fits it\.(\[@ref:[0-9a-f-]{36}\])/.exec(text())![1];
describe("ATTEMPT4 ATTACKS: N9 (every copy)", () => {
  it("A1 token pasted THREE times (4 copies) then the save fails", async () => {
    await failFlight(() => { const m = pasteTok(); const v = view(); for (let k = 0; k < 3; k++) v.dispatch({ changes: { from: v.state.doc.length, insert: "\nPASTE" + k + " " + m } }); });
    expect(newTokens().length).toBe(0);
    expect(rowsNew()).toBe(1);
  });
  it("A1b three adjacent pastes (token token token)", async () => {
    await failFlight(() => { const m = pasteTok(); const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\n" + m + m + m } }); });
    expect(newTokens().length).toBe(0);
    expect(rowsNew()).toBe(1);
  });
  it("A2 token pasted, then the PASTED copy edited (an id char changed)", async () => {
    await failFlight(() => { const m = pasteTok(); const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\nP " + m } });
      const t = text(); const at = t.lastIndexOf("[@ref:"); v.dispatch({ changes: { from: at + 10, to: at + 11, insert: "Z" } }); });
    expect(newTokens().length > 0 && rowsNew() > 0).toBe(false);
    expect(newTokens().length).toBe(0);
  });
  it("A2b token pasted, then the ORIGINAL copy edited (id char changed)", async () => {
    await failFlight(() => { const m = pasteTok(); const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\nP " + m } });
      const t = text(); const at = t.indexOf("[@ref:", t.indexOf(BOARD)); v.dispatch({ changes: { from: at + 10, to: at + 11, insert: "Z" } }); });
    expect(newTokens().length > 0 && rowsNew() > 0).toBe(false);
    expect(newTokens().length).toBe(0);
  });
  it("A2c token pasted, the pasted copy has its closing bracket removed", async () => {
    await failFlight(() => { const m = pasteTok(); const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\nP " + m } });
      const t = text(); v.dispatch({ changes: { from: t.length - 1, to: t.length } }); });
    expect(newTokens().length > 0 && rowsNew() > 0).toBe(false);
  });
});
describe("ATTEMPT4 ATTACKS: N10 (replaced text)", () => {
  const atEnd = () => { const v = view(); v.dispatch({ selection: { anchor: v.state.doc.length } }); };
  const flight = async (cursor: () => void) => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    act(cursor);
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    return { row, open };
  };
  const inMid = () => { const v = view(); const at = v.state.doc.toString().indexOf(BOARD) + BOARD.length; v.dispatch({ selection: { anchor: at } }); };
  it("R1 whole-text replace, cursor at the VERY END (success path)", async () => {
    const { open } = await flight(atEnd);
    act(() => { const v = view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Other\n\nTheir version of the text.\n" } }); });
    open();
    await wait(1200);
    expect(newTokens().length).toBe(0);
    expect(rowsNew()).toBe(1);
    expect(msgNow()).toMatch(/^Not placed/);
    expect(msgNow()).not.toMatch(/at the cursor/);
  });
  it("R1b same, but the file then fails to save", async () => {
    const { open } = await flight(atEnd);
    act(() => { const v = view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Other\n\nTheir version.\n" } }); });
    breakSave();
    open();
    await wait(1200);
    expect(newTokens().length > 0 && rowsNew() > 0).toBe(false);
    expect(newTokens().length + rowsNew()).toBe(1);
  });
  it("R2 replace of a range that ENDS EXACTLY at the cursor", async () => {
    const { open } = await flight(inMid);
    act(() => { const v = view(); const at = text().indexOf(BOARD); v.dispatch({ changes: { from: at, to: at + BOARD.length, insert: "The board is rewritten." } }); });
    open();
    await wait(1200);
    // decided: the sentence the person pointed after was rewritten, so nothing is placed and the cite is back in To place
    expect(newTokens().length).toBe(0);
    expect(rowsNew()).toBe(1);
    expect(msgNow()).toMatch(/^Not placed/);
  });
  it("R3 whole-text replace with IDENTICAL text, cursor mid-document", async () => {
    const { open } = await flight(inMid);
    act(() => { const v = view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: v.state.doc.toString() } }); });
    open();
    await wait(1200);
    expect(newTokens().length + rowsNew()).toBe(1);
    if (newTokens().length === 1) expect(msgNow()).toMatch(/Placed/); else expect(msgNow()).toMatch(/replaced/);
  });
  it("R3b identical replace of only the sentence around the cursor (with 3 chars each side)", async () => {
    const { open } = await flight(inMid);
    act(() => { const v = view(); const at = text().indexOf(BOARD); v.dispatch({ changes: { from: at - 3, to: at + BOARD.length + 3, insert: text().slice(at - 3, at + BOARD.length + 3) } }); });
    open();
    await wait(1200);
    expect(newTokens().length + rowsNew()).toBe(1);
    if (newTokens().length === 1) expect(msgNow()).toMatch(/Placed/); else expect(msgNow()).toMatch(/replaced/);
  });
  it("R4 replace spanning the cursor, then the file fails to save", async () => {
    const { open } = await flight(inMid);
    act(() => { const v = view(); const at = text().indexOf(BOARD); v.dispatch({ changes: { from: at + 2, to: at + 10, insert: "QQ" } }); });
    breakSave();
    open();
    await wait(1200);
    expect(newTokens().length + rowsNew()).toBe(1);
  });
  it("R5 two transactions: one above, one spanning the cursor", async () => {
    const { open } = await flight(inMid);
    act(() => { const v = view(); v.dispatch({ changes: { from: 0, insert: "AAA " } }); const at = text().indexOf(BOARD); v.dispatch({ changes: { from: at, to: at + BOARD.length + 1, insert: "X" } }); });
    open();
    await wait(1200);
    expect(newTokens().length + rowsNew()).toBe(1);
  });
});

describe("a plain deletion ending at the cursor still places (only a replacement is lost)", () => {
  it("S1 backspace of the character before the cursor while the place is in flight: the citation is placed", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    act(() => { const v = view(); const at = v.state.doc.toString().indexOf(BOARD) + BOARD.length; v.dispatch({ selection: { anchor: at } }); });
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    act(() => { const v = view(); const at = text().indexOf(BOARD) + BOARD.length; v.dispatch({ changes: { from: at - 1, to: at } }); });
    open();
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(500);
    expect(newTokens().length).toBe(1);
    expect(msgNow()).toMatch(/^Placed/);
  });
  it("S2 a whole-text replace with the cursor mid-text (the other version has no such sentence) places nothing", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    act(() => { const v = view(); const at = v.state.doc.toString().indexOf(BOARD) + BOARD.length; v.dispatch({ selection: { anchor: at } }); });
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    act(() => { const v = view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Other\n\nTheir version.\n" } }); });
    open();
    await wait(1000);
    expect(newTokens().length).toBe(0);
    expect(rowsNew()).toBe(1);
  });
});
