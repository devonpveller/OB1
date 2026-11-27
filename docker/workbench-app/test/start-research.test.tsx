// The Start research dialog (rwr-start-research): prefill and the amber bar, the debounced preview, "the text shown is
// the text sent", Start into Research, the refusal and failure states, the two-identity checks, no idea attach, the
// workbench-only calls, and nothing kept in the browser. A fake back end that applies the rules of the real routes
// (own documents only, one 404 for anything else, a boundary that never returns the personal text).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { App } from "../src/App";
import { StartResearch } from "../src/screens/research-start/StartResearch";
import { ToastProvider } from "../src/shell/Toast";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { startResearchHref } from "../src/screens/research-start/start-data";

type Id = "alice" | "bob";
const MARK = "PERSONAL-MARKER-7731"; // planted in alice's document text: must never reach the preview or a request
const NEW = "c0000000-0000-4000-8000-000000000001"; // the opaque id of "ALPHA newest draft": addresses carry it, never the path
const DB = {
  alice: { docs: [
    { id: "c0000000-0000-4000-8000-000000000001", title: "ALPHA newest draft", path: "documents/alice/alpha-new.md", text: `---\ntitle: "ALPHA newest draft"\n---\nbody ${MARK} https://example.org/public` },
    { id: "c0000000-0000-4000-8000-000000000002", title: "ALPHA older note", path: "documents/alice/alpha-old.md", text: `---\ntitle: "ALPHA older note"\n---\nold` },
    { id: "c0000000-0000-4000-8000-000000000003", title: "ALPHA trashed", path: "documents/alice/.trash/alpha-gone.md", text: "x" },
    { id: "c0000000-0000-4000-8000-000000000004", title: "ALPHA archived", path: "documents/alice/.archive/alpha-arch.md", text: "x" },
  ] },
  bob: { docs: [{ id: "c0000000-0000-4000-8000-000000000005", title: "BRAVO plan", path: "documents/bob/bravo.md", text: `---\ntitle: "BRAVO plan"\n---\nplan` }] },
} as const;

let who: Id = "alice";
let previews: any[] = [];
let starts: any[] = [];
let jobs: { id: string; question: string }[] = [];
let mode: "ok" | "refuse" | "fail" | "malformed" | "changed" | "unavailable" = "ok";
const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
// the boundary: what leaves is a cleaned question made from the typed words only (never the document text)
const clean = (q: string) => "clean: " + q.toLowerCase().replace(/\s+/g, " ").trim();
const DEPTH = { quick: { name: "quick", rounds: 1, max_fetch: 12, wall_ms: 300000 }, standard: { name: "standard", rounds: 2, max_fetch: 40, wall_ms: 600000 }, deep: { name: "deep", rounds: 3, max_fetch: 80, wall_ms: 900000 } } as const;

