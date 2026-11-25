// The Ideas screen (rwr-ideas): the list by state, the open idea, Revise (a new revision, earlier runs stay linked to their
// wording, asserted by id), Archive / Reopen, Research this idea (the idea's own research-now, never Start research), every
// idea marked private, the two-identity planted-marker test, a person switch without a reload, and nothing kept in the browser.
// The back end is e2e/ideas-fake.mjs, the SAME module the headless-Chromium lab serves.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { App } from "../src/App";
import { Ideas, RESEARCH_POLL_MS } from "../src/screens/ideas/Ideas";
import { ToastProvider } from "../src/shell/Toast";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { uid as docUid } from "../e2e/docs-fake.mjs";
import { createFake, NOT_WAITING, UNCONFIGURED, type Who } from "../e2e/ideas-fake.mjs";

let fake = createFake();
let who: Who = "alice";
let ids: Record<string, string> = {};
const MARK_A = "ALPHA-PLANTED-9f3c", MARK_B = "BRAVO-PLANTED-71d2";

function seed() {
  fake = createFake();
  ids = {};
  const A = fake.people.alice.sub, B = fake.people.bob.sub;
  ids.wiki = fake.addIdea(A, { title: "Move the wiki to the cluster", summary: `${MARK_A} run the wiki on the cluster`, status: "new", created: fake.iso(5 * fake.D), thread_root: "mm-1" });
  ids.cpu = fake.addIdea(A, {
    title: "Plan the CPU upgrade", status: "researched", created: fake.iso(14 * fake.D), updated: fake.iso(2 * fake.H),
    revisions: [`${MARK_A} move to a top part`, `${MARK_A} narrowed to boards with strong power stages`], jobs: ["job-old", null], sessionQueries: { "job-old": "Which LGA2066 CPUs fit a 7820X board?" },
    document: null, podcasts: ["p1", "p2"], room: { entries: 5 }, user_sources: [{ id: "s1", title: "Your own: pantry export" }], revAt: [fake.iso(14 * fake.D), fake.iso(fake.D)],
  });
  ids.old = fake.addIdea(A, { title: "A weekly podcast of what changed", summary: `${MARK_A} one episode a week`, status: "archived", created: fake.iso(60 * fake.D) });
  ids.bob = fake.addIdea(B, { title: "Bob's idea", summary: `${MARK_B} something of bob's`, status: "engaged", created: fake.iso(3 * fake.D) });
}

let gate: Promise<void> | null = null; // holds an archive write until the test lets it through
function stub() {
  setFetcher(async (u, init) => {
    if (gate && /\/archive$/.test(u)) await gate;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const a = fake.handle((init?.method ?? "GET").toUpperCase(), u, body, who);
    return new Response(JSON.stringify(a.body), { status: a.status });
  });
}

