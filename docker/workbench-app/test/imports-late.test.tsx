// rwr-imports: late answers and message text (folded in from the tester's T1-T5, attempt 1, after the whole-change review D3).
// A late answer is held back AFTER the fake has answered for the person who MADE the request (the subject is captured when the
// request is made), so the answer really holds the first person's data; it must never land on the second person. And no message
// (add, retry, cancel, a refusal) names a document, an idea or an item.
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Imports } from "../src/screens/imports/Imports";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { createFake } from "../e2e/imports-fake.mjs";

const H = 3600 * 1000;
let fake = createFake();
let who = "u-alice";
const gates: Record<string, Promise<void>> = {};
const releases: Record<string, () => void> = {};
const gate = (name: string) => { gates[name] = new Promise<void>((r) => { releases[name] = r; }); };
const LEAK = /ALPHA|alpha\.example|alice|half-typed|the page answered|could not be read/i;

function seed() {
  fake = createFake();
  fake.docs.push({ owner: "u-alice", path: "documents/k-a/alpha-plan.md", title: "ALPHA plan", refinery: true },
    { owner: "u-bob", path: "documents/k-b/bravo.md", title: "BRAVO doc", refinery: true });
  fake.ideas.push({ owner: "u-alice", id: "11111111-1111-4111-8111-111111111111", title: "ALPHA pantry idea", status: "open" });
  fake.seed("u-alice", { url: "https://alpha.example/refused", status: "failed", error: "the page answered with an error", doc_path: "documents/k-a/alpha-plan.md", created: Date.now() - 2 * H });
  fake.seed("u-alice", { url: "https://alpha.example/chat-link", status: "fetching", origin: "owui", refinery_id: "11111111-1111-4111-8111-111111111111", created: Date.now() - H });
  fake.seed("u-bob", { url: "https://bravo.example/own", status: "held", doc_path: "documents/k-b/bravo.md", created: Date.now() - H });
  fake.inlets.push({ owner: "u-alice", kind: "vault", created: Date.now() - 4 * 24 * H }, { owner: "u-bob", kind: "gmail", created: Date.now() - 24 * H });
}
function stub() {
  setFetcher(async (u, init) => {
    const x = new URL(u, "http://x");
    const sub = who; // captured when the request is MADE
    let json: any = {}, form: any = null;
    if (init?.body instanceof FormData) {
      form = {};
      for (const [k, v] of init.body.entries()) form[k] = v instanceof File ? { name: v.name, head: (await v.slice(0, 512).text()) } : v;
    } else if (init?.body) json = JSON.parse(String(init.body));
    const r = fake.handle({ who: sub, method: init?.method ?? "GET", path: x.pathname, query: Object.fromEntries(x.searchParams), json, form });
    const g = Object.keys(gates).find((k) => sub === "u-alice" && x.pathname.endsWith(k));
    if (g) await gates[g];
    return new Response(JSON.stringify(r?.body ?? { error: "not found" }), { status: r?.status ?? 404 });
  });
}
const titles = () => screen.queryAllByTestId("imp-title").map((e) => e.textContent);
const pickRow = (t: string) => fireEvent.click(screen.getAllByTestId("imp-row").find((r) => r.textContent!.includes(t))!);
const page = () => document.documentElement.outerHTML + document.body.innerText;
const settle = () => new Promise((r) => setTimeout(r, 80));

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); who = "u-alice";
  for (const k of Object.keys(gates)) { delete gates[k]; delete releases[k]; }
  window.localStorage.clear(); window.sessionStorage.clear();
  seed(); stub();
});

