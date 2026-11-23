// The document screen's writing surface (rwr-doc-editor), against the shared fake documents back end
// (e2e/docs-fake.mjs: the same one the e2e stub runs; it copies the server's file / history / research / reference
// routes byte for byte). One describe per acceptance item of the anchor.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { App } from "../src/App";
import { DocumentScreen } from "../src/screens/documents/DocumentScreen";
import { ToastProvider } from "../src/shell/Toast";
import { parseRoute } from "../src/lib/router";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState, getLockedDocument, setLockedDocument } from "../src/lib/state";
import { NOT_FOUND } from "../src/screens/documents/docs-data";
import { DOC_TABS } from "../src/screens/document-editor/InThisDoc";
import { cspNonce } from "../src/editor";
import { createFake, PEOPLE, REF_A } from "../e2e/docs-fake.mjs";

// a parallel full run loads the machine: the default 1 s wait is too short for a screen that reads three routes
configure({ asyncUtilTimeout: 5000 });
const NOW = Date.now();
const fake = createFake({ now: () => NOW });
let who: "alice" | "bob" = "alice";
let bodies: { method: string; url: string; body: any; who: string }[] = [];
let failPut = false;
const settings = new Map<string, { value: unknown; version: number }>();
const CPU = "documents/k-a/Hardware/cpu.md";
const href = (p: string) => "/documents/" + encodeURIComponent(p);

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
    if (failPut && method === "PUT" && path === "/workbench/documents/file") return j({ error: "internal" }, 500);
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
const view = () => EditorView.findFromDOM(screen.getByTestId("doc-editor").querySelector(".cm-editor") as HTMLElement)!;
const text = () => view().state.doc.toString();
const type = (s: string) => act(() => { const v = view(); v.dispatch({ changes: { from: v.state.doc.length, insert: s } }); });
const select = (from: number, to: number) => act(() => { view().dispatch({ selection: { anchor: from, head: to } }); });
const version = () => screen.getByTestId("doc-version").textContent ?? "";
const fileOf = (p = CPU) => fake.handle("alice", "GET", "/workbench/documents/file?path=" + encodeURIComponent(p), {})!.body;
const puts = () => bodies.filter((b) => b.method === "PUT" && b.url.startsWith("/workbench/documents/file"));

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); fake.reset(); settings.clear(); who = "alice"; failPut = false;
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("acceptance 1: edit, save, reload - the text and the version indicator are right", () => {
  it("opens with the body (front matter kept out of the box) and 'v1 - saved <ago>' from the history", async () => {
    await openDoc();
    expect(text()).toBe("ALPHA body of the CPU plan.\nSecond line.");
    expect(version()).toMatch(/^v1 · saved 2 h ago$/);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ALPHA Upgrading the CPU");
  });
  it("Save sends front matter + body with the hash of what this tab read, makes ONE version, and the reload shows both", async () => {
    await openDoc();
    const before = fileOf();
    type("\nThird line, typed.");
    expect(version()).toMatch(/^v1 · unsaved changes$/);
    fireEvent.click(screen.getByTestId("doc-save"));
    await waitFor(() => expect(version()).toMatch(/^v2 · saved/));
    const sent = puts();
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe(`/workbench/documents/file?path=${encodeURIComponent(CPU)}&commit=1`);
    expect(sent[0].body).toEqual({ content: `---\ntitle: "ALPHA Upgrading the CPU"\n---\nALPHA body of the CPU plan.\nSecond line.\nThird line, typed.`, if_match: before.hash });
    expect(fileOf().content).toBe(sent[0].body.content);
    // a reload: a fresh App on the same URL
    cleanup(); resetState();
    await openDoc();
    expect(text()).toBe("ALPHA body of the CPU plan.\nSecond line.\nThird line, typed.");
    expect(version()).toMatch(/^v2 · saved/);
  });
  it("saving the same text again makes no new version (nothing to commit)", async () => {
    await openDoc();
    type("x");
    fireEvent.click(screen.getByTestId("doc-save"));
    await waitFor(() => expect(version()).toMatch(/^v2 · saved/));
    fireEvent.click(screen.getByTestId("doc-save"));
    await new Promise((r) => setTimeout(r, 50));
    expect(version()).toMatch(/^v2 · saved/);
    expect(puts().length).toBe(1);
  });
  it("Ctrl+S saves a version from the box", async () => {
    await openDoc();
    type("!");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(version()).toMatch(/^v2 · saved/));
  });
  it("a pause in typing writes the file (no version); the indicator keeps the version and says saved", async () => {
    await openDoc();
    type(" more");
    await waitFor(() => expect(version()).toMatch(/^v1 · saved/), { timeout: 4000 });
    expect(puts().map((p) => p.url.includes("commit=1"))).toEqual([false]);
    expect(fileOf().content).toMatch(/Second line\. more$/);
  });
  it("a failed save keeps the text, says so, and Close does not close", async () => {
    await openDoc();
    type(" keep me");
    failPut = true;
    fireEvent.click(screen.getByTestId("doc-save"));
    await waitFor(() => expect(screen.getByTestId("doc-error").textContent).toMatch(/Not saved/));
    expect(version()).toMatch(/not saved/);
    expect(text()).toMatch(/keep me$/);
    fireEvent.click(screen.getByTestId("doc-close"));
    await waitFor(() => expect(screen.getByTestId("doc-note").textContent).toMatch(/Not closed/));
    expect(window.location.pathname).toBe(href(CPU));
    failPut = false;
    fireEvent.click(screen.getByTestId("doc-save"));
    await waitFor(() => expect(version()).toMatch(/^v2 · saved/));
  });
  it("past 30 versions the history route is capped, so the indicator says '30+', never a wrong number", async () => {
    const d = fake.db().docs.get(CPU)!;
    for (let i = 0; i < 34; i++) d.history.push("documents: edit " + i);
    await openDoc();
    expect(version()).toMatch(/^v30\+ · saved/);
  });
  it("the breadcrumb is Documents / folder / and the title is the heading", async () => {
    await openDoc();
    await waitFor(() => expect(screen.getByTestId("breadcrumb").textContent).toMatch(/^Documents \/ Hardware \/$/));
    expect(within(screen.getByTestId("breadcrumb")).getByRole("link", { name: "Documents" }).getAttribute("href")).toBe("/documents");
  });
});

