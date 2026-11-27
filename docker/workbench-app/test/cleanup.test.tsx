// The Cleanup screen (rwr-cleanup). One describe per acceptance line of the anchor and per attack class of the test plan.
// The back end is the shared fakes of the real routes: e2e/cleanup-fake.mjs (sources, process-all, candidates, lift,
// dismissals, registries), e2e/flags-fake.mjs (flags) and e2e/docs-fake.mjs (documents); the e2e stub drives the same three.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen, fireEvent, cleanup, waitFor, within, act, configure } from "@testing-library/react";
import { App } from "../src/App";
import { ToastProvider } from "../src/shell/Toast";
import { Cleanup, CleanupScreen } from "../src/screens/cleanup/Cleanup";
import { reasonLabel, visibleSuggestions, readSuggestions, type ReasonWords } from "../src/screens/cleanup/cleanup-data";
import { docHref } from "../src/screens/documents/docs-data";
import { setFetcher, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { createFake, PEOPLE, uid } from "../e2e/docs-fake.mjs";
import { createFlagsFake, ITEMS } from "../e2e/flags-fake.mjs";
import { createCleanupFake, SRC, TOMB, DISMISSAL_KINDS } from "../e2e/cleanup-fake.mjs";

configure({ asyncUtilTimeout: 5000 });
const NOW = Date.now();
const docs = createFake({ now: () => NOW });
const flags = createFlagsFake({ now: () => NOW, ownsDocument: (w, p) => docs.db().docs.get(p)?.owner === w.sub });
const cl = createCleanupFake({ now: () => NOW });
type Id = "alice" | "bob";
let who: Id = "alice";
let sent: { method: string; url: string; body: any; who: Id }[] = [];
let failNext: Record<string, number> = {};
let slow: Record<string, Promise<void>> = {};
const MARK = "PRIVATE-FLAG-NOTE-7788"; // a flag note: only its owner may ever see it
const SRC_A = ITEMS.source[0].id, CLAIM = ITEMS.claim[0].id;
const PUNCT_DOC = "documents/k-a/Notes+[v2];100%.md";      // accepted by the real route today: no space, none of  " ' ? & # , )
const SPACE_DOC = "documents/k-a/Old notes & ideas/plan.md"; // a row the real route will take once rw-doc-path-spaces lands

function stub() {
  sent = [];
  setFetcher(async (u, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method, url: u, body, who });
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    const path = u.split("?")[0];
    const key = method + " " + path;
    if (failNext[key]) { const st = failNext[key]; delete failNext[key]; return j({ error: "SECRET-SERVER-TEXT for u-alice: relation user_flags" }, st); }
    if (key in slow) { const h = slow[key]; delete slow[key]; await h; }
    const me = PEOPLE[who];
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: me.sub, actor_sub: me.sub, name: me.name });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth", kind: "user", subject_sub: me.sub });
    if (path === "/workbench/settings") return j({ settings: [] });
    const f = flags.handle(me, method, u, body ?? {}); if (f) return j(f.body, f.status);
    const c = cl.handle(me, method, u, body ?? {}); if (c) return j(c.body, c.status);
    const r = docs.handle(who, method, u, body ?? {}); if (r) return j(r.body, r.status);
    if (path === "/workbench/contract/sessions") return j({ sessions: [] });
    if (path === "/workbench/intake/jobs") return j({ jobs: [] });
    return j({ error: "not found" }, 404);
  });
}

const flag = (id: Id, reason: string, o: { note?: string; from?: { kind: string; ref: string }; item?: string } = {}) => {
  const r = flags.handle(PEOPLE[id], "POST", "/workbench/contract/flags", {
    item_kind: "source", item_id: o.item ?? SRC_A, reason, note: o.note ?? "", from: o.from ?? { kind: "source", ref: SRC_A },
  })!;
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};
const rawFlag = (id: Id, reason: string, from: { kind: string; ref: string }) => {
  flags.rows().push({ id: `f1a90000-0000-4000-8000-${String(900 + flags.rows().length).padStart(12, "0")}`, owner_sub: PEOPLE[id].sub, item_kind: "source", item_id: SRC_A, reason, note: "",
    from_kind: from.kind, from_ref: from.ref, state: "open", created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() });
};

const open = async (id: Id = "alice", tab: string = "suggestions") => {
  who = id;
  render(<ToastProvider><Cleanup subject={PEOPLE[id].sub} ready /></ToastProvider>);
  if (tab !== "suggestions") fireEvent.click(screen.getByTestId("tab-" + tab));
  await waitFor(() => expect(screen.queryAllByText("Loading...").length).toBe(0));
};
const cards = (t = /^card-(ready|reopen|flag|suggestion)$/) => screen.queryAllByTestId(t);
const titles = () => cards().map((c) => c.querySelector("[data-testid=card-title]")!.textContent);
const typeWord = (w: string) => fireEvent.change(screen.getByTestId("typed-input"), { target: { value: w } });
const posts = (re: RegExp) => sent.filter((s) => s.method !== "GET" && re.test(s.url));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); docs.reset(); flags.reset(); cl.reset(); who = "alice"; failNext = {}; slow = {}; stub();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the screen: four tabs, each item with why / what it affects / preview / reason kept", () => {
  it("/cleanup is the real screen (not a 'coming in phase' placeholder) with the four tabs in order", async () => {
    window.history.pushState({}, "", "/cleanup");
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("cleanup")).toBeTruthy());
    expect(screen.queryByTestId("placeholder")).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Suggestions", "Flagged by you", "Ready to erase", "Worth reopening"]);
  });
  it("Suggestions is empty until the scan lands, says so, and asks the server for nothing", async () => {
    await open();
    expect(screen.getByTestId("empty").textContent).toMatch(/No suggestions yet/);
    expect(await readSuggestions()).toEqual([]);
    expect(sent.some((s) => /suggest/i.test(s.url) && !/dismissals/.test(s.url))).toBe(false);
  });
  it("Ready to erase lists only what the server says may be erased, with the four facts", async () => {
    await open("alice", "ready");
    expect(titles()).toEqual(["SRC-SHARED ready one", "SRC-SHARED ready two", "SRC-SHARED ready three"]); // the blocked, still-used one is not offered
    const c = cards()[0];
    expect(within(c).getByTestId("fact-why").textContent).toBe("duplicate of another");
    expect(within(c).getByTestId("fact-affects").textContent).toMatch(/Nothing depends on it/);
    expect(within(c).getByTestId("fact-preview").textContent).toBe("https://example.org/ready-one");
    expect(within(cards()[2]).getByTestId("fact-why").textContent).toBe("No reason recorded");
    expect(screen.getByTestId("count").textContent).toBe("3");
  });
  it("Worth reopening shows the evidence, the reason kept and what reopening does; a debunked one names the criticism it would attach", async () => {
    await open("alice", "reopen");
    expect(titles()).toEqual(["SRC-SHARED erased by alice", "SRC-SHARED erased by bob"]);
    const a = cards()[0];
    expect(within(a).getByTestId("fact-kept").textContent).toBe("It was shown to be wrong: wrong figures");
    expect(within(a).getByTestId("fact-affects").textContent).toMatch(/attaches the earlier debunking/);
    expect(within(a).getByTestId("evidence").textContent).toMatch(/a new report cites it/);
    expect(within(cards()[1]).getByTestId("fact-affects").textContent).not.toMatch(/debunking/);
  });
  it("a read that fails says so and offers Try again", async () => {
    failNext["GET /workbench/contract/cleanup/sources"] = 500;
    await open("alice", "ready");
    expect(screen.getByTestId("failed").textContent).toMatch(/Could not load this list/);
    expect(document.body.textContent).not.toMatch(/SECRET-SERVER-TEXT/);
    fireEvent.click(within(screen.getByTestId("failed")).getByText("Try again"));
    await waitFor(() => expect(cards().length).toBe(3));
  });
});