let handler: (u: string, i?: RequestInit) => Promise<Response> = async () => new Response("{}", { status: 404 });
function stub() {
  previews = []; starts = []; jobs = [];
  handler = async (u, init) => {
    const url = new URL(u, "http://x");
    const path = url.pathname;
    const mine = DB[who].docs;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: "u-" + who, actor_sub: "u-" + who, name: who });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth" });
    if (path === "/workbench/settings") return j({ admin: false, settings: [] });
    if (path === "/workbench/contract/documents") return j({ documents: mine.map((d) => ({ id: d.id, title: d.title, path: d.path, updated: new Date().toISOString(), outbound_links: [] })) });
    if (path === "/workbench/documents/state") {
      const p = url.searchParams.get("path") ?? "";
      const d = mine.find((x) => x.path === p);
      if (!d) return j({ error: "not found" }, 404); // someone else's and a missing one: the same answer
      return j({ id: d.id, path: p, listed: true, trashed: /\/\.trash\//.test(p), archived: /\/\.archive\//.test(p) });
    }
    if (path === "/workbench/documents/resolve") {
      const d = mine.find((x) => x.id === url.searchParams.get("id")); // the owner's only: another person's id is a missing one
      if (!d) return j({ error: "no such document" }, 404);
      return j({ id: d.id, path: d.path, listed: true, trashed: /\/\.trash\//.test(d.path), archived: /\/\.archive\//.test(d.path) });
    }
    if (path === "/workbench/documents/file") {
      const d = mine.find((x) => x.path === url.searchParams.get("path"));
      return d ? j({ content: d.text }) : j({ error: "not found" }, 404);
    }
    if (path === "/workbench/research/preview" || path === "/workbench/research") {
      const isStart = path === "/workbench/research";
      (isStart ? starts : previews).push(body);
      if (mode === "fail") return j({ error: "boom" }, 500);
      if (mode === "malformed") return new Response("<html>sign in</html>", { status: 200 });
      if (isStart && mode === "unavailable") return j({ error: "no research service" }, 503);
      if (body.attach.kind === "idea") return j({ error: "an idea is researched from the idea itself" }, 400);
      if (body.attach.kind === "document" && !mine.some((d) => d.path === body.attach.path)) return j({ error: "not found" }, 404);
      const shown = mode === "refuse"
        ? { question: null, topic: null, links: [], depth: null, refusal: "no_public_evidence" }
        : { question: clean(body.question), topic: "topic of " + body.depth, links: body.attach.kind === "document" ? ["https://example.org/public"] : [], depth: DEPTH[body.depth as keyof typeof DEPTH], refusal: null };
      if (!isStart) return j({ ok: mode !== "refuse", ...shown });
      if (mode === "refuse") return j({ started: false, job_id: null, ...shown });
      if (mode === "changed") return j({ error: "the request changed since the preview" }, 409);
      if (body.approved_question !== shown.question) return j({ error: "the request changed since the preview" }, 409);
      const id = "d0d0d0d0-0000-4000-8000-00000000000" + (jobs.length + 1);
      jobs.push({ id, question: shown.question! });
      return j({ started: true, job_id: id, ...shown }, 202);
    }
    return j({}, 404);
  };
  setFetcher(handler);
}

const openAt = async (href = "/research/start") => {
  window.history.pushState({}, "", href);
  render(<App />);
  await screen.findByTestId("start-dialog");
};
const type = (text: string) => fireEvent.change(screen.getByTestId("start-question"), { target: { value: text } });
const shownQ = () => screen.getByTestId("leaves-question").textContent!.replace(/[“”]/g, "");
const waitPreview = (n: number) => waitFor(() => expect(previews.length).toBe(n), { timeout: 2500 });
const posts = () => requestLog().filter((r) => r.method === "POST");

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); who = "alice"; mode = "ok";
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => cleanup());