describe("acceptance 2: a concurrent edit from a second tab is refused, never overwritten, nothing silently lost", () => {
  it("tab A's save after tab B's is refused with a clear message; both texts survive", async () => {
    await openDoc();
    // tab B: reads the file, writes a different text (the same route, the same if_match rule)
    const b = fileOf();
    const theirs = b.content.replace("Second line.", "B's second line.");
    expect(fake.handle("alice", "PUT", `/workbench/documents/file?path=${CPU}&commit=1`, { content: theirs, if_match: b.hash })!.status).toBe(200);
    // tab A types and saves
    type("\nA's own sentence.");
    fireEvent.click(screen.getByTestId("doc-save"));
    await waitFor(() => expect(screen.getByTestId("doc-conflict")).toBeTruthy());
    expect(screen.getByTestId("doc-conflict").textContent).toMatch(/changed somewhere else/);
    expect(screen.getByTestId("doc-conflict").textContent).toMatch(/nothing was overwritten/);
    expect(version()).toMatch(/not saved/);
    // B's text is on the server, untouched; A's text is still in A's box
    expect(fileOf().content).toBe(theirs);
    expect(text()).toBe("ALPHA body of the CPU plan.\nSecond line.\nA's own sentence.");
    // the refused write was the only one A made
    expect(puts().length).toBe(1);
    // typing on keeps the text and writes nothing more (no autosave into a conflict)
    type(" more");
    await new Promise((r) => setTimeout(r, 1700));
    expect(puts().length).toBe(1);
    expect(fileOf().content).toBe(theirs);
  });
  it("Close does not close on a conflict; Copy my text copies the box; Load the other version needs a second click and is undoable", async () => {
    await openDoc();
    const b = fileOf();
    const theirs = b.content.replace("Second line.", "B's second line.");
    fake.handle("alice", "PUT", `/workbench/documents/file?path=${CPU}`, { content: theirs, if_match: b.hash });
    type(" mine");
    fireEvent.click(screen.getByTestId("doc-close"));
    await waitFor(() => expect(screen.getByTestId("doc-conflict")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("doc-note").textContent).toMatch(/Not closed/));
    expect(window.location.pathname).toBe(href(CPU));
    const clip = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clip }, configurable: true });
    fireEvent.click(screen.getByTestId("doc-copy-mine"));
    await waitFor(() => expect(clip).toHaveBeenCalledWith("ALPHA body of the CPU plan.\nSecond line. mine"));
    // loading the other version asks first
    fireEvent.click(screen.getByTestId("doc-take-other"));
    expect(screen.getByTestId("doc-conflict").textContent).toMatch(/Your text here is lost unless you copied it/);
    expect(text()).toMatch(/ mine$/);
    fireEvent.click(screen.getByTestId("doc-take-other-ok"));
    await waitFor(() => expect(text()).toBe("ALPHA body of the CPU plan.\nB's second line."));
    expect(screen.queryByTestId("doc-conflict")).toBeNull();
    // the hash is the other version's: the next save goes through
    type("!");
    fireEvent.click(screen.getByTestId("doc-save"));
    await waitFor(() => expect(version()).toMatch(/saved/));
    expect(fileOf().content).toMatch(/B's second line\.!$/);
  });
});

