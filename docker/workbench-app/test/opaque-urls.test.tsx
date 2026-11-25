// rwr-doc-opaque-urls: a document link never puts a title, a slug or the owner's folder key in the address bar, in the
// browser history, in a link's href or in the page title (operator decision 2026-11-23). This walks EVERY document link
// builder of the app (the Documents list's title and Open, the document screen and the editor, a new document, Home's
// Continue writing, the rail's Last and Locked slot, Start research's prefill and its way back) as alice, and after each
// step inspects: location, every URL handed to history.pushState / replaceState, every <a href> on the page, and
// document.title. Then: an old /documents/<path> address is replaced by the id form (replaceState, no new entry); and with
// two identities another person's id, a deleted one and a made-up one are the same one sentence.
// The fake back end is e2e/docs-fake.mjs (the shared one): its ids are kept through every move, as the server's listing
// row's is, and its resolve read answers the owner only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, configure } from "@testing-library/react";
import { App } from "../src/App";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { NOT_FOUND, hrefOfPath, docHref } from "../src/screens/documents/docs-data";
import { startResearchHref } from "../src/screens/research-start/start-data";
import { createFake, PEOPLE, uid } from "../e2e/docs-fake.mjs";
import { createFake as createIdeasFake } from "../e2e/ideas-fake.mjs";

configure({ asyncUtilTimeout: 5000 });
const NOW = Date.now();
const fake = createFake({ now: () => NOW });
// the Ideas screen's own back end (rwr-ideas); it also answers state / resolve for the documents of an idea
let ideasFake = createIdeasFake({ now: () => NOW });
let who: "alice" | "bob" = "alice";
const settings = new Map<string, { value: unknown; version: number }>();
const CPU = "documents/k-a/Hardware/cpu.md";
const GATEWAY = "documents/k-a/Stack/gateway.md";
const ID = (p: string) => uid(p);
const H = (p: string) => "/documents/d/" + ID(p);

// what must never appear in an address: a title word, a file-name slug, a folder, the owner's folder key, an encoded
// slash, the .md extension, the vault prefix of an owner
const LEAK = /u-alice|k-a|alpha|upgrading|\bcpu\b|gateway|hardware|stack|draft|fresh|%2F|\.md|documents\/k/i;

function stub() {
  setFetcher(async (u, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
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
    if (path === "/workbench/research/preview") return j({ ok: true, question: "q", topic: "t", links: [], depth: { name: "standard", rounds: 2, max_fetch: 40, wall_ms: 600000 }, refusal: null });
    if (/^\/workbench\/(contract\/ideas|ideas\/)/.test(path) || path === "/workbench/documents/seed") { const a = ideasFake.handle(method, u, body, who); return j(a.body, a.status); }
    if (path === "/workbench/documents/state" || path === "/workbench/documents/resolve") { const a = ideasFake.handle(method, u, body, who); if (a.status === 200 || ideasFake.state.docState === "fail") return j(a.body, a.status); }
    const r = fake.handle(who, method, u, body ?? {});
    if (r) return j(r.body, r.status);
    if (path === "/workbench/contract/sessions") return j({ sessions: [] });
    if (path === "/workbench/intake/jobs") return j({ jobs: who === "alice" ? importJobs : [] });
    return j({ error: "not found" }, 404);
  });
}

// alice's one import job, landed in the CPU document: the Imports screen's "Landed in" link is one more document link builder
const importJobs = [{ id: "99999999-0000-4000-8000-000000000001", kind: "add", status: "held", created_at: new Date(NOW - 3600000).toISOString(), updated_at: new Date(NOW - 3600000).toISOString(),
  detail: { url: "https://example.test/article", doc_path: "documents/k-a/Hardware/cpu.md", held_source_id: "aaaaaaaa-0000-4000-8000-000000000001", attempts: 1, actions: [] } }];