describe("prefill and the amber bar (acceptance 1)", () => {
  it("from a document the dialog is prefilled with it and carries the For document bar", async () => {
    await openAt(startResearchHref(NEW));
    const bar = await screen.findByTestId("for-document");
    expect(within(bar).getByTestId("for-document-title").textContent).toBe("ALPHA newest draft");
    expect(bar.textContent).toMatch(/For document/);
    expect(within(bar).getByTestId("for-document-back").getAttribute("href")).toBe("/documents/d/" + NEW);
    expect(screen.getByTestId("attach-doc").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("attach-none").getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(screen.getByTestId("start-question"));
  });
  it("without a document there is no bar and the attach is Nothing", async () => {
    await openAt();
    expect(screen.queryByTestId("for-document")).toBeNull();
    expect(screen.getByTestId("attach-none").getAttribute("aria-pressed")).toBe("true");
  });
  it("choosing a document in the dialog puts the bar up; only live documents of the person are offered", async () => {
    await openAt();
    fireEvent.click(screen.getByTestId("attach-doc"));
    const rows = await screen.findAllByTestId("doc-choice");
    expect(rows.map((r) => r.textContent)).toEqual(["ALPHA newest draft", "ALPHA older note"]); // not the trash, not the archive, not bob's
    fireEvent.click(rows[1]);
    expect(screen.getByTestId("for-document-title").textContent).toBe("ALPHA older note");
    type("what is new?");
    await waitPreview(1);
    expect(previews[0].attach).toEqual({ kind: "document", path: "documents/alice/alpha-old.md" });
  });
  it("Start is off until a document is chosen when A document is selected", async () => {
    await openAt();
    type("a question");
    fireEvent.click(screen.getByTestId("attach-doc"));
    await screen.findByTestId("doc-chooser");
    await new Promise((r) => setTimeout(r, 600));
    expect(previews.length).toBe(0); // nothing is asked about a half-made request
    expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the preview and what Start sends (acceptance 2)", () => {
  it("is debounced: three quick edits make one preview, of the last text", async () => {
    await openAt();
    type("a"); type("ab"); type("Does an X299 board need a BIOS update?");
    await waitPreview(1);
    await new Promise((r) => setTimeout(r, 600));
    expect(previews.length).toBe(1);
    expect(previews[0].question).toBe("Does an X299 board need a BIOS update?");
    expect(shownQ()).toBe(clean("Does an X299 board need a BIOS update?"));
  });
  it("updates as the question changes, and Start is off while a new preview is pending", async () => {
    await openAt();
    type("first question");
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false), { timeout: 2500 });
    expect(shownQ()).toBe(clean("first question"));
    type("second question");
    expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(true); // the shown text is no longer this question's
    expect(screen.queryByTestId("leaves-question")).toBeNull();
    await waitFor(() => expect(shownQ()).toBe(clean("second question")), { timeout: 2500 });
    expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false);
  });
  it("Start sends the SAME body the preview did, plus exactly the text it showed; the job's request is that text", async () => {
    await openAt(startResearchHref(NEW));
    await screen.findByTestId("for-document");
    fireEvent.click(screen.getByTestId("depth-deep"));
    type("Does an X299 board need a BIOS update?");
    await waitFor(() => expect(screen.getByTestId("leaves-question")).toBeTruthy(), { timeout: 2500 });
    const shown = shownQ();
    fireEvent.click(screen.getByTestId("start-go"));
    await waitFor(() => expect(starts.length).toBe(1));
    const { approved_question, ...rest } = starts[0];
    expect(rest).toEqual(previews[previews.length - 1]);
    expect(approved_question).toBe(shown);
    expect(jobs[0].question).toBe(shown);
    expect(starts[0].depth).toBe("deep");
    expect(starts[0].attach).toEqual({ kind: "document", path: "documents/alice/alpha-new.md" });
    expect(Object.keys(starts[0]).sort()).toEqual(["approved_question", "attach", "depth", "question", "sources"]); // no owner, no user (rwr-research-sources: + the Sources choice)
  });
  it("shows the topic, the public pages and the limits of the chosen depth, and the depth's estimate", async () => {
    await openAt(startResearchHref(NEW));
    await screen.findByTestId("for-document");
    type("q one");
    await screen.findByTestId("leaves-ok", undefined, { timeout: 2500 });
    expect(screen.getByTestId("leaves-links").textContent).toMatch(/https:\/\/example\.org\/public/);
    expect(screen.getByTestId("leaves-topic").textContent).toMatch(/topic of standard/);
    expect(screen.getByTestId("leaves-limits").textContent).toBe("Up to 2 rounds of searching, up to 40 pages read, and it stops after 10 minutes.");
    expect(screen.getByTestId("estimate").textContent).toBe("Standard: usually under an hour. You can steer it while it runs.");
    fireEvent.click(screen.getByTestId("depth-quick"));
    expect(screen.getByTestId("estimate").textContent).toBe("Quick: usually a few minutes.");
    await waitFor(() => expect(screen.getByTestId("leaves-limits").textContent).toMatch(/Up to 1 round of searching, up to 12 pages read, and it stops after 5 minutes\./), { timeout: 2500 });
  });
});

describe("Start opens the run in Research (acceptance 3)", () => {
  it("navigates to /research with the new run, and the toast names no title and no question", async () => {
    await openAt(startResearchHref(NEW));
    await screen.findByTestId("for-document");
    type("A private question about ALPHA things");
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false), { timeout: 2500 });
    fireEvent.click(screen.getByTestId("start-go"));
    await waitFor(() => expect(window.location.pathname).toBe("/research"), { timeout: 2500 });
    expect(window.location.search).toBe("?run=" + jobs[0].id);
    const toast = screen.getByTestId("toasts").textContent!;
    expect(toast).toMatch(/Research started\./);
    expect(toast).not.toMatch(/ALPHA|private question/i);
  });
  it("a second press while starting starts once", async () => {
    await openAt();
    type("one run only");
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false), { timeout: 2500 });
    const go = screen.getByTestId("start-go");
    fireEvent.click(go); fireEvent.click(go);
    await waitFor(() => expect(window.location.pathname).toBe("/research"), { timeout: 2500 });
    expect(starts.length).toBe(1);
  });
});

describe("a planted personal marker stays here (acceptance 4)", () => {
  it("is in the document the person opened, and in no preview, no start, no request body and nowhere on the page", async () => {
    await openAt(startResearchHref(NEW));
    await screen.findByTestId("for-document");
    type("what about the board?");
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false), { timeout: 2500 });
    fireEvent.click(screen.getByTestId("start-go"));
    await waitFor(() => expect(starts.length).toBe(1));
    for (const b of [...previews, ...starts]) expect(JSON.stringify(b)).not.toContain(MARK);
    expect(document.body.innerHTML).not.toContain(MARK);
    expect(previews.length + starts.length).toBeGreaterThan(1);
  });
});