describe("acceptance 3: a citation chip opens the cited section of the pinned revision", () => {
  const withChip = () => {
    const d = fake.db().docs.get(CPU)!;
    d.raw = `---\ntitle: "ALPHA Upgrading the CPU"\n---\nThe board supports it [@ref:${REF_A}] as stated.`;
  };
  it("clicking [1] opens a side drawer: the pinned words, the pinned revision, the cited chunk and its neighbours", async () => {
    withChip();
    await openDoc();
    const chip = screen.getByTestId("doc-editor").querySelector("button.ws-chip") as HTMLElement;
    expect(chip.textContent).toBe("[1]");
    fireEvent.mouseDown(chip);
    const drawer = await screen.findByTestId("source-drawer");
    await waitFor(() => expect(within(drawer).getByTestId("drawer-body")).toBeTruthy());
    expect(within(drawer).getByTestId("drawer-title").textContent).toBe("SRC-ALPHA Socket guide");
    expect(within(drawer).getByTestId("drawer-pin").textContent).toMatch(/Cited as \[1\] · Pinned at revision 2\. A newer revision \(3\) exists; this document still cites revision 2\./);
    expect(within(drawer).getByTestId("drawer-quote").textContent).toBe("the LGA2066 socket takes a 165 W part");
    const passage = within(drawer).getByTestId("drawer-passage");
    expect(passage.textContent).toMatch(/SRC-ALPHA intro chunk\..*Chunk two: the LGA2066 socket takes a 165 W part.*SRC-ALPHA closing chunk\./);
    expect(passage.querySelector("[data-target=true]")!.textContent).toMatch(/^Chunk two/);
    // what was asked: the record, then the chunk of the record's source at the record's chunk
    const asked = requestLog().map((r) => r.url).filter((u) => u.includes("/contract/"));
    expect(asked).toContain(`/workbench/contract/references/${REF_A}`);
    expect(asked.some((u) => /chunks\/b1000000-0000-4000-8000-0000000000a1%3A1\/context\?window=1$/.test(u))).toBe(true);
    // Esc and Close shut it, the document stays
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("source-drawer")).toBeNull());
    expect(text()).toMatch(/as stated\.$/);
  });
  it("the keyboard opens it too: Alt+Enter with the caret beside the chip", async () => {
    withChip();
    await openDoc();
    const chipSpan = text().indexOf("[@ref:");
    select(chipSpan, chipSpan);
    fireEvent.keyDown(view().contentDOM, { key: "Enter", altKey: true });
    await screen.findByTestId("source-drawer");
  });
  it("a source that is gone says so in one sentence", async () => {
    fake.db().docs.get(CPU)!.raw = `---\ntitle: "x"\n---\nA [@ref:a1000000-0000-4000-8000-0000000000ff] cite.`;
    await openDoc();
    fireEvent.mouseDown(screen.getByTestId("doc-editor").querySelector("button.ws-chip")!);
    await waitFor(() => expect(screen.getByTestId("drawer-missing").textContent).toBe("This source is not available any more."));
  });
});

