// Attempt-2 attack tests (tester wt-t-doc-refs2, evidence attempt2/attack-refs2.test.tsx), adopted: N1 (revert by token), N2c (a 409 on the
// requeue), N3 (position carried through edits), N8 (the person flips between Add's re-read and its write: kills plan mutant M5).
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
import { CPU, createRefsFake, PEOPLE, REF_SOCKET, S_BARE, S_NEW, S_SOCKET } from "../e2e/refs-fake.mjs";

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
const searchFor = (term: string) => { fireEvent.change(screen.getByTestId("find-q"), { target: { value: term } }); fireEvent.click(screen.getByTestId("find-go")); };


const rep = "Repeated sentence that is certainly longer than forty chars.";
const breakSave = () => { const d = fake.db().docs.get(CPU)!; d.body = d.body + "\nOTHER BROWSER EDIT\n"; delete d.raw; };
const citeAfterBoard = () => /The board fits it\.\[@ref:/.test(text());
const gatePut = () => { let open: () => void = () => {}; putGate = new Promise<void>((r) => { open = r; }); return () => open(); };

describe("ATTEMPT2 ATTACKS", () => {
  it("N1 D2 revert: the person types BEFORE the citation while the save is in flight and the save conflicts", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    breakSave();
    const open = gatePut();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(citeAfterBoard()).toBe(true));
    await wait(150);
    act(() => { view().dispatch({ changes: { from: 0, insert: "TYPED-MEANWHILE " } }); });
    open();
    await wait(900);
    const t = text();
    const n = pendingIds().filter((r) => r.source_id === S_NEW).length;
    expect(t).toContain("TYPED-MEANWHILE ");
    expect(citeAfterBoard() && n > 0).toBe(false);
    expect(citeAfterBoard()).toBe(false);
  });
  it("N1b the person types AFTER the citation while the save is in flight: revert removes exactly the citation, keeps the typing", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    breakSave();
    const open = gatePut();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(citeAfterBoard()).toBe(true));
    await wait(150);
    act(() => { view().dispatch({ changes: { from: view().state.doc.length, insert: " TYPED-AT-END" } }); });
    open();
    await wait(900);
    const t = text();
    expect(t).toContain("TYPED-AT-END");
    expect(citeAfterBoard()).toBe(false);
    expect(t).toContain("The board fits it.");
    expect(pendingIds().filter((r) => r.source_id === S_NEW).length).toBe(1);
  });
  it("N1c the person types inside the citation while saving", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    breakSave();
    const open = gatePut();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(citeAfterBoard()).toBe(true));
    await wait(150);
    act(() => { const at = text().indexOf("[@ref:", text().indexOf("The board fits it.")); view().dispatch({ changes: { from: at + 3, insert: "X" } }); });
    open();
    await wait(900);
    const t = text();
    // the protected span refuses typing inside it, so the placed citation is intact: the revert removes it whole (and only it); the document's own chip stays
    expect(t).not.toMatch(/\[@ref:a9[0-9a-f-]{34}\]/);
    expect(t).toContain(`[@ref:${REF_SOCKET}]`);
  });
  it("N2 requeue cannot double-add: exactly one queue row for the source, one requeue request, none in the text", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    breakSave();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(900);
    expect(pendingIds().filter((r) => r.source_id === S_NEW).length).toBe(1);
    expect(sent(/pending-refs$/).filter((b) => b.body?.added_from === "requeue").length).toBe(1);
    expect(citeAfterBoard()).toBe(false);
  });
  it("N2b a claim row failing to save is requeued as a claim", async () => {
    await openRefs();
    const row = queueRow((r) => r.claim_id != null && r.source_id == null);
    cursorAfter("The board fits it.");
    breakSave();
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(900);
    const rq = sent(/pending-refs$/).filter((b) => b.body?.added_from === "requeue");
    expect(rq.length).toBe(1);
    expect(rq[0].body.claim_id).toBeTruthy();
  });
  it("N2c the same source queued again in another browser during the place: requeue 409 must not be reported as failure", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    breakSave();
    let open: () => void = () => {};
    placeGate = new Promise<void>((r) => { open = r; });
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    fake.handle("alice", "POST", "/workbench/contract/documents/pending-refs", { path: CPU, source_id: S_NEW, added_from: "find" });
    open();
    await wait(1200);
    const msg = screen.getByTestId("refs-msg").textContent ?? "";
    expect(pendingIds().filter((r) => r.source_id === S_NEW).length).toBe(1);
    expect(msg).toMatch(/already waiting in To place/);
    expect(msg).not.toMatch(/could not be put back/);
  });
  it("N3 D3 repeated text: cursor after the SECOND of two identical passages, text edited before it while the place is in flight", async () => {
    const d0 = fake.db().docs.get(CPU)!;
    d0.body = d0.body + `\n\n${rep}\n\nMiddle filler paragraph.\n\n${rep}\n\nTail.\n`; delete d0.raw;
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    act(() => { const v = view(); const s = v.state.doc.toString(); const at = s.lastIndexOf(rep) + rep.length; v.dispatch({ selection: { anchor: at } }); });
    let open: () => void = () => {};
    placeGate = new Promise<void>((r) => { open = r; });
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    act(() => { view().dispatch({ changes: { from: 0, insert: "EDIT-BEFORE " } }); });
    open();
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(500);
    const t = text();
    const first = t.indexOf(rep), second = t.lastIndexOf(rep);
    const afterFirst = t.slice(first + rep.length, first + rep.length + 6), afterSecond = t.slice(second + rep.length, second + rep.length + 6);
    expect(afterSecond).toMatch(/^\[@ref:/);
    expect(afterFirst).not.toMatch(/^\[@ref:/);
  });
  it("N3b no change while in flight: cursor (second occurrence) is honored", async () => {
    const d0 = fake.db().docs.get(CPU)!;
    d0.body = d0.body + `\n\n${rep}\n\nMiddle filler paragraph.\n\n${rep}\n\nTail.\n`; delete d0.raw;
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    act(() => { const v = view(); const s = v.state.doc.toString(); v.dispatch({ selection: { anchor: s.lastIndexOf(rep) + rep.length } }); });
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(300);
    const t = text(); const second = t.lastIndexOf(rep);
    expect(t.slice(second + rep.length, second + rep.length + 6)).toMatch(/^\[@ref:/);
  });
  it("N3c edit AFTER the cursor while in flight keeps the position", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    let open: () => void = () => {};
    placeGate = new Promise<void>((r) => { open = r; });
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    act(() => { view().dispatch({ changes: { from: view().state.doc.length, insert: "\nappended" } }); });
    open();
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(300);
    expect(citeAfterBoard()).toBe(true);
  });
  it("N5 Add when the re-read of the cited list fails: nothing is sent", async () => {
    await openRefs();
    searchFor("unrated");
    const add = await screen.findByTestId(`find-add-${S_BARE}`);
    failHolders = true;
    const n = bodies.length;
    fireEvent.click(add);
    await waitFor(() => expect(screen.getByTestId("refs-msg").textContent).toMatch(/could not be checked/));
    expect(bodies.slice(n).filter((b) => b.method === "POST" && /pending-refs/.test(b.url))).toEqual([]);
  });
  it("N5b a second search whose re-read fails: results of the first search do not stay", async () => {
    await openRefs();
    searchFor("ALPHA");
    await screen.findByTestId("find-results");
    failHolders = true;
    searchFor("unrated");
    await waitFor(() => expect(screen.getByTestId("find-failed")).toBeTruthy());
    expect(screen.queryAllByTestId("find-row").length).toBe(0);
  });
  it("N6 hidden-in-session tag is shown on the result and the source can still be added", async () => {
    fake.state().sources.get(S_BARE)!.hidden = true;
    await openRefs();
    searchFor("unrated");
    await waitFor(() => expect(screen.queryByTestId(`find-tags-${S_BARE}`)).toBeTruthy());
    expect(screen.getByTestId(`find-tags-${S_BARE}`).textContent).toBe("hidden in this session");
    fireEvent.click(screen.getByTestId(`find-add-${S_BARE}`));
    await waitFor(() => expect(pendingIds().some((r) => r.source_id === S_BARE)).toBe(true));
  });
  it("N4 D6 the logged race: a revision lands between the re-check and the repin; what does the page say", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    const mv = await screen.findByTestId(`repin-move-${REF_SOCKET}`);
    expect(mv.textContent).toMatch(/revision 3/);
    diffHook = () => fake.addRevision(S_SOCKET, "Socket intro, again.\n\nPer the vendor, the LGA2066 socket takes a 165 W part. Rev four.");
    fireEvent.click(mv);
    await waitFor(() => expect(text()).not.toContain(REF_SOCKET));
    const fresh = /\[@ref:([0-9a-f-]{36})\]/.exec(text())![1];
    const rev = fake.state().records.get(fresh)!.pinned_revision;
    expect(rev).toBe(4);
  });
  it("N7 Move re-check when diff-check fails: nothing moves and it says so", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    const mv = await screen.findByTestId(`repin-move-${REF_SOCKET}`);
    const orig = fake.handle.bind(fake);
    const spy = vi.spyOn(fake, "handle").mockImplementation((w: any, m: any, u: any, b: any) => (/diff-check/.test(u) ? { status: 500, body: { error: "x" } } : orig(w, m, u, b)));
    fireEvent.click(mv);
    await wait(500);
    spy.mockRestore();
    expect(sent(/\/repin/).length).toBe(0);
    expect(screen.getByTestId("refs-msg").textContent).toMatch(/could not be re-checked|changed since/);
  });
  it("N8 (M5) the person changes silently between Add's re-read of the cited list and its write: nothing is sent", async () => {
    await openRefs();
    searchFor("unrated");
    const add = await screen.findByTestId(`find-add-${S_BARE}`);
    flipAfterHolders = true;
    const n = bodies.length;
    fireEvent.click(add);
    await wait(700);
    const posts = bodies.slice(n).filter((b) => b.method === "POST" && /pending-refs/.test(b.url));
    expect(posts).toEqual([]);
  });
});
