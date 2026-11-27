// The References tab of the document screen (rwr-doc-refs), against the shared fake back end (e2e/refs-fake.mjs: the same
// one the e2e stub runs; it copies the workbench's pending-refs, references, candidates, diff-check and quality routes).
// One describe per acceptance item of the anchor, then the house rules (a change of person, storage, selects, honesty).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { App } from "../src/App";
import { DocumentScreen } from "../src/screens/documents/DocumentScreen";
import { ToastProvider } from "../src/shell/Toast";
import { parseRoute } from "../src/lib/router";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { uid } from "../e2e/docs-fake.mjs";
import {
  BRAVO, C_ORPHAN, C_POWER, CPU, createRefsFake, PEOPLE, REF_COOL, REF_DRIFT, REF_POWER, REF_SOCKET,
  S_BARE, S_BRAVO, S_COOL, S_DRIFT, S_NEW, S_POWER, S_SOCKET,
} from "../e2e/refs-fake.mjs";

configure({ asyncUtilTimeout: 5000 });
const fake = createRefsFake({ now: () => Date.now() });
let who: "alice" | "bob" = "alice";
let bodies: { method: string; url: string; body: any; who: string }[] = [];
let failPendingGet = false;
let diffGate: Promise<void> | null = null;
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
    if (failPendingGet && method === "GET" && path === "/workbench/contract/documents/pending-refs") return j({ error: "internal" }, 500);
    if (diffGate && method === "POST" && path === "/workbench/contract/diff-check") {
      const r = fake.handle(who, method, u, body ?? {})!;
      const g = diffGate; await g;
      return j(r.body, r.status);
    }
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
const cited = () => rowsOf("cited-list", "cited-row").map((r) => r.getAttribute("data-ref"));
const queued = () => rowsOf("toplace-list", "toplace-row").map((r) => r.getAttribute("data-id")!);
const sent = (re: RegExp, method = "POST") => bodies.filter((b) => b.method === method && re.test(b.url));
const pendingIds = (person: "alice" | "bob" = "alice") => [...fake.state().pending.values()].filter((r) => r.owner === PEOPLE[person].sub);
const queueRow = (pred: (r: { source_id: string | null; claim_id: string | null }) => boolean) => pendingIds().find(pred)!;

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); fake.reset(); settings.clear(); who = "alice"; failPendingGet = false; diffGate = null;
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("acceptance 1: the cited list matches the holder references in order", () => {
  it("lists every holder reference in the order the references route answers, titled as the export prints them", async () => {
    await openRefs();
    const server = fake.handle("alice", "GET", `/workbench/documents/references?path=${encodeURIComponent(CPU)}`, {})!.body.references;
    expect(cited()).toEqual(server.map((r: any) => r.reference_id));
    expect(cited()).toEqual([REF_SOCKET, REF_POWER, REF_DRIFT, REF_COOL]);
    expect(screen.getByTestId(`cited-title-${REF_SOCKET}`).textContent).toBe("ALPHA Socket guide");
    expect(screen.getByTestId(`cited-title-${REF_COOL}`).textContent).toBe("ALPHA Cooling paper");
  });
  it("says which section of the text each citation sits in, and that an attached one is not in the text", async () => {
    await openRefs();
    expect(screen.getByTestId(`cited-section-${REF_SOCKET}`).textContent).toMatch(/Socket/);
    expect(screen.getByTestId(`cited-section-${REF_POWER}`).textContent).toMatch(/Power/);
    expect(screen.getByTestId(`cited-section-${REF_DRIFT}`).textContent).toMatch(/Drift/);
    expect(screen.getByTestId(`cited-section-${REF_COOL}`).textContent).toMatch(/not in the text/i);
  });
  it("shows a quality note per cited source: the score and why, or that it is not rated", async () => {
    await openRefs();
    await waitFor(() => expect(screen.getByTestId(`cited-quality-${REF_SOCKET}`).textContent).toMatch(/0\.82/));
    expect(screen.getByTestId(`cited-quality-${REF_SOCKET}`).textContent).toMatch(/two independent sources agree/);
    expect(screen.getByTestId(`cited-quality-${REF_POWER}`).textContent).toMatch(/0\.4/);
    // an unrated source says so; it is never shown as a score of zero
    fake.handle("alice", "POST", "/workbench/documents/references", { path: CPU, source_id: S_BARE, form: "added" });
    cleanup(); resetState(); await openRefs();
    const bare = cited().find((id) => fake.state().records.get(id!)?.source_id === S_BARE)!;
    await waitFor(() => expect(screen.getByTestId(`cited-quality-${bare}`).textContent).toMatch(/not rated/i));
    expect(screen.getByTestId(`cited-quality-${bare}`).textContent).not.toMatch(/\b0\b/);
  });
  it("flags a citation whose source has a newer revision (one diff-check for the whole list)", async () => {
    await openRefs();
    await waitFor(() => expect(screen.getByTestId(`cited-newer-${REF_SOCKET}`).textContent).toMatch(/revision 3/));
    expect(screen.queryByTestId(`cited-newer-${REF_POWER}`)).toBeNull();
    expect(sent(/\/workbench\/contract\/diff-check$/).length).toBe(1);
  });
  it("a cited reference has no Remove (the server refuses it): it says to delete its citation from the text", async () => {
    await openRefs();
    expect(screen.queryByTestId(`cited-remove-${REF_SOCKET}`)).toBeNull();
    expect(screen.getByTestId(`cited-howto-${REF_SOCKET}`).textContent).toMatch(/delete (its|the) citation from the text/i);
    expect(screen.getByTestId(`cited-remove-${REF_COOL}`)).toBeTruthy();
  });
});