// every URL the app hands to the history, and every leak found so far
let urls: string[] = [];
let pushes: string[] = [];
let replaces: string[] = [];
function watchHistory() {
  urls = []; pushes = []; replaces = [];
  const push = window.history.pushState.bind(window.history), rep = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, "pushState").mockImplementation((s, t, u) => { urls.push(String(u)); pushes.push(String(u)); push(s, t, u); });
  vi.spyOn(window.history, "replaceState").mockImplementation((s, t, u) => { urls.push(String(u)); replaces.push(String(u)); rep(s, t, u); });
}
// everything the person (or the browser's history list) could see of a link: returns the leaks, named
function leaks(): string[] {
  const out: string[] = [];
  const check = (what: string, v: string | null | undefined) => { if (v && LEAK.test(decodeURIComponent(v))) out.push(`${what}: ${v}`); };
  check("location", window.location.pathname + window.location.search + window.location.hash);
  urls.forEach((u) => check("history entry", u));
  document.querySelectorAll("a[href]").forEach((a) => check("href", a.getAttribute("href")));
  check("document.title", document.title);
  return out;
}
const none = () => expect(leaks()).toEqual([]);

const row = (title: string) => screen.getAllByTestId("doc-row").find((r) => r.textContent?.includes(title))!;
const edText = () => screen.getByTestId("doc-editor").querySelector(".cm-content")?.textContent ?? "";

