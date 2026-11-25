// "Flag for cleanup" (rwr-flag-buttons): the button and dialog on a reference and a source in the citation drawer, and
// the component any screen mounts for a claim or for a source screen. One describe per acceptance line of the anchor.
// The back end is the shared fake of the flags routes (e2e/flags-fake.mjs, which copies the real route and repo code) next to
// the shared fake documents back end; the e2e stub drives the same two.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { App } from "../src/App";
import { ToastProvider } from "../src/shell/Toast";
import { FlagForCleanup, NOTHING_CHANGES } from "../src/components/flag/FlagForCleanup";
import { SourceDrawer } from "../src/screens/document-editor/SourceDrawer";
import { docHref } from "../src/screens/documents/docs-data";
import { flagBackLink, flagItem, readMyFlags, REASONS } from "../src/components/flag/flag-data";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { createFake, PEOPLE, REF_A, REF_B, REF_C, SRC_A, uid } from "../e2e/docs-fake.mjs";
import { createFlagsFake, ITEMS, REASONS as SERVER_REASONS } from "../e2e/flags-fake.mjs";

configure({ asyncUtilTimeout: 5000 });
const NOW = Date.now();
const docs = createFake({ now: () => NOW });
const CPU = "documents/k-a/Hardware/cpu.md";
const BRAVO = "documents/k-b/bravo.md";
const CLAIM = ITEMS.claim[0].id;
const MARK = "PRIVATE-NOTE-MARKER-5521"; // typed into a note: it may reach the flags route and nothing else
let who: "alice" | "bob" = "alice";
const flags = createFlagsFake({
  now: () => NOW,
  ownsDocument: (w, p) => docs.db().docs.get(p)?.owner === w.sub,
});
let sent: { method: string; url: string; body: any; who: string }[] = [];
let hold: Promise<void> | null = null; // a slow ANSWER to the next flag POST (the server has recorded it; the browser has not heard)
let release: () => void = () => {};
let down: number | null = null;        // answer the next flag POST with this status instead

function stub() {
  sent = [];
  setFetcher(async (u, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, url: u, body, who });
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    const path = u.split("?")[0];
    const me = PEOPLE[who];
    if (path === `/workbench/contract/references/${SRC_A}`) { // a source id answers with the source only (no record)
      return j({ id: SRC_A, kind: "source", state: "active", version: 1, record: null, held: null, source: { title: "SRC-ALPHA Socket guide", url: null, excerpt: "an excerpt" } });
    }
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: me.sub, actor_sub: me.sub, name: me.name });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth", kind: "user", subject_sub: me.sub });
    if (path === "/workbench/settings") return j({ settings: [] });
    if (path === "/workbench/contract/flags" && method === "POST") {
      if (down !== null) { const s = down; down = null; return j({ error: "database says: relation user_flags does not exist" }, s); }
      const r = flags.handle(me, method, u, body ?? {})!;
      if (hold) { const h = hold; hold = null; await h; }
      return j(r.body, r.status);
    }
    const f = flags.handle(me, method, u, body ?? {});
    if (f) return j(f.body, f.status);
    const r = docs.handle(who, method, u, body ?? {});
    if (r) return j(r.body, r.status);
    if (path === "/workbench/contract/sessions") return j({ sessions: [] });
    if (path === "/workbench/intake/jobs") return j({ jobs: [] });
    if (path === "/workbench/contract/cleanup/sources") return j({ sources: [], total: 0 });
    if (path === "/workbench/contract/cleanup/reopen-candidates") return j({ candidates: [] });
    return j({ error: "not found" }, 404);
  });
}
const posts = () => sent.filter((s) => s.method === "POST" && s.url === "/workbench/contract/flags");

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); docs.reset(); flags.reset(); flags.setAdmins([]);
  who = "alice"; hold = null; down = null;
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });

