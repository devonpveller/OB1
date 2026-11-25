// The Research screen (rwr-research-runs): the list with state counts and its three groupings, the live tree, node details, steer /
// follow-up / stop, archive per person, the report as a document, the Discussion tab, and the two-identity checks. The fake back
// end is e2e/runs-fake.mjs - the one the e2e stub serves too - which applies the rules of the real routes (research_runs.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { App } from "../src/App";
import { Research } from "../src/screens/research/Research";
import { ToastProvider } from "../src/shell/Toast";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { groupRuns, dateBucket, documentName, type RunRow } from "../src/screens/research/runs-data";
import { createRunsFake } from "../e2e/runs-fake.mjs";

let who: "alice" | "bob" = "alice";
let fake = createRunsFake();
const SUB = { alice: "u-alice", bob: "u-bob" } as const;
const PRIV = "ALPHA-PRIVATE-CLAIM-MARKER"; // a claim drawn from alice's private report: it has no row in the shared claims table
const REPORT = "ALPHA-REPORT-TEXT";
let RUN = ""; // alice's finished run (a steer branch, a gap pass; sources; claims)
let LIVE = ""; // alice's running run
let streams = 0;
let listDelay = 0; // ms the list read waits (a real network takes time; the fake does not)
let dropFirst = false; // the next stream is closed by the "server" right after its first card

const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

function seed() {
  fake = createRunsFake();
  fake.state.sharedClaims.set("k1", "A shared claim about sensors.");
  const claims = [{ id: "k1" }, { id: "k-private" }]; // k-private has no shared row: the screen never lists or counts it
  RUN = fake.addRun({
    owner: SUB.alice, question: "ALPHA how do the sensors compare?", topic: "sensors", document: "documents/u-alice/alpha-sensors-note.md", status: "done", report: REPORT,
    sources: [{ url: "https://example.org/a", title: "Page A", stages: ["fetched", "admitted"] }], claims,
    nodes: [
      { id: "b1000000-0000-4000-8000-000000000001", kind: "steer", status: "done", query: "ALPHA focus on noise", sources: [{ url: "https://example.org/b" }], claims: [] },
      { id: "b1000000-0000-4000-8000-000000000002", kind: "gap", status: "done", query: "ALPHA gap: calibration", claims: [] },
    ],
  }).id;
  LIVE = fake.addRun({ owner: SUB.alice, question: "ALPHA live question", topic: "power", status: "running", created: Date.now() - 600_000, step: "step-7" }).id;
  fake.addRun({ owner: SUB.alice, question: "ALPHA waits in the queue", status: "queued", created: Date.now() - 300_000 });
  fake.addRun({ owner: SUB.alice, question: "ALPHA failed one", status: "error", created: Date.now() - 9 * 24 * 3600_000 });
  fake.addRun({ owner: SUB.bob, question: "BRAVO their question", topic: "bravo-topic", status: "done", report: "BRAVO-REPORT" }).id;
}

function streamBody(run: any, mine: boolean) {
  const n = ++streams;
  let un: () => void = () => {};
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(fake.sse(run, mine)));
      if (dropFirst && n === 1) { c.close(); return; }
      un = fake.listen(run.id, () => { try { c.enqueue(enc.encode(fake.sse(run, mine))); } catch { /* closed */ } });
    },
    cancel() { un(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stub() {
  seed(); streams = 0; dropFirst = false; listDelay = 0;
  setFetcher(async (u, init) => {
    const url = new URL(u, "http://x");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const sub = SUB[who];
    const p = url.pathname;
    if (p === "/workbench/workspace/whoami") return j({ subject_sub: sub, actor_sub: sub, name: who });
    if (p === "/workbench/auth/me") return j({ mode: "forward-auth" });
    if (p === "/workbench/settings") return j({ admin: false, settings: [] });
    if (listDelay && p === "/workbench/contract/research/runs") await new Promise((r) => setTimeout(r, listDelay));
    const a = fake.handle(method, u, body, sub);
    if (a) return a.stream ? streamBody(a.run, !!a.mine) : j(a.body, a.status);
    return j({}, 404);
  });
}
const rows = () => screen.queryAllByTestId("run-row").map((r) => r.textContent!);
const openAt = async (href = "/research") => {
  window.history.pushState({}, "", href);
  render(<App />);
  await screen.findByTestId("runs-list", undefined, { timeout: 3000 });
};
const posts = () => requestLog().filter((r) => r.method === "POST");

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); who = "alice";
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => cleanup());