describe("acceptance 4: protected transclusions stay atomic, the deliberate break works (the existing editor tests run in this app)", () => {
  it("test/editor.test.ts is the restored suite and runs here against the restored editor", () => {
    const src = readFileSync("test/editor.test.ts", "utf8");
    expect(src).toMatch(/C1: the span is atomic/);
    expect(src).toMatch(/C2: the deliberate break/);
    expect(src).toMatch(/from "\.\.\/src\/editor"/);
  });
  it("inside the screen: the quoted text of a transclusion cannot be typed into; the break leaves text + a chip on the same record", async () => {
    const R = "a1000000-0000-4000-8000-0000000000a1";
    fake.db().docs.get(CPU)!.raw = `---\ntitle: "ALPHA Upgrading the CPU"\n---\nIntro {{ref:${R}}}quoted words{{/ref}} end.`;
    await openDoc();
    const before = text();
    const at = before.indexOf("quoted") + 3;
    act(() => { view().dispatch({ changes: { from: at, insert: "ZZ" } }); });
    expect(text()).toBe(before);
    act(() => { view().dispatch({ selection: { anchor: before.indexOf("{{ref:") + 2 } }); });
    fireEvent.keyDown(view().contentDOM, { key: "b", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(text()).toBe(`Intro quoted words [@ref:${R}] end.`));
  });
});

describe("acceptance 5: the grammar twin", () => {
  it("the app's grammar copy is the editor's import and is the one the doc parses with", () => {
    expect(readFileSync("src/editor/protected.ts", "utf8")).toMatch(/from "\.\.\/lib\/grammar"/);
    expect(readFileSync("src/screens/document-editor/editor-data.ts", "utf8")).toMatch(/from "\.\.\/\.\.\/lib\/grammar"/);
  });
});

describe("acceptance 6: Close then open from Documents reopens the same document at the top", () => {
  it("Close returns to Documents (the document is still listed, saved); opening it again starts at the first line, scrolled to the top", async () => {
    await openDoc();
    const main = screen.getByTestId("main");
    main.scrollTop = 500;
    type("\nclosing words");
    select(5, 5);
    fireEvent.click(screen.getByTestId("doc-close"));
    await waitFor(() => expect(window.location.pathname).toBe("/documents"));
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(3));
    expect(fileOf().content).toMatch(/closing words$/);
    const row = screen.getAllByTestId("doc-row").find((r) => within(r).getByTestId("doc-title").textContent === "ALPHA Upgrading the CPU")!;
    screen.getByTestId("main").scrollTop = 300;
    fireEvent.click(within(row).getByTestId("doc-title"));
    await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
    expect(view().state.selection.main.head).toBe(0);
    expect(text()).toBe("ALPHA body of the CPU plan.\nSecond line.\nclosing words");
    expect(screen.getByTestId("main").scrollTop).toBe(0);
    expect(version()).toMatch(/^v2 /); // Close made a version of the unsaved change
  });
  it("Close writes the autosave-only text into a version, and with nothing changed sends nothing at all", async () => {
    await openDoc();
    fireEvent.click(screen.getByTestId("doc-close"));
    await waitFor(() => expect(window.location.pathname).toBe("/documents"));
    expect(puts().length).toBe(0);
  });
});