describe("late answers never land on the next person", () => {
  it("T1 alice's jobs read answered after the switch to bob (the answer holds ALICE's jobs)", async () => {
    gate("/workbench/intake/jobs");
    const { rerender } = render(<Imports subject="u-alice" whoAnswered />);
    await settle();
    who = "u-bob";
    rerender(<Imports subject="u-bob" whoAnswered />);
    await waitFor(() => expect(titles()).toEqual(["https://bravo.example/own"]));
    releases["/workbench/intake/jobs"]();
    await settle(); await settle();
    expect(titles()).toEqual(["https://bravo.example/own"]);
    expect(page()).not.toMatch(LEAK);
  });
  it("T2 alice's landing options answered after the switch (bob's open form never shows them)", async () => {
    const { rerender } = render(<Imports subject="u-alice" whoAnswered />);
    await waitFor(() => expect(titles().length).toBe(2));
    gate("/workbench/contract/documents");
    fireEvent.click(screen.getByTestId("imp-add-toggle"));
    await settle();
    who = "u-bob";
    rerender(<Imports subject="u-bob" whoAnswered />);
    await waitFor(() => expect(titles()).toEqual(["https://bravo.example/own"]));
    fireEvent.click(screen.getByTestId("imp-add-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("where-opt").length).toBe(1));
    releases["/workbench/contract/documents"]();
    await settle(); await settle();
    expect(screen.getAllByTestId("where-opt").length).toBe(1);
    expect(page()).not.toMatch(LEAK);
  });
  it("T3 alice's retry answered after the switch: no message lands on bob", async () => {
    const { rerender } = render(<Imports subject="u-alice" whoAnswered />);
    await waitFor(() => expect(titles().length).toBe(2));
    pickRow("refused");
    gate("/retry");
    fireEvent.click(screen.getByTestId("imp-retry"));
    await settle();
    who = "u-bob";
    rerender(<Imports subject="u-bob" whoAnswered />);
    await waitFor(() => expect(titles()).toEqual(["https://bravo.example/own"]));
    releases["/retry"]();
    await settle(); await settle();
    expect(screen.getByTestId("imp-note").textContent).toBe("");
    expect(page()).not.toMatch(LEAK);
  });
  it("T4 alice's inlets read answered after the switch: bob's panel lists his one connection only", async () => {
    const { rerender } = render(<Imports subject="u-alice" whoAnswered />);
    await waitFor(() => expect(titles().length).toBe(2));
    gate("/inlets/connections");
    fireEvent.click(screen.getByTestId("panel-inlets"));
    await settle();
    who = "u-bob";
    rerender(<Imports subject="u-bob" whoAnswered />);
    await waitFor(() => expect(titles()).toEqual(["https://bravo.example/own"]));
    fireEvent.click(screen.getByTestId("panel-inlets"));
    await waitFor(() => expect(screen.getAllByTestId("inlet-row").length).toBe(1));
    releases["/inlets/connections"]();
    await settle(); await settle();
    expect(screen.getAllByTestId("inlet-row").length).toBe(1);
    expect(document.body.innerText).not.toMatch(/Vault/);
  });
});

describe("messages name no document, idea or item", () => {
  it("T5 add into 'ALPHA plan', retry, cancel and a refusal: no title in any message; no toast", async () => {
    render(<Imports subject="u-alice" whoAnswered />);
    await waitFor(() => expect(titles().length).toBe(2));
    const msgs: string[] = [];
    const grab = () => { msgs.push(screen.getByTestId("imp-note").textContent || ""); const p = screen.queryByTestId("add-problem"); if (p) msgs.push(p.textContent || ""); };
    fireEvent.click(screen.getByTestId("imp-add-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("where-opt").length).toBe(2));
    fireEvent.click(screen.getAllByTestId("where-opt")[0]);
    fireEvent.change(screen.getByTestId("add-link"), { target: { value: "https://alpha.example/new-one" } });
    fireEvent.click(screen.getByTestId("add-submit"));
    await waitFor(() => expect(screen.queryByTestId("imp-form")).toBeNull());
    grab();
    pickRow("refused"); fireEvent.click(screen.getByTestId("imp-retry"));
    await waitFor(() => expect(screen.getByTestId("imp-note").textContent).toMatch(/Trying again/)); grab();
    pickRow("chat-link"); fireEvent.click(screen.getByTestId("imp-cancel"));
    await waitFor(() => expect(screen.getByTestId("imp-note").textContent).toMatch(/Cancelled/)); grab();
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    for (const m of msgs) expect(m, m).not.toMatch(/ALPHA|alpha\.example|pantry|plan/i);
    expect(document.querySelectorAll("[data-testid=toast], dialog, [role=dialog]").length).toBe(0);
  });
});