beforeEach(() => {
  ideasFake = createIdeasFake({ now: () => NOW });
  cleanup(); clearRequestLog(); resetState(); fake.reset(); settings.clear(); who = "alice";
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("every document link builder, walked as alice", () => {
  it("the Documents list, the document screen, the editor and the rail slots never carry a title, a slug or the owner's key", async () => {
    window.history.pushState({}, "", "/documents");
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(3));
    // the list: every title link and every Open button
    const hrefs = screen.getAllByTestId("doc-row").flatMap((r) => [...r.querySelectorAll("a")].map((a) => a.getAttribute("href")));
    expect(hrefs.length).toBe(6);
    for (const h of hrefs) expect(h).toMatch(/^\/documents\/d\/[0-9a-f-]{36}$/);
    none();
    // a title opens the writing surface at the id; it becomes the Last document: the rail slot is the id too
    fireEvent.click(within(row("ALPHA Upgrading the CPU")).getByTestId("doc-title"));
    expect(window.location.pathname).toBe(H(CPU));
    await waitFor(() => expect(edText()).toMatch(/ALPHA body of the CPU plan/));
    await waitFor(() => expect(screen.getByTestId("doc-slot").getAttribute("href")).toBe(H(CPU)));
    expect(screen.getByTestId("doc-slot").textContent).toBe("ALPHA Upgrading the CPU"); // the title is shown, never addressed
    none();
    // Lock: the Locked slot is the id too
    fireEvent.click(screen.getByTestId("doc-lock"));
    await waitFor(() => expect(screen.getByTestId("doc-lock").textContent).toBe("Unlock"));
    expect(screen.getByTestId("doc-slot").getAttribute("href")).toBe(H(CPU));
    none();
    // Close goes back to the list; Open (the button) opens another document at its id
    fireEvent.click(screen.getByTestId("doc-close"));
    await waitFor(() => expect(window.location.pathname).toBe("/documents"));
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(3));
    fireEvent.click(within(row("ALPHA One gateway")).getByTestId("act-open"));
    expect(window.location.pathname).toBe(H(GATEWAY));
    await waitFor(() => expect(edText()).toMatch(/ALPHA gateway notes/));
    none();
    // no entry the app made names a path: only /documents and /documents/d/<id> were pushed
    for (const u of pushes) expect(u).toMatch(/^\/documents(\/d\/[0-9a-f-]{36})?$/);
  });

  it("archiving a document keeps its id: the rail slot and the address do not change, nothing names the path", async () => {
    window.history.pushState({}, "", "/documents");
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(3));
    fireEvent.click(within(row("ALPHA One gateway")).getByTestId("doc-title"));
    await waitFor(() => expect(edText()).toMatch(/ALPHA gateway notes/));
    await waitFor(() => expect(screen.getByTestId("doc-slot").getAttribute("href")).toBe(H(GATEWAY)));
    fireEvent.click(screen.getByTestId("doc-close"));
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(3));
    fireEvent.click(within(row("ALPHA One gateway")).getByTestId("act-archive"));
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(2));
    expect(screen.getByTestId("doc-slot").getAttribute("href")).toBe(H(GATEWAY)); // the path moved under .archive; the id did not
    fireEvent.click(screen.getByTestId("doc-slot"));
    await waitFor(() => expect(screen.getByTestId("document").dataset.docState).toBe("archived"));
    expect(window.location.pathname).toBe(H(GATEWAY));
    none();
    // Unarchive: the same address, the writing surface again
    fireEvent.click(screen.getByTestId("doc-unarchive"));
    await waitFor(() => expect(screen.getByTestId("document").dataset.docState).toBe("active"));
    expect(window.location.pathname).toBe(H(GATEWAY));
    none();
  });

  it("a new document opens at its id, read back from the server (the create answers with the path only)", async () => {
    window.history.pushState({}, "", "/documents");
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(3));
    fireEvent.click(screen.getByTestId("new-doc"));
    fireEvent.change(screen.getByTestId("doc-name"), { target: { value: "ALPHA fresh notes" } });
    fireEvent.click(screen.getByTestId("doc-ok"));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/documents\/d\/[0-9a-f-]{36}$/));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ALPHA fresh notes"));
    await waitFor(() => expect(screen.getByTestId("doc-slot").getAttribute("href")).toBe(window.location.pathname));
    none();
  });

  it("Home's Continue writing rows are ids; the row opens the document at its id", async () => {
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("row-doc").length).toBe(3));
    for (const a of screen.getAllByTestId("row-doc")) expect(a.getAttribute("href")).toMatch(/^\/documents\/d\/[0-9a-f-]{36}$/);
    none();
    fireEvent.click(screen.getAllByTestId("row-doc")[0]);
    expect(window.location.pathname).toBe(H(CPU)); // the newest edit
    await waitFor(() => expect(edText()).toMatch(/ALPHA body of the CPU plan/));
    none();
  });

  it("Start research from a document: the prefill is the id, the way back is the id, and none of it names the path", async () => {
    watchHistory();
    const href = startResearchHref(ID(CPU));
    expect(href).toBe("/research/start?document=" + ID(CPU));
    expect(startResearchHref(CPU)).toBe("/research/start"); // a path is never put in an address
    window.history.pushState({}, "", href);
    render(<App />);
    const bar = await screen.findByTestId("for-document");
    expect(within(bar).getByTestId("for-document-title").textContent).toBe("ALPHA Upgrading the CPU");
    expect(within(bar).getByTestId("for-document-back").getAttribute("href")).toBe(H(CPU));
    none();
    // choosing a document in the dialog: the way back is that document's id as well
    fireEvent.click(screen.getByTestId("attach-none"));
    fireEvent.click(screen.getByTestId("attach-doc"));
    const picks = await screen.findAllByTestId("doc-choice");
    fireEvent.click(picks.find((p) => p.textContent === "ALPHA One gateway")!);
    expect(screen.getByTestId("for-document-back").getAttribute("href")).toBe(H(GATEWAY));
    none();
    fireEvent.keyDown(screen.getByTestId("start-question"), { key: "Escape" }); // Esc goes back to the document the dialog was opened for
    expect(window.location.pathname).toBe(H(CPU));
    none();
  });

  it("a [[doc:<path>]] link is turned into the target's id before the address changes", async () => {
    expect(await hrefOfPath(GATEWAY)).toBe(H(GATEWAY));
    expect(await hrefOfPath("documents/k-a/no-such.md")).toBeNull();
    expect(docHref("")).toBe("/documents"); // no id, no address that names anything
  });
});