describe("acceptance 1: apply-all uses ONE reason for the whole batch, and the screen says so", () => {
  it("the tab says it before anything is chosen; the panel repeats it with the chosen reason; ERASE is typed", async () => {
    await open("alice", "ready");
    expect(screen.getByTestId("one-reason-note").textContent).toMatch(/one reason for the whole batch/);
    fireEvent.click(screen.getByTestId("apply-all"));
    expect(screen.getByTestId("batch-says").textContent).toMatch(/All 3 sources are erased with this one reason: On purpose/);
    fireEvent.click(screen.getByTestId("batch-reason-credibility"));
    expect(screen.getByTestId("batch-says").textContent).toMatch(/not credible enough/);
    expect((screen.getByTestId("typed-ok") as HTMLButtonElement).disabled).toBe(true);
    typeWord("erase"); expect((screen.getByTestId("typed-ok") as HTMLButtonElement).disabled).toBe(true);
    typeWord("ERASE"); expect((screen.getByTestId("typed-ok") as HTMLButtonElement).disabled).toBe(false);
  });
  it("one POST process-all carries one reason and every listed id (nothing else), and the result says one reason for the whole batch", async () => {
    await open("alice", "ready");
    fireEvent.click(screen.getByTestId("apply-all"));
    fireEvent.click(screen.getByTestId("batch-reason-debunked"));
    typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(screen.getByTestId("batch-result")).toBeTruthy());
    const p = posts(/process-all/);
    expect(p.length).toBe(1);
    expect(Object.keys(p[0].body).sort()).toEqual(["reason_type", "source_ids"]);
    expect(p[0].body.reason_type).toBe("debunked");
    expect([...p[0].body.source_ids].sort()).toEqual([SRC.ready1, SRC.ready2, SRC.ready3].sort());
    expect(posts(/\/erase$/).length).toBe(0);
    expect(screen.getByTestId("batch-result").textContent).toBe("Erased 3 of 3 with one reason for the whole batch: It was shown to be wrong.");
    await waitFor(() => expect(screen.getByTestId("empty")).toBeTruthy());
  });
  it("a source the server will not erase is reported, not hidden: 'could not be erased'", async () => {
    await open("alice", "ready");
    cl.sources().find((s) => s.id === SRC.ready2)!.erase_allowed = false; // it became connected again after the list was read
    fireEvent.click(screen.getByTestId("apply-all"));
    typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(screen.getByTestId("batch-result")).toBeTruthy());
    expect(screen.getByTestId("batch-result").textContent).toMatch(/Erased 2 of 3 with one reason for the whole batch/);
    expect(screen.getByTestId("batch-result").textContent).toMatch(/1 could not be erased and was left as it was/);
  });
  it("a refused batch shows one plain sentence, never the server's text", async () => {
    await open("alice", "ready");
    failNext["POST /workbench/contract/cleanup/process-all"] = 500;
    fireEvent.click(screen.getByTestId("apply-all")); typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(screen.getByTestId("batch-error")).toBeTruthy());
    expect(screen.getByTestId("batch-error").textContent).toBe("That did not work. Nothing was changed.");
    expect(document.body.textContent).not.toMatch(/SECRET-SERVER-TEXT|user_flags/);
  });
});

