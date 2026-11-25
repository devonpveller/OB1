// The Imports screen (rwr-imports) against ONE fake of the real intake routes (e2e/imports-fake.mjs, the same logic the
// e2e stub runs; test/imports-drift.test.ts keeps it equal to the server's source): the list and its counts, a failed
// fetch with its reason and Try again ONCE, private items shown to their owner only, one link into the chosen document,
// the connected-inlets panel, two identities, a change of the signed-in person, and nothing kept in the browser.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";
import { Imports } from "../src/screens/imports/Imports";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { createFake, RETRIED_ALREADY } from "../e2e/imports-fake.mjs";
import { uid } from "../e2e/docs-fake.mjs";

const H = 3600 * 1000, D = 24 * H;
let fake = createFake();
let who: "alice" | "bob" | "nobody" = "alice";
let failing: string[] = [];
let malformed: string[] = [];
const REASON = "the page answered with an error";

function seedAll() {
  fake = createFake();
  fake.docs.push({ owner: "u-alice", path: "documents/k-a/alpha-plan.md", title: "ALPHA plan", refinery: true }, { owner: "u-alice", path: "documents/k-a/alpha-bare.md", title: "ALPHA bare", refinery: false },
    { owner: "u-alice", path: "documents/k-a/.trash/alpha-gone.md", title: "ALPHA trashed", refinery: true }, { owner: "u-bob", path: "documents/k-b/bravo.md", title: "BRAVO doc", refinery: true });
  fake.ideas.push({ owner: "u-alice", id: "11111111-1111-4111-8111-111111111111", title: "ALPHA pantry idea", status: "researched" },
    { owner: "u-alice", id: "22222222-2222-4222-8222-222222222222", title: "ALPHA old idea", status: "archived" }, { owner: "u-bob", id: "33333333-3333-4333-8333-333333333333", title: "BRAVO idea", status: "open" });
  fake.seed("u-alice", { url: "https://alpha.example/held-article", status: "held", doc_path: "documents/k-a/alpha-plan.md", held_source_id: "aaaaaaaa-0000-4000-8000-000000000001", created: Date.now() - 3 * H });
  fake.seed("u-alice", { url: "https://alpha.example/refused", status: "failed", error: REASON, doc_path: "documents/k-a/alpha-plan.md", created: Date.now() - 2 * H });
  fake.seed("u-alice", { url: "https://alpha.example/chat-link", status: "fetching", origin: "owui", refinery_id: "11111111-1111-4111-8111-111111111111", created: Date.now() - H });
  fake.seed("u-alice", { filename: "ALPHA-notes.pdf", status: "failed", error: "the file could not be read", attempts: 2, doc_path: "documents/k-a/alpha-plan.md", created: Date.now() - 5 * H });
  fake.seed("u-alice", { mode: "import", url: "https://alpha.example/old-import", status: "done", source_id: "aaaaaaaa-0000-4000-8000-000000000002", created: Date.now() - 9 * D });
  fake.inlets.push({ owner: "u-alice", kind: "gmail", created: Date.now() - 5 * D }, { owner: "u-alice", kind: "vault", created: Date.now() - 4 * D }, { owner: "u-bob", kind: "gmail", created: Date.now() - D });
  fake.seed("u-bob", { url: "https://bravo.example/own", status: "held", doc_path: "documents/k-b/bravo.md", created: Date.now() - H });
}
const jobIdOf = (owner: string, part: string) => [...fake.jobs.values()].find((j) => j.owner === owner && (j.url ?? j.filename).includes(part)).id;

function stub() {
  setFetcher(async (u, init) => {
    const x = new URL(u, "http://x");
    const path = x.pathname;
    if (failing.some((f) => path.endsWith(f))) return new Response("{}", { status: 500 });
    if (malformed.some((f) => path.endsWith(f))) return new Response("<html>please sign in</html>", { status: 200 });
    const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
    const sub = "u-" + who;
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: sub, actor_sub: sub, name: who });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth" });
    let json: any = {}, form: any = null;
    if (init?.body instanceof FormData) {
      form = {};
      for (const [k, v] of init.body.entries()) form[k] = v instanceof File ? { name: v.name, head: await v.text().then((t) => t.slice(0, 512)) } : v;
    } else if (init?.body) json = JSON.parse(String(init.body));
    const r = fake.handle({ who: sub, method: init?.method ?? "GET", path, query: Object.fromEntries(x.searchParams), json, form });
    return r ? j(r.body, r.status) : new Response("{}", { status: 404 });
  });
}