describe("two identities (acceptance 5)", () => {
  it("bob cannot prefill from, attach to, or learn the title of alice's document", async () => {
    who = "bob";
    await openAt(startResearchHref(NEW));
    await screen.findByTestId("doc-gone");
    expect(screen.getByTestId("doc-gone").textContent).toBe("That document is not available.");
    expect(screen.queryByTestId("for-document")).toBeNull();
    expect(screen.getByTestId("attach-none").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).not.toMatch(/ALPHA|alice/i);
    type("anything");
    await waitPreview(1);
    expect(previews[0].attach).toEqual({ kind: "none" }); // nothing of alice's was carried into the request
    fireEvent.click(screen.getByTestId("attach-doc"));
    const rows = await screen.findAllByTestId("doc-choice");
    expect(rows.map((r) => r.textContent)).toEqual(["BRAVO plan"]);
  });
  it("a missing document and another person's are one sentence", async () => {
    who = "bob";
    await openAt(startResearchHref(NEW));
    const a = (await screen.findByTestId("doc-gone")).textContent;
    cleanup();
    await openAt(startResearchHref("c0000000-0000-4000-8000-0000000000ff"));
    expect((await screen.findByTestId("doc-gone")).textContent).toBe(a);
  });
  it("the back end answers 404 to bob for alice's document (the fake keeps the real route's rule)", async () => {
    who = "bob";
    const r = await handler("/workbench/research/preview", { method: "POST", body: JSON.stringify({ attach: { kind: "document", path: "documents/alice/alpha-new.md" }, question: "x", depth: "standard" }) });
    expect(r.status).toBe(404);
  });
  it("a different person on the page empties the dialog: no question, no document, no preview, no toast", async () => {
    const tree = (s: string | null) => <ToastProvider><StartResearch subject={s} whoAnswered={true} /></ToastProvider>;
    window.history.pushState({}, "", startResearchHref(NEW));
    const { rerender } = render(tree("u-alice"));
    await screen.findByTestId("for-document");
    type("ALPHA secret question");
    await screen.findByTestId("leaves-ok", undefined, { timeout: 2500 });
    who = "bob";
    rerender(tree("u-bob"));
    await screen.findByTestId("start-dialog");
    expect((screen.getByTestId("start-question") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByTestId("leaves-question")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("doc-checking")).toBeNull());
    expect(document.body.textContent).not.toMatch(/ALPHA|secret/i);
    expect(screen.getByTestId("toasts").textContent).toBe("");
  });
  it("a start answered after the person changed does nothing: no navigation, no toast", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    setFetcher(async (u, i) => { if (u === "/workbench/research") await gate; return handler(u, i); });
    window.history.pushState({}, "", "/research/start");
    const tree = (s: string) => <ToastProvider><StartResearch subject={s} whoAnswered={true} /></ToastProvider>;
    const { rerender } = render(tree("u-alice"));
    await screen.findByTestId("start-dialog");
    type("slow one");
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false), { timeout: 2500 });
    fireEvent.click(screen.getByTestId("start-go"));
    rerender(tree("u-bob"));
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 100)); });
    expect(window.location.pathname).toBe("/research/start");
    expect(screen.getByTestId("toasts").textContent).toBe("");
  });
});

describe("an idea is never an attachment (acceptance 8)", () => {
  it("the dialog offers Nothing and A document only, and says where an idea is researched", async () => {
    await openAt();
    expect(screen.queryByTestId("attach-idea")).toBeNull();
    const dlg = screen.getByTestId("start-dialog");
    const ideaButtons = within(dlg).getAllByRole("button").filter((b) => /\bidea/i.test(b.textContent ?? ""));
    expect(ideaButtons).toEqual([]);
    expect(screen.getByTestId("idea-hint").textContent).toMatch(/open the idea and choose Research this/);
  });
  it("an address that names an idea does not prefill from it, and no request ever carries kind idea", async () => {
    await openAt("/research/start?idea=i1&document=" + encodeURIComponent("ideas/i1"));
    expect(screen.queryByTestId("for-document")).toBeNull();
    type("q");
    await waitPreview(1);
    for (const b of [...previews, ...starts]) expect(JSON.stringify(b)).not.toMatch(/idea/);
    for (const r of requestLog()) expect(r.url).not.toMatch(/ideas/);
  });
});