describe("the In this doc tab strip", () => {
  it("seven tabs; each renders a placeholder that says it is not built yet - never an error", async () => {
    await openDoc();
    const strip = screen.getByTestId("in-this-doc");
    expect(within(strip).getAllByRole("tab").map((t) => t.textContent)).toEqual(["References", "Coverage", "Topics", "Refine", "History", "Details", "Export"]);
    expect(DOC_TABS.length).toBe(7);
    for (const t of DOC_TABS) {
      fireEvent.click(within(strip).getByRole("tab", { name: t.label }));
      const panel = within(strip).getByRole("tabpanel");
      expect(panel.textContent).toMatch(new RegExp(`${t.label} is not built yet`));
      expect(strip.querySelector("[role=alert]")).toBeNull();
      expect(panel.textContent).not.toMatch(/error|could not|failed/i);
    }
  });
  it("the strip is keyboard-driven: Arrow keys, Home and End move between tabs; one tab stop", async () => {
    await openDoc();
    const strip = screen.getByTestId("in-this-doc");
    const tabs = within(strip).getAllByRole("tab");
    expect(tabs.filter((t) => t.tabIndex === 0).length).toBe(1);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(document.activeElement).toBe(tabs[6]);
    fireEvent.keyDown(tabs[6], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[6]);
  });
});