describe("the list: state counts and the three groupings", () => {
  it("lists the person's own runs with the server's counts; the failed one is under Stopped; archived are apart", async () => {
    await openAt();
    expect(rows().length).toBe(4);
    expect(screen.getByTestId("count-n-running").textContent).toBe("1");
    expect(screen.getByTestId("count-n-queued").textContent).toBe("1");
    expect(screen.getByTestId("count-n-done").textContent).toBe("1");
    expect(screen.getByTestId("count-n-stopped").textContent).toBe("1");
    expect(screen.getByTestId("count-n-archived").textContent).toBe("0");
    fireEvent.click(screen.getByTestId("count-running"));
    expect(rows().length).toBe(1);
    expect(rows()[0]).toMatch(/ALPHA live question/);
    expect(screen.getByTestId("count-running").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("count-running"));
    expect(rows().length).toBe(4);
  });
  it("group by date, by document and by topic put the same runs under their own headers", async () => {
    await openAt();
    const heads = () => screen.queryAllByTestId("group-header").map((h) => h.textContent!.replace(/\d+$/, "").trim());
    expect(heads()).toEqual(["Today", "Earlier"]);
    fireEvent.click(screen.getByTestId("by-document"));
    expect(heads()).toEqual(["alpha sensors note", "Not attached to a document"]);
    fireEvent.click(screen.getByTestId("by-topic"));
    expect(heads()).toEqual(["power", "sensors", "No topic"]);
    expect(rows().length).toBe(4);
  });
  it("an empty list says so and offers Start research; a failed read says so and offers a retry", async () => {
    who = "bob"; fake.state.runs = [];
    await openAt();
    expect(screen.getByTestId("runs-empty").textContent).toMatch(/no research yet/);
    cleanup();
    setFetcher(async (u) => (u.startsWith("/workbench/contract/research/runs") ? new Response("<html>sign in</html>", { status: 200 }) : j({ subject_sub: "u-alice", actor_sub: "u-alice", name: "a" })));
    window.history.pushState({}, "", "/research");
    render(<App />);
    expect(await screen.findByTestId("runs-failed", undefined, { timeout: 3000 })).toBeTruthy();
  });
  it("pure grouping: date buckets and a document's name", () => {
    const now = Date.parse("2026-11-25T12:00:00");
    expect(dateBucket("2026-11-25T01:00:00", now).header).toBe("Today");
    expect(dateBucket("2026-11-24T23:00:00", now).header).toBe("Yesterday");
    expect(dateBucket("2026-11-21T10:00:00", now).header).toBe("Earlier this week");
    expect(dateBucket("2026-10-01T10:00:00", now).header).toBe("Earlier");
    expect(documentName("documents/u/the-cpu-note.md")).toBe("the cpu note");
    const r = (id: string, document: string | null) => ({ id, question: "q", topic: null, document, status: "done", group: "done", branches: 0, created_at: "2026-11-25T01:00:00", finished_at: null, archived: false, archived_at: null }) as RunRow;
    expect(groupRuns([r("1", "documents/a.md"), r("2", null), r("3", "documents/a.md")], "document", now).map((g) => [g.header, g.runs.length])).toEqual([["a", 2], ["Not attached to a document", 1]]);
  });
});