const open = async () => {
  window.history.pushState({}, "", "/imports");
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("imports")).toBeTruthy());
  await waitFor(() => expect(screen.queryByTestId("imp-loading")).toBeNull());
};
const titles = () => screen.queryAllByTestId("imp-title").map((e) => e.textContent);
const pickRow = (t: string) => fireEvent.click(screen.getAllByTestId("imp-row").find((r) => r.textContent!.includes(t))!);

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); who = "alice"; failing = []; malformed = [];
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
  seedAll(); stub();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the list (what, from, status, who sees it, when)", () => {
  it("lists the caller's own jobs, newest first, with what / status / from / who sees it", async () => {
    await open();
    expect(titles()).toEqual(["https://alpha.example/chat-link", "https://alpha.example/refused", "https://alpha.example/held-article", "ALPHA-notes.pdf", "https://alpha.example/old-import"]);
    const rows = screen.getAllByTestId("imp-row");
    expect(rows[0].textContent).toMatch(/Fetching/); expect(rows[0].textContent).toMatch(/Open WebUI chat/); expect(rows[0].textContent).toMatch(/Only you/);
    expect(rows[2].textContent).toMatch(/Held/); expect(rows[2].textContent).toMatch(/Link/);
    expect(rows[1].textContent).toMatch(/Failed/);
    expect(rows[3].textContent).toMatch(/File/);
    expect(rows[4].textContent).toMatch(/Shared library/);
    expect(rows[2].textContent).toMatch(/3 h ago/);
  });
  it("asks for the caller's two queues only, a GET, and names no person", async () => {
    await open();
    const reads = requestLog().filter((r) => r.url.startsWith("/workbench/intake/jobs"));
    expect(reads.some((r) => r.url === "/workbench/intake/jobs?kinds=import,add&limit=200")).toBe(true);
    expect(reads.every((r) => r.method === "GET")).toBe(true); // (the shell's own count read is the other)
    expect(requestLog().every((r) => !/alice|bob|u-/i.test(r.url))).toBe(true);
  });
  it("This week counts only the last seven days, from the caller's own jobs", async () => {
    await open();
    expect(screen.getByTestId("week-came").textContent).toBe("4");      // the 9-day-old import is out
    expect(screen.getByTestId("week-landed").textContent).toBe("1");
    expect(screen.getByTestId("week-running").textContent).toBe("1");
    expect(screen.getByTestId("week-failed").textContent).toBe("2");
    expect(screen.getByTestId("week-cancelled").textContent).toBe("0");
  });
  it("filters: all / in progress / needs a look / private to me, each with its count", async () => {
    await open();
    expect(screen.getByTestId("filter-all").textContent).toMatch(/5/);
    expect(screen.getByTestId("filter-run").textContent).toMatch(/1/);
    expect(screen.getByTestId("filter-fail").textContent).toMatch(/2/);
    expect(screen.getByTestId("filter-mine").textContent).toMatch(/4/); // the four adds; the import is the shared library's
    fireEvent.click(screen.getByTestId("filter-fail"));
    expect(titles()).toEqual(["https://alpha.example/refused", "ALPHA-notes.pdf"]);
    fireEvent.click(screen.getByTestId("filter-run"));
    expect(titles()).toEqual(["https://alpha.example/chat-link"]);
    fireEvent.click(screen.getByTestId("filter-mine"));
    expect(titles()).not.toContain("https://alpha.example/old-import");
    expect(titles()).toHaveLength(4);
    expect(screen.getByTestId("filter-mine").getAttribute("aria-pressed")).toBe("true");
  });
  it("a read that fails, or answers something that is not the list, says so (never an empty list)", async () => {
    failing = ["/intake/jobs"];
    await open();
    expect(screen.getByTestId("imp-failed")).toBeTruthy();
    expect(screen.queryByTestId("imp-empty")).toBeNull();
    cleanup(); failing = []; malformed = ["/intake/jobs"];
    await open();
    expect(screen.getByTestId("imp-failed")).toBeTruthy();
  });
  it("a person with nothing brought in sees one plain line, and the counts say 0", async () => {
    who = "nobody";
    await open();
    expect(screen.getByTestId("imp-empty").textContent).toMatch(/Nothing has been brought in yet/);
    expect(screen.getByTestId("week-came").textContent).toBe("0");
  });
});