describe("keyboard: the text box is not a keyboard trap", () => {
  it("Tab is not taken by the box (it moves focus on and writes nothing); Escape hands focus to Save", async () => {
    await openDoc();
    const before = text();
    const notPrevented = fireEvent.keyDown(view().contentDOM, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(text()).toBe(before);
    view().contentDOM.focus();
    fireEvent.keyDown(view().contentDOM, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByTestId("doc-save"));
    expect(screen.getByTestId("doc-keys").textContent).toMatch(/Tab or Esc leaves the text box/);
  });
});

describe("Lock / Unlock / Swap (rwr-ui-state-keys)", () => {
  it("Lock locks this document (the account key holds the path), Unlock clears it, Swap replaces another lock", async () => {
    await openDoc();
    const btn = () => screen.getByTestId("doc-lock");
    expect(btn().textContent).toBe("Lock");
    fireEvent.click(btn());
    await waitFor(() => expect(btn().textContent).toBe("Unlock"));
    await waitFor(() => expect(settings.get("ui.locked_document")?.value).toBe(CPU));
    expect(screen.getByTestId("doc-locked-note")).toBeTruthy();
    fireEvent.click(btn());
    await waitFor(() => expect(btn().textContent).toBe("Lock"));
    await waitFor(() => expect(settings.get("ui.locked_document")?.value).toBeNull());
    // another document locked: this one offers Swap
    act(() => setLockedDocument({ id: "documents/k-a/Stack/gateway.md", title: "ALPHA One gateway" }));
    await waitFor(() => expect(btn().textContent).toBe("Swap"));
    fireEvent.click(btn());
    await waitFor(() => expect(getLockedDocument()?.id).toBe(CPU));
    await waitFor(() => expect(settings.get("ui.locked_document")?.value).toBe(CPU));
    expect(btn().textContent).toBe("Unlock");
  });
  it("opening the document makes it the Last document (identifier only)", async () => {
    await openDoc();
    await waitFor(() => expect(settings.get("ui.last_document")?.value).toBe(CPU));
  });
});

describe("selected-text toolbar: Research this", () => {
  it("is off with nothing selected; with a selection it queues the document's own research route with the selected words", async () => {
    await openDoc();
    const b = () => screen.getByTestId("research-this") as HTMLButtonElement;
    expect(b().disabled).toBe(true);
    select(0, 5);
    await waitFor(() => expect(b().disabled).toBe(false));
    expect(screen.getByTestId("sel-bar").textContent).toMatch(/5 characters selected/);
    fireEvent.click(b());
    await waitFor(() => expect(screen.getByTestId("toasts").textContent).toMatch(/Research queued on the selected text\./));
    expect(bodies.filter((x) => x.url === "/workbench/documents/research").map((x) => x.body)).toEqual([{ path: CPU, query: "ALPHA", kind: "research" }]);
    // the toast does not carry the words
    expect(screen.getByTestId("toasts").textContent).not.toMatch(/ALPHA/);
    select(3, 3);
    await waitFor(() => expect(b().disabled).toBe(true));
  });
  it("Ctrl+Alt+R is the keyboard door; a refusal is said in words", async () => {
    await openDoc();
    select(0, 5);
    const orig = fake.handle;
    vi.spyOn(fake, "handle").mockImplementation((p: string, m: string, u: string, bd?: any) =>
      u === "/workbench/documents/research" ? { status: 503, body: { error: "the research service is not configured" } } : orig(p, m, u, bd));
    fireEvent.keyDown(view().contentDOM, { key: "r", ctrlKey: true, altKey: true });
    await waitFor(() => expect(screen.getByTestId("research-err").textContent).toBe("Research is not set up on this stack yet."));
  });
});

describe("acceptance 7: two identities - bob never sees alice's text, titles, locked / last document or versions", () => {
  it("bob opening alice's document gets the one sentence a missing document gets; nothing of alice is on the page or sent", async () => {
    const seen: string[] = [];
    who = "bob";
    for (const p of [CPU, "documents/k-b/no-such.md", "documents/k-a/.trash/Hardware/dup.md"]) {
      window.history.pushState({}, "", href(p));
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("doc-gone")).toBeTruthy());
      seen.push(screen.getByTestId("main").textContent ?? "");
      expect(document.body.innerHTML).not.toMatch(/ALPHA|SRC-ALPHA|k-a|u-alice|Hardware/);
      cleanup(); resetState();
    }
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toContain(NOT_FOUND);
    // bob changed nothing and the editor never mounted for him
    expect(bodies.filter((b) => b.who === "bob" && b.method !== "GET" && !b.url.startsWith("/workbench/settings"))).toEqual([]);
    expect(bodies.some((b) => b.url.startsWith("/workbench/documents/history") || b.url.startsWith("/workbench/documents/research"))).toBe(false);
  });
  it("alice's unsent draft is gone when the person changes without a reload, and nothing of it is sent under bob", async () => {
    window.history.pushState({}, "", href(CPU));
    const route = () => ({ route: parseRoute(window.location.pathname), params: { id: CPU }, whoAnswered: true });
    const ui = (subject: string) => <ToastProvider><DocumentScreen {...route()} subject={subject} /></ToastProvider>;
    const r = render(ui("u-alice"));
    await waitFor(() => expect(screen.getByTestId("doc-editor").querySelector(".cm-content")).toBeTruthy());
    await waitFor(() => expect(version()).toMatch(/^v1/));
    type(" ALICE-DRAFT-MARKER");
    fireEvent.click(screen.getByTestId("doc-lock"));
    await waitFor(() => expect(screen.getByTestId("doc-lock").textContent).toBe("Unlock"));
    // the person changes: the shell resets the account copy first (shell-data), then the screen gets the new subject
    who = "bob";
    const n = bodies.length;
    act(() => resetState());
    r.rerender(ui("u-bob"));
    await waitFor(() => expect(screen.getByTestId("doc-gone")).toBeTruthy());
    expect(document.body.innerHTML).not.toMatch(/ALICE-DRAFT-MARKER|ALPHA/);
    expect(screen.queryByTestId("doc-editor")).toBeNull();
    expect(getLockedDocument()).toBeNull();
    // after the switch nothing carried the draft; the draft was never written under alice either (no pause was long enough)
    expect(bodies.slice(n).some((b) => JSON.stringify(b.body ?? "").includes("ALICE-DRAFT-MARKER"))).toBe(false);
    expect(bodies.slice(n).filter((b) => b.method === "PUT" && b.url.startsWith("/workbench/documents/file"))).toEqual([]);
  });
  it("a pending autosave sends nothing when the person has changed and the shell has not noticed yet", async () => {
    await openDoc();
    type(" ALICE-PENDING-WORDS");
    who = "bob"; // the session is bob's now; this page still shows alice's document and has not been told
    const n = bodies.length;
    await waitFor(() => expect(screen.getByTestId("doc-error").textContent).toMatch(/could not confirm that you are still the person who opened this document/), { timeout: 4000 });
    expect(bodies.slice(n).filter((b) => b.method === "PUT")).toEqual([]);
    expect(bodies.slice(n).some((b) => JSON.stringify(b.body ?? "").includes("ALICE-PENDING-WORDS"))).toBe(false);
    expect(fileOf().content).not.toMatch(/ALICE-PENDING/);
    // Save does not send it either
    fireEvent.click(screen.getByTestId("doc-save"));
    await new Promise((r) => setTimeout(r, 100));
    expect(bodies.slice(n).filter((b) => b.method === "PUT")).toEqual([]);
  });
  it("leaving by an in-app door writes the unwritten text for the same person", async () => {
    await openDoc();
    type(" leaving words");
    act(() => { window.history.pushState({}, "", "/documents"); window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(fileOf().content).toMatch(/leaving words$/));
  });
  it("a refusal for another person's row and for a missing row is the same on the wire", () => {
    const mine = fake.handle("bob", "PUT", `/workbench/documents/file?path=${CPU}`, { content: "x", if_match: "h" });
    const none = fake.handle("bob", "PUT", `/workbench/documents/file?path=documents/k-b/none.md`, { content: "x", if_match: "h" });
    expect(mine).toEqual(none);
    expect(fake.handle("bob", "POST", "/workbench/documents/research", { path: CPU, query: "q" })).toEqual(fake.handle("bob", "POST", "/workbench/documents/research", { path: "documents/k-b/none.md", query: "q" }));
    expect(fileOf().content).not.toBe("x");
  });
});