describe("the Imports screen's Landed in link", () => {
  it("is the document's id: no title, slug, folder key or .md in the href, the address or history", async () => {
    window.history.pushState({}, "", "/imports");
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("imp-row").length).toBe(1));
    fireEvent.click(screen.getAllByTestId("imp-row")[0]);
    const link = await waitFor(() => within(screen.getByTestId("imp-details")).getByRole("link", { name: /Document:/ }));
    expect(link.getAttribute("href")).toBe(H(CPU));
    none();
    fireEvent.click(link);
    expect(window.location.pathname).toBe(H(CPU));
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toBeTruthy());
    none();
    for (const u of pushes) expect(u).toMatch(/^\/(imports|documents\/d\/[0-9a-f-]{36})$/);
  });
});

describe("an old /documents/<path> address", () => {
  it("is replaced by the id form with history.replaceState: the path is in no history entry the app made", async () => {
    window.history.pushState({}, "", "/documents/" + encodeURIComponent(CPU));
    const before = window.history.length;
    watchHistory();
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe(H(CPU)));
    await waitFor(() => expect(edText()).toMatch(/ALPHA body of the CPU plan/));
    expect(replaces).toContain(H(CPU));
    expect(pushes.filter((u) => LEAK.test(decodeURIComponent(u)))).toEqual([]); // the app pushed no path
    expect(window.history.length).toBe(before); // and the swap added no entry
    expect(urls.filter((u) => LEAK.test(decodeURIComponent(u)))).toEqual([]);
    none();
  });
  it("a trashed document's old path address becomes its id and shows the trash page", async () => {
    window.history.pushState({}, "", "/documents/" + encodeURIComponent("documents/k-a/.trash/Hardware/dup.md"));
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("doc-trashed")).toBeTruthy());
    expect(window.location.pathname).toBe(H("documents/k-a/.trash/Hardware/dup.md"));
    none();
  });
});

describe("two identities", () => {
  const sentence = async (path: string) => {
    cleanup(); resetState();
    window.history.pushState({}, "", path);
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("doc-gone")).toBeTruthy());
    expect(screen.getByTestId("doc-gone").textContent).toBe(NOT_FOUND);
    expect(screen.getByTestId("main").textContent).not.toMatch(/ALPHA/);
    return screen.getByTestId("main").innerHTML;
  };
  it("bob opening alice's /documents/d/<id> sees exactly the missing-document page; his read answers him as a made-up id", async () => {
    who = "bob";
    const foreign = await sentence(H(CPU));
    const missing = await sentence("/documents/d/" + uid("nothing-here"));
    const junk = await sentence("/documents/d/not-an-id");
    expect(foreign).toBe(missing);
    expect(foreign).toBe(junk);
    // the resolve read itself: same status, same body for alice's id, a made-up id and no id
    const ask = (id: string) => fake.handle("bob", "GET", "/workbench/documents/resolve?id=" + id, {});
    expect(ask(ID(CPU))).toEqual(ask(uid("nothing-here")));
    expect(ask(ID(CPU))).toEqual({ status: 404, body: { error: "no such document" } });
    expect(ask("")).toEqual(ask(ID(CPU)));
    // and alice's own id still opens for alice
    expect(fake.handle("alice", "GET", "/workbench/documents/resolve?id=" + ID(CPU), {})!.status).toBe(200);
  });
  it("bob opening alice's old path address is replaced by the id form of nothing: the same sentence, no path left", async () => {
    who = "bob";
    window.history.pushState({}, "", "/documents/" + encodeURIComponent(CPU));
    const before = window.history.length;
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("doc-gone").textContent).toBe(NOT_FOUND));
    expect(window.location.pathname).toBe("/documents/d/none");
    expect(window.history.length).toBe(before);
    expect(urls.filter((u) => LEAK.test(decodeURIComponent(u)))).toEqual([]);
    none();
  });
  it("bob's Documents list, Home and rail carry only his own ids", async () => {
    who = "bob";
    window.history.pushState({}, "", "/documents");
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(1));
    const hrefs = [...document.querySelectorAll("a[href^='/documents/d/']")].map((a) => a.getAttribute("href"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toBe("/documents/d/" + uid("documents/k-b/bravo.md"));
    expect(document.body.innerHTML).not.toMatch(/ALPHA/);
  });
});