describe("acceptance 2: review one at a time records each decision and ends with a summary", () => {
  it("ready to erase: erase one (typed), leave one, stop: the summary says what was decided; only the erased one was sent", async () => {
    await open("alice", "ready");
    fireEvent.click(screen.getByTestId("review-start"));
    expect(screen.getByTestId("review-progress").textContent).toBe("1 of 3");
    fireEvent.click(screen.getByTestId("erase")); typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(screen.getByTestId("review-progress").textContent).toBe("2 of 3"));
    expect(posts(/\/erase$/).map((p) => p.url)).toEqual([`/workbench/contract/cleanup/sources/${SRC.ready1}/erase`]);
    fireEvent.click(screen.getByTestId("review-skip"));
    expect(screen.getByTestId("review-progress").textContent).toBe("3 of 3");
    fireEvent.click(screen.getByTestId("review-stop"));
    const sum = screen.getByTestId("review-summary");
    expect(within(sum).getByTestId("review-counts").textContent).toBe("You decided on 1 of 3 items; 2 were left as they were.");
    expect(within(sum).getAllByRole("listitem").map((l) => l.textContent)).toEqual(['Erased "SRC-SHARED ready one" (On purpose: I do not want it)', "Left it as it was"]);
    fireEvent.click(within(sum).getByTestId("review-close"));
    await waitFor(() => expect(cards().length).toBe(2));
  });
  it("the review ends by itself after the last item, with the summary", async () => {
    await open("alice", "ready");
    fireEvent.click(screen.getByTestId("review-start"));
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId("review-skip"));
    expect(screen.getByTestId("review-counts").textContent).toBe("You decided on 0 of 3 items; 3 were left as they were.");
    expect(posts(/./).length).toBe(0);
  });
  it("flagged by you: take one flag back, leave the other; each decision is a PATCH and the summary lists it", async () => {
    const f1 = flag("alice", "wrong_claim"), f2 = flag("alice", "duplicate");
    await open("alice", "flagged");
    fireEvent.click(screen.getByTestId("review-start"));
    fireEvent.click(screen.getByTestId("withdraw"));
    await waitFor(() => expect(screen.getByTestId("review-progress").textContent).toBe("2 of 2"));
    fireEvent.click(screen.getByTestId("review-skip"));
    expect(screen.getByTestId("review-counts").textContent).toMatch(/1 of 2 items/);
    expect(posts(/flags\//).map((p) => [p.method, p.url, p.body])).toEqual([["PATCH", `/workbench/contract/flags/${[f1, f2].sort()[0] === f1 ? f1 : f1}`, { state: "withdrawn" }]]);
    expect(flags.rows().find((r) => r.id === f1)!.state).toBe("withdrawn");
    expect(flags.rows().find((r) => r.id === f2)!.state).toBe("open");
  });
  it("worth reopening: reopen one (confirmed), dismiss the other; the summary lists both", async () => {
    await open("alice", "reopen");
    fireEvent.click(screen.getByTestId("review-start"));
    fireEvent.click(screen.getByTestId("reopen")); fireEvent.click(screen.getByTestId("reopen-ok"));
    await waitFor(() => expect(screen.getByTestId("review-progress").textContent).toBe("2 of 2"));
    fireEvent.click(screen.getByTestId("dismiss"));
    await waitFor(() => expect(screen.getByTestId("review-summary")).toBeTruthy());
    expect(within(screen.getByTestId("review-log")).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      'Reopened "SRC-SHARED erased by alice"', 'Will not show "SRC-SHARED erased by bob" again']);
    expect(cl.tombs()[TOMB.alice].lifted).toBe(true);
    expect(cl.dismissals().map((d) => d.ref)).toEqual([TOMB.bob]);
  });
  it("a decision that fails is not counted as decided", async () => {
    flag("alice", "other");
    await open("alice", "flagged");
    fireEvent.click(screen.getByTestId("review-start"));
    failNext["PATCH " + "/workbench/contract/flags/" + flags.rows()[0].id] = 500;
    fireEvent.click(screen.getByTestId("withdraw"));
    await waitFor(() => expect(screen.getByTestId("card-error")).toBeTruthy());
    expect(screen.getByTestId("review-progress").textContent).toBe("1 of 1");
    fireEvent.click(screen.getByTestId("review-skip"));
    expect(screen.getByTestId("review-counts").textContent).toMatch(/0 of 1 item; 1 was left as it was/);
  });
});