describe("acceptance 2: To place - Place at cursor", () => {
  it("lists the waiting cites, oldest first, titled; a claim is said to be a claim", async () => {
    await openRefs();
    const ids = queued();
    expect(ids.length).toBe(2);
    expect(ids).toEqual(pendingIds().map((r) => r.id));
    expect(within(screen.getByTestId("toplace-list")).getByText("ALPHA Memory timings")).toBeTruthy();
    expect(within(screen.getByTestId("toplace-list")).getByTestId(`toplace-kind-${ids[1]}`).textContent).toMatch(/claim/i);
  });
  it("Place at cursor puts the citation where the cursor is, leaves the queue, saves, and the cited list gains it", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(queued()).not.toContain(row.id));
    const m = /\[@ref:([0-9a-f-]{36})\]/g;
    const ids = [...text().matchAll(m)].map((x) => x[1]);
    expect(ids.length).toBe(2);
    const fresh = ids.find((x) => x !== REF_SOCKET)!;
    // exactly where the cursor was: right after the sentence, before the existing chip
    expect(text()).toContain(`The board fits it.[@ref:${fresh}] [@ref:${REF_SOCKET}]`);
    expect(sent(new RegExp(`/pending-refs/${row.id}/place$`)).length).toBe(1);
    // the file is written so the server's holders follow the text; the list then shows the new reference
    await waitFor(() => expect(sent(/\/workbench\/documents\/file/, "PUT").length).toBeGreaterThan(0));
    await waitFor(() => expect(cited()).toContain(fresh));
    expect(screen.getByTestId(`cited-title-${fresh}`).textContent).toBe("ALPHA Memory timings");
    expect(screen.getByTestId(`cited-section-${fresh}`).textContent).toMatch(/Socket/);
  });
  it("with no cursor placed yet it says so, sends nothing, and the cite stays in the queue", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    expect(screen.getByTestId("refs-msg").textContent).toMatch(/click in the text/i);
    expect(sent(/\/place$/).length).toBe(0);
    expect(queued()).toContain(row.id);
  });
  it("a claim is placed on the source it states from", async () => {
    await openRefs();
    const row = queueRow((r) => r.claim_id === C_POWER);
    cursorAfter("Second");
    cursorAfter("The board fits it.");
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await waitFor(() => expect(queued()).not.toContain(row.id));
    const fresh = [...text().matchAll(/\[@ref:([0-9a-f-]{36})\]/g)].map((x) => x[1]).find((x) => x !== REF_SOCKET)!;
    expect(fake.state().records.get(fresh)!.source_id).toBe(S_POWER);
  });
  it("a refused placement (a claim that states from no source) leaves the text and the queue as they were, and says why", async () => {
    const add = fake.handle("alice", "POST", "/workbench/contract/documents/pending-refs", { path: CPU, claim_id: C_ORPHAN, added_from: "chat" })!;
    expect(add.status).toBe(201);
    await openRefs();
    const before = text();
    cursorAfter("The board fits it.");
    fireEvent.click(screen.getByTestId(`place-${add.body.id}`));
    await waitFor(() => expect(screen.getByTestId("refs-msg").textContent).toMatch(/states from no source/));
    expect(text()).toBe(before);
    expect(queued()).toContain(add.body.id);
  });
  it("a failed read of the queue says so with a way to try again; it never shows 'nothing waiting'", async () => {
    failPendingGet = true;
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("toplace-failed")).toBeTruthy());
    expect(screen.queryByTestId("toplace-empty")).toBeNull();
    failPendingGet = false;
    fireEvent.click(within(screen.getByTestId("toplace-failed")).getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByTestId("toplace-list")).toBeTruthy());
  });
  it("an empty queue says nothing is waiting (and only then)", async () => {
    for (const r of pendingIds()) fake.state().pending.delete(r.id);
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("toplace-empty")).toBeTruthy());
  });
});