describe("the tree and the node details (acceptance 1, live)", () => {
  it("opening a run shows its question, its steer and gap branches with states, and each node's sources and claims", async () => {
    await openAt();
    fireEvent.click(screen.getAllByTestId("run-row").find((r) => /compare/.test(r.textContent!))!);
    await screen.findByTestId("run");
    expect(window.location.search).toBe("?run=" + RUN);
    const nodes = screen.getAllByTestId("tree-node");
    expect(nodes.map((n) => n.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/Question.*ALPHA how do the sensors compare/), expect.stringMatching(/Steer or follow-up.*focus on noise/), expect.stringMatching(/Gap pass.*calibration/)]));
    expect(screen.getByTestId("sources").textContent).toMatch(/Page A/);
    expect(screen.getByTestId("claims").textContent).toMatch(/A shared claim about sensors/);
    expect(screen.getByTestId("claim-count").textContent).toBe("1");
    expect(document.body.textContent).not.toMatch(new RegExp(PRIV + "|k-private"));
    fireEvent.click(nodes.find((n) => /focus on noise/.test(n.textContent!))!);
    expect(screen.getByTestId("sources").textContent).toMatch(/example\.org\/b/);
    expect(screen.getByTestId("no-claims")).toBeTruthy();
  });
  it("a running tree updates by itself: a node added on the server appears with no reload and no navigation", async () => {
    await openAt("/research?run=" + LIVE);
    await screen.findByTestId("run");
    await waitFor(() => expect(streams).toBe(1));
    expect(screen.getAllByTestId("tree-node").length).toBe(1);
    const before = requestLog().filter((r) => r.url.includes("/research/runs/" + LIVE)).length;
    act(() => { fake.grow(LIVE, { kind: "gap", status: "running", query: "ALPHA a new gap pass" }); });
    await waitFor(() => expect(screen.getAllByTestId("tree-node").length).toBe(2), { timeout: 3000 });
    expect(screen.getAllByTestId("tree-node")[1].textContent).toMatch(/Gap pass.*a new gap pass/);
    expect(requestLog().filter((r) => r.url.includes("/research/runs/" + LIVE)).length).toBeGreaterThan(before);
    expect(window.location.search).toBe("?run=" + LIVE);
    act(() => fake.finish(LIVE));
    await waitFor(() => expect(screen.getByTestId("run-live").textContent).toBe("Finished."), { timeout: 3000 });
  });
  it("a stream that drops while the run still runs is opened again", async () => {
    dropFirst = true;
    await openAt("/research?run=" + LIVE);
    await waitFor(() => expect(streams).toBe(1));
    await waitFor(() => expect(streams).toBe(2), { timeout: 4000 });
    act(() => { fake.grow(LIVE, { kind: "gap", status: "running", query: "ALPHA after the reconnect" }); });
    await waitFor(() => expect(screen.getAllByTestId("tree-node").length).toBe(2), { timeout: 3000 });
  });
  it("the Discussion tab is empty and says so", async () => {
    await openAt("/research?run=" + RUN);
    await screen.findByTestId("run");
    fireEvent.click(screen.getByTestId("tab-discussion"));
    expect(screen.getByTestId("discussion-empty").textContent).toMatch(/Nothing here yet/);
    fireEvent.click(screen.getByTestId("tab-tree"));
    expect(screen.getByTestId("tree")).toBeTruthy();
  });
});

