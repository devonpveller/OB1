// Review-1 tests (reviewer wt-r-doc-refs): D1 (Add on a full queue says so), D2 (the queue read asks for 200 and says when the list is cut),
// F1 (the insert is checked; a throw never leaves the buttons disabled), F2 (M41: a copy of the token inside a protected passage), F3 (no listener
// left behind), F4 (changed or removed), F6 (Move the pin replaces every copy).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { App } from "../src/App";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { uid } from "../e2e/docs-fake.mjs";
import { C_POWER, CPU, createRefsFake, PEOPLE, REF_SOCKET, S_BARE, S_NEW } from "../e2e/refs-fake.mjs";

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

const searchFor = (term: string) => { fireEvent.change(screen.getByTestId("find-q"), { target: { value: term } }); fireEvent.click(screen.getByTestId("find-go")); };
const sent = (re: RegExp, method = "POST") => bodies.filter((b) => b.method === method && re.test(b.url));
// n more cites in alice's queue for the document (claim cites with distinct quotes), oldest first; `at` puts a source cite at that index
const plant = (n: number, extra?: { at: number; source: string }) => {
  const rows = fake.state().pending;
  for (let i = 0; i < n; i++) {
    const id = "9e000000-0000-4000-8000-" + String(800000 + i).padStart(12, "0");
    const src = extra && extra.at === i;
    rows.set(id, { id, owner: "u-alice", path: CPU, source_id: src ? extra!.source : null, claim_id: src ? null : C_POWER, section: "", quote: src ? "" : "q" + i, added_from: "chat", created_at: new Date(Date.parse("2026-11-27T10:00:00.000Z") + i * 1000).toISOString() });
  }
};

describe("D1: Add to references on a full queue says so", () => {
  it("D1 200 cites waiting: Add sends one POST, the message says the queue is full, the result keeps its Add button", async () => {
    plant(198); // the two seeded cites make 200
    await openRefs();
    searchFor("unrated");
    const add = await screen.findByTestId(`find-add-${S_BARE}`);
    const n = bodies.length;
    fireEvent.click(add);
    await waitFor(() => expect(msgNow()).toMatch(/queue for this document is full/));
    expect(bodies.slice(n).filter((b) => b.method === "POST" && /pending-refs$/.test(b.url)).length).toBe(1);
    expect(msgNow()).toMatch(/^Not added/);
    expect(screen.getByTestId(`find-add-${S_BARE}`)).toBeTruthy();
  });
  it("D1b a duplicate 409 (it is already waiting) stays a quiet 'waiting', not an error", async () => {
    await openRefs();
    searchFor("unrated");
    const add = await screen.findByTestId(`find-add-${S_BARE}`);
    fake.handle("alice", "POST", "/workbench/contract/documents/pending-refs", { path: CPU, source_id: S_BARE, added_from: "chat" });
    fireEvent.click(add);
    await waitFor(() => expect(screen.getByTestId(`find-row-${S_BARE}`).textContent).toMatch(/waiting/i));
    expect(msgNow()).toBe("");
  });
});

describe("D2: the queue is read up to 200 and the list says when it is cut", () => {
  it("D2 150 cites waiting: all 150 are listed (the read asks for limit=200) and Find knows a source waiting at row 120", async () => {
    plant(148, { at: 120, source: S_BARE });
    await openRefs();
    expect(sent(/pending-refs\?path=.*limit=200/, "GET").length).toBeGreaterThan(0);
    await waitFor(() => expect(queued().length).toBe(150));
    expect(screen.queryByTestId("toplace-cut")).toBeNull();
    searchFor("unrated");
    const row = await screen.findByTestId(`find-row-${S_BARE}`);
    expect(row.textContent).toMatch(/waiting/i);
    expect(within(row).queryByRole("button", { name: /add to references/i })).toBeNull();
  });
  it("D2b more waiting than one read holds (230 of a 200 page): the list says 'Showing 200 of 230'", async () => {
    plant(228);
    await openRefs();
    await waitFor(() => expect(queued().length).toBe(200));
    expect(screen.getByTestId("toplace-cut").textContent).toMatch(/Showing 200 of 230/);
  });
});

describe("F1 / F2 / F3: the insert is checked, a copy inside a protected passage, no listener left behind", () => {
  it("F1 the cursor ends up inside a protected passage: the editor refuses the insert, the tab says so, the cite is back, the buttons are not left disabled", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter(BOARD);
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    const U = "c1000000-0000-4000-8000-0000000000f1";
    act(() => {
      const v = view(); const at = text().indexOf(BOARD);
      v.dispatch({ changes: { from: at, insert: `{{ref:${U}}}` } });
      const end = text().indexOf(BOARD) + BOARD.length;
      v.dispatch({ changes: { from: end, insert: "{{/ref}}" } });
    });
    open();
    await wait(1500);
    expect(newTokens().length).toBe(0);
    expect(msgNow()).toMatch(/^Not placed/);
    expect(msgNow()).toMatch(/protected passage/);
    expect(rowsNew()).toBe(1);
    await waitFor(() => expect((screen.getAllByRole("button").filter((b) => /Place at cursor/.test(b.textContent ?? "")) as HTMLButtonElement[]).every((b) => !b.disabled)).toBe(true));
  });
  it("F2 (M41) a copy of the new token inside a hand-typed quoted passage, then the save fails: the revert is refused, so the cite is NOT put back and the message says to check the text", async () => {
    await failFlight(() => {
      const t = pasteTok(); const v = view();
      v.dispatch({ changes: { from: v.state.doc.length, insert: `\n{{ref:c1000000-0000-4000-8000-0000000000f2}}quoted ${t} words{{/ref}}` } });
    });
    expect(msgNow()).toMatch(/NOT put back/);
    expect(rowsNew()).toBe(0);
    expect(newTokens().length).toBeGreaterThan(0); // the text still holds it, and the person was told
  });
  it("F3 no update listener is left behind by a place (success or failure)", async () => {
    await openRefs();
    const n0 = view().state.facet(EditorView.updateListener).length;
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter(BOARD);
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(700);
    expect(view().state.facet(EditorView.updateListener).length).toBe(n0);
  });
});

describe("F4: the lost message says 'changed or removed'", () => {
  it("F4 a whole-text replace while the place is in flight", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter(BOARD);
    const open = gatePlace();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    act(() => { const v = view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Other\n\nTheir version.\n" } }); });
    open();
    await wait(1000);
    expect(msgNow()).toMatch(/changed or removed/);
    expect(msgNow()).not.toMatch(/replaced/);
  });
});

describe("F6: Move the pin replaces every copy of the citation", () => {
  it("F6 the chip is in the text twice: both become the new reference, and the message says how many", async () => {
    const d = fake.db().docs.get(CPU)!;
    d.body = d.body.replace(`[@ref:${REF_SOCKET}]`, `[@ref:${REF_SOCKET}] and again [@ref:${REF_SOCKET}]`); delete d.raw;
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    fireEvent.click(await screen.findByTestId(`repin-move-${REF_SOCKET}`));
    await waitFor(() => expect(text()).not.toContain(REF_SOCKET));
    const ids = [...text().matchAll(/\[@ref:([0-9a-f-]{36})\]/g)].map((m) => m[1]).filter((x) => x !== undefined);
    const fresh = ids.filter((x) => fake.state().records.get(x)?.source_id === fake.state().records.get(ids[0])?.source_id);
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fresh).size).toBe(1);
    expect(msgNow()).toMatch(/all 2 copies/);
  });
});