describe("details: steps, landed in, who sees it, why it failed (acceptance 1)", () => {
  it("a failed fetch shows its reason; Try again is offered and works", async () => {
    await open();
    pickRow("refused");
    expect(screen.getByTestId("imp-why").textContent).toMatch(new RegExp(REASON));
    const retry = screen.getByTestId("imp-retry");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId("imp-note").textContent).toMatch(/Trying again/));
    expect(requestLog().some((r) => r.method === "POST" && /\/intake\/jobs\/add\/[^/]+\/retry$/.test(r.url))).toBe(true);
    await waitFor(() => expect(screen.getByTestId("imp-details").textContent).toMatch(/Waiting/));
    expect(screen.queryByTestId("imp-retry")).toBeNull(); // not offered again while it runs
  });
  it("Try again works ONCE: when the second try fails the same way it is not offered again, and the screen says why", async () => {
    await open();
    pickRow("refused");
    fireEvent.click(screen.getByTestId("imp-retry"));
    await waitFor(() => expect(screen.queryByTestId("imp-retry")).toBeNull());
    fake.set(jobIdOf("u-alice", "refused"), "failed", REASON); // the pipeline fails it again
    fireEvent.click(screen.getByTestId("filter-fail")); fireEvent.click(screen.getByTestId("filter-all"));
    // the page's own re-read (a poll) is stood in for by reopening the screen: the job is read afresh
    cleanup(); await open(); pickRow("refused");
    expect(screen.getByTestId("imp-why").textContent).toMatch(new RegExp(REASON));
    expect(screen.queryByTestId("imp-retry")).toBeNull();
    expect(screen.getByTestId("imp-no-retry").textContent).toMatch(/second time/);
    expect(fake.jobs.get(jobIdOf("u-alice", "refused")).attempts).toBe(2);
  });
  it("a job that has already run twice and failed is not offered Try again at all, with its reason", async () => {
    await open();
    pickRow("ALPHA-notes");
    expect(screen.queryByTestId("imp-retry")).toBeNull();
    expect(screen.getByTestId("imp-why").textContent).toMatch(/the file could not be read/);
    expect(screen.getByTestId("imp-no-retry")).toBeTruthy();
    expect(requestLog().filter((r) => /retry$/.test(r.url))).toHaveLength(0);
  });
  it("a click on Try again sends ONE retry even when pressed twice quickly", async () => {
    await open();
    pickRow("refused");
    const b = screen.getByTestId("imp-retry");
    fireEvent.click(b); fireEvent.click(b);
    await waitFor(() => expect(screen.queryByTestId("imp-retry")).toBeNull());
    expect(requestLog().filter((r) => /retry$/.test(r.url))).toHaveLength(1);
    expect(fake.jobs.get(jobIdOf("u-alice", "refused")).attempts).toBe(2);
  });
  it("Cancel is offered while it can still stop (waiting, fetching, reading), never once it is holding or done", async () => {
    await open();
    pickRow("chat-link");
    expect(screen.getByTestId("imp-cancel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("imp-cancel"));
    await waitFor(() => expect(screen.getByTestId("imp-note").textContent).toMatch(/Cancelled/));
    expect(fake.jobs.get(jobIdOf("u-alice", "chat-link")).status).toBe("cancelled");
    fake.set(jobIdOf("u-alice", "held-article"), "holding");
    cleanup(); await open(); pickRow("held-article");
    expect(screen.queryByTestId("imp-cancel")).toBeNull();
  });
  it("steps, landed in and who sees it are the job's own facts", async () => {
    await open();
    pickRow("held-article");
    const d = screen.getByTestId("imp-details").textContent!;
    expect(d).toMatch(/Fetched through the private search gateway/); expect(d).toMatch(/Held in your refinery/);
    expect(d).toMatch(/Document: alpha plan/);
    // the link is the opaque id (docHref), never the owner's folder key or the file name
    await waitFor(() => expect(within(screen.getByTestId("imp-details")).getByRole("link", { name: /alpha plan/ }).getAttribute("href")).toBe("/documents/d/" + uid("documents/k-a/alpha-plan.md")));
    expect(d).toMatch(/private to your refinery until it is admitted/);
    pickRow("old-import");
    expect(screen.getByTestId("imp-details").textContent).toMatch(/Everyone on the workbench/);
  });
  it("a refusal from the server is shown as the server says it (a 409 for a job that moved on)", async () => {
    await open();
    pickRow("refused");
    fake.set(jobIdOf("u-alice", "refused"), "held"); // it moved on after the page read it
    fireEvent.click(screen.getByTestId("imp-retry"));
    await waitFor(() => expect(screen.getByTestId("imp-note").textContent).toBe("a held add job cannot be retried"));
  });
});