describe("acceptance 3: Find sources never lists a source the document already cites", () => {
  const find = async (q: string) => {
    fireEvent.change(screen.getByTestId("find-q"), { target: { value: q } });
    fireEvent.click(screen.getByTestId("find-go"));
    await waitFor(() => expect(screen.getByTestId("find-results")).toBeTruthy());
  };
  it("lists sources only: not the ones cited or attached, not documents, not claims", async () => {
    await openRefs();
    await find("ALPHA");
    const ids = within(screen.getByTestId("find-results")).getAllByTestId("find-row").map((r) => r.getAttribute("data-source"));
    for (const cited of [S_SOCKET, S_POWER, S_DRIFT, S_COOL]) expect(ids).not.toContain(cited);
    expect(ids).toContain(S_NEW);
    expect(ids).toContain(S_BARE);
    expect(screen.getByTestId("find-results").textContent).not.toMatch(/Upgrading the CPU|One gateway|a claim with no source/);
    // the request carries the document, so the server can scope the search to it
    expect(sent(/\/workbench\/documents\/candidates\?/, "GET")[0].url).toContain(`path=${encodeURIComponent(CPU)}`);
  });
  it("a source already waiting in To place is shown as waiting, with no button to add it again", async () => {
    await openRefs();
    await find("memory");
    const row = within(screen.getByTestId("find-results")).getByTestId(`find-row-${S_NEW}`);
    expect(row.textContent).toMatch(/waiting/i);
    expect(within(row).queryByRole("button", { name: /add to references/i })).toBeNull();
  });
  it("Add to references puts the source in To place (the queue), and it is then shown as waiting", async () => {
    await openRefs();
    await find("unrated");
    fireEvent.click(screen.getByTestId(`find-add-${S_BARE}`));
    await waitFor(() => expect(queued().length).toBe(3));
    const post = sent(/\/workbench\/contract\/documents\/pending-refs$/)[0];
    expect(post.body).toEqual({ path: CPU, source_id: S_BARE, added_from: "find" });
    expect(screen.getByTestId(`find-row-${S_BARE}`).textContent).toMatch(/waiting/i);
    // it is NOT cited yet: no reference record exists for it until it is placed
    expect(cited().length).toBe(4);
  });
  it("a source that went into the queue elsewhere meanwhile (409) is said to be waiting, not shown as an error", async () => {
    await openRefs();
    await find("unrated");
    fake.handle("alice", "POST", "/workbench/contract/documents/pending-refs", { path: CPU, source_id: S_BARE, added_from: "chat" });
    fireEvent.click(screen.getByTestId(`find-add-${S_BARE}`));
    await waitFor(() => expect(screen.getByTestId(`find-row-${S_BARE}`).textContent).toMatch(/waiting/i));
    await waitFor(() => expect(queued().length).toBe(3));
  });
  it("one letter is not a search: it asks for more and sends nothing", async () => {
    await openRefs();
    fireEvent.change(screen.getByTestId("find-q"), { target: { value: "a" } });
    fireEvent.click(screen.getByTestId("find-go"));
    expect(screen.getByTestId("find-hint").textContent).toMatch(/two letters/i);
    expect(sent(/documents\/candidates/, "GET").map((b) => b.url)).toEqual([]);
  });
  it("no match says so", async () => {
    await openRefs();
    await waitFor(() => expect(screen.getByTestId("find-q")).toBeTruthy());
    fireEvent.change(screen.getByTestId("find-q"), { target: { value: "zzzzzz" } });
    fireEvent.click(screen.getByTestId("find-go"));
    await waitFor(() => expect(screen.getByTestId("find-none")).toBeTruthy());
  });
});