// open alice's CPU document with a citation to REF_A (and one to REF_B, a whole-source pin) and click the first chip
const withChips = (refs: string[] = [REF_A]) => {
  docs.db().docs.get(CPU)!.raw = `---\ntitle: "ALPHA Upgrading the CPU"\n---\nThe board [@ref:${refs[0]}] as stated${refs[1] ? ` and [@ref:${refs[1]}]` : ""}.`;
};
const openDrawer = async (n = 0, path = CPU) => {
  window.history.pushState({}, "", "/documents/d/" + uid(path));
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId("doc-version").textContent).toMatch(/^v\d/));
  fireEvent.mouseDown(screen.getByTestId("doc-editor").querySelectorAll("button.ws-chip")[n]);
  await waitFor(() => expect(screen.getByTestId("drawer-body")).toBeTruthy());
};
const flagBox = (kind: string) => screen.getByTestId("drawer-flags").querySelector(`[data-item-kind=${kind}]`) as HTMLElement;
const opener = (kind: string) => within(flagBox(kind)).getByTestId("flag-open");
const choose = (r: string) => fireEvent.click(screen.getByTestId(`flag-reason-${r}`));

describe("acceptance 3: the reason picker offers exactly wrong claim, low quality, duplicate, other", () => {
  it("four radio buttons in that order, none chosen, Flag it off until one is; never a select or a datalist", async () => {
    withChips(); await openDrawer();
    fireEvent.click(opener("reference"));
    const dlg = screen.getByTestId("flag-dialog");
    const radios = within(screen.getByTestId("flag-reasons")).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["wrong_claim", "low_quality", "duplicate", "other"]);
    expect(within(screen.getByTestId("flag-reasons")).getAllByRole("radio").map((r) => (r.closest("label") as HTMLElement).textContent)).toEqual(["Wrong claim", "Low quality", "Duplicate", "Other"]);
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(dlg.querySelector("select, datalist, [role=listbox], [role=combobox]")).toBeNull();
    expect((screen.getByTestId("flag-send") as HTMLButtonElement).disabled).toBe(true);
    choose("duplicate");
    expect((screen.getByTestId("flag-send") as HTMLButtonElement).disabled).toBe(false);
  });
  it("the four the app offers are the four keys of the server's registry (the fake's list is the route's)", () => {
    expect(REASONS.map((r) => r.key)).toEqual(SERVER_REASONS);
  });
});