describe("what it asks for, and what it keeps (acceptance 6)", () => {
  it("every request is a same-origin /workbench route; nothing else is read or sent", async () => {
    await openAt(startResearchHref(NEW));
    await screen.findByTestId("for-document");
    type("q about cpus");
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false), { timeout: 2500 });
    fireEvent.click(screen.getByTestId("start-go"));
    await waitFor(() => expect(starts.length).toBe(1));
    expect(requestLog().length).toBeGreaterThan(3);
    for (const r of requestLog()) expect(r.url.startsWith("/workbench/")).toBe(true);
    expect(posts().map((p) => p.url).sort()).toEqual(["/workbench/research", "/workbench/research/preview"]);
  });
  it("nothing is kept in the browser, and the question is not put in the address", async () => {
    await openAt();
    type("a private question");
    await waitFor(() => expect(screen.getByTestId("leaves-question")).toBeTruthy(), { timeout: 2500 });
    expect(Object.keys(window.localStorage)).toEqual([]);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(window.location.search).toBe("");
  });
});

describe("refusals and failures never start anything", () => {
  it("a refused preview says why in plain words, keeps Start off, and offers the way forward", async () => {
    mode = "refuse";
    await openAt();
    type("something personal");
    const r = await screen.findByTestId("leaves-refused", undefined, { timeout: 2500 });
    expect(r.textContent).toMatch(/no public page it could use/i);
    expect(r.textContent).toMatch(/no_public_evidence/);
    expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(true);
    expect(starts.length).toBe(0);
  });
  it("a failed or malformed preview is not an empty one: it says so and Start stays off", async () => {
    for (const m of ["fail", "malformed"] as const) {
      cleanup(); stub(); mode = m;
      await openAt();
      type("q");
      const f = await screen.findByTestId("leaves-failed", undefined, { timeout: 2500 });
      expect(f.textContent).toMatch(/Could not check what would be sent/);
      expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(true);
    }
    mode = "ok";
    fireEvent.click(screen.getByTestId("leaves-retry"));
    await screen.findByTestId("leaves-ok", undefined, { timeout: 2500 });
    expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false);
  });
  it("a start the back end refuses as changed (409) says so, starts nothing and shows the new text", async () => {
    await openAt();
    type("will change");
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false), { timeout: 2500 });
    mode = "changed";
    fireEvent.click(screen.getByTestId("start-go"));
    const n = await screen.findByTestId("start-note");
    expect(n.textContent).toMatch(/changed while you were looking/);
    expect(jobs.length).toBe(0);
    expect(window.location.pathname).toBe("/research/start");
  });
  it("the research service being down says so and starts nothing", async () => {
    await openAt();
    type("q");
    await waitFor(() => expect((screen.getByTestId("start-go") as HTMLButtonElement).disabled).toBe(false), { timeout: 2500 });
    mode = "unavailable";
    fireEvent.click(screen.getByTestId("start-go"));
    expect((await screen.findByTestId("start-note")).textContent).toMatch(/not available right now. Nothing was started/);
    expect(window.location.pathname).toBe("/research/start");
  });
});

describe("leaving", () => {
  it("Cancel and Esc go home, or back to the document the dialog was opened for", async () => {
    await openAt();
    fireEvent.click(screen.getByTestId("start-cancel"));
    expect(window.location.pathname).toBe("/");
    cleanup();
    await openAt(startResearchHref(NEW));
    await screen.findByTestId("for-document");
    fireEvent.keyDown(screen.getByTestId("start-question"), { key: "Escape" });
    expect(window.location.pathname).toBe("/documents/d/" + NEW);
  });
  it("Research this builds the document address", () => {
    expect(startResearchHref()).toBe("/research/start");
    expect(startResearchHref(NEW)).toBe("/research/start?document=" + NEW);
    expect(startResearchHref("documents/a b/x.md")).toBe("/research/start"); // a path never goes into an address
  });
  it("a malformed document in the address is no document (nothing is asked about it)", async () => {
    await openAt("/research/start?document=" + encodeURIComponent("../../etc/passwd"));
    expect(screen.queryByTestId("for-document")).toBeNull();
    expect(screen.queryByTestId("doc-checking")).toBeNull();
    expect(requestLog().some((r) => /passwd/.test(r.url))).toBe(false);
  });
});