describe("acceptance 3 (re-pin): it shows what changed before it moves the pin", () => {
  it("Re-pin only READS (diff-check) and shows the pinned words, the newer words and both revisions; the pin has not moved", async () => {
    await openRefs();
    const n = bodies.length;
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    const v = await screen.findByTestId(`repin-view-${REF_SOCKET}`);
    expect(v.textContent).toMatch(/revision 2/);
    expect(v.textContent).toMatch(/revision 3/);
    expect(within(v).getByTestId("repin-before").textContent).toContain("takes a 165 W part");
    expect(within(v).getByTestId("repin-after").textContent).toContain("A new BIOS is needed.");
    expect(bodies.slice(n).filter((b) => b.method !== "GET" && !/diff-check/.test(b.url))).toEqual([]);
    expect(sent(/\/repin/).length).toBe(0);
    expect(text()).toContain(`[@ref:${REF_SOCKET}]`);
  });
  it("the move button does not exist until the view is on screen (a slow diff-check cannot be skipped)", async () => {
    await openRefs();
    let open: () => void = () => {};
    diffGate = new Promise<void>((r) => { open = r; });
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByTestId(`repin-move-${REF_SOCKET}`)).toBeNull();
    expect(sent(/\/repin/).length).toBe(0);
    open();
    await screen.findByTestId(`repin-move-${REF_SOCKET}`);
  });
  it("Move the pin makes a new record at the newest revision and puts it in the text in place of the old one", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    fireEvent.click(await screen.findByTestId(`repin-move-${REF_SOCKET}`));
    await waitFor(() => expect(text()).not.toContain(REF_SOCKET));
    const fresh = /\[@ref:([0-9a-f-]{36})\]/.exec(text())![1];
    expect(fake.state().records.get(fresh)!.pinned_revision).toBe(3);
    expect(sent(new RegExp(`/documents/references/${REF_SOCKET}/repin\\?path=`)).length).toBe(1);
    await waitFor(() => expect(cited()).toContain(fresh));
    await waitFor(() => expect(cited()).not.toContain(REF_SOCKET)); // the save made the server drop the old holder
    expect(screen.queryByTestId(`repin-view-${REF_SOCKET}`)).toBeNull();
  });
  it("a quoted passage (transclusion) is replaced by the text the server answers", async () => {
    fake.addRevision(S_POWER, "Power overview, revised.\n\nThe chip draws 140 W under load. Idle is 20 W.");
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_POWER}`));
    fireEvent.click(await screen.findByTestId(`repin-move-${REF_POWER}`));
    await waitFor(() => expect(text()).not.toContain(REF_POWER));
    expect(text()).toMatch(/\{\{ref:[0-9a-f-]{36}\}\}The chip draws 140 W under load\.\{\{\/ref\}\}/);
  });
  it("when nothing changed it says so and offers no move", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_POWER}`));
    const v = await screen.findByTestId(`repin-view-${REF_POWER}`);
    expect(v.textContent).toMatch(/nothing has changed/i);
    expect(screen.queryByTestId(`repin-move-${REF_POWER}`)).toBeNull();
  });
  it("when the pinned words are gone from the newest revision it says so and offers no move (the server would refuse)", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_DRIFT}`));
    const v = await screen.findByTestId(`repin-view-${REF_DRIFT}`);
    expect(v.textContent).toMatch(/not (found|in)/i);
    expect(screen.queryByTestId(`repin-move-${REF_DRIFT}`)).toBeNull();
    expect(text()).toContain(REF_DRIFT);
  });
  it("only one re-pin view is open at a time, and Cancel closes it without a write", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    await screen.findByTestId(`repin-view-${REF_SOCKET}`);
    fireEvent.click(screen.getByTestId(`repin-${REF_POWER}`));
    await screen.findByTestId(`repin-view-${REF_POWER}`);
    expect(screen.queryByTestId(`repin-view-${REF_SOCKET}`)).toBeNull();
    fireEvent.click(screen.getByTestId("repin-cancel"));
    expect(screen.queryByTestId(`repin-view-${REF_POWER}`)).toBeNull();
    expect(sent(/\/repin/).length).toBe(0);
  });
  it("a refusal on the move (the words left the source in between) changes nothing and is said", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    const move = await screen.findByTestId(`repin-move-${REF_SOCKET}`);
    fake.addRevision(S_SOCKET, "Totally different text.");
    fireEvent.click(move);
    await waitFor(() => expect(screen.getByTestId("refs-msg").textContent).toMatch(/not in revision 4/));
    expect(text()).toContain(REF_SOCKET);
  });
});

describe("acceptance 4: a title opens the source at its section (the side drawer)", () => {
  it("a cited title opens the drawer on the pinned section", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`cited-title-${REF_SOCKET}`));
    const d = await screen.findByTestId("source-drawer");
    await waitFor(() => expect(within(d).getByTestId("drawer-passage").textContent).toMatch(/LGA2066/));
    expect(within(d).getByTestId("drawer-quote").textContent).toBe("takes a 165 W part");
    expect(within(d).getByTestId("drawer-pin").textContent).toMatch(/Pinned at revision 2/);
    fireEvent.click(within(d).getByTestId("drawer-close"));
    expect(screen.queryByTestId("source-drawer")).toBeNull();
  });
  it("a waiting cite's title opens its source", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    fireEvent.click(screen.getByTestId(`toplace-title-${row.id}`));
    const d = await screen.findByTestId("source-drawer");
    await waitFor(() => expect(within(d).getByTestId("drawer-title").textContent).toBe("ALPHA Memory timings"));
  });
  it("a Find sources title opens its source", async () => {
    await openRefs();
    fireEvent.change(screen.getByTestId("find-q"), { target: { value: "unrated" } });
    fireEvent.click(screen.getByTestId("find-go"));
    fireEvent.click(await screen.findByTestId(`find-title-${S_BARE}`));
    const d = await screen.findByTestId("source-drawer");
    await waitFor(() => expect(within(d).getByTestId("drawer-title").textContent).toBe("ALPHA Unrated memo"));
  });
});

describe("destructive actions: one confirmation, keyed to its target; the other destructive buttons are off while it is open", () => {
  it("removing a waiting cite asks first, for THAT cite, and the other remove buttons are disabled meanwhile", async () => {
    await openRefs();
    const [a, b] = queued();
    fireEvent.click(screen.getByTestId(`toplace-remove-${a}`));
    const ask = screen.getByTestId(`confirm-${a}`);
    expect(ask.textContent).toMatch(/ALPHA Memory timings/);
    expect(screen.queryByTestId(`confirm-${b}`)).toBeNull();
    expect((screen.getByTestId(`toplace-remove-${b}`) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId(`cited-remove-${REF_COOL}`) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId(`repin-${REF_SOCKET}`) as HTMLButtonElement).disabled).toBe(false); // re-pin only reads
    expect(sent(/pending-refs\//, "DELETE").length).toBe(0);
    fireEvent.click(within(ask).getByTestId("confirm-no"));
    expect(screen.queryByTestId(`confirm-${a}`)).toBeNull();
    expect((screen.getByTestId(`toplace-remove-${b}`) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId(`toplace-remove-${a}`));
    fireEvent.click(within(screen.getByTestId(`confirm-${a}`)).getByTestId("confirm-yes"));
    await waitFor(() => expect(queued()).toEqual([b]));
    expect(sent(new RegExp(`/pending-refs/${a}$`), "DELETE").length).toBe(1);
  });
  it("removing an attached reference asks first and then deletes THAT reference only", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`cited-remove-${REF_COOL}`));
    const ask = screen.getByTestId(`confirm-${REF_COOL}`);
    expect(ask.textContent).toMatch(/ALPHA Cooling paper/);
    for (const id of queued()) expect((screen.getByTestId(`toplace-remove-${id}`) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(ask).getByTestId("confirm-yes"));
    await waitFor(() => expect(cited()).toEqual([REF_SOCKET, REF_POWER, REF_DRIFT]));
    expect(sent(new RegExp(`/documents/references/${REF_COOL}\\?path=`), "DELETE").length).toBe(1);
  });
  it("Move the pin is also disabled while a removal is being confirmed", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    const move = await screen.findByTestId(`repin-move-${REF_SOCKET}`);
    fireEvent.click(screen.getByTestId(`cited-remove-${REF_COOL}`));
    expect((move as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("two identities, and a change of person without a reload", () => {
  it("bob sees only his own queue and references; nothing of alice's is on the page or in a request", async () => {
    who = "bob";
    await openDoc(BRAVO);
    await waitFor(() => expect(screen.getByTestId("toplace-list")).toBeTruthy());
    expect(within(screen.getByTestId("toplace-list")).getByText("BRAVO private held source")).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/ALPHA|SRC-ALPHA|k-a|u-alice|Hardware/);
    expect(JSON.stringify(bodies.map((b) => [b.url, b.body]))).not.toMatch(/ALPHA|k-a|u-alice/);
  });
  it("alice never sees bob's held source: not in Find sources, not by its id", async () => {
    await openRefs();
    fireEvent.change(screen.getByTestId("find-q"), { target: { value: "secret held" } });
    fireEvent.click(screen.getByTestId("find-go"));
    await waitFor(() => expect(screen.getByTestId("find-none")).toBeTruthy());
    expect(document.body.innerHTML).not.toMatch(/BRAVO|u-bob|documents\/k-b/);
    expect(fake.handle("alice", "POST", "/workbench/contract/documents/pending-refs", { path: CPU, source_id: S_BRAVO, added_from: "find" })!.body)
      .toEqual(fake.handle("alice", "POST", "/workbench/contract/documents/pending-refs", { path: CPU, source_id: "b1000000-0000-4000-8000-00000000dead", added_from: "find" })!.body);
  });
  it("another user's queue row and a missing one are the same answer on the wire", () => {
    const bobs = pendingIds("bob")[0].id;
    const a = fake.handle("alice", "DELETE", `/workbench/contract/documents/pending-refs/${bobs}`, {});
    const b = fake.handle("alice", "DELETE", "/workbench/contract/documents/pending-refs/9e000000-0000-4000-8000-00000000ffff", {});
    expect(a).toEqual(b);
    expect(fake.handle("alice", "POST", `/workbench/contract/documents/pending-refs/${bobs}/place`, {})).toEqual(b);
  });
  it("when the person changes without a reload, every draft, confirmation and view of the first person is gone", async () => {
    window.history.pushState({}, "", href(CPU));
    const route = () => ({ route: parseRoute(window.location.pathname), params: { ref: uid(CPU) }, whoAnswered: true });
    const ui = (subject: string) => <ToastProvider><DocumentScreen {...route()} subject={subject} /></ToastProvider>;
    const r = render(ui("u-alice"));
    await waitFor(() => expect(screen.getByTestId("cited-list")).toBeTruthy());
    fireEvent.change(screen.getByTestId("find-q"), { target: { value: "ALPHA-DRAFT" } });
    fireEvent.click(screen.getByTestId(`cited-remove-${REF_COOL}`));
    expect(screen.getByTestId(`confirm-${REF_COOL}`)).toBeTruthy();
    who = "bob";
    const n = bodies.length;
    act(() => resetState());
    r.rerender(ui("u-bob"));
    await waitFor(() => expect(screen.getByTestId("doc-gone")).toBeTruthy());
    expect(document.body.innerHTML).not.toMatch(/ALPHA/);
    expect(bodies.slice(n).some((b) => /ALPHA-DRAFT/.test(JSON.stringify(b.body ?? "") + b.url))).toBe(false);
    expect(bodies.slice(n).filter((b) => b.method === "DELETE")).toEqual([]);
  });
  it("after a SILENT change of person, Place at cursor sends nothing", async () => {
    await openRefs();
    const row = queueRow((r) => r.source_id === S_NEW);
    cursorAfter("The board fits it.");
    who = "bob";
    const n = bodies.length;
    fireEvent.click(screen.getByTestId(`place-${row.id}`));
    await new Promise((r) => setTimeout(r, 200));
    expect(bodies.slice(n).filter((b) => b.method !== "GET")).toEqual([]);
    expect(screen.getByTestId("refs-msg").textContent).toMatch(/could not confirm that you are still the person/i);
    expect(fake.state().pending.has(row.id)).toBe(true);
  });
  it("after a SILENT change of person, Add to references, Remove and Move the pin each send nothing", async () => {
    await openRefs();
    fireEvent.change(screen.getByTestId("find-q"), { target: { value: "unrated" } });
    fireEvent.click(screen.getByTestId("find-go"));
    const add = await screen.findByTestId(`find-add-${S_BARE}`);
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    const move = await screen.findByTestId(`repin-move-${REF_SOCKET}`);
    who = "bob";
    const n = bodies.length;
    fireEvent.click(add);
    fireEvent.click(move);
    await new Promise((r) => setTimeout(r, 200));
    fireEvent.click(screen.getByTestId(`cited-remove-${REF_COOL}`));
    fireEvent.click(within(screen.getByTestId(`confirm-${REF_COOL}`)).getByTestId("confirm-yes"));
    await new Promise((r) => setTimeout(r, 200));
    expect(bodies.slice(n).filter((b) => b.method !== "GET" && !/whoami/.test(b.url))).toEqual([]);
  });
});

describe("house rules", () => {
  it("nothing is kept in the browser and no private title is in the page title", async () => {
    await openRefs();
    fireEvent.change(screen.getByTestId("find-q"), { target: { value: "unrated" } });
    fireEvent.click(screen.getByTestId("find-go"));
    await screen.findByTestId("find-results");
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    await screen.findByTestId(`repin-view-${REF_SOCKET}`);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.title).not.toMatch(/ALPHA|Socket|Cooling/);
  });
  it("the tab has no select and no datalist (the item picker is the only place for them)", async () => {
    await openRefs();
    fireEvent.click(screen.getByTestId(`repin-${REF_SOCKET}`));
    await screen.findByTestId(`repin-view-${REF_SOCKET}`);
    expect(screen.getByTestId("dpanel-references").querySelector("select, datalist")).toBeNull();
  });
  it("every request goes to the one door: /workbench/ paths only", async () => {
    await openRefs();
    for (const b of bodies) expect(b.url.startsWith("/workbench/")).toBe(true);
  });
  it("the tab's styles keep long titles inside the panel: wrapping and min-width 0 on every refs rule that holds text", () => {
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.refs-title[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.refs-row[^{]*\{[^}]*min-width:\s*0/);
  });
  it("only the References tab changed in the shared tab bar: the other tabs are still placeholders", async () => {
    await openDoc();
    fireEvent.click(screen.getByTestId("dtab-coverage"));
    expect(screen.getByTestId("dpanel-coverage").textContent).toMatch(/not built yet|Coverage/);
  });
});
