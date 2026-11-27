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
import { CPU, createRefsFake, PEOPLE, REF_COOL, REF_POWER, REF_SOCKET, S_BARE, S_NEW, S_SOCKET } from "../e2e/refs-fake.mjs";

configure({ asyncUtilTimeout: 5000 });
const fake = createRefsFake({ now: () => Date.now() });
let who: "alice" | "bob" = "alice";
let bodies: { method: string; url: string; body: any; who: string }[] = [];
let failPendingGet = false;
let diffGate: Promise<void> | null = null;
let placeGate: Promise<void> | null = null;
let failHolders = false;
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
    if (failHolders && method === "GET" && path === "/workbench/documents/references") return j({ error: "internal" }, 500);
    if (failPendingGet && method === "GET" && path === "/workbench/contract/documents/pending-refs") return j({ error: "internal" }, 500);
    if (diffGate && method === "POST" && path === "/workbench/contract/diff-check") {
      const r = fake.handle(who, method, u, body ?? {})!;
      const g = diffGate; await g;
      return j(r.body, r.status);
    }
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
  cleanup(); clearRequestLog(); resetState(); fake.reset(); settings.clear(); who = "alice"; failPendingGet = false; diffGate = null; placeGate = null; failHolders = false;
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });

const typeAt = (needle: string, ins: string) => act(() => { const v = view(); const at = v.state.doc.toString().indexOf(needle); v.dispatch({ changes: { from: at, insert: ins } }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const searchFor = (term: string) => { fireEvent.change(screen.getByTestId("find-q"), { target: { value: term } }); fireEvent.click(screen.getByTestId("find-go")); };

describe("ATTACK", () => {
  it("A1 a confirmation whose target vanished must not leave every destructive button locked", async () => {
    await openRefs();
    const [a] = queued();
    fireEvent.click(screen.getByTestId(`toplace-remove-${a}`));
    fake.state().pending.delete(a); // another browser placed/removed it
    searchFor("unrated");
    fireEvent.click(await screen.findByTestId(`find-add-${S_BARE}`));
    await waitFor(() => expect(queued()).not.toContain(a));
    await wait(300);
    const btns = screen.getAllByRole("button").filter((b) => /^Remove$|Place at cursor/.test(b.textContent ?? ""));
    console.log("A1 destructive buttons:", btns.length, "all disabled:", btns.every((b) => (b as HTMLButtonElement).disabled));
    expect(btns.every((b) => (b as HTMLButtonElement).disabled)).toBe(false);
  });
  it("A2 two browsers: a place whose save conflicts must not say Placed", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    const d = fake.db().docs.get(CPU)!; d.body = d.body + "\nOTHER BROWSER EDIT\n"; delete d.raw;
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(600);
    console.log("A2 msg=", screen.queryByTestId("refs-msg")?.textContent, "| conflict banner:", !!screen.queryByTestId("doc-conflict"), "| row still on server:", fake.state().pending.has(row.id));
    expect(!!screen.queryByTestId("doc-conflict") && /^Placed/.test(screen.queryByTestId("refs-msg")?.textContent ?? "")).toBe(false);
    // D2: nothing was placed: the message says so, the citation is out of the text again and the cite is back in To place
    expect(screen.getByTestId("refs-msg").textContent).toMatch(/^Not placed/);
    expect(screen.getByTestId("refs-msg").textContent).toMatch(/back in To place/);
    expect(text()).not.toMatch(/The board fits it\.\[@ref:/);
    await waitFor(() => expect(pendingIds().some((r) => r.source_id === S_NEW)).toBe(true));
    await waitFor(() => expect(queued().length).toBe(2));
    expect(sent(/pending-refs$/).some((b) => b.body?.added_from === "requeue" && b.body?.source_id === S_NEW)).toBe(true);
  });
  it("A3 an edit racing the place: where does the citation land", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    let open: () => void = () => {};
    placeGate = new Promise<void>((r) => { open = r; });
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(100);
    { const v = view(); const at = v.state.doc.toString().indexOf("The chip draws 140 W under load.") + 31; v.dispatch({ selection: { anchor: at } }); }
    open();
    await waitFor(() => expect(queued()).not.toContain(row.id));
    const t = text();
    console.log("A3 text:", JSON.stringify(t));
    expect(t.includes(`The board fits it.[@ref:`) && !t.includes(`under load.{{/ref}}[@ref:`)).toBe(true);
  });
  it("A4 section label follows the text typed since the tab opened", async () => {
    await openRefs();
    typeAt("The board fits it.", "x"); // dirty
    await wait(50);
    typeAt("## Power", "## Newhead\nfiller\n\n");
    await wait(100);
    console.log("A4 power section:", screen.getByTestId(`cited-section-${REF_POWER}`).textContent);
    expect(screen.getByTestId(`cited-section-${REF_POWER}`).textContent).toMatch(/In: Power/);
  });
  it("A4b (D4) Re-pin on a citation deleted from the text while dirty sends no repin and makes no record", async () => {
    await openRefs();
    typeAt("The board fits it.", "x");
    await wait(50);
    act(() => { const v = view(); const s = text(); const at = s.indexOf(`[@ref:${REF_SOCKET}]`); v.dispatch({ changes: { from: at, to: at + `[@ref:${REF_SOCKET}]`.length, insert: "" } }); });
    await wait(50);
    const records = fake.state().records.size;
    const btn = screen.queryByTestId(`repin-${REF_SOCKET}`);
    if (btn) fireEvent.click(btn);
    await wait(400);
    expect(sent(/\/repin/).length).toBe(0);
    expect(screen.queryByTestId(`repin-move-${REF_SOCKET}`)).toBeNull();
    expect(fake.state().records.size).toBe(records);
    if (btn) expect(screen.getByTestId("refs-msg").textContent).toMatch(/not in the text any more/);
  });
  it("D4 a pin view opened on a live citation, whose citation is then deleted from the text, moves nothing", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    const mv = await screen.findByTestId(`repin-move-${REF_SOCKET}`);
    act(() => { const v = view(); const s = text(); const at = s.indexOf(`[@ref:${REF_SOCKET}]`); v.dispatch({ changes: { from: at, to: at + `[@ref:${REF_SOCKET}]`.length, insert: "" } }); });
    const records = fake.state().records.size;
    fireEvent.click(mv);
    await wait(500);
    expect(sent(/\/repin/).length).toBe(0);
    expect(fake.state().records.size).toBe(records);
    expect(screen.getByTestId("refs-msg").textContent).toMatch(/not in the text any more/);
  });
  it("A5 (D6) the source moved on between the view and the click: nothing moves, the view is drawn again for the newest revision", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    const mv = await screen.findByTestId(`repin-move-${REF_SOCKET}`);
    expect(mv.textContent).toMatch(/revision 3/);
    fake.addRevision(S_SOCKET, "Socket intro, again.\n\nPer the vendor, the LGA2066 socket takes a 165 W part. Rev four.");
    fireEvent.click(mv);
    await waitFor(() => expect(screen.getByTestId("repin-revisions").textContent).toMatch(/revision 4/));
    expect(sent(/\/repin/).length).toBe(0);
    expect(text()).toContain(REF_SOCKET);
    expect(screen.getByTestId("refs-msg").textContent).toMatch(/changed since you looked/);
    expect(screen.getByTestId("repin-after").textContent).toContain("Rev four.");
    // the person now sees revision 4 and may move to it knowingly
    fireEvent.click(await screen.findByTestId(`repin-move-${REF_SOCKET}`));
    await waitFor(() => expect(text()).not.toContain(REF_SOCKET));
    const fresh = /\[@ref:([0-9a-f-]{36})\]/.exec(text())![1];
    expect(fake.state().records.get(fresh)!.pinned_revision).toBe(4);
  });
  it("A6 a waiting cite whose source became unreadable keeps showing its old title after a reload", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    await screen.findByText("ALPHA Memory timings");
    fake.state().sources.get(S_NEW)!.held = true; fake.state().sources.get(S_NEW)!.owner = "u-bob"; // now hidden from alice
    searchFor("unrated");
    fireEvent.click(await screen.findByTestId(`find-add-${S_BARE}`));
    await waitFor(() => expect(queued().length).toBe(3));
    await wait(300);
    console.log("A6 title now:", screen.getByTestId(`toplace-title-${row.id}`).textContent);
    expect(screen.queryByText("ALPHA Memory timings")).toBeNull();
    expect(screen.getByTestId(`toplace-title-${row.id}`).textContent).toMatch(/not available any more/);
  });
  it("A7 Find sources after another browser attached a source: still never lists a cited source", async () => {
    await openRefs();
    fake.handle("alice", "POST", "/workbench/documents/references", { path: CPU, source_id: S_NEW, form: "added" }); // other tab
    searchFor("Memory timings");
    await wait(600);
    console.log("A7 find rows:", screen.queryAllByTestId("find-row").map((r) => r.getAttribute("data-source")));
    expect(screen.queryByTestId(`find-row-${S_NEW}`)).toBeNull();
  });
  it("A8 results of an open search never list a source once it is cited (place)", async () => {
    await openRefs();
    searchFor("ALPHA");
    await screen.findByTestId("find-results");
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(queued()).not.toContain(row.id));
    await wait(600);
    console.log("A8 find rows after place:", screen.queryAllByTestId("find-row").map((r) => r.getAttribute("data-source")));
    expect(screen.queryByTestId(`find-row-${S_NEW}`)).toBeNull();
  });
  it("A9 place at cursor 0 in a non-empty doc sends nothing", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    act(() => { view().dispatch({ selection: { anchor: 0 } }); });
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await wait(200);
    expect(sent(/place$/).length).toBe(0);
  });
  it("A10 confirm acts on its own target even after the list changes", async () => {
    await openRefs();
    const [a, b] = queued();
    fireEvent.click(screen.getByTestId(`toplace-remove-${b}`));
    fake.state().pending.delete(a);
    searchFor("unrated");
    fireEvent.click(await screen.findByTestId(`find-add-${S_BARE}`));
    await waitFor(() => expect(queued()).not.toContain(a));
    fireEvent.click(within(screen.getByTestId(`confirm-${b}`)).getByTestId("confirm-yes"));
    await waitFor(() => expect(queued()).not.toContain(b));
    expect(sent(/pending-refs\//, "DELETE").length).toBe(1);
    expect(sent(/pending-refs\//, "DELETE")[0].url).toContain(b);
  });
});

describe("surviving mutants and the notes", () => {
  it("M17 Place at cursor is disabled while a confirmation is open (every row's, not only the one being confirmed)", async () => {
    await openRefs();
    const [a, b] = queued();
    fireEvent.click(screen.getByTestId(`toplace-remove-${a}`));
    expect((screen.getByTestId(`place-${a}`) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId(`place-${b}`) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(screen.getByTestId(`confirm-${a}`)).getByTestId("confirm-no"));
    expect((screen.getByTestId(`place-${a}`) as HTMLButtonElement).disabled).toBe(false);
  });
  it("M9 when the list of what the document cites cannot be read, open results are held back (never shown)", async () => {
    await openRefs();
    searchFor("ALPHA");
    await screen.findByTestId("find-results");
    failHolders = true;
    fireEvent.click(screen.getByTestId(`cited-remove-${REF_COOL}`));
    fireEvent.click(within(screen.getByTestId(`confirm-${REF_COOL}`)).getByTestId("confirm-yes"));
    await waitFor(() => expect(screen.getByTestId("cited-failed")).toBeTruthy());
    expect(screen.queryAllByTestId("find-row").length).toBe(0);
    expect(screen.getByTestId("find-wait")).toBeTruthy();
  });
  it("M9b a search made while the cited list cannot be read shows no results", async () => {
    await openRefs();
    failHolders = true;
    searchFor("ALPHA");
    await waitFor(() => expect(screen.getByTestId("find-failed")).toBeTruthy());
    expect(screen.queryAllByTestId("find-row").length).toBe(0);
  });
  it("D5 Add re-reads what the document cites: a source attached in another browser meanwhile is not added", async () => {
    await openRefs();
    searchFor("unrated");
    const add = await screen.findByTestId(`find-add-${S_BARE}`);
    fake.handle("alice", "POST", "/workbench/documents/references", { path: CPU, source_id: S_BARE, form: "added" }); // other tab
    const n = bodies.length;
    fireEvent.click(add);
    await waitFor(() => expect(screen.getByTestId("refs-msg").textContent).toMatch(/already cites that source/));
    expect(bodies.slice(n).filter((b) => b.method === "POST" && /pending-refs/.test(b.url))).toEqual([]);
    expect(screen.queryByTestId(`find-row-${S_BARE}`)).toBeNull();
  });
  it("D1b a confirmation on an attached reference whose holder vanished elsewhere is dropped too", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`cited-remove-${REF_COOL}`));
    fake.state().holders.set(CPU, fake.state().holders.get(CPU)!.filter((h) => h.reference_id !== REF_COOL));
    searchFor("unrated"); // a read of the holders
    await screen.findByTestId("find-results");
    await waitFor(() => expect(screen.queryByTestId(`confirm-${REF_COOL}`)).toBeNull());
    const [a] = queued();
    expect((screen.getByTestId(`toplace-remove-${a}`) as HTMLButtonElement).disabled).toBe(false);
  });
  it("a hidden-in-session source is listed WITH its tag (the server's tag is shown, not dropped)", async () => {
    fake.state().sources.get(S_BARE)!.hidden = true;
    await openRefs();
    searchFor("unrated");
    await screen.findByTestId(`find-row-${S_BARE}`);
    expect(screen.getByTestId(`find-tags-${S_BARE}`).textContent).toMatch(/hidden in this session/);
  });
});