const renderApp = async () => {
  window.history.pushState({}, "", "/ideas");
  render(<App />);
  await waitFor(() => expect(screen.queryByTestId("ideas-loading")).toBeNull());
  await screen.findByTestId("idea-view");
};
const rows = () => screen.queryAllByTestId("idea-row");
const rowTitles = () => rows().map((r) => r.querySelector(".idea-pick-title")!.textContent);
const pick = async (title: string) => {
  fireEvent.click(rows().find((r) => r.querySelector(".idea-pick-title")!.textContent === title)!);
  await waitFor(() => expect(screen.getByTestId("idea-title").textContent).toBe(title));
};
const posts = () => requestLog().filter((r) => r.method !== "GET").map((r) => r.method + " " + r.url);

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); who = "alice"; gate = null; seed(); stub();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the list, by state", () => {
  it("lists only the caller's ideas in groups, each marked private, and opens the first", async () => {
    await renderApp();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ideas");
    expect(["new", "refining", "archived"].map((g) => within(screen.getByTestId("group-" + g)).getByRole("heading").textContent)).toEqual(["New · 1", "Refining · 1", "Archived · 1"]);
    expect(rowTitles()).toEqual(["Move the wiki to the cluster", "Plan the CPU upgrade", "A weekly podcast of what changed"]);
    for (const r of rows()) expect(r.textContent).toMatch(/private to you/);
    expect(screen.getByTestId("idea-title").textContent).toBe("Move the wiki to the cluster");
    expect(screen.getByTestId("idea-private").textContent).toBe("private to you");
    expect(document.body.textContent).not.toMatch(/Bob's idea|BRAVO/);
  });
  it("a person with no ideas sees an empty state, not an error", async () => {
    who = "nobody";
    window.history.pushState({}, "", "/ideas");
    render(<App />);
    expect((await screen.findByTestId("ideas-empty")).textContent).toMatch(/no ideas yet/);
    expect(screen.queryByTestId("ideas-failed")).toBeNull();
    expect(screen.queryByTestId("idea-view")).toBeNull();
  });
  it("a failed read says so and offers a retry; a 200 that is not the list is a failure, never an empty list", async () => {
    fake.hook("fail-list", { on: true });
    window.history.pushState({}, "", "/ideas");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByTestId("ideas-failed");
    cleanup();
    setFetcher(async (u, init) => {
      if (/contract\/ideas/.test(u)) return new Response("<html>please sign in</html>", { status: 200 });
      const a = fake.handle((init?.method ?? "GET").toUpperCase(), u, undefined, who);
      return new Response(JSON.stringify(a.body), { status: a.status });
    });
    window.history.pushState({}, "", "/ideas");
    render(<App />);
    await screen.findByTestId("ideas-failed");
    expect(screen.queryByTestId("ideas-empty")).toBeNull();
  });
});

describe("the open idea", () => {
  it("shows wording, where it came from, when, what belongs to it and how it changed", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    expect(screen.getByTestId("idea-state").textContent).toBe("researched");
    expect(screen.getByTestId("idea-view").textContent).toMatch(/captured 14 days ago · from a thought you captured/);
    expect(screen.getByTestId("idea-summary").textContent).toContain("narrowed to boards");
    const belongs = within(screen.getByTestId("belongs"));
    expect(belongs.getAllByTestId("mem").map((m) => m.textContent)).toEqual([
      "ResearchWhich LGA2066 CPUs fit a 7820X board?done", "ChatThe idea's room5 entries", "Podcast2 podcasts", "SourceYour own: pantry exporta source you added",
    ]);
    const revs = within(screen.getByTestId("changed")).getAllByTestId("rev");
    expect(revs.map((r) => r.getAttribute("data-revision"))).toEqual(["2", "1"]);
    expect(revs[0].textContent).toMatch(/Revision 2 \(current\)/);
    expect(revs[1].textContent).toMatch(/Captured/);
  });
  it("an idea from a Mattermost message says so", async () => {
    await renderApp();
    expect(screen.getByTestId("idea-view").textContent).toMatch(/from a Mattermost message/);
  });
  it("Discuss it and Refine it in chat are not shown (their screens are not built)", async () => {
    await renderApp();
    expect(screen.queryByText(/Discuss it/)).toBeNull();
    expect(screen.queryByText(/Refine it in chat/)).toBeNull();
  });
});