describe("one link or file lands in the chosen document through the existing route (acceptance 3)", () => {
  const openForm = async () => { await open(); fireEvent.click(screen.getByTestId("imp-add-toggle")); await waitFor(() => expect(screen.getAllByTestId("where-opt").length).toBeGreaterThan(0)); };
  const chooseDoc = (t: string) => fireEvent.click(screen.getAllByTestId("where-opt").find((o) => o.parentElement!.textContent!.includes(t))!);
  it("offers the caller's documents and ideas only (not a trashed document, an archived idea, or anyone else's)", async () => {
    await openForm();
    const opts = screen.getAllByTestId("where-opt").map((o) => o.parentElement!.textContent!.trim());
    expect(opts).toEqual(["ALPHA plan", "ALPHA bare", "ALPHA pantry idea"]);
  });
  it("the link is added to the chosen document: JSON {url, path}, no person named, then it is in the list", async () => {
    await openForm();
    chooseDoc("ALPHA plan");
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: " https://alpha.example/new-thing " } });
    fireEvent.click(screen.getByTestId("add-submit"));
    await waitFor(() => expect(screen.queryByTestId("imp-form")).toBeNull());
    const post = requestLog().find((r) => r.method === "POST" && r.url === "/workbench/intake/add");
    expect(post).toBeTruthy();
    const made = [...fake.jobs.values()].find((j) => j.url === "https://alpha.example/new-thing");
    expect(made).toMatchObject({ owner: "u-alice", doc_path: "documents/k-a/alpha-plan.md", status: "queued", refinery_id: null });
    await waitFor(() => expect(titles()).toContain("https://alpha.example/new-thing"));
    expect(screen.getByTestId("imp-note").textContent).toMatch(/Added/);
    pickRow("new-thing");
    expect(screen.getByTestId("imp-details").textContent).toMatch(/alpha plan/);
  });
  it("an idea's refinery is the other landing (refinery_id)", async () => {
    await openForm();
    chooseDoc("ALPHA pantry idea");
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: "https://alpha.example/to-idea" } });
    fireEvent.click(screen.getByTestId("add-submit"));
    await waitFor(() => expect(screen.queryByTestId("imp-form")).toBeNull());
    expect([...fake.jobs.values()].find((j) => j.url === "https://alpha.example/to-idea")).toMatchObject({ refinery_id: "11111111-1111-4111-8111-111111111111", doc_path: null });
  });
  it("nothing is sent without a landing, or with something that is not an http(s) link", async () => {
    await openForm();
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: "https://alpha.example/x" } });
    fireEvent.click(screen.getByTestId("add-submit"));
    expect(screen.getByTestId("add-problem").textContent).toMatch(/Choose where it lands/);
    chooseDoc("ALPHA plan");
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: "see the thread on noctua" } });
    fireEvent.click(screen.getByTestId("add-submit"));
    expect(screen.getByTestId("add-problem").textContent).toMatch(/http or https/);
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: "ftp://alpha.example/x" } });
    fireEvent.click(screen.getByTestId("add-submit"));
    expect(screen.getByTestId("add-problem").textContent).toMatch(/http or https/);
    expect(requestLog().filter((r) => r.method === "POST")).toHaveLength(0);
  });
  it("a document with no open refinery: the server's own reason is shown and the form stays", async () => {
    await openForm();
    chooseDoc("ALPHA bare");
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: "https://alpha.example/x" } });
    fireEvent.click(screen.getByTestId("add-submit"));
    await waitFor(() => expect(screen.getByTestId("add-problem").textContent).toMatch(/this document has no open refinery/));
    expect(screen.getByTestId("imp-form")).toBeTruthy();
  });
  it("a file: sent as a multipart form to the same route; over the intake limit (25 MB) or not a PDF / saved page is refused before sending", async () => {
    await openForm();
    chooseDoc("ALPHA plan");
    fireEvent.click(screen.getByTestId("mode-file"));
    const pick = (f: File) => fireEvent.change(screen.getByTestId("add-file"), { target: { files: [f] } });
    pick(new File([new Uint8Array(26 * 1024 * 1024)], "big.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByTestId("add-submit"));
    expect(screen.getByTestId("add-problem").textContent).toMatch(/over 25 MB/);
    pick(new File(["MZ"], "tool.exe"));
    fireEvent.click(screen.getByTestId("add-submit"));
    expect(screen.getByTestId("add-problem").textContent).toMatch(/PDF or a saved web page/);
    expect(requestLog().filter((r) => r.method === "POST")).toHaveLength(0);
    pick(new File(["%PDF-1.7 hello"], "ALPHA-paper.pdf", { type: "application/pdf" }));
    fireEvent.click(screen.getByTestId("add-submit"));
    await waitFor(() => expect(screen.queryByTestId("imp-form")).toBeNull());
    expect([...fake.jobs.values()].find((j) => j.filename === "ALPHA-paper.pdf")).toMatchObject({ owner: "u-alice", doc_path: "documents/k-a/alpha-plan.md" });
  });
  it("a file that looks like a PDF by name but is not: the server's 415 reason is shown", async () => {
    await openForm();
    chooseDoc("ALPHA plan");
    fireEvent.click(screen.getByTestId("mode-file"));
    fireEvent.change(screen.getByTestId("add-file"), { target: { files: [new File(["not a pdf at all"], "fake.pdf")] } });
    fireEvent.click(screen.getByTestId("add-submit"));
    await waitFor(() => expect(screen.getByTestId("add-problem").textContent).toMatch(/a file add is a PDF or a saved web page/));
  });
  it("a person with no document and no idea is told so, with the way forward, and cannot send", async () => {
    who = "nobody";
    await open(); fireEvent.click(screen.getByTestId("imp-add-toggle"));
    await waitFor(() => expect(screen.getByTestId("where-empty")).toBeTruthy());
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: "https://x.example/" } });
    fireEvent.click(screen.getByTestId("add-submit"));
    expect(requestLog().filter((r) => r.method === "POST")).toHaveLength(0);
  });
});