describe("acceptance 3 and 4: a dismissed suggestion stays dismissed for that person only; dismissals are per-user rows through the seam", () => {
  it("dismissing sends {kind, ref} only, the item goes, and it is still gone after the screen is opened again", async () => {
    await open("alice", "reopen");
    fireEvent.click(within(cards()[0]).getByTestId("dismiss"));
    await waitFor(() => expect(titles()).toEqual(["SRC-SHARED erased by bob"]));
    const p = posts(/dismissals/);
    expect(p.length).toBe(1);
    expect(p[0].body).toEqual({ kind: "reopen_candidate", ref: TOMB.alice });
    cleanup(); clearRequestLog();
    await open("alice", "reopen");
    expect(titles()).toEqual(["SRC-SHARED erased by bob"]);
  });
  it("it still shows for another person; and bob's own dismissal does not touch alice's list", async () => {
    await open("alice", "reopen");
    fireEvent.click(within(cards()[0]).getByTestId("dismiss"));
    await waitFor(() => expect(titles().length).toBe(1));
    cleanup();
    await open("bob", "reopen");
    expect(titles()).toEqual(["SRC-SHARED erased by alice", "SRC-SHARED erased by bob"]);
    fireEvent.click(within(cards()[1]).getByTestId("dismiss"));
    await waitFor(() => expect(titles()).toEqual(["SRC-SHARED erased by alice"]));
    cleanup();
    await open("alice", "reopen");
    expect(titles()).toEqual(["SRC-SHARED erased by bob"]);
  });
  it("Undo on the toast takes the dismissal back and the item returns", async () => {
    await open("alice", "reopen");
    fireEvent.click(within(cards()[0]).getByTestId("dismiss"));
    await waitFor(() => expect(screen.getByTestId("toast-undo")).toBeTruthy());
    expect(screen.getByTestId("toast").textContent).toBe("It will not be shown to you again.Undox"); // a fixed sentence: no title
    fireEvent.click(screen.getByTestId("toast-undo"));
    await waitFor(() => expect(titles().length).toBe(2));
    expect(cl.dismissals().length).toBe(0);
    expect(posts(/dismissals/).map((p) => p.method)).toEqual(["POST", "DELETE"]);
  });
  it("no request names a person: no body, query or path carries a subject or an owner", async () => {
    flag("alice", "other");
    await open("alice", "reopen");
    fireEvent.click(within(cards()[0]).getByTestId("dismiss")); await settle();
    fireEvent.click(screen.getByTestId("tab-flagged")); await settle();
    fireEvent.click(screen.getByTestId("withdraw")); await settle();
    const wire = JSON.stringify(sent.map((s) => [s.method, s.url, s.body]));
    expect(wire).not.toMatch(/u-alice|u-bob|owner_sub|actor_sub|subject_sub|"sub"|"user"/);
    expect(sent.some((s) => /scope=all/.test(s.url))).toBe(false);
  });
  it("the suggestion filter hides a dismissed key for this person and keeps the rest", () => {
    const s = (key: string) => ({ key, title: key, why: "", affects: "", preview: "" });
    expect(visibleSuggestions([s("a"), s("b")], new Map([["a", "d1"]])).map((x) => x.key)).toEqual(["b"]);
  });
  it("the dismissals the fake serves are the real route's: strict body, registry kind, clean ref, same thing twice is one row, own rows only", () => {
    const A = PEOPLE.alice, B = PEOPLE.bob;
    const U = "/workbench/contract/cleanup/dismissals";
    expect(cl.handle(A, "POST", U, { kind: "reopen_candidate", ref: "x", owner_sub: "u-bob" })!.status).toBe(400);
    expect(cl.handle(A, "POST", U, { kind: "nope", ref: "x" })!.status).toBe(422);
    expect(cl.handle(A, "POST", U, { kind: "suggestion", ref: "a\u0000b" })!.status).toBe(400);
    expect(cl.handle(A, "POST", U, { kind: "suggestion", ref: "x".repeat(201) })!.status).toBe(400);
    const one = cl.handle(A, "POST", U, { kind: "suggestion", ref: "k1" })!, two = cl.handle(A, "POST", U, { kind: "suggestion", ref: "k1" })!;
    expect([one.status, two.status, one.body.id === two.body.id]).toEqual([201, 201, true]);
    expect(cl.handle(B, "GET", U)!.body).toEqual({ dismissals: [], total: 0 });
    expect(cl.handle(B, "DELETE", `${U}/${one.body.id}`)!.status).toBe(404);
    expect(cl.handle(B, "DELETE", `${U}/not-an-id`)!.body).toEqual(cl.handle(B, "DELETE", `${U}/${one.body.id}`)!.body); // another person's row reads as a missing one
    expect(cl.handle(A, "DELETE", `${U}/${one.body.id}`)!.status).toBe(200);
    expect(DISMISSAL_KINDS.sort()).toEqual(["reopen_candidate", "suggestion"]);
  });
  it("the fake's dismissal kinds are the migration's registry rows (when the migration is reachable)", () => {
    let sql = "";
    try { sql = readFileSync(join(__dirname, "../../init-cleanup-dismissals.sql"), "utf8"); } catch { return; } // not in the image build
    expect([...sql.matchAll(/\('dismissal_kinds', '([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...DISMISSAL_KINDS].sort());
  });
});

describe("acceptance 5 and 6: two identities - user B never sees user A's flags, notes, counts or errors; nothing private on the page title or in storage", () => {
  it("bob's Flagged tab has only bob's flags; alice's note, reason and count appear nowhere on bob's page", async () => {
    flag("alice", "wrong_claim", { note: MARK });
    flag("alice", "duplicate", { note: MARK });
    flag("bob", "other", { note: "bob's own note" });
    await open("bob", "flagged");
    expect(cards().length).toBe(1);
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(document.body.textContent).not.toMatch(new RegExp(MARK));
    expect(within(cards()[0]).getByTestId("fact-note").textContent).toBe("bob's own note");
    // ...and in the answers bob's page received
    expect(sent.every((s) => s.who === "bob")).toBe(true);
    expect(JSON.stringify(flags.handle(PEOPLE.bob, "GET", "/workbench/contract/flags?state=open&limit=500")!.body)).not.toMatch(new RegExp(MARK));
    cleanup();
    await open("alice", "flagged");
    expect(cards().length).toBe(2);
    expect(within(cards()[0]).getByTestId("fact-note").textContent).toBe(MARK);
  });
  it("the screen never asks for everyone's flags (scope=all) and never reads a flag by id", async () => {
    flag("alice", "other");
    await open("alice", "flagged");
    fireEvent.click(screen.getByTestId("review-start"));
    expect(sent.filter((s) => /\/contract\/flags/.test(s.url)).every((s) => s.method === "GET" && /\/contract\/flags\?state=open&limit=500$/.test(s.url))).toBe(true);
  });
  it("another person's flag cannot be taken back: the refusal reads like a missing flag, in both cases the same sentence", async () => {
    const mine = flag("alice", "other");
    await open("alice", "flagged");
    // bob's page is the same account switch: bob PATCHes alice's id (fake = the real 404) and a missing id
    const other = flags.handle(PEOPLE.bob, "PATCH", `/workbench/contract/flags/${mine}`, { state: "withdrawn" })!;
    const missing = flags.handle(PEOPLE.bob, "PATCH", "/workbench/contract/flags/f1a90000-0000-4000-8000-0000000000ff", { state: "withdrawn" })!;
    expect(other).toEqual(missing);
    expect(flags.rows()[0].state).toBe("open");
    // the same on screen: the flag was withdrawn from another tab, so the click finds nothing
    flags.rows()[0].owner_sub = "u-someone-else";
    fireEvent.click(screen.getByTestId("withdraw"));
    await waitFor(() => expect(screen.getByTestId("card-error")).toBeTruthy());
    expect(screen.getByTestId("card-error").textContent).toBe("That is not there any more, so nothing was changed.");
  });
  it("a planted marker in a flag note reaches the flags routes and nothing else (no cleanup route, no storage, no title)", async () => {
    flag("alice", "other", { note: MARK });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await open("alice", "flagged");
    fireEvent.click(screen.getByTestId("review-start")); fireEvent.click(screen.getByTestId("withdraw")); await settle();
    expect(sent.filter((s) => s.body && JSON.stringify(s.body).includes(MARK)).length).toBe(0); // the app never sends a note back
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)) + document.title).not.toMatch(new RegExp(MARK + "|SRC-SHARED"));
  });
  it("the page title never carries a title: the shell names the screen only", async () => {
    window.history.pushState({}, "", "/cleanup");
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("cleanup")).toBeTruthy());
    fireEvent.click(screen.getByTestId("tab-ready")); await settle();
    expect(document.title).toBe("Cleanup - Research workbench");
  });
  it("nothing from the screen is kept in the browser: no localStorage, sessionStorage, cookie or IndexedDB write", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const cookie = vi.spyOn(document, "cookie", "set");
    await open("alice", "reopen");
    fireEvent.click(within(cards()[0]).getByTestId("dismiss")); await settle();
    expect(setItem).not.toHaveBeenCalled(); expect(cookie).not.toHaveBeenCalled();
  });
});