describe("Revise: a new revision, earlier runs stay with their wording (acceptance 1)", () => {
  it("saves the new wording as the next revision; the run of the old wording keeps its revision, by id", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    const runBefore = fake.ideas.get(ids.cpu).revisions.map((r: any) => [r.revision, r.research_job_id]);
    expect(runBefore).toEqual([[1, "job-old"], [2, null]]);
    fireEvent.click(screen.getByTestId("act-revise"));
    const ta = screen.getByTestId("revise-text") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toContain("narrowed to boards");
    fireEvent.change(ta, { target: { value: `${MARK_A} third wording: also check the cooler` } });
    fireEvent.click(screen.getByTestId("revise-save"));
    await waitFor(() => expect(screen.getAllByTestId("rev").length).toBe(3));
    expect(posts()).toEqual([`POST /workbench/ideas/${ids.cpu}/edit`]);
    // server side, by id
    const revs = fake.ideas.get(ids.cpu).revisions;
    expect(revs.map((r: any) => [r.revision, r.research_job_id])).toEqual([[1, "job-old"], [2, null], [3, null]]);
    expect(fake.ideas.get(ids.cpu).summary).toContain("third wording");
    // the screen: the run still hangs on revision 1, the new revision carries none
    const shown = screen.getAllByTestId("rev");
    expect(shown.map((r) => [r.getAttribute("data-revision"), r.getAttribute("data-run-id")])).toEqual([["3", null], ["2", null], ["1", "job-old"]]);
    expect(shown[2].textContent).toMatch(/Research started from this wording: Which LGA2066/);
    expect(screen.getByTestId("toasts").textContent).toMatch(/Saved as revision 3/);
    expect(screen.queryByTestId("revise-form")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("act-revise"));
    // the boundary forms a run for revision 3 later: it joins revision 3 only
    act(() => { fake.hook("form-run", { id: ids.cpu, query: "the new question" }); });
    expect(fake.ideas.get(ids.cpu).revisions.map((r: any) => !!r.research_job_id)).toEqual([true, false, true]);
  });
  it("an unchanged wording says so and adds nothing; Cancel and Escape close the form without a write", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-revise"));
    expect((screen.getByTestId("revise-save") as HTMLButtonElement).disabled).toBe(true); // the same text: nothing to save
    fireEvent.click(screen.getByTestId("revise-cancel"));
    expect(screen.queryByTestId("revise-form")).toBeNull();
    fireEvent.click(screen.getByTestId("act-revise"));
    fireEvent.keyDown(screen.getByTestId("revise-text"), { key: "Escape" });
    expect(screen.queryByTestId("revise-form")).toBeNull();
    expect(posts()).toEqual([]);
  });
});

describe("Archive and Reopen (acceptance 2)", () => {
  it("Archive moves the idea to Archived with an Undo; Reopen brings it back exactly as it was", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    const before = JSON.stringify([fake.ideas.get(ids.cpu).summary, fake.ideas.get(ids.cpu).revisions, fake.ideas.get(ids.cpu).status]);
    fireEvent.click(screen.getByTestId("act-archive"));
    await waitFor(() => expect(within(screen.getByTestId("group-archived")).getAllByTestId("idea-row").length).toBe(2));
    expect(fake.ideas.get(ids.cpu).status).toBe("archived");
    expect(screen.getByTestId("idea-archived-note")).toBeTruthy();
    expect((screen.getByTestId("act-research") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("act-revise") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("toasts").textContent).toMatch(/Scheduled research for it has stopped/);
    expect(screen.getByTestId("toasts").textContent).not.toMatch(/Plan the CPU|ALPHA/); // a toast never carries the idea's text
    fireEvent.click(screen.getByTestId("act-reopen"));
    await waitFor(() => expect(screen.queryByTestId("idea-archived-note")).toBeNull());
    expect(JSON.stringify([fake.ideas.get(ids.cpu).summary, fake.ideas.get(ids.cpu).revisions, fake.ideas.get(ids.cpu).status])).toBe(before);
    expect(posts()).toEqual([`POST /workbench/ideas/${ids.cpu}/archive`, `POST /workbench/ideas/${ids.cpu}/reopen`]);
    expect(within(screen.getByTestId("group-refining")).getAllByTestId("idea-row").length).toBe(1);
  });
  it("Undo on the archive toast reopens the idea", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-archive"));
    await waitFor(() => expect(fake.ideas.get(ids.cpu).status).toBe("archived"));
    fireEvent.click(await screen.findByTestId("toast-undo"));
    await waitFor(() => expect(fake.ideas.get(ids.cpu).status).toBe("researched"));
  });
  it("an archived idea opens with Reopen, and can be reopened (it was archived with no stamp: back to engaged)", async () => {
    await renderApp();
    await pick("A weekly podcast of what changed");
    expect(screen.getByTestId("act-reopen")).toBeTruthy();
    fireEvent.click(screen.getByTestId("act-reopen"));
    await waitFor(() => expect(fake.ideas.get(ids.old).status).toBe("engaged"));
  });
  it("a refusal (the idea was archived elsewhere) is shown in plain words, nothing else changes", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    fake.ideas.get(ids.cpu).status = "archived"; // archived in another window
    fireEvent.click(screen.getByTestId("act-archive"));
    expect((await screen.findByTestId("idea-error")).textContent).toBe("this idea is already archived");
  });
});