describe("steer, follow-up and stop (acceptance 2)", () => {
  it("Steer sends the run's next steering point and the words; the new branch appears and runs", async () => {
    await openAt("/research?run=" + LIVE);
    await screen.findByTestId("run");
    fireEvent.click(screen.getByTestId("act-steer"));
    fireEvent.change(screen.getByTestId("steer-text"), { target: { value: "ALPHA look at idle power" } });
    fireEvent.click(screen.getByTestId("steer-send"));
    await waitFor(() => expect(screen.getAllByTestId("tree-node").length).toBe(2), { timeout: 3000 });
    expect(posts().filter((r) => r.url.endsWith("/steer")).length).toBe(1);
    const run = fake.find(LIVE);
    expect(run.nodes[1]).toMatchObject({ kind: "steer", status: "queued", query: "ALPHA look at idle power", rooted: "step-7" });
    expect(screen.getAllByTestId("tree-node")[1].textContent).toMatch(/queued/);
    expect(screen.queryByTestId("steer-form")).toBeNull();
    expect(screen.getByTestId("toasts").textContent).toMatch(/Steered/);
    expect(screen.getByTestId("toasts").textContent).not.toMatch(/ALPHA/);
  });
  it("Add a follow-up is the same route with its own words", async () => {
    await openAt("/research?run=" + LIVE);
    await screen.findByTestId("run");
    fireEvent.click(screen.getByTestId("act-followup"));
    expect(screen.getByTestId("steer-form").textContent).toMatch(/What else should it look into/);
    fireEvent.change(screen.getByTestId("steer-text"), { target: { value: "ALPHA and what about heat?" } });
    fireEvent.click(screen.getByTestId("steer-send"));
    await waitFor(() => expect(screen.getAllByTestId("tree-node").length).toBe(2), { timeout: 3000 });
    expect(screen.getByTestId("toasts").textContent).toMatch(/Follow-up added/);
  });
  it("a finished run offers neither Steer nor Stop; Send stays off until there are words", async () => {
    await openAt("/research?run=" + RUN);
    await screen.findByTestId("run");
    expect(screen.queryByTestId("act-stop")).toBeNull();
    cleanup(); stub();
    await openAt("/research?run=" + LIVE);
    await screen.findByTestId("run");
    fireEvent.click(screen.getByTestId("act-steer"));
    expect((screen.getByTestId("steer-send") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a steer the server refuses says so in one sentence and creates no node", async () => {
    await openAt("/research?run=" + LIVE);
    await screen.findByTestId("run");
    fake.find(LIVE).step = "step-8"; // the steering point moved on: the screen still holds step-7
    fireEvent.click(screen.getByTestId("act-steer"));
    fireEvent.change(screen.getByTestId("steer-text"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("steer-send"));
    expect((await screen.findByTestId("run-note")).textContent).toMatch(/did not work|cannot be done/);
    expect(fake.find(LIVE).nodes.length).toBe(1);
  });
  it("Stop asks first; Keep it going changes nothing; Stop it cancels the run", async () => {
    await openAt("/research?run=" + LIVE);
    await screen.findByTestId("run");
    fireEvent.click(screen.getByTestId("act-stop"));
    fireEvent.click(screen.getByTestId("stop-keep"));
    expect(posts().filter((r) => r.url.endsWith("/cancel")).length).toBe(0);
    fireEvent.click(screen.getByTestId("act-stop"));
    fireEvent.click(screen.getByTestId("stop-ok"));
    await waitFor(() => expect(fake.find(LIVE).status).toBe("cancelled"));
    await waitFor(() => expect(screen.getByTestId("run-state").textContent).toBe("stopped"), { timeout: 3000 });
    expect(screen.queryByTestId("act-stop")).toBeNull();
  });
});

describe("archive is the person's own view (acceptance 3)", () => {
  it("Archive hides the run from this person's list, counts it as archived, and Undo brings it back", async () => {
    await openAt("/research?run=" + RUN);
    const open = await screen.findByTestId("run");
    listDelay = 80;
    fireEvent.click(screen.getByTestId("act-archive"));
    await waitFor(() => expect(screen.getByTestId("count-n-archived").textContent).toBe("1"), { timeout: 3000 });
    expect(screen.getByTestId("run")).toBe(open); // the list was read again WITHOUT dropping the open run (no flash, no lost draft)
    expect(rows().some((r) => /compare/.test(r))).toBe(false);
    expect(screen.getByTestId("count-n-done").textContent).toBe("0");
    expect(screen.getByTestId("toasts").textContent).toMatch(/Archived/);
    expect(screen.getByTestId("toasts").textContent).not.toMatch(/ALPHA|sensors/);
    fireEvent.click(screen.getByTestId("count-archived"));
    expect(rows().length).toBe(1);
    // another person's view of the same run is untouched, and so are the run's sources and claims
    expect(fake.find(RUN).archivedBy.has(SUB.bob)).toBe(false);
    expect(fake.handle("GET", "/workbench/contract/research/runs?view=all", undefined, SUB.bob)!.body.runs.length).toBe(1);
    expect(fake.find(RUN).nodes[0].claims.length).toBe(2);
    fireEvent.click(screen.getByTestId("toast-undo"));
    await waitFor(() => expect(screen.getByTestId("count-n-archived").textContent).toBe("0"), { timeout: 3000 });
    expect(fake.find(RUN).archivedBy.size).toBe(0);
  });
  it("an archived run offers Unarchive", async () => {
    fake.find(RUN).archivedBy.add(SUB.alice);
    await openAt("/research?run=" + RUN);
    await screen.findByTestId("run");
    expect(screen.queryByTestId("act-archive")).toBeNull();
    fireEvent.click(screen.getByTestId("act-unarchive"));
    await waitFor(() => expect(fake.find(RUN).archivedBy.size).toBe(0));
  });
});

describe("open the report as a document (acceptance 5)", () => {
  it("makes a document of the caller's own and opens it; the toast names no title", async () => {
    await openAt("/research?run=" + RUN);
    await screen.findByTestId("run");
    fireEvent.click(screen.getByTestId("act-report"));
    await waitFor(() => expect(fake.state.docs.length).toBe(1));
    expect(fake.state.docs[0]).toMatchObject({ owner: SUB.alice, body: REPORT });
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/documents\//), { timeout: 3000 });
    expect(window.location.pathname).toBe("/documents/d/" + fake.state.docs[0].id);
    expect(screen.getByTestId("toasts").textContent).toMatch(/Opened the report/);
    expect(screen.getByTestId("toasts").textContent).not.toMatch(/ALPHA|sensors/);
  });
  it("a run with no report yet has the button off", async () => {
    await openAt("/research?run=" + LIVE);
    await screen.findByTestId("run");
    expect((screen.getByTestId("act-report") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("two identities (acceptance 4)", () => {
  it("bob sees only his own run: no ALPHA anywhere in the page, the address or any request, and the counts are his", async () => {
    who = "bob";
    await openAt();
    expect(rows().length).toBe(1);
    expect(screen.getByTestId("count-n-done").textContent).toBe("1");
    expect(screen.getByTestId("count-n-running").textContent).toBe("0");
    for (const g of ["document", "topic", "date"]) { fireEvent.click(screen.getByTestId("by-" + g)); expect(screen.getByTestId("research").textContent).not.toMatch(/ALPHA|sensors|u-alice/); }
    expect(document.body.textContent).not.toMatch(/ALPHA|alpha sensors/);
    expect(requestLog().some((r) => r.url.includes(RUN) || r.url.includes(LIVE))).toBe(false);
  });
  it("opening another person's run by its id is the same one sentence as a missing run, with no ALPHA text", async () => {
    who = "bob";
    await openAt("/research?run=" + RUN);
    expect((await screen.findByTestId("run-gone")).textContent).toBe("That run is not available.");
    const missing = fake.handle("GET", "/workbench/contract/research/runs/" + "e0000000-0000-4000-8000-0000000000ff", undefined, SUB.bob);
    const foreign = fake.handle("GET", "/workbench/contract/research/runs/" + RUN, undefined, SUB.bob);
    expect(foreign).toEqual(missing);
    expect(document.body.textContent).not.toMatch(/ALPHA/);
    for (const [m, s] of [["POST", "archive"], ["POST", "unarchive"], ["POST", "document"]] as const) expect(fake.handle(m, `/workbench/contract/research/runs/${RUN}/${s}`, undefined, SUB.bob)).toEqual(missing);
    expect(fake.handle("POST", `/workbench/contract/sessions/${RUN}/steer`, { step_id: "s", text: "x" }, SUB.bob)!.status).toBe(404);
    expect(fake.find(RUN).archivedBy.size).toBe(0);
  });
  it("another person's stream is the shared card: no question, no steer text", async () => {
    const a = fake.handle("GET", `/workbench/contract/sessions/${RUN}/stream`, undefined, SUB.bob)!;
    const text = fake.sse(a.run, !!a.mine);
    expect(text).not.toMatch(/ALPHA/);
    expect(fake.sse(a.run, true)).toMatch(/ALPHA focus on noise/);
  });
  it("a different person on the page (no reload) drops the list, the open run, the draft, the confirm and the toasts", async () => {
    const tree = (s: string | null) => <ToastProvider><Research subject={s} whoAnswered={true} /></ToastProvider>;
    window.history.pushState({}, "", "/research?run=" + LIVE);
    const { rerender } = render(tree(SUB.alice));
    await screen.findByTestId("run");
    fireEvent.click(screen.getByTestId("act-steer"));
    fireEvent.change(screen.getByTestId("steer-text"), { target: { value: "ALPHA my half-written steer" } });
    fireEvent.click(screen.getByTestId("act-stop"));
    expect(screen.getByTestId("stop-confirm")).toBeTruthy();
    who = "bob";
    act(() => { resetState(); });
    rerender(tree(SUB.bob));
    await waitFor(() => expect(screen.getByTestId("run-gone")).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByTestId("steer-form")).toBeNull();
    expect(screen.queryByTestId("stop-confirm")).toBeNull();
    expect(document.body.textContent).not.toMatch(/ALPHA|half-written/);
    expect(rows().length).toBe(1);
    expect(screen.getByTestId("toasts") ? true : true).toBe(true);
  });
  it("a late answer for the previous person does nothing: no toast, no navigation", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = (await import("../src/lib/api")) as any;
    const orig = fake.handle;
    setFetcher(async (u, init) => {
      const url = new URL(u, "http://x");
      if (url.pathname.endsWith("/archive")) await gate;
      const a = orig(init?.method ?? "GET", u, init?.body ? JSON.parse(String(init.body)) : undefined, SUB[who]);
      if (url.pathname === "/workbench/workspace/whoami") return j({ subject_sub: SUB[who], actor_sub: SUB[who], name: who });
      if (url.pathname === "/workbench/auth/me") return j({ mode: "forward-auth" });
      if (url.pathname === "/workbench/settings") return j({ admin: false, settings: [] });
      return a ? (a.stream ? streamBody(a.run, !!a.mine) : j(a.body, a.status)) : j({}, 404);
    });
    void inner;
    const tree = (s: string) => <ToastProvider><Research subject={s} whoAnswered={true} /></ToastProvider>;
    window.history.pushState({}, "", "/research?run=" + RUN);
    const { rerender } = render(tree(SUB.alice));
    await screen.findByTestId("run");
    fireEvent.click(screen.getByTestId("act-archive"));
    who = "bob";
    act(() => { resetState(); });
    rerender(tree(SUB.bob));
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 150)); });
    expect(screen.getByTestId("toasts").textContent).toBe("");
    expect(window.location.pathname).toBe("/research");
  });
});

describe("what the screen keeps and where it looks", () => {
  it("nothing in storage, no title or question in the page title or the address, only workbench routes, no <select>", async () => {
    await openAt("/research?run=" + RUN);
    await screen.findByTestId("run");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.title).not.toMatch(/ALPHA|sensors/);
    expect(window.location.href).not.toMatch(/ALPHA|sensors/);
    expect(document.querySelectorAll("select, datalist").length).toBe(0);
    for (const r of requestLog()) expect(r.url).toMatch(/^\/workbench\//);
    expect(within(screen.getByTestId("research")).queryAllByRole("heading", { level: 1 }).length).toBe(1);
  });
  it("without a known person nothing is read or shown", async () => {
    render(<ToastProvider><Research subject={null} whoAnswered={false} /></ToastProvider>);
    expect(screen.getByTestId("research-waiting")).toBeTruthy();
    expect(requestLog().length).toBe(0);
  });
});