describe("destructive confirmations: keyed per target, one open at a time, the rest off", () => {
  it("a typed word never carries to another target: open, type ERASE, cancel, open the next: empty", async () => {
    await open("alice", "ready");
    fireEvent.click(within(cards()[0]).getByTestId("erase"));
    typeWord("ERASE"); expect((screen.getByTestId("typed-input") as HTMLInputElement).value).toBe("ERASE");
    fireEvent.click(screen.getByTestId("typed-cancel"));
    fireEvent.click(within(cards()[1]).getByTestId("erase"));
    expect((screen.getByTestId("typed-input") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("typed-ok") as HTMLButtonElement).disabled).toBe(true);
  });
  it("the batch's typed word does not carry into a card's confirmation, and back", async () => {
    await open("alice", "ready");
    fireEvent.click(screen.getByTestId("apply-all")); typeWord("ERASE");
    fireEvent.click(screen.getByTestId("typed-cancel"));
    fireEvent.click(within(cards()[0]).getByTestId("erase"));
    expect((screen.getByTestId("typed-input") as HTMLInputElement).value).toBe("");
    typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-cancel"));
    fireEvent.click(screen.getByTestId("apply-all"));
    expect((screen.getByTestId("typed-input") as HTMLInputElement).value).toBe("");
  });
  it("while one confirmation is open every other destructive button is off (cards, apply-all, reopen)", async () => {
    await open("alice", "ready");
    fireEvent.click(within(cards()[0]).getByTestId("erase"));
    expect((screen.getByTestId("apply-all") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByTestId("erase").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByTestId("erase").length).toBe(2); // the open card shows its panel instead of its button
    fireEvent.click(screen.getByTestId("typed-cancel"));
    expect(screen.getAllByTestId("erase").every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(screen.getByTestId("apply-all"));
    expect(screen.getAllByTestId("erase").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(screen.getByTestId("typed-cancel"));
    fireEvent.click(screen.getByTestId("tab-reopen")); await waitFor(() => expect(cards().length).toBe(2));
    fireEvent.click(screen.getByTestId("reopen"));
    expect(screen.queryAllByTestId("reopen").length).toBe(0); // bob's candidate has no reopen button for alice; hers shows the panel
    expect(screen.getByTestId("reopen-panel")).toBeTruthy();
  });
  it("switching tabs closes an open confirmation (nothing stays armed on a tab you cannot see)", async () => {
    await open("alice", "ready");
    fireEvent.click(within(cards()[0]).getByTestId("erase")); typeWord("ERASE");
    fireEvent.click(screen.getByTestId("tab-flagged")); fireEvent.click(screen.getByTestId("tab-ready"));
    await waitFor(() => expect(cards().length).toBe(3));
    expect(screen.queryByTestId("typed-confirm")).toBeNull();
    expect(posts(/./).length).toBe(0);
  });
  it("Erase for good sends the chosen reason once; a double submit sends one request", async () => {
    await open("alice", "ready");
    fireEvent.click(within(cards()[0]).getByTestId("erase"));
    fireEvent.click(screen.getByTestId("erase-reason-credibility"));
    typeWord("ERASE");
    const ok = screen.getByTestId("typed-ok");
    slow["POST " + `/workbench/contract/cleanup/sources/${SRC.ready1}/erase`] = new Promise((r) => setTimeout(r, 60));
    fireEvent.click(ok); fireEvent.click(ok);
    await waitFor(() => expect(cards().length).toBe(2));
    expect(posts(/\/erase$/).map((p) => p.body)).toEqual([{ reason_type: "credibility" }]);
  });
});

describe("a change of person drops every dialog, typed word, draft and in-flight answer", () => {
  it("a new subject starts from nothing: the open panel and the typed word are gone", async () => {
    who = "alice";
    const r = render(<ToastProvider><Cleanup key="u-alice" subject="u-alice" ready /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-ready")); await waitFor(() => expect(cards().length).toBe(3));
    fireEvent.click(within(cards()[0]).getByTestId("erase")); typeWord("ERASE");
    who = "bob";
    r.rerender(<ToastProvider><Cleanup key="u-bob" subject="u-bob" ready /></ToastProvider>);
    expect(screen.queryByTestId("typed-confirm")).toBeNull();
    expect(screen.queryByTestId("erase-panel")).toBeNull();
    expect(screen.getByTestId("tab-suggestions").getAttribute("aria-selected")).toBe("true");
  });
  it("a request is sent only while the person who opened it is still signed in", async () => {
    await open("alice", "ready");
    fireEvent.click(within(cards()[0]).getByTestId("erase")); typeWord("ERASE");
    who = "bob"; // whoami now answers bob, the screen is still alice's
    fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(screen.getByTestId("card-error")).toBeTruthy());
    expect(screen.getByTestId("card-error").textContent).toBe("The person signed in changed, so nothing was done.");
    expect(posts(/./).length).toBe(0);
  });
  it("a late answer for a replaced screen changes nothing and toasts nothing", async () => {
    await open("alice", "reopen");
    let release = () => {};
    slow["POST /workbench/contract/cleanup/dismissals"] = new Promise<void>((r) => { release = r; });
    fireEvent.click(within(cards()[0]).getByTestId("dismiss"));
    await settle();
    cleanup(); // the screen is replaced (a different person)
    render(<ToastProvider><div data-testid="other" /></ToastProvider>);
    release(); await settle();
    expect(screen.queryByTestId("toast")).toBeNull();
  });
  it("the toasts of the previous person are dropped when the state epoch changes", async () => {
    await open("alice", "reopen");
    fireEvent.click(within(cards()[0]).getByTestId("dismiss"));
    await waitFor(() => expect(screen.getByTestId("toast")).toBeTruthy());
    act(() => resetState());
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});

describe("attack: links back are opaque - a path with punctuation or spaces never goes into an address", () => {
  const link = async (ref: string, kind = "document") => {
    rawFlag("alice", "other", { kind, ref });
    await open("alice", "flagged");
    // the link is resolved after the card shows (its own read): wait for "Looking..." to go
    await waitFor(() => expect(screen.getByTestId("fact-where").textContent).not.toBe("Looking..."));
    return screen.queryByTestId("flag-link") as HTMLAnchorElement | null;
  };
  it("a document with punctuation in its name links through its opaque id (docHref), never its path", async () => {
    docs.db().docs.set(PUNCT_DOC, { id: uid(PUNCT_DOC), owner: "u-alice", title: "ALPHA punct", body: "x", updated: new Date(NOW).toISOString(), links: [], history: ["c"] });
    const a = (await link(PUNCT_DOC))!;
    expect(a.getAttribute("href")).toBe(docHref(uid(PUNCT_DOC)));
    expect(a.getAttribute("href")).not.toMatch(/Notes|v2|100|%5B|;/);
  });
  it("a document in a folder with spaces and '&' links the same way, and a path is never concatenated into /documents/", async () => {
    docs.db().docs.set(SPACE_DOC, { id: uid(SPACE_DOC), owner: "u-alice", title: "ALPHA spaced", body: "x", updated: new Date(NOW).toISOString(), links: [], history: ["c"] });
    const a = (await link(SPACE_DOC))!;
    expect(a.getAttribute("href")).toBe(docHref(uid(SPACE_DOC)));
    expect(a.getAttribute("href")).not.toMatch(/Old|notes|ideas|%20|%26/);
    const src = readFileSync(join(__dirname, "../src/screens/cleanup/Cleanup.tsx"), "utf8") + readFileSync(join(__dirname, "../src/screens/cleanup/cleanup-data.ts"), "utf8");
    expect(src).not.toMatch(/["'`]\/documents\/["'`]\s*\+|`\/documents\/\$\{/);
  });
  it("a document that is gone has no link and says so; a source links to the library with its id encoded", async () => {
    await link("documents/k-a/gone.md");
    expect(screen.queryByTestId("flag-link")).toBeNull();
    expect(screen.getByTestId("fact-where").textContent).toBe("Where you flagged it is not available any more.");
    cleanup(); flags.reset();
    const a = await link(SRC_A, "source");
    expect(a!.getAttribute("href")).toBe("/library?source=" + encodeURIComponent(SRC_A));
  });
});

describe("attack: concurrent decide actions on one flag", () => {
  it("a double click takes the flag back once: one PATCH", async () => {
    const f = flag("alice", "other");
    await open("alice", "flagged");
    slow[`PATCH /workbench/contract/flags/${f}`] = new Promise((r) => setTimeout(r, 60));
    const b = screen.getByTestId("withdraw");
    fireEvent.click(b); fireEvent.click(b); fireEvent.click(b);
    await waitFor(() => expect(screen.getByTestId("empty")).toBeTruthy());
    expect(posts(/flags\//).length).toBe(1);
  });
  it("the same flag offered in the list and in a review sends one request between them", async () => {
    const f = flag("alice", "other");
    await open("alice", "flagged");
    slow[`PATCH /workbench/contract/flags/${f}`] = new Promise((r) => setTimeout(r, 60));
    fireEvent.click(screen.getByTestId("withdraw"));
    await settle();
    expect(posts(/flags\//).length).toBe(1);
    await waitFor(() => expect(screen.getByTestId("empty")).toBeTruthy());
  });
  it("a flag already taken back elsewhere: the second decision is a plain 'not there any more' or a quiet success, never an error page", async () => {
    const f = flag("alice", "other");
    await open("alice", "flagged");
    flags.handle(PEOPLE.alice, "PATCH", `/workbench/contract/flags/${f}`, { state: "withdrawn" }); // another tab got there first
    fireEvent.click(screen.getByTestId("withdraw"));
    await waitFor(() => expect(screen.getByTestId("empty")).toBeTruthy()); // the real route answers 200 again: the list reloads without it
    expect(posts(/flags\//).length).toBe(1);
  });
});

describe("attack: reasons come from the server's registry; an unknown reason never breaks or injects", () => {
  it("six registry reasons all read as words, with no list in the app", async () => {
    const six = ["wrong_claim", "low_quality", "duplicate", "outdated", "broken_link", "other"];
    const six_cl = createCleanupFake({ now: () => NOW, flagReasons: six });
    setFetcher(async (u, init) => {
      const me = PEOPLE.alice, method = init?.method ?? "GET";
      const c = six_cl.handle(me, method, u, {}); if (c) return new Response(JSON.stringify(c.body), { status: c.status });
      const f = flags.handle(me, method, u, init?.body ? JSON.parse(String(init.body)) : {}); if (f) return new Response(JSON.stringify(f.body), { status: f.status });
      return new Response(JSON.stringify({}), { status: u.includes("whoami") ? 200 : 404 });
    });
    for (const r of six) rawFlag("alice", r, { kind: "source", ref: SRC_A });
    render(<ToastProvider><Cleanup subject="u-alice" ready /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-flagged"));
    await waitFor(() => expect(cards().length).toBe(6));
    expect(screen.getAllByTestId("flag-reason").map((e) => e.textContent).sort()).toEqual(["Broken link", "Duplicate", "Low quality", "Other", "Outdated", "Wrong claim"]);
    const src = readFileSync(join(__dirname, "../src/screens/cleanup/cleanup-data.ts"), "utf8") + readFileSync(join(__dirname, "../src/screens/cleanup/Cleanup.tsx"), "utf8");
    expect(src).not.toMatch(/wrong_claim|low_quality|broken_link|"duplicate"|"outdated"/);
  });
  it("a reason the server knows but the app has never seen reads by its registry label", () => {
    expect(reasonLabel("stale_data", new Map([["stale_data", "out of date data"]]))).toBe("Out of date data");
  });
  it("a reason the registry did not list reads as words; one that is not a plain key reads 'Another reason' and is never shown raw", async () => {
    expect(reasonLabel("brand_new", new Map())).toBe("Brand new");
    expect(reasonLabel("brand_new", null)).toBe("Brand new");
    for (const bad of ["<img src=x onerror=alert(1)>", "", "A".repeat(80), "wrong claim!", "x".repeat(41)]) expect(reasonLabel(bad, new Map() as ReasonWords)).toBe("Another reason");
    rawFlag("alice", "<img src=x onerror=alert(1)>", { kind: "source", ref: SRC_A });
    rawFlag("alice", "from_the_future", { kind: "source", ref: SRC_A });
    await open("alice", "flagged");
    expect(screen.getAllByTestId("flag-reason").map((e) => e.textContent).sort()).toEqual(["Another reason", "From the future"]);
    expect(document.body.innerHTML).not.toMatch(/onerror|<img/);
  });
  it("with the registry unreadable the screen still works (words from the keys)", async () => {
    failNext["GET /workbench/contract/registries/flag_reasons"] = 500;
    rawFlag("alice", "wrong_claim", { kind: "source", ref: SRC_A });
    await open("alice", "flagged");
    expect(screen.getByTestId("flag-reason").textContent).toBe("Wrong claim");
  });
  it("an erase reason the app has no words for reads 'Another reason'", async () => {
    cl.tombs()[TOMB.alice].reason_type = "from_the_future";
    await open("alice", "reopen");
    expect(within(cards()[0]).getByTestId("fact-kept").textContent).toBe("Another reason: wrong figures");
  });
});

describe("reopening: only the eraser may; the rest is explained, never offered", () => {
  it("alice may reopen hers; bob's carries the explanation and no button; lifting sends one POST", async () => {
    await open("alice", "reopen");
    expect(within(cards()[0]).getByTestId("reopen")).toBeTruthy();
    expect(within(cards()[1]).queryByTestId("reopen")).toBeNull();
    expect(within(cards()[1]).getByTestId("reopen-not-yours").textContent).toBe("Only the person who erased it can reopen it.");
    fireEvent.click(within(cards()[0]).getByTestId("reopen"));
    expect(screen.getByTestId("reopen-panel").textContent).toMatch(/What is lost[\s\S]*What stays/);
    fireEvent.click(screen.getByTestId("reopen-ok"));
    await waitFor(() => expect(titles()).toEqual(["SRC-SHARED erased by bob"]));
    expect(posts(/lift/).map((p) => p.url)).toEqual([`/workbench/contract/cleanup/tombstones/${TOMB.alice}/lift`]);
  });
});

describe("UI rules", () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
  it("no <select>, <datalist>, listbox or option anywhere in the screen; no href built from a path; no console output", () => {
    for (const f of files(join(__dirname, "../src/screens/cleanup")).filter((x) => /\.tsx?$/.test(x))) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/<select|<datalist|role="(listbox|option|combobox|grid|row)"|aria-activedescendant|console\./);
    }
  });
  it("the screen's own text never asks the server for a title or path to build a page title", () => {
    const t = readFileSync(join(__dirname, "../src/screens/cleanup/Cleanup.tsx"), "utf8");
    expect(t).not.toMatch(/document\.title|localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
  it("a refusal never shows the server's words: 404, 409 and 500 are three fixed sentences", async () => {
    await open("alice", "ready");
    for (const [st, text] of [[404, "That is not there any more, so nothing was changed."], [409, "That is no longer possible: it changed while you were looking. Nothing was changed."], [500, "That did not work. Nothing was changed."]] as const) {
      failNext[`POST /workbench/contract/cleanup/sources/${SRC.ready1}/erase`] = st;
      fireEvent.click(within(cards()[0]).getByTestId("erase")); typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
      await waitFor(() => expect(within(cards()[0]).getByTestId("card-error").textContent).toBe(text));
      expect(document.body.textContent).not.toMatch(/SECRET-SERVER-TEXT/);
      fireEvent.click(screen.getByTestId("typed-cancel"));
    }
  });
  it("tabs are a real tablist: arrow keys move, the panel is labelled by its tab", async () => {
    await open();
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(screen.getByTestId("tab-flagged").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("tab-flagged"), { key: "ArrowLeft" });
    expect(screen.getByTestId("tab-suggestions").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("cl-tab-suggestions");
  });
  it("the claim kind and the three item kinds read as words; an unknown kind reads 'an item'", async () => {
    flags.handle(PEOPLE.alice, "POST", "/workbench/contract/flags", { item_kind: "claim", item_id: CLAIM, reason: "other", from: { kind: "source", ref: SRC_A } });
    rawFlag("alice", "other", { kind: "source", ref: SRC_A }); flags.rows()[1].item_kind = "mystery";
    await open("alice", "flagged");
    expect(titles().sort()).toEqual(["A claim you flagged", "An item you flagged"]);
  });
});

// ---- fix round 1 (tester attempt 1, Cases 10 and 11 and the mutants UM1, UM2, UM4); sources adopted from wt-t-cleanup
describe("rwr-cleanup fix round 1: a change of person while a request is held", () => {
  it("TA1 alice's held Apply-to-all does not swallow bob's Apply-to-all after the switch (in-flight guard is per person)", async () => {
    who = "alice";
    const r = render(<ToastProvider><Cleanup key="u-alice" subject="u-alice" ready /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-ready")); await waitFor(() => expect(cards().length).toBe(3));
    let release = () => {};
    slow["POST /workbench/contract/cleanup/process-all"] = new Promise<void>((res) => { release = res; });
    fireEvent.click(screen.getByTestId("apply-all")); typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
    await settle();
    who = "bob";
    r.rerender(<ToastProvider><Cleanup key="u-bob" subject="u-bob" ready /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-ready")); await waitFor(() => expect(cards().length).toBe(3));
    fireEvent.click(screen.getByTestId("apply-all")); typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
    await settle(); await settle();
    const bobs = sent.filter((s) => s.who === "bob" && s.method === "POST" && /process-all$/.test(s.url));
    const bobSaw = screen.queryByTestId("batch-error")?.textContent ?? screen.queryByTestId("batch-result")?.textContent ?? "(nothing: no request, no message)";
    release(); await settle();
    expect({ bobRequests: bobs.length, bobSaw }).toEqual({ bobRequests: 1, bobSaw: expect.stringMatching(/Erased/) });
  });
  it("TA2 alice's held dismissal of a shared candidate does not swallow bob's dismissal of it after the switch", async () => {
    who = "alice";
    const r = render(<ToastProvider><Cleanup key="u-alice" subject="u-alice" ready /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-reopen")); await waitFor(() => expect(cards().length).toBe(2));
    let release = () => {};
    slow["POST /workbench/contract/cleanup/dismissals"] = new Promise<void>((res) => { release = res; });
    fireEvent.click(within(cards()[0]).getByTestId("dismiss")); await settle();
    who = "bob";
    r.rerender(<ToastProvider><Cleanup key="u-bob" subject="u-bob" ready /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-reopen")); await waitFor(() => expect(cards().length).toBe(2));
    fireEvent.click(within(cards()[0]).getByTestId("dismiss")); await settle(); await settle();
    const bobs = sent.filter((s) => s.who === "bob" && s.method === "POST" && /dismissals$/.test(s.url));
    release(); await settle();
    expect(bobs.length).toBe(1);
  });
  it("TA3 a held request released after the switch (same toast provider, no state reset) shows nothing on bob's screen and leaves his list whole", async () => {
    who = "alice";
    const r = render(<ToastProvider><CleanupScreen subject="u-alice" whoAnswered {...({} as any)} /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-reopen")); await waitFor(() => expect(cards().length).toBe(2));
    let release = () => {};
    slow["POST /workbench/contract/cleanup/dismissals"] = new Promise<void>((res) => { release = res; });
    fireEvent.click(within(cards()[0]).getByTestId("dismiss")); await settle();
    who = "bob";
    r.rerender(<ToastProvider><CleanupScreen subject="u-bob" whoAnswered {...({} as any)} /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-reopen")); await waitFor(() => expect(cards().length).toBe(2));
    const before = sent.length;
    release(); await settle(); await settle();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(screen.queryByTestId("card-error")).toBeNull();
    expect(cards().length).toBe(2);                       // alice's dismissal is hers: bob's list is whole
    expect(sent.slice(before).filter((s) => s.method === "GET").length).toBe(0); // no refresh of bob's lists by alice's answer
  });
  it("TA4 CleanupScreen (the route's screen) itself drops an open panel and typed word on a person switch (the key guard)", async () => {
    who = "alice";
    const r = render(<ToastProvider><CleanupScreen subject="u-alice" whoAnswered {...({} as any)} /></ToastProvider>);
    fireEvent.click(screen.getByTestId("tab-ready")); await waitFor(() => expect(cards().length).toBe(3));
    fireEvent.click(within(cards()[0]).getByTestId("erase")); typeWord("ERASE");
    who = "bob";
    r.rerender(<ToastProvider><CleanupScreen subject="u-bob" whoAnswered {...({} as any)} /></ToastProvider>);
    expect(screen.queryByTestId("typed-confirm")).toBeNull();
    expect(screen.getByTestId("tab-suggestions").getAttribute("aria-selected")).toBe("true");
  });
});

describe("rwr-cleanup fix round 1: armed confirmations and the review", () => {
  it("TB1 starting a review while a card's erase panel is open leaves nothing armed and nothing stuck", async () => {
    await open("alice", "ready");
    fireEvent.click(within(cards()[1]).getByTestId("erase")); typeWord("ERASE");
    const start = screen.getByTestId("review-start") as HTMLButtonElement;
    expect(start.disabled).toBe(false); // an open panel does not stop the review from starting; it is closed by starting it
    fireEvent.click(start);
    await waitFor(() => expect(screen.getByTestId("review")).toBeTruthy());
    // card 1 of the review is the first source; its Erase must be usable (nothing armed elsewhere)
    const erase = screen.queryByTestId("erase") as HTMLButtonElement | null;
    expect(erase && !erase.disabled).toBe(true);
  });
  it("TB2 the same on Worth reopening: a reopen panel open, then Review one at a time", async () => {
    await open("alice", "reopen");
    const mine = cards().find((c) => within(c).queryByTestId("reopen"))!;
    fireEvent.click(within(mine).getByTestId("reopen"));
    const start = screen.getByTestId("review-start") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(screen.getByTestId("review")).toBeTruthy());
    const reopen = screen.queryByTestId("reopen") as HTMLButtonElement | null;
    const panel = screen.queryByTestId("reopen-panel");
    // either the review's first card is the open one (its panel shows, armed from outside the review) or another (its button must not be stuck off)
    expect({ armedFromOutside: !!panel, stuckOff: !!reopen && reopen.disabled }).toEqual({ armedFromOutside: false, stuckOff: false });
  });
});
describe("rwr-cleanup fix round 1: reason words really come from the registry", () => {
  it("TD1 a registry label that differs from its key is what the card says (the fallback would say the key's words)", async () => {
    const real = cl.handle;
    (cl as any).handle = (w: any, m: string, u: string, b: any) => {
      const r = real(w, m, u, b);
      if (r && m === "GET" && /registries\/flag_reasons$/.test(u)) r.body.entries = r.body.entries.map((e: any) => e.key === "wrong_claim" ? { ...e, label: "claim looks false" } : e);
      return r;
    };
    try {
      flag("alice", "wrong_claim");
      await open("alice", "flagged");
      await waitFor(() => expect(screen.getByTestId("flag-reason").textContent).toBe("Claim looks false"));
    } finally { (cl as any).handle = real; }
  });
});

describe("rwr-cleanup fix round 1: one guard per screen, and a refusal says so", () => {
  it("UM4 a flag withdrawn from the list (request held) and offered again in a review sends ONE request and the second card says why", async () => {
    flag("alice", "wrong_claim");
    await open("alice", "flagged");
    let release = () => {};
    slow["PATCH /workbench/contract/flags/" + flags.rows()[flags.rows().length - 1].id] = new Promise<void>((res) => { release = res; });
    fireEvent.click(within(cards()[0]).getByTestId("withdraw")); await settle();
    fireEvent.click(screen.getByTestId("review-start"));
    await waitFor(() => expect(screen.getByTestId("review")).toBeTruthy());
    fireEvent.click(screen.getByTestId("withdraw")); await settle();
    expect(posts(/flags\//).length).toBe(1);
    expect(screen.getByTestId("card-error").textContent).toMatch(/already being done/);
    release(); await settle();
  });
  it("a double click on one card is one request and no complaint", async () => {
    flag("alice", "wrong_claim");
    await open("alice", "flagged");
    const b = within(cards()[0]).getByTestId("withdraw");
    fireEvent.click(b); fireEvent.click(b); await settle(); await settle();
    expect(posts(/flags\//).length).toBe(1);
    expect(screen.queryByTestId("card-error")).toBeNull();
  });
  it("TB3 a flag card has no panel, so a review of flags starts clean; an open erase panel is closed by starting any review", async () => {
    await open("alice", "ready");
    fireEvent.click(within(cards()[0]).getByTestId("erase"));
    expect(screen.getByTestId("erase-panel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("review-start"));
    await waitFor(() => expect(screen.getByTestId("review")).toBeTruthy());
    expect(screen.queryByTestId("erase-panel")).toBeNull();
    expect((screen.getByTestId("erase") as HTMLButtonElement).disabled).toBe(false);
  });
  it("the apply-all panel is closed by starting a review too", async () => {
    await open("alice", "ready");
    fireEvent.click(screen.getByTestId("apply-all")); expect(screen.getByTestId("apply-panel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("review-start"));
    await waitFor(() => expect(screen.getByTestId("review")).toBeTruthy());
    expect(screen.queryByTestId("apply-panel")).toBeNull();
  });
});