describe("Research this idea: the idea's own research-now (acceptance 8)", () => {
  it("calls research-now for that idea and nothing else; it never reaches Start research or POST /workbench/research", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    expect(screen.getByTestId("act-research").tagName).toBe("BUTTON"); // not a link to the Start research dialog
    expect(within(screen.getByTestId("ideas")).queryByRole("link", { name: /start research/i })).toBeNull();
    expect(screen.getByTestId("ideas").querySelector('a[href^="/research/start"]')).toBeNull();
    fireEvent.click(screen.getByTestId("act-research"));
    await waitFor(() => expect(screen.getByTestId("research-state").getAttribute("data-state")).toBe("pending"));
    expect(posts()).toEqual([`POST /workbench/ideas/${ids.cpu}/research-now`]);
    expect(requestLog().some((r) => /\/workbench\/research(\/|\?|$)/.test(r.url))).toBe(false);
    expect(window.location.pathname).toBe("/ideas");
    expect(screen.getByTestId("research-state").textContent).toMatch(/being prepared/);
  });
  it("when the boundary needs the owner, the question can be edited, approved or run privately", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-research"));
    await waitFor(() => expect(screen.getByTestId("research-state").getAttribute("data-state")).toBe("pending"));
    // the boundary could not phrase a public question: the idea's research now waits for its owner (seen on the next read)
    fake.hook("await-owner", { id: ids.cpu, candidate: "Which CPUs fit this board?", failing: ["Acme"] });
    await pick("Move the wiki to the cluster");
    await pick("Plan the CPU upgrade");
    await screen.findByTestId("review-question");
    expect(screen.getByTestId("research-state").getAttribute("data-state")).toBe("awaiting_owner");
    expect(screen.getByTestId("research-state").textContent).toMatch(/Acme/);
    fireEvent.change(screen.getByTestId("review-question"), { target: { value: "Which CPUs fit a 7820X board?" } });
    fireEvent.click(screen.getByTestId("review-private"));
    await waitFor(() => expect(screen.getByTestId("research-state").getAttribute("data-state")).toBe("queued"));
    expect(posts()).toEqual([`POST /workbench/ideas/${ids.cpu}/research-now`, `POST /workbench/ideas/${ids.cpu}/research/private`]);
  });
  it("a pending request is read again by itself, so a question that needs the owner shows up without a reload", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-research"));
    await waitFor(() => expect(screen.getByTestId("research-state").getAttribute("data-state")).toBe("pending"));
    fake.hook("await-owner", { id: ids.cpu });
    await screen.findByTestId("review-question", {}, { timeout: RESEARCH_POLL_MS + 3000 });
  }, 15000);
});

describe("Create / Open its document", () => {
  it("creates the document through the seed and opens it; an idea that has one opens that", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-document"));
    // the address is the document's opaque id (rwr-doc-opaque-urls), never its path: no owner key, no title slug
    const made = () => fake.ideas.get(ids.cpu).document.path as string;
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/documents\/d\/[0-9a-f-]{36}$/));
    expect(posts()).toEqual(["POST /workbench/documents/seed"]);
    expect(window.location.pathname).toBe("/documents/d/" + docUid(made()));
    expect(decodeURIComponent(window.location.pathname)).not.toMatch(/u-alice|plan-the-cpu|\.md/);
    cleanup();
    await renderApp();
    await pick("Plan the CPU upgrade");
    await waitFor(() => expect(screen.getByTestId("act-document").tagName).toBe("A"));
    const a = screen.getByTestId("act-document");
    expect(a.textContent).toBe("Open its document");
    expect(a.getAttribute("href")).toBe("/documents/d/" + docUid(made()));
    expect(a.getAttribute("href")).not.toMatch(/u-alice|plan-the-cpu|\.md|%2F/);
  });
});