describe("acceptance 2: the dialog says nothing changes until it is decided, and the item is unchanged afterwards", () => {
  it("states it before anything is sent, names who can see it, and sends nothing until Flag it", async () => {
    withChips(); await openDrawer();
    expect(posts()).toHaveLength(0);
    fireEvent.click(opener("reference"));
    const promise = screen.getByTestId("flag-promise").textContent!;
    expect(promise).toContain(NOTHING_CHANGES);
    expect(promise).toMatch(/Nothing changes until it is decided\./);
    expect(promise).toMatch(/Only you and admins can see your flag\./);
    expect(screen.getByTestId("flag-dialog").getAttribute("aria-describedby")).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
  it("after Flag it the reference and its source are unchanged and ONE write was made: the flag", async () => {
    withChips(); await openDrawer();
    const before = { items: flags.itemsSnapshot(), refs: JSON.stringify([...docs.db().refs]), docs: JSON.stringify([...docs.db().docs]) };
    const mark = sent.length; // the editor's own bookkeeping (its last-document key) was written before the drawer opened
    fireEvent.click(opener("reference"));
    choose("wrong_claim");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    expect(sent.slice(mark).filter((s) => s.method !== "GET").map((w) => `${w.method} ${w.url}`)).toEqual(["POST /workbench/contract/flags"]);
    expect(flags.itemsSnapshot()).toBe(before.items);
    expect(JSON.stringify([...docs.db().refs])).toBe(before.refs);
    expect(JSON.stringify([...docs.db().docs])).toBe(before.docs);
    // and the drawer still shows the same pinned words
    expect(screen.getByTestId("drawer-quote").textContent).toBe("the LGA2066 socket takes a 165 W part");
    expect(screen.getByTestId("drawer-title").textContent).toBe("SRC-ALPHA Socket guide");
  });
});

describe("acceptance 1: the flag is recorded with the reason and a link back to where it was made", () => {
  it("a reference flagged from the open document: the body names the item, the reason, the note and the document", async () => {
    withChips(); await openDrawer();
    fireEvent.click(opener("reference"));
    choose("low_quality");
    fireEvent.change(screen.getByTestId("flag-note"), { target: { value: "thin and repeated elsewhere" } });
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ item_kind: "reference", item_id: REF_A, reason: "low_quality", note: "thin and repeated elsewhere", from: { kind: "document", ref: CPU } });
    expect(flags.rows()).toHaveLength(1);
    expect(flags.rows()[0].owner_sub).toBe("u-alice");
    // the person is told where it is, with a link to Cleanup; the toast carries no title and no note
    expect(within(screen.getByTestId("flag-done")).getByTestId("flag-cleanup-link").getAttribute("href")).toBe("/cleanup");
    const toast = screen.getByTestId("toasts").textContent!;
    expect(toast).toMatch(/Flagged for cleanup\. It is under Cleanup, Flagged by you\./);
    expect(toast).not.toMatch(/SRC-ALPHA|ALPHA|thin and repeated/);
  });
  it("the source of that reference is flagged from the same drawer, as a source", async () => {
    withChips(); await openDrawer();
    fireEvent.click(opener("source"));
    choose("duplicate");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(within(flagBox("source") ?? document.body).queryByTestId("flag-done") ?? screen.getAllByTestId("flag-done")[0]).toBeTruthy());
    expect(posts()[0].body).toEqual({ item_kind: "source", item_id: SRC_A, reason: "duplicate", from: { kind: "document", ref: CPU } });
  });
  it("a whole-source pin (REF_B) offers both buttons", async () => {
    withChips([REF_B]); await openDrawer();
    expect(within(screen.getByTestId("drawer-flags")).getAllByTestId("flag-open").map((b) => b.textContent)).toEqual(["Flag this reference", "Flag this source"]);
  });
  it("a plain source link (the answer names the source only) offers the source button alone, with the source's own id", async () => {
    render(<ToastProvider><SourceDrawer target={{ kind: "source", id: SRC_A, n: 0 }} docPath={CPU} subject="u-alice" onClose={() => {}} /></ToastProvider>);
    await waitFor(() => expect(screen.getByTestId("drawer-body")).toBeTruthy());
    expect(within(screen.getByTestId("drawer-flags")).getAllByTestId("flag-open").map((b) => b.textContent)).toEqual(["Flag this source"]);
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    expect(posts()[0].body).toMatchObject({ item_kind: "source", item_id: SRC_A });
  });
  it("without a document and a signed-in person the drawer offers no flag at all", async () => {
    render(<ToastProvider><SourceDrawer target={{ kind: "source", id: SRC_A, n: 0 }} onClose={() => {}} /></ToastProvider>);
    await waitFor(() => expect(screen.getByTestId("drawer-body")).toBeTruthy());
    expect(screen.queryByTestId("drawer-flags")).toBeNull();
  });
  it("a HELD source (still in an idea's refinery) is not in the library: no flag buttons", async () => {
    withChips([REF_C]); await openDrawer();
    expect(screen.queryByTestId("drawer-flags")).toBeNull();
    expect(screen.queryByTestId("flag-open")).toBeNull();
  });
  it("Flagged by you lists it, with the document it was made in as a link back by opaque id; the source form links to the Library", async () => {
    withChips(); await openDrawer();
    fireEvent.click(opener("reference"));
    choose("other");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    const mine = await readMyFlags();
    expect(mine.total).toBe(1);
    expect(mine.flags[0]).toMatchObject({ item: { kind: "reference", id: REF_A }, reason: "other", from: { kind: "document", ref: CPU }, state: "open" });
    expect(await flagBackLink(mine.flags[0].from)).toBe(docHref(uid(CPU))); // built by the app's own document-link helper
    expect(await flagBackLink(mine.flags[0].from)).toBe("/documents/d/" + uid(CPU));
    expect(await flagBackLink({ kind: "source", ref: SRC_A })).toBe("/library?source=" + SRC_A);
    // a document that is gone has no link, and the address never carries the path or a title
    expect(await flagBackLink({ kind: "document", ref: "documents/k-a/nowhere.md" })).toBeNull();
    expect(await flagBackLink(mine.flags[0].from)).not.toMatch(/cpu|Hardware|ALPHA/i);
  });
  it("a claim and a source screen mount the same component: flagged from a source, with a note kept off the page", async () => {
    render(<ToastProvider><FlagForCleanup item={{ kind: "claim", id: CLAIM }} from={{ kind: "source", ref: SRC_A }} subject="u-alice" what="this claim" /></ToastProvider>);
    fireEvent.click(screen.getByTestId("flag-open"));
    expect(screen.getByTestId("flag-dialog").textContent).toMatch(/Flag this claim for cleanup/);
    choose("wrong_claim");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    expect(posts()[0].body).toEqual({ item_kind: "claim", item_id: CLAIM, reason: "wrong_claim", from: { kind: "source", ref: SRC_A } });
    expect(flags.rows()[0]).toMatchObject({ item_kind: "claim", from_kind: "source", from_ref: SRC_A });
  });
  it("nothing is offered until the shell knows who is signed in", () => {
    render(<ToastProvider><FlagForCleanup item={{ kind: "claim", id: CLAIM }} from={{ kind: "source", ref: SRC_A }} subject={null} what="this claim" /></ToastProvider>);
    expect(screen.queryByTestId("flag-open")).toBeNull();
  });
});