describe("the page title and storage", () => {
  it("document.title names the screen, never a document; no title or path is put in browser storage", async () => {
    window.history.pushState({}, "", H(CPU));
    render(<App />);
    await waitFor(() => expect(edText()).toMatch(/ALPHA body/));
    expect(document.title).toBe("Document - Research workbench");
    for (const s of [window.localStorage, window.sessionStorage]) for (let i = 0; i < s.length; i++) expect(String(s.getItem(s.key(i)!))).not.toMatch(/ALPHA|k-a/);
    // the account keys keep the PATH (account-side, never an address): that is allowed; nothing else is stored
    expect(JSON.stringify([...settings])).not.toMatch(/ALPHA/);
  });
});

describe("the Ideas screen's document links (rwr-ideas)", () => {
  const pickIdea = async (title: string) => {
    fireEvent.click(screen.getAllByTestId("idea-row").find((r) => r.querySelector(".idea-pick-title")!.textContent === title)!);
    await waitFor(() => expect(screen.getByTestId("idea-title").textContent).toBe(title));
  };
  const openIdeas = async () => {
    window.history.pushState({}, "", "/ideas");
    watchHistory();
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId("ideas-loading")).toBeNull());
    await screen.findByTestId("idea-view");
  };
  const seedIdeas = () => {
    ideasFake.addIdea(PEOPLE.alice.sub, { title: "ALPHA Plan the CPU upgrade", status: "promoted", created: new Date(NOW - 3 * 864e5).toISOString(), document: { path: CPU, title: "ALPHA Upgrading the CPU" } });
    ideasFake.addIdea(PEOPLE.alice.sub, { title: "ALPHA Move the wiki", status: "new", created: new Date(NOW - 5 * 864e5).toISOString() });
  };

  it("Open its document, the document under what belongs to it and the address after Create are all /documents/d/<id>", async () => {
    seedIdeas();
    await openIdeas();
    await pickIdea("ALPHA Plan the CPU upgrade");
    const link = await screen.findByTestId("act-document");
    await waitFor(() => expect(screen.getByTestId("act-document").tagName).toBe("A"));
    expect(screen.getByTestId("act-document").getAttribute("href")).toBe(H(CPU));
    const mem = screen.getAllByTestId("mem").find((m) => m.textContent?.includes("Document"))!;
    await waitFor(() => expect(mem.tagName).toBe("A"));
    expect(mem.getAttribute("href")).toBe(H(CPU));
    expect(link).toBeTruthy();
    none();
    // Create: the seed answers with a path only; the address is the id read back, never the path
    await pickIdea("ALPHA Move the wiki");
    fireEvent.click(screen.getByTestId("act-document"));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/documents\/d\/[0-9a-f-]{36}$/));
    none();
    for (const u of pushes) expect(u).toMatch(/^\/(ideas|documents(\/d\/[0-9a-f-]{36})?)$/);
  });

  it("when the id cannot be read back there is no link at all (never a path address) and Create says so", async () => {
    seedIdeas();
    ideasFake.hook("doc-state", { mode: "noid" });
    await openIdeas();
    await pickIdea("ALPHA Plan the CPU upgrade");
    await waitFor(() => expect(screen.getByTestId("doc-unavailable")).toBeTruthy());
    expect(screen.getByTestId("act-document").tagName).not.toBe("A");
    const mem = screen.getAllByTestId("mem").find((m) => m.textContent?.includes("Document"))!;
    expect(mem.tagName).not.toBe("A");
    none();
    await pickIdea("ALPHA Move the wiki");
    fireEvent.click(screen.getByTestId("act-document"));
    await waitFor(() => expect(screen.getByTestId("toasts").textContent).toMatch(/Open it from Documents/));
    expect(window.location.pathname).toBe("/ideas");
    none();
  });
});