describe("two identities (acceptance 5)", () => {
  it("Bob never sees Alice's ideas, counts or wording anywhere in the page", async () => {
    who = "bob";
    await renderApp();
    expect(rowTitles()).toEqual(["Bob's idea"]);
    expect(document.documentElement.outerHTML).not.toMatch(/ALPHA|Alice|alice|wiki|CPU upgrade|podcast of what changed/);
    expect(document.body.textContent).toMatch(/BRAVO/);
    // every request answered for Bob came back with Bob's data only
    expect(requestLog().every((r) => !/u-alice/.test(r.url))).toBe(true);
  });
  it("a refusal for another person's idea reads like a missing one: the same sentence, no write", async () => {
    who = "bob";
    const sentence = async (idea: string) => {
      const a = fake.handle("GET", `/workbench/contract/ideas/${idea}`, undefined, "bob");
      return [a.status, JSON.stringify(a.body)];
    };
    const foreign = await sentence(ids.cpu), missing = await sentence("a1000000-0000-4000-8000-0000000000ff");
    expect(foreign).toEqual(missing);
    for (const verb of ["edit", "research-now", "archive", "reopen"]) {
      const f = fake.handle("POST", `/workbench/ideas/${ids.cpu}/${verb}`, { summary: "x" }, "bob");
      const m = fake.handle("POST", `/workbench/ideas/a1000000-0000-4000-8000-0000000000ff/${verb}`, { summary: "x" }, "bob");
      expect([f.status, f.body]).toEqual([m.status, m.body]);
    }
    expect(fake.ideas.get(ids.cpu).status).toBe("researched");
    // and the screen says one thing for either
    window.history.pushState({}, "", "/ideas");
    render(<App />);
    await screen.findByTestId("idea-view");
  });
  it("a person switch without a reload drops the list, the open idea, a half-typed revision and a Reopen Undo", async () => {
    const view = render(<ToastProvider><Ideas subject="u-alice" whoAnswered /></ToastProvider>);
    await screen.findByTestId("idea-view");
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-revise"));
    fireEvent.change(screen.getByTestId("revise-text"), { target: { value: `${MARK_A} unsent draft` } });
    expect(document.body.textContent).toMatch(/unsent draft/);
    who = "bob";
    resetState(); // what the shell does when whoami names a different person
    view.rerender(<ToastProvider><Ideas subject="u-bob" whoAnswered /></ToastProvider>);
    await waitFor(() => expect(rowTitles()).toEqual(["Bob's idea"]));
    expect(screen.queryByTestId("revise-form")).toBeNull();
    expect(document.documentElement.outerHTML).not.toMatch(/ALPHA|unsent draft|CPU upgrade/);
  });
  it("an Undo captured before a switch of person does nothing", async () => {
    const view = render(<ToastProvider><Ideas subject="u-alice" whoAnswered /></ToastProvider>);
    await screen.findByTestId("idea-view");
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-archive"));
    await waitFor(() => expect(fake.ideas.get(ids.cpu).status).toBe("archived"));
    await screen.findByTestId("toast-undo");
    who = "bob"; resetState();
    view.rerender(<ToastProvider><Ideas subject="u-bob" whoAnswered /></ToastProvider>);
    await waitFor(() => expect(rowTitles()).toEqual(["Bob's idea"]));
    // the shell's toast drops every toast when the person changes: no Undo is left to click, and nothing was sent
    // (the epoch check inside Ideas.tsx, the second line of defence, is tested in ideas-undo.test.tsx)
    expect(screen.queryByTestId("toast-undo")).toBeNull();
    expect(screen.getByTestId("toasts").textContent).toBe("");
    await new Promise((r) => setTimeout(r, 20));
    expect(requestLog().filter((r) => r.method !== "GET")).toEqual([`POST /workbench/ideas/${ids.cpu}/archive`].map((x) => ({ method: "POST", url: x.slice(5) })));
    expect(fake.ideas.get(ids.cpu).status).toBe("archived");
  });
});