describe("acceptance 4 and 5: a flag is its flagger's (and admins'); user B never sees user A's", () => {
  const flagAsAlice = async (note = MARK) => {
    const r = await flagItem({ kind: "claim", id: CLAIM }, "low_quality", note, { kind: "document", ref: CPU });
    expect(r.kind).toBe("flagged");
  };
  it("B's own list is empty and its total is 0 (no count of A's); B's by-id read and edit of A's flag are the missing-flag answer", async () => {
    await flagAsAlice();
    const id = flags.rows()[0].id;
    who = "bob";
    const mine = await readMyFlags();
    expect(mine).toEqual({ flags: [], total: 0 });
    const miss = flags.handle(PEOPLE.bob, "GET", "/workbench/contract/flags/f1a90000-0000-4000-8000-0000000000ff")!;
    const foreign = flags.handle(PEOPLE.bob, "GET", `/workbench/contract/flags/${id}`)!;
    expect(foreign).toEqual(miss);
    expect(JSON.stringify(foreign)).not.toMatch(/alice|PRIVATE|u-alice|low_quality/);
    expect(flags.handle(PEOPLE.bob, "PATCH", `/workbench/contract/flags/${id}`, { state: "withdrawn" })).toEqual(miss);
    expect(flags.rows()[0].state).toBe("open");
    // scope=all is refused for B, and the refusal names nothing of A's
    const all = flags.handle(PEOPLE.bob, "GET", "/workbench/contract/flags?scope=all")!;
    expect(all.status).toBe(403);
    expect(JSON.stringify(all.body)).not.toMatch(/alice|PRIVATE|low_quality|total/);
  });
  it("an admin reads everyone's, with who flagged them; the flagger's own list stays their own", async () => {
    await flagAsAlice();
    flags.setAdmins(["u-bob"]);
    who = "bob";
    const all = flags.handle(PEOPLE.bob, "GET", "/workbench/contract/flags?scope=all")!;
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(1);
    expect(all.body.flags[0]).toMatchObject({ flagged_by: "u-alice", note: MARK });
    expect((await readMyFlags()).total).toBe(0); // the app's own list never asks scope=all
    expect(requestLog().some((r) => r.url.includes("scope=all"))).toBe(false);
  });
  it("another person's document as `from` and a missing item are ONE sentence in the dialog, naming neither", async () => {
    who = "bob";
    const foreignDoc = await flagItem({ kind: "claim", id: CLAIM }, "other", "", { kind: "document", ref: CPU });
    const missingItem = await flagItem({ kind: "claim", id: "c1000000-0000-4000-8000-0000000000ee" }, "other", "", { kind: "document", ref: BRAVO });
    const heldOfAlice = await flagItem({ kind: "reference", id: REF_C }, "other", "", { kind: "document", ref: BRAVO });
    expect(foreignDoc).toEqual({ kind: "gone" });
    expect(missingItem).toEqual(foreignDoc);
    expect(heldOfAlice).toEqual(foreignDoc);
    expect(flags.rows()).toHaveLength(0);
    // in the dialog: the same words, and none of the server's own
    render(<ToastProvider><FlagForCleanup item={{ kind: "claim", id: "c1000000-0000-4000-8000-0000000000ee" }} from={{ kind: "document", ref: BRAVO }} subject="u-bob" what="this claim" /></ToastProvider>);
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    fireEvent.click(screen.getByTestId("flag-send"));
    const p = await screen.findByTestId("flag-problem");
    expect(p.textContent).toBe("That item is not available any more, so nothing was flagged.");
    expect(document.body.textContent).not.toMatch(/no such|claim c1|document/i);
  });
  it("a server error is told in a fixed sentence: its text (a database name) never reaches the page", async () => {
    render(<ToastProvider><FlagForCleanup item={{ kind: "claim", id: CLAIM }} from={{ kind: "source", ref: SRC_A }} subject="u-alice" what="this claim" /></ToastProvider>);
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    down = 500;
    fireEvent.click(screen.getByTestId("flag-send"));
    expect((await screen.findByTestId("flag-problem")).textContent).toBe("The flag could not be sent. Nothing was flagged. Try again.");
    expect(document.body.textContent).not.toMatch(/user_flags|relation|database/);
    // the person can try again: the dialog is still open with the same choice, and the retry goes through
    expect((screen.getByTestId("flag-reason-other") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    expect(flags.rows()).toHaveLength(1);
  });
  it("a refusal (422 / 400) is its own fixed sentence", async () => {
    render(<ToastProvider><FlagForCleanup item={{ kind: "claim", id: CLAIM }} from={{ kind: "source", ref: SRC_A }} subject="u-alice" what="this claim" /></ToastProvider>);
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    down = 422;
    fireEvent.click(screen.getByTestId("flag-send"));
    expect((await screen.findByTestId("flag-problem")).textContent).toMatch(/^The flag was not accepted\./);
  });
});

describe("acceptance 6: nothing private from this item reaches a shared surface (a planted marker)", () => {
  it("the marker typed into a note goes to the flags route only: no other request, no toast, no title, no address, no browser storage", async () => {
    withChips(); await openDrawer();
    const spyLs = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.click(opener("reference"));
    choose("wrong_claim");
    fireEvent.change(screen.getByTestId("flag-note"), { target: { value: `see ${MARK}` } });
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    const withMark = sent.filter((s) => JSON.stringify(s.body ?? "").includes(MARK) || s.url.includes(MARK));
    expect(withMark.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /workbench/contract/flags"]);
    expect(screen.getByTestId("toasts").textContent).not.toContain(MARK);
    expect(document.body.textContent).not.toContain(MARK); // the note is not shown back anywhere
    expect(document.title).not.toMatch(/ALPHA|SRC|PRIVATE/);
    expect(window.location.href).not.toContain(MARK);
    expect(spyLs).not.toHaveBeenCalled();
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    // the item the flag points at still carries none of it (a flag writes only its own row)
    expect(JSON.stringify(ITEMS)).not.toContain(MARK);
    expect(JSON.stringify([...docs.db().refs])).not.toContain(MARK);
  });
  it("the flags and the document title it was made from are not in any request except the flag's own", async () => {
    withChips(); await openDrawer();
    fireEvent.click(opener("source"));
    choose("other");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    expect(sent.filter((s) => s.method === "POST").every((s) => s.url === "/workbench/contract/flags")).toBe(true);
    expect(sent.every((s) => s.url.startsWith("/workbench/"))).toBe(true);
    expect(JSON.stringify(posts().map((p) => p.body))).not.toMatch(/ALPHA/); // no title of the document or the source
  });
  it("the component's source reads nothing out of the browser and writes nothing to it, and never sets the page title", () => {
    const dir = "src/components/flag";
    const src = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|document\.title|console\./);
    expect(src).not.toMatch(/<select|<datalist/);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});

describe("a different person on the page (rwr-docs-list's rule): the dialog, its draft and a late answer are dropped", () => {
  const mount = (sub: string | null) => (
    <ToastProvider><FlagForCleanup item={{ kind: "claim", id: CLAIM }} from={{ kind: "source", ref: SRC_A }} subject={sub} what="this claim" /></ToastProvider>
  );
  it("a reset of the state (the shell's reaction to a new whoami) closes an open dialog and forgets the reason and the note", async () => {
    const r = render(mount("u-alice"));
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("duplicate");
    fireEvent.change(screen.getByTestId("flag-note"), { target: { value: MARK } });
    who = "bob";
    act(() => resetState());
    r.rerender(mount("u-bob"));
    expect(screen.queryByTestId("flag-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("flag-open"));
    expect((screen.getByTestId("flag-note") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getAllByRole("radio") as HTMLInputElement[]).some((x) => x.checked)).toBe(false);
    expect(document.body.textContent).not.toContain(MARK);
  });
  it("a different subject with no reset (the prop alone) starts afresh as well", () => {
    const r = render(mount("u-alice"));
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    r.rerender(mount("u-bob"));
    expect(screen.queryByTestId("flag-dialog")).toBeNull();
  });
  it("an answer that arrives after the person changed neither toasts nor shows a flag as made; the earlier person's toast goes too", async () => {
    const r = render(mount("u-alice"));
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    hold = new Promise<void>((res) => { release = res; });
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    who = "bob";
    act(() => resetState());
    r.rerender(mount("u-bob"));
    release();
    await act(async () => { await new Promise((x) => setTimeout(x, 20)); });
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(screen.queryByTestId("flag-done")).toBeNull();
    expect(screen.getByTestId("flag-open")).toBeTruthy(); // bob has flagged nothing
  });
  it("a toast the first person was shown is dropped when the person changes", async () => {
    const r = render(mount("u-alice"));
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("toast")).toBeTruthy());
    who = "bob";
    act(() => resetState());
    r.rerender(mount("u-bob"));
    expect(screen.queryByTestId("toast")).toBeNull();
  });
  it("Flag it sends nothing when the person signed in is no longer the one who opened the dialog (no reset yet)", async () => {
    render(mount("u-alice"));
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    who = "bob"; // whoami now answers bob; the page has not noticed
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-problem").textContent).toMatch(/signed in changed, so nothing was sent/));
    expect(posts()).toHaveLength(0);
    expect(flags.rows()).toHaveLength(0);
  });
});

describe("the dialog's own behaviour", () => {
  const mount = () => render(<ToastProvider><FlagForCleanup item={{ kind: "claim", id: CLAIM }} from={{ kind: "source", ref: SRC_A }} subject="u-alice" what="this claim" /></ToastProvider>);
  it("a double click on Flag it makes ONE flag, and after it the button gives way (no second flag from the same open page)", async () => {
    mount();
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    hold = new Promise<void>((res) => { release = res; });
    fireEvent.click(screen.getByTestId("flag-send"));
    fireEvent.click(screen.getByTestId("flag-send")); // a disabled button takes no click ...
    fireEvent.submit(screen.getByTestId("flag-form")); // ... and Enter in the note submits the form regardless of the button
    await waitFor(() => expect(posts()).toHaveLength(1));
    await act(async () => { await new Promise((x) => setTimeout(x, 20)); });
    release();
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    expect(posts()).toHaveLength(1);
    expect(screen.queryByTestId("flag-open")).toBeNull();
    expect(flags.rows()).toHaveLength(1);
  });
  it("Cancel sends nothing and returns focus to the button; a note with a control character is refused before any request", async () => {
    mount();
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    fireEvent.change(screen.getByTestId("flag-note"), { target: { value: "bad\u0000note" } });
    fireEvent.click(screen.getByTestId("flag-send"));
    expect((await screen.findByTestId("flag-problem")).textContent).toMatch(/control characters/);
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("flag-cancel"));
    expect(screen.queryByTestId("flag-dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("flag-open"));
    expect(posts()).toHaveLength(0);
  });
  it("Cancel and Escape discard the draft: the next open has no reason chosen and an empty note", async () => {
    mount();
    for (const how of ["cancel", "escape"]) {
      fireEvent.click(screen.getByTestId("flag-open"));
      choose("duplicate");
      fireEvent.change(screen.getByTestId("flag-note"), { target: { value: MARK } });
      if (how === "cancel") fireEvent.click(screen.getByTestId("flag-cancel"));
      else fireEvent.keyDown(screen.getByTestId("flag-dialog"), { key: "Escape" });
      expect(screen.queryByTestId("flag-dialog")).toBeNull();
      fireEvent.click(screen.getByTestId("flag-open"));
      expect((screen.getByTestId("flag-note") as HTMLTextAreaElement).value).toBe("");
      expect((screen.getAllByRole("radio") as HTMLInputElement[]).some((x) => x.checked)).toBe(false);
      expect(document.body.textContent).not.toContain(MARK);
      fireEvent.click(screen.getByTestId("flag-cancel"));
    }
  });
  it("Escape closes only the dialog, not the drawer around it", async () => {
    withChips(); await openDrawer();
    fireEvent.click(opener("reference"));
    fireEvent.keyDown(screen.getByTestId("flag-dialog"), { key: "Escape" });
    expect(screen.queryByTestId("flag-dialog")).toBeNull();
    expect(screen.getByTestId("source-drawer")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("source-drawer"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("source-drawer")).toBeNull());
  });
  it("the note is capped at the route's 2000 characters and a blank note is not sent", async () => {
    mount();
    fireEvent.click(screen.getByTestId("flag-open"));
    expect(screen.getByTestId("flag-note").getAttribute("maxlength")).toBe("2000");
    choose("other");
    fireEvent.change(screen.getByTestId("flag-note"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect("note" in posts()[0].body).toBe(false);
  });
  it("the focus lands in the dialog and the dialog is named and described", () => {
    mount();
    fireEvent.click(screen.getByTestId("flag-open"));
    const dlg = screen.getByRole("dialog");
    expect(dlg.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(dlg.getAttribute("aria-labelledby")!)!.textContent).toBe("Flag this claim for cleanup");
    expect(dlg.contains(document.activeElement)).toBe(true);
    expect((screen.getByTestId("flag-open") as HTMLButtonElement).disabled).toBe(true); // one dialog at a time
  });
});

// ── the folder-with-a-space defect (tester attempt 1, Case 1) ──
// The real route reads `from.ref` through the server's documentPathsIn, which stops a path at a space or at " ' ? & # , ), so a
// document in a folder named "Old notes" is refused (400) TODAY. The fake copies that scanner (flags-fake.mjs), so these two
// cases show it. The server fix is the separate item rw-doc-path-spaces; when it lands, the flags-fake's copy changes with it and
// the `it.fails` below turns green by itself (vitest then reports it as FAILED: remove the `.fails`).
const OLD = "documents/k-a/Old notes/cpu.md";
const plantOld = () => {
  const d = docs.db().docs.get(CPU)!;
  docs.db().docs.set(OLD, { ...d, id: uid(OLD), raw: `---
title: "ALPHA Old notes CPU"
---
The board [@ref:${REF_A}] as stated.` });
};
describe("a document in a folder whose name has a space (server item rw-doc-path-spaces)", () => {
  it("TODAY the real route refuses such an origin, and the fake says so exactly as the server does: the app shows its refusal", async () => {
    for (const bad of ["documents/k-a/Old notes/cpu.md", "documents/k-a/R&D/x.md", "documents/k-a/Q1, Q2/x.md", "documents/k-a/Bob's/x.md", "documents/k-a/(draft)/x.md", "documents/k-a/a#b/x.md"]) {
      expect(await flagItem({ kind: "claim", id: CLAIM }, "other", "", { kind: "document", ref: bad }), bad).toEqual({ kind: "refused" });
    }
    expect(await flagItem({ kind: "claim", id: CLAIM }, "other", "", { kind: "document", ref: CPU })).toEqual({ kind: "flagged" });
    expect(flags.rows()).toHaveLength(1);
  });
  // EXPECTED TO FAIL until rw-doc-path-spaces lands (the server accepts a spaced folder): the person flags from such a document
  it.fails("EXPECTED FAIL until rw-doc-path-spaces: flagging a reference from a document in 'Old notes' makes the flag", async () => {
    plantOld();
    await openDrawer(0, OLD);
    fireEvent.click(opener("reference"));
    choose("other");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy(), { timeout: 1500 });
    expect(flags.rows()[0].from_ref).toBe(OLD);
  });
});

describe("one flag per item, person and document for the life of the page", () => {
  it("closing the drawer and opening the same citation again shows the flagged line, not the button; no second request", async () => {
    withChips(); await openDrawer();
    fireEvent.click(opener("reference"));
    choose("other");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    fireEvent.click(screen.getByTestId("drawer-close"));
    await waitFor(() => expect(screen.queryByTestId("source-drawer")).toBeNull());
    fireEvent.mouseDown(screen.getByTestId("doc-editor").querySelectorAll("button.ws-chip")[0]);
    await waitFor(() => expect(screen.getByTestId("drawer-body")).toBeTruthy());
    expect(screen.getByTestId("drawer-flags").querySelector("[data-testid=flag-done]")).toBeTruthy();
    expect(within(screen.getByTestId("drawer-flags")).getAllByTestId("flag-open").map((b) => b.textContent)).toEqual(["Flag this source"]); // the source was not flagged
    expect(posts()).toHaveLength(1);
  });
  it("it is that person's and that document's: another person, or the same item from another origin, may flag again", async () => {
    const mount = (sub: string, ref: string) => (
      <ToastProvider><FlagForCleanup item={{ kind: "claim", id: CLAIM }} from={{ kind: "source", ref }} subject={sub} what="this claim" /></ToastProvider>
    );
    const r = render(mount("u-alice", SRC_A));
    fireEvent.click(screen.getByTestId("flag-open"));
    choose("other");
    fireEvent.click(screen.getByTestId("flag-send"));
    await waitFor(() => expect(screen.getByTestId("flag-done")).toBeTruthy());
    r.rerender(mount("u-alice", "b1000000-0000-4000-8000-0000000000b2")); // another origin
    expect(screen.getByTestId("flag-open")).toBeTruthy();
    r.rerender(mount("u-alice", SRC_A)); // back to the first: still flagged
    expect(screen.getByTestId("flag-done")).toBeTruthy();
    who = "bob";
    act(() => resetState()); // a different person on the page: nothing carries over
    r.rerender(mount("u-bob", SRC_A));
    expect(screen.queryByTestId("flag-done")).toBeNull();
    expect(screen.getByTestId("flag-open")).toBeTruthy();
  });
});