describe("files over the old 1 MB are sent; a refusal is shown as the server says it", () => {
  it("a 2 MB PDF goes up (the intake route's limit is 25 MB); a 413 from the door is shown verbatim", async () => {
    window.history.pushState({}, "", "/imports");
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("imports")).toBeTruthy());
    fireEvent.click(screen.getByTestId("imp-add-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("where-opt").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId("where-opt")[0]);
    fireEvent.click(screen.getByTestId("mode-file"));
    const f = new File([new Uint8Array(2 * 1024 * 1024)], "two.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("add-file"), { target: { files: [f] } });
    setFetcher(async () => new Response(JSON.stringify({ error: "request body over 1 MB" }), { status: 413 }));
    fireEvent.click(screen.getByTestId("add-submit"));
    await waitFor(() => expect(screen.getByTestId("add-problem").textContent).toBe("request body over 1 MB"));
    expect(screen.getByTestId("imp-form")).toBeTruthy();
    expect(requestLog().filter((r) => r.method === "POST" && r.url === "/workbench/intake/add")).toHaveLength(1);
  });
});

describe("the server's own retry cap", () => {
  it("if the server refuses a retry (already retried elsewhere), its reason is shown and nothing changes", async () => {
    await open();
    pickRow("refused");
    fake.jobs.get(jobIdOf("u-alice", "refused")).attempts = 2; // retried from another window after this page read it
    fireEvent.click(screen.getByTestId("imp-retry"));
    await waitFor(() => expect(screen.getByTestId("imp-note").textContent).toBe(RETRIED_ALREADY));
    expect(fake.jobs.get(jobIdOf("u-alice", "refused"))).toMatchObject({ status: "failed", attempts: 2 });
  });
});

describe("the connected inlets panel (acceptance 4): only the caller's own connections", () => {
  const inletsOpen = async () => { await open(); fireEvent.click(screen.getByTestId("panel-inlets")); await waitFor(() => expect(screen.queryByTestId("inlets-loading")).toBeNull()); };
  it("lists the caller's own connections (kind and when), from the own-inlets read only", async () => {
    await inletsOpen();
    const rows = screen.getAllByTestId("inlet-row").map((r) => r.textContent!);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/Gmail/); expect(rows[0]).toMatch(/Only you/); expect(rows[0]).toMatch(/connected 5 days ago/);
    expect(rows[1]).toMatch(/Vault/);
    expect(screen.getByTestId("inlets-origin").textContent).toMatch(/Open WebUI chats: 1\./);
    const r = requestLog().filter((x) => /inlets/.test(x.url));
    expect(r).toEqual([{ method: "GET", url: "/workbench/contract/inlets/connections" }]);
    expect(screen.queryByText(/can't be listed/)).toBeNull();
  });
  it("a person sees only their own: bob has one, a person with none gets one plain line", async () => {
    who = "bob"; await inletsOpen();
    expect(screen.getAllByTestId("inlet-row")).toHaveLength(1);
    expect(document.body.innerText).not.toMatch(/Vault/);
    cleanup(); who = "nobody"; await inletsOpen();
    expect(screen.getByTestId("inlets-empty").textContent).toMatch(/No inlet is connected/);
  });
  it("a read that fails says so and offers a retry (never 'no inlets')", async () => {
    failing = ["/inlets/connections"];
    await inletsOpen();
    expect(screen.getByTestId("inlets-failed")).toBeTruthy();
    expect(screen.queryByTestId("inlets-empty")).toBeNull();
    failing = [];
    fireEvent.click(within(screen.getByTestId("inlets-failed")).getByRole("button"));
    await waitFor(() => expect(screen.getAllByTestId("inlet-row")).toHaveLength(2));
  });
  it("a malformed answer is a failure, not an empty list", async () => {
    malformed = ["/inlets/connections"];
    await inletsOpen();
    expect(screen.getByTestId("inlets-failed")).toBeTruthy();
  });
});

describe("two identities (acceptance 2 and 5)", () => {
  it("bob never sees alice's imports, titles, reasons, counts or totals anywhere in the page, nor in storage", async () => {
    await open();
    expect(document.documentElement.outerHTML).toMatch(/ALPHA|alpha\.example/);
    cleanup(); who = "bob"; await open();
    expect(titles()).toEqual(["https://bravo.example/own"]);
    const html = document.documentElement.outerHTML + document.body.innerText;
    expect(html).not.toMatch(/ALPHA|alpha\.example|alice|the file could not be read|the page answered/i);
    expect(screen.getByTestId("week-came").textContent).toBe("1");
    expect(screen.getByTestId("week-failed").textContent).toBe("0");
    expect(screen.getByTestId("filter-all").textContent).toMatch(/1/);
    expect(screen.getByTestId("filter-mine").textContent).toMatch(/1/);
    fireEvent.click(screen.getByTestId("imp-add-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("where-opt").length).toBeGreaterThan(0));
    expect(document.documentElement.outerHTML).not.toMatch(/ALPHA|alpha\.example/);
    expect(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toMatch(/alpha|alice|bravo/i);
  });
  it("a retry or cancel of alice's job by bob is refused exactly as a job that does not exist (the same 404 and text)", async () => {
    const a = jobIdOf("u-alice", "refused");
    const mine = (verb: string, id: string, w: string) => fake.handle({ who: w, method: "POST", path: `/workbench/intake/jobs/add/${id}/${verb}` });
    const missing = mine("retry", "99999999-9999-4999-8999-999999999999", "u-bob");
    for (const verb of ["retry", "cancel"]) expect(mine(verb, a, "u-bob")).toEqual(missing);
    expect(fake.jobs.get(a)).toMatchObject({ status: "failed", attempts: 1 });
  });
  it("a change of the signed-in person drops the first person's messages, details and open form (no subject-bound note survives)", async () => {
    const { rerender } = render(<Imports subject="u-alice" whoAnswered />);
    await waitFor(() => expect(screen.getAllByTestId("imp-row").length).toBeGreaterThan(0));
    pickRow("refused");
    fireEvent.click(screen.getByTestId("imp-retry"));
    await waitFor(() => expect(screen.getByTestId("imp-note").textContent).toMatch(/Trying again/));
    fireEvent.click(screen.getByTestId("imp-add-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("where-opt").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: "https://alpha.example/half-typed" } });
    who = "bob";
    rerender(<Imports subject="u-bob" whoAnswered />);
    await waitFor(() => expect(titles()).toEqual(["https://bravo.example/own"]));
    expect(screen.getByTestId("imp-note").textContent).toBe("");
    expect(screen.queryByTestId("imp-form")).toBeNull();
    expect(screen.queryByTestId("imp-details")).toBeNull();
    expect(document.documentElement.outerHTML + document.body.innerText).not.toMatch(/ALPHA|alpha\.example|half-typed|Trying again/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("a late answer for the first person cannot land on the second", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    setFetcher(async (u, init) => {
      const x = new URL(u, "http://x");
      const sub = "u-" + who; // the person who MADE the request: the late answer holds THEIR data (alice's), not the next person's
      const r = fake.handle({ who: sub, method: init?.method ?? "GET", path: x.pathname, query: Object.fromEntries(x.searchParams) });
      if (x.pathname === "/workbench/intake/jobs" && sub === "u-alice") { await gate; }
      return new Response(JSON.stringify(r?.body ?? {}), { status: r?.status ?? 404 });
    });
    const { rerender } = render(<Imports subject="u-alice" whoAnswered />);
    who = "bob";
    rerender(<Imports subject="u-bob" whoAnswered />);
    await waitFor(() => expect(titles()).toEqual(["https://bravo.example/own"]));
    release!();
    await new Promise((r) => setTimeout(r, 50));
    expect(titles()).toEqual(["https://bravo.example/own"]);
    expect(document.body.innerText).not.toMatch(/alpha/i);
  });
  it("nothing is drawn or read until the person is known; a failed who-am-i says so", async () => {
    render(<Imports subject={null} whoAnswered={false} />);
    expect(screen.getByTestId("imports-waiting")).toBeTruthy();
    cleanup();
    render(<Imports subject={null} whoAnswered />);
    expect(screen.getByTestId("imports-who-failed")).toBeTruthy();
    expect(requestLog()).toHaveLength(0);
  });
});

describe("nothing is kept in the browser, nothing is logged", () => {
  it("after a full use the storage holds nothing and the console stays quiet", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    await open();
    pickRow("refused"); fireEvent.click(screen.getByTestId("imp-retry"));
    await waitFor(() => expect(screen.getByTestId("imp-note").textContent).toMatch(/Trying/));
    fireEvent.click(screen.getByTestId("imp-add-toggle"));
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(spies.flatMap((s) => s.mock.calls)).toEqual([]);
  });
  it("every request the screen made is a same-origin /workbench/ call through the door", async () => {
    await open();
    pickRow("refused");
    expect(requestLog().length).toBeGreaterThan(0);
    expect(requestLog().every((r) => r.url.startsWith("/workbench/"))).toBe(true);
  });
});