describe("nothing private is kept", () => {
  it("the idea's text is not in the page title, the URL, storage or the console", async () => {
    const spy = vi.spyOn(console, "log"), err = vi.spyOn(console, "error"), warn = vi.spyOn(console, "warn");
    await renderApp();
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-revise"));
    fireEvent.change(screen.getByTestId("revise-text"), { target: { value: `${MARK_A} another wording` } });
    fireEvent.click(screen.getByTestId("revise-save"));
    await waitFor(() => expect(screen.getAllByTestId("rev").length).toBe(3));
    expect(document.title).toBe("Ideas - Research workbench");
    expect(window.location.href).not.toMatch(/ALPHA|CPU|wording/);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toMatch(/ALPHA|CPU|wording|ideas/i);
    for (const s of [spy, err, warn]) expect(JSON.stringify(s.mock.calls)).not.toMatch(/ALPHA|wording/);
    expect(requestLog().every((r) => !/ALPHA|wording/.test(r.url))).toBe(true);
  });
  it("no select or datalist: list pickers belong to ItemPicker", () => {
    const dir = "src/screens/ideas";
    for (const f of readdirSync(dir)) expect(readFileSync(dir + "/" + f, "utf8")).not.toMatch(/<select|<datalist/);
  });
});

// every toast the screen shows is one of these sentences, exactly: none carries an idea's title or wording
const TOAST_OK = [
  /^Research on this idea was requested\.$/,
  /^Saved as revision \d+\. The next research uses it; earlier runs stay with their wording\.$/,
  /^That is already the idea's wording\. Nothing changed\.$/,
  /^Idea archived\. Scheduled research for it has stopped\.$/,
  /^Idea reopened, as it was\.$/,
  /^Running privately\. The report will be yours alone\.$/,
  /^Approved\. The question is queued as shared research\.$/,
];
const toastTexts = () => [...screen.getByTestId("toasts").querySelectorAll('[data-testid="toast"] > span')].map((e) => e.textContent!);

describe("every toast is a fixed sentence (no idea words)", () => {
  it("research, revise, archive, reopen, run privately and approve", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    fireEvent.click(screen.getByTestId("act-research"));
    await waitFor(() => expect(toastTexts().length).toBe(1));
    fireEvent.click(screen.getByTestId("act-revise"));
    fireEvent.change(screen.getByTestId("revise-text"), { target: { value: `${MARK_A} yet another wording about coolers` } });
    fireEvent.click(screen.getByTestId("revise-save"));
    await waitFor(() => expect(toastTexts().length).toBe(2));
    fireEvent.click(screen.getByTestId("act-archive"));
    await waitFor(() => expect(toastTexts().length).toBe(3));
    fireEvent.click(screen.getByTestId("act-reopen"));
    await waitFor(() => expect(toastTexts().length).toBe(4));
    fake.hook("await-owner", { id: ids.cpu, candidate: "a question", failing: ["x"] });
    await pick("Move the wiki to the cluster"); await pick("Plan the CPU upgrade");
    fireEvent.click(await screen.findByTestId("review-private"));
    await waitFor(() => expect(toastTexts().length).toBe(5));
    fake.hook("configure-research", { on: true });
    fake.hook("await-owner", { id: ids.cpu, candidate: "a question", failing: ["x"] });
    await pick("Move the wiki to the cluster"); await pick("Plan the CPU upgrade");
    fireEvent.click(await screen.findByTestId("review-approve"));
    await waitFor(() => expect(toastTexts().length).toBe(6));
    for (const t of toastTexts()) expect(TOAST_OK.some((re) => re.test(t)), `unexpected toast: ${t}`).toBe(true);
    expect(screen.getByTestId("toasts").textContent).not.toMatch(/ALPHA|CPU|coolers|power stages/);
  });
  it("an unchanged revise says so with a fixed sentence", async () => {
    await renderApp();
    await pick("Move the wiki to the cluster");
    fireEvent.click(screen.getByTestId("act-revise"));
    fireEvent.change(screen.getByTestId("revise-text"), { target: { value: fake.ideas.get(ids.wiki).summary.toUpperCase() } });
    fireEvent.click(screen.getByTestId("revise-save"));
    await waitFor(() => expect(toastTexts()).toEqual(["That is already the idea's wording. Nothing changed."]));
  });
});