describe("acceptance 8: nothing private is cached in the browser or put on a shared surface (planted marker)", () => {
  it("the marker typed, saved and closed is in no storage, cookie, title, account key or console line", async () => {
    const con = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m as "log"));
    await openDoc();
    type(" PLANTED-MARKER-7731");
    fireEvent.click(screen.getByTestId("doc-save"));
    await waitFor(() => expect(version()).toMatch(/^v2 · saved/));
    fireEvent.click(screen.getByTestId("doc-lock"));
    await waitFor(() => expect(settings.get("ui.locked_document")?.value).toBe(CPU));
    fireEvent.click(screen.getByTestId("doc-close"));
    await waitFor(() => expect(window.location.pathname).toBe("/documents"));
    const all = JSON.stringify({ ls: { ...window.localStorage }, ss: { ...window.sessionStorage }, ck: document.cookie, t: document.title, acct: [...settings] });
    expect(all).not.toMatch(/PLANTED-MARKER|ALPHA/);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    expect(document.title).toBe("Documents - Research workbench");
    for (const c of con) expect(c).not.toHaveBeenCalled();
    expect(requestLog().every((r) => r.url.startsWith("/workbench/"))).toBe(true);
  });
  it("the page title on the document screen names no document", async () => {
    await openDoc();
    expect(document.title).toBe("Document - Research workbench");
  });
  it("CodeMirror's own <style> element carries the page's CSP nonce (serve.mjs allows only that one), and none is made up without a meta tag", async () => {
    const meta = document.createElement("meta");
    meta.name = "csp-nonce"; meta.content = "QUJDREVGR0hJSktMTU5PUA==";
    document.head.appendChild(meta);
    try {
      await openDoc();
      const styles = [...document.querySelectorAll("style")].filter((x) => x.getAttribute("nonce"));
      expect(styles.length).toBeGreaterThan(0);
      expect(styles.every((x) => x.getAttribute("nonce") === "QUJDREVGR0hJSktMTU5PUA==")).toBe(true);
    } finally { meta.remove(); }
    expect(cspNonce()).toBeNull();
    const bad = document.createElement("meta"); bad.name = "csp-nonce"; bad.content = "__CSP_NONCE__"; document.head.appendChild(bad);
    expect(cspNonce()).toBeNull(); // the unrewritten placeholder (a dev server) is not a nonce
    bad.remove();
  });
  it("the editor's code keeps nothing in the browser and reaches the back end only through lib/api.ts", () => {
    const files = [
      ...readdirSync("src/screens/document-editor").map((f) => "src/screens/document-editor/" + f),
      ...readdirSync("src/editor").map((f) => "src/editor/" + f),
      "src/lib/grammar.ts",
    ];
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie|console\.(log|info|warn|error|debug)/);
    }
  });
});