describe("a write answered after the person opened another idea (F3)", () => {
  it("still reads the list again, and still says what happened", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    let release: () => void = () => {};
    gate = new Promise<void>((r) => { release = r; });
    fireEvent.click(screen.getByTestId("act-archive"));
    await pick("Move the wiki to the cluster"); // another idea is open while the write is in flight
    release();
    await waitFor(() => expect(fake.ideas.get(ids.cpu).status).toBe("archived"));
    await waitFor(() => expect(within(screen.getByTestId("group-archived")).getAllByTestId("idea-row").length).toBe(2));
    expect(toastTexts()).toEqual(["Idea archived. Scheduled research for it has stopped."]);
  });
});

describe("the owner's review, as the server answers it (F5)", () => {
  it("approve on a default install (no research service) says so and offers the private run; configured, it queues", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    fake.hook("await-owner", { id: ids.cpu, candidate: "Which CPUs?", failing: [] });
    await pick("Move the wiki to the cluster"); await pick("Plan the CPU upgrade");
    fireEvent.click(await screen.findByTestId("review-approve"));
    expect((await screen.findByTestId("idea-error")).textContent).toMatch(/research service, which is not set up here\. Run it privately instead/);
    expect(screen.getByTestId("review-private")).toBeTruthy();
    fake.hook("configure-research", { on: true });
    fireEvent.click(screen.getByTestId("review-approve"));
    await waitFor(() => expect(screen.getByTestId("research-state").getAttribute("data-state")).toBe("queued"));
  });
  it("refused, delivered and failed are said in words, never as a raw state", async () => {
    await renderApp();
    await pick("Plan the CPU upgrade");
    for (const [state, re] of [["refused", /was not sent/], ["delivered", /finished/], ["failed", /failed/]] as const) {
      fake.hook("research-state", { id: ids.cpu, state });
      await pick("Move the wiki to the cluster"); await pick("Plan the CPU upgrade");
      await waitFor(() => expect(screen.getByTestId("research-state").getAttribute("data-state")).toBe(state));
      expect(screen.getByTestId("research-state").textContent).toMatch(re);
      expect(screen.getByTestId("research-state").textContent).not.toMatch(/Research: /);
    }
  });
  it("the fake answers as the server does: the body is judged before ownership, the 409 and 502 sentences are the server's", () => {
    const id = ids.bob; // not alice's
    for (const [verb, body] of [["edit", {}], ["research/approve", {}], ["research/private", { question: " " }]] as const) {
      expect(fake.handle("POST", `/workbench/ideas/${id}/${verb}`, body, "alice").status, verb).toBe(400);
    }
    expect(fake.handle("POST", `/workbench/ideas/${id}/research/private`, { question: "q" }, "alice").status).toBe(404);
    const a = fake.handle("POST", `/workbench/ideas/${ids.cpu}/research/approve`, { question: "q" }, "alice");
    expect([a.status, a.body.error]).toEqual([502, UNCONFIGURED]);
    const p = fake.handle("POST", `/workbench/ideas/${ids.cpu}/research/private`, { question: "q" }, "alice");
    expect([p.status, p.body.error]).toEqual([409, NOT_WAITING]);
  });
});
