// The Removals and trail screen (rwr-removals): each action against the route that already exists and its line in
// the trail with "You" as the actor, erase offered only when nothing depends on it, the typed word, private rows for
// their owner only, a read-only trail, and the two-identity planted-data test.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { isMine, dependsOn } from "../src/screens/removals/removals-data";

type Id = "alice" | "bob";
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3600 * 1000;
const AID = (n: number) => `a1000000-0000-4000-8000-00000000000${n}`;
const BID = (n: number) => `b2000000-0000-4000-8000-00000000000${n}`;

type Src = { id: string; title: string; url: string | null; lifecycle: "suppressed" | "unlinked"; reason: string; suppressed_at: string; counts: Record<string, number>; blocking: number; erase_allowed: boolean };
type Ev = { kind: string; source_id: string; tombstone_id: string | null; state: string; reason: string | null; context: Record<string, unknown>; at: string; lifecycle: string; counts_as_evidence: false };
type Act = { id: string; kind: string; source_id: string | null; tombstone_id: string | null; created_at: string };
type Doc = { title: string; path: string; updated: string; outbound_links: unknown[] };

// shared world (the library is shared); per-identity worlds hold the private rows
let SRC: Src[], TRAIL: Ev[], TOMB: Record<string, { erased_by: Id; lifted: boolean }>;
let ACTS: Record<Id, Act[]>, DOCS: Record<Id, Doc[]>, IDEAS: Record<Id, any[]>, DTRAIL: Record<Id, any[]>;
let who: Id;
let calls: { method: string; url: string; body: any }[];
let failNext: Record<string, number> = {};
let seq = 0;

const ev = (kind: string, source_id: string, over: Partial<Ev> = {}): Ev => ({ kind, source_id, tombstone_id: null, state: "current", reason: null, context: {}, at: iso(H), lifecycle: "suppressed", counts_as_evidence: false, ...over });

function world() {
  seq = 0; calls = []; failNext = {};
  SRC = [
    { id: "s1", title: "Hidden source one", url: "https://example.org/one", lifecycle: "suppressed", reason: "misattributed quote", suppressed_at: iso(5 * H), counts: { claim_edge: 2, chunk: 3, document_link: 1 }, blocking: 3, erase_allowed: false },
    { id: "s2", title: "Cut loose source two", url: "https://example.org/two", lifecycle: "unlinked", reason: "duplicate of another", suppressed_at: iso(4 * H), counts: {}, blocking: 0, erase_allowed: true },
    { id: "s3", title: "Held by private work", url: null, lifecycle: "suppressed", reason: "old", suppressed_at: iso(3 * H), counts: { reference_record: 4 }, blocking: 4, erase_allowed: false },
  ];
  TRAIL = [
    ev("suppressed", "s1", { reason: "misattributed quote", context: { title: "Hidden source one", suppressed_by: "cleanup-action:" + AID(1) }, at: iso(5 * H) }),
    ev("suppressed", "s2", { reason: "duplicate of another", context: { title: "Cut loose source two", suppressed_by: "cleanup-action:" + BID(1) }, at: iso(4 * H) }),
    ev("suppressed", "s3", { reason: "old", context: { title: "Held by private work", suppressed_by: "cleanup-action:" + BID(2) }, at: iso(3 * H) }),
    ev("severed", "s2", { context: { kind: "chunk", ref: "0", claims: 0, pages: 0 }, at: iso(3.5 * H) }),
    ev("severed", "s2", { context: { kind: "chunk", ref: "1", claims: 0, pages: 0 }, at: iso(3.5 * H) }),
    // an erased source whose marker waits: alice erased it
    ev("erased", "gone1", { tombstone_id: "t1", state: "erased", reason: "debunked", context: { title: "Erased shared source", url: "https://example.org/gone", eraser_kind: "user" }, lifecycle: "erased", at: iso(24 * H) }),
  ];
  TOMB = { t1: { erased_by: "alice", lifted: false } };
  ACTS = { alice: [{ id: AID(1), kind: "suppress", source_id: "s1", tombstone_id: null, created_at: iso(5 * H) }, { id: AID(2), kind: "erase", source_id: "gone1", tombstone_id: "t1", created_at: iso(24 * H) }], bob: [{ id: BID(1), kind: "suppress", source_id: "s2", tombstone_id: null, created_at: iso(4 * H) }] };
  DOCS = {
    alice: [
      { title: "ALPHA live plan", path: "documents/k-a/plan.md", updated: iso(H), outbound_links: [] },
      { title: "ALPHA trashed memo", path: "documents/k-a/.trash/memo.md", updated: iso(2 * H), outbound_links: [] },
      { title: "ALPHA archived notes", path: "documents/k-a/.archive/notes.md", updated: iso(3 * H), outbound_links: [] },
    ],
    bob: [{ title: "BRAVO trashed draft", path: "documents/k-b/.trash/draft.md", updated: iso(H), outbound_links: [] }],
  };
  IDEAS = {
    alice: [{ id: "i1", title: "ALPHA parked idea", status: "archived", updated_at: iso(6 * H), document_path: "documents/k-a/idea.md" }, { id: "i2", title: "ALPHA live idea", status: "engaged", updated_at: iso(H), document_path: null }],
    bob: [{ id: "i9", title: "BRAVO archived idea", status: "archived", updated_at: iso(H), document_path: null }],
  };
  DTRAIL = { alice: [{ id: "l1", kind: "delete_forever", path: "documents/k-a/.trash/ALPHA-old.md", actor_sub: "u-alice", trashed_at: iso(40 * H), created_at: iso(30 * H) }, { id: "l2", kind: "nightly_expired", path: "documents/k-a/.trash/ALPHA-expired.md", actor_sub: "system:nightly", trashed_at: iso(900 * H), created_at: iso(20 * H) }], bob: [{ id: "l9", kind: "delete_forever", path: "documents/k-b/.trash/BRAVO-gone.md", actor_sub: "u-bob", trashed_at: iso(H), created_at: iso(H) }] };
}

const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const mineKey = () => (who === "alice" ? AID : BID);
function record(kind: string, source_id: string | null, tombstone_id: string | null) {
  const id = mineKey()(5 + ++seq);
  ACTS[who].push({ id, kind, source_id, tombstone_id, created_at: new Date().toISOString() });
  return id;
}
function stub() {
  setFetcher(async (u, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = u.split("?")[0];
    calls.push({ method, url: u, body });
    const key = method + " " + path;
    if (failNext[key]) { const st = failNext[key]; delete failNext[key]; return j({ error: "SECRET-ALPHA-server-text for u-alice" }, st); }
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: "u-" + who, actor_sub: "u-" + who, name: who });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth", kind: "user" });
    if (path === "/workbench/settings") return j({ admin: false, settings: [] });
    if (path === "/workbench/contract/cleanup/sources" && method === "GET") return j({ sources: SRC, total: SRC.length });
    if (path === "/workbench/contract/trail") return j({ entries: [...TRAIL].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), leads: [] });
    if (path === "/workbench/contract/cleanup/actions") return j({ actions: [...ACTS[who]].reverse() });
    if (path === "/workbench/contract/documents") return j({ documents: DOCS[who] });
    if (path === "/workbench/contract/ideas") return j({ ideas: IDEAS[who] });
    if (path === "/workbench/documents/trail") return j({ lines: DTRAIL[who], total: DTRAIL[who].length });
    let m = path.match(/^\/workbench\/contract\/tombstones\/([^/]+)$/);
    if (m && method === "GET") { const t = TOMB[m[1]]; return t ? j({ id: m[1], lifted_at: t.lifted ? iso(0) : null, may_lift: t.erased_by === who, erased_by_you: t.erased_by === who }) : j({ error: "no tombstone" }, 404); }
    m = path.match(/^\/workbench\/sources\/([^/]+)\/restore$/);
    if (m && method === "POST") {
      const s = SRC.find((x) => x.id === m![1]); if (!s) return j({ error: "not found" }, 404);
      SRC = SRC.filter((x) => x !== s);
      const aid = record("restore", s.id, null);
      // REAL (repositories/sources.ts:330-333): restore clears retraction_committed_at / unlinked_at, so the derived 'suppressed'
      // line (contracts/repo/knowledge.ts:468-473) is gone; and (sources.ts:340-342) the 'restored' line's detail is
      // { from, to, reason, door } with NO title.
      TRAIL = TRAIL.filter((e) => !(e.kind === "suppressed" && e.source_id === s.id));
      TRAIL.push(ev("restored", s.id, { state: "current", context: { from: s.lifecycle, to: "active", reason: s.reason, door: "POST /workbench/sources/:id/restore" }, lifecycle: "active", at: new Date().toISOString() }));
      return j({ source: { id: s.id }, transition: { from: s.lifecycle, to: "active" }, aid });
    }
    m = path.match(/^\/workbench\/contract\/cleanup\/sources\/([^/]+)\/erase$/);
    if (m && method === "POST") {
      const s = SRC.find((x) => x.id === m![1]);
      if (!s || !s.erase_allowed) return j({ error: "erase refused" }, s ? 409 : 404);
      SRC = SRC.filter((x) => x !== s);
      const tid = "t" + (10 + ++seq); TOMB[tid] = { erased_by: who, lifted: false };
      record("erase", s.id, tid);
      TRAIL.push(ev("erased", s.id, { tombstone_id: tid, state: "erased", reason: body.reason_type, context: { title: s.title, url: s.url, eraser_kind: "user" }, lifecycle: "erased", at: new Date().toISOString() }));
      return j({ tombstone_id: tid, reason_type: body.reason_type });
    }
    m = path.match(/^\/workbench\/contract\/cleanup\/tombstones\/([^/]+)\/lift$/);
    if (m && method === "POST") {
      const t = TOMB[m[1]]; if (!t) return j({ error: "no" }, 404);
      if (t.erased_by !== who) return j({ error: "only the eraser" }, 403);
      t.lifted = true; record("lift", null, m[1]);
      // REAL (contracts/repo/lifecycle.ts:36-41 trail() inserts no tombstone_id column; :343 puts the id in detail only)
      TRAIL.push(ev("lifted", "gone1", { tombstone_id: null, context: { tombstone_id: m[1], note: null }, lifecycle: "erased", at: new Date().toISOString() }));
      return j({ tombstone_id: m[1] });
    }
    if (path === "/workbench/documents/restore" && method === "POST") {
      const d = DOCS[who].find((x) => x.path === body.path); if (!d) return j({ error: "no such document" }, 404);
      // REAL (documents/repo.ts:241-245 restoreDocument writes a 'restored' line to documents/trail; trail.ts:8 TrailKind)
      d.path = d.path.replace("/.trash/", "/").replace("/.archive/", "/");
      DTRAIL[who].unshift({ id: "lr" + ++seq, kind: "restored", path: d.path, actor_sub: "u-" + who, trashed_at: null, created_at: new Date().toISOString() });
      return j({ restored: d.path });
    }
    if (path === "/workbench/documents/unarchive" && method === "POST") {
      const d = DOCS[who].find((x) => x.path === body.path); if (!d) return j({ error: "no such document" }, 404);
      // REAL: the unarchive door writes an 'unarchived' line (documents/trail.ts:8)
      d.path = d.path.replace("/.archive/", "/");
      DTRAIL[who].unshift({ id: "lu" + ++seq, kind: "unarchived", path: d.path, actor_sub: "u-" + who, trashed_at: null, created_at: new Date().toISOString() });
      return j({ unarchived: d.path, refinery: { refinery_id: null, archived: false } });
    }
    // REAL (contracts/routes/idea_archive.ts:3,36-38; ideas/repo.ts reopenIdea): by the idea's id, for the caller's own ideas only.
    // Another user's idea is 404 exactly like a missing one; an idea that is not archived is 409; 200 {idea_id, status: <the state it
    // was archived from>, archived: false}. Needs no document.
    m = path.match(/^\/workbench\/ideas\/([^/]+)\/reopen$/);
    if (m && method === "POST") {
      const i = IDEAS[who].find((x) => x.id === m![1]); if (!i) return j({ error: "no such idea" }, 404);
      if (i.status !== "archived") return j({ error: "not archived" }, 409);
      // REAL (rw-idea-reopen-trail, ideas/repo.ts reopenIdea -> documents/trail.ts writeReopened): one owner-scoped line, kind 'reopened',
      // no path and no idea text; the same line is written by documents/refinery.ts reopenRefinery. A refused reopen (404, 409) writes none.
      i.status = "engaged";
      DTRAIL[who].unshift({ id: "lo" + ++seq, kind: "reopened", path: null, idea_id: i.id, actor_sub: "u-" + who, trashed_at: null, created_at: new Date().toISOString() });
      return j({ idea_id: i.id, status: "engaged", archived: false });
    }
    if (path === "/workbench/documents/delete-forever" && method === "POST") {
      if (body.confirm !== true) return j({ error: "confirm" }, 400);
      const d = DOCS[who].find((x) => x.path === body.path && x.path.includes("/.trash/")); if (!d) return j({ error: "no such document" }, 404);
      DOCS[who] = DOCS[who].filter((x) => x !== d);
      DTRAIL[who].unshift({ id: "l" + ++seq + "x", kind: "delete_forever", path: d.path, actor_sub: "u-" + who, trashed_at: iso(H), created_at: new Date().toISOString() });
      return j({ deleted: d.path });
    }
    return j({ error: "not found" }, 404);
  });
}

const open = async (id: Id = "alice") => {
  who = id;
  window.history.pushState({}, "", "/removals");
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("removals")).toBeTruthy());
  await waitFor(() => expect(within(screen.getByTestId("removed-tab")).queryAllByText("Loading...").length).toBe(0));
  // the erased row reads its tombstone (who erased it, may you lift it) after the list shows
  await waitFor(() => expect(within(sec("erased")).queryAllByTestId("by").every((b) => b.textContent !== "Not known")).toBe(true));
};
const sec = (id: string) => screen.getByTestId("sec-" + id);
const titles = (id: string) => within(sec(id)).queryAllByTestId(/^row-(source|erased|cut|trashed|archived|idea)$/).map((r) => r.querySelector(".row-title")!.textContent);
const goTrail = async () => {
  fireEvent.click(screen.getByTestId("tab-trail"));
  await waitFor(() => expect(screen.getByTestId("trail-tab")).toBeTruthy());
  await waitFor(() => expect(within(screen.getByTestId("trail-tab")).queryAllByText("Loading...").length).toBe(0));
};
const lines = () => within(screen.getByTestId("trail-tab")).queryAllByTestId("trail-line").map((l) => l.textContent!);
const typeWord = (w: string) => fireEvent.change(screen.getByTestId("typed-input"), { target: { value: w } });

beforeEach(() => { cleanup(); clearRequestLog(); resetState(); world(); stub(); document.documentElement.removeAttribute("data-theme"); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the Removed tab lists everything removed, with by / why / depended on it / getting it back", () => {
  it("alice: sources by stage, erased markers, cut connections, trash, archive, archived ideas", async () => {
    await open();
    expect(titles("sources")).toEqual(["Hidden source one", "Cut loose source two", "Held by private work"]);
    const [s1, s2] = within(sec("sources")).getAllByTestId("row-source");
    expect(s1.getAttribute("data-stage")).toBe("hidden"); expect(s2.getAttribute("data-stage")).toBe("cut");
    expect(within(s1).getByTestId("by").textContent).toBe("You");           // alice's own action
    expect(within(s2).getByTestId("by").textContent).toBe("Someone else");  // bob's: never named
    expect(within(s1).getByTestId("why").textContent).toBe("misattributed quote");
    expect(within(s1).getByTestId("depended").textContent).toMatch(/2 claims, 3 text pieces/);
    expect(within(s2).getByTestId("depended").textContent).toMatch(/Nothing depends on it/);
    expect(within(s1).getByTestId("show-again")).toBeTruthy();
    expect(titles("erased")).toEqual(["Erased shared source"]);
    await waitFor(() => expect(within(sec("erased")).getByTestId("by").textContent).toBe("You")); // from the tombstone read: erased_by_you
    expect(titles("trashed")).toEqual(["ALPHA trashed memo"]);
    expect(titles("archived")).toEqual(["ALPHA archived notes"]);
    expect(titles("ideas")).toEqual(["ALPHA parked idea"]);
    expect(within(sec("cut")).getByTestId("row-cut").textContent).toMatch(/2 connections \(a text piece\) cut from Cut loose source two/);
  });
  it("counts of dependence kinds a person can own are never shown: the row says only that something holds it", async () => {
    await open();
    const s1 = within(sec("sources")).getAllByTestId("row-source")[0];
    expect(s1.textContent).toMatch(/something in private work still holds it/);
    expect(s1.textContent).not.toMatch(/document link|1 document/i);
    const s3 = within(sec("sources")).getAllByTestId("row-source")[2];
    expect(s3.textContent).toMatch(/something in private work still holds it/);
    expect(s3.textContent).not.toMatch(/\b4\b/);
    expect(dependsOn({ reference_record: 9, chunk: 1 })).toEqual({ shared: ["1 text pieces"], private: true });
  });
  it("every empty section says so", async () => {
    SRC = []; TRAIL = []; ACTS.alice = []; DOCS.alice = []; IDEAS.alice = [];
    await open();
    for (const id of ["sources", "erased", "cut", "trashed", "archived", "ideas"]) expect(within(sec(id)).getByTestId("empty-" + id)).toBeTruthy();
  });
  it("a read that fails says so and offers Try again; the other lists still show", async () => {
    failNext["GET /workbench/contract/ideas"] = 500;
    await open();
    expect(within(sec("ideas")).getByTestId("failed-ideas")).toBeTruthy();
    expect(titles("trashed")).toEqual(["ALPHA trashed memo"]);
    fireEvent.click(within(sec("ideas")).getByText("Try again"));
    await waitFor(() => expect(titles("ideas")).toEqual(["ALPHA parked idea"]));
  });
});

describe("each action calls the existing route and shows up in the trail with the caller as the actor (acceptance 1)", () => {
  it("Show it again (source): POST sources/:id/restore, then a 'Shown again ... You' line", async () => {
    await open();
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[0]).getByTestId("show-again"));
    await waitFor(() => expect(titles("sources")).toEqual(["Cut loose source two", "Held by private work"]));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/workbench/sources/s1/restore"]);
    await goTrail();
    // the real restored line has no title, so none is invented: it says what it came back from, and why it had gone
    const l = lines().find((x) => /Shown again \(it had been hidden\)/.test(x))!;
    expect(l).toBeTruthy(); expect(l).toMatch(/You/); expect(l).toMatch(/misattributed quote/); expect(l).not.toMatch(/Hidden source one/);
    // and the Hidden line is gone with the state it was read from
    expect(lines().some((x) => /Hidden: Hidden source one/.test(x))).toBe(false);
  });
  it("Erase for good: POST cleanup/sources/:id/erase with the chosen reason, then an 'Erased for good ... You' line", async () => {
    await open();
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[1]).getByTestId("erase"));
    fireEvent.click(screen.getByTestId("erase-reason-credibility"));
    typeWord("ERASE");
    fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(titles("sources")).toEqual(["Hidden source one", "Held by private work"]));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/workbench/contract/cleanup/sources/s2/erase"); expect(post.body).toEqual({ reason_type: "credibility" });
    await goTrail();
    const l = lines().find((x) => /Erased for good: Cut loose source two/.test(x))!;
    expect(l).toMatch(/You/); expect(l).toMatch(/Reason: credibility/);
  });
  it("Lift the marker: POST cleanup/tombstones/:id/lift, the row leaves Removed, and a 'Marker lifted ... You' line appears", async () => {
    await open();
    fireEvent.click(within(sec("erased")).getByTestId("lift"));
    expect(screen.getByTestId("lost-stays").textContent).toMatch(/does not bring it back/);
    fireEvent.click(screen.getByTestId("lift-ok"));
    await waitFor(() => expect(within(sec("erased")).getByTestId("empty-erased")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.url).toBe("/workbench/contract/cleanup/tombstones/t1/lift");
    await goTrail();
    expect(lines().find((x) => /Marker lifted/.test(x))).toMatch(/You/);
  });
  it("Show it again for a trashed document, an archived document and an archived idea call their routes", async () => {
    await open();
    fireEvent.click(within(within(sec("trashed")).getByTestId("row-trashed")).getByTestId("show-again"));
    await waitFor(() => expect(within(sec("trashed")).getByTestId("empty-trashed")).toBeTruthy());
    fireEvent.click(within(within(sec("archived")).getByTestId("row-archived")).getByTestId("show-again"));
    await waitFor(() => expect(within(sec("archived")).getByTestId("empty-archived")).toBeTruthy());
    fireEvent.click(within(within(sec("ideas")).getByTestId("row-idea")).getByTestId("show-again"));
    await waitFor(() => expect(within(sec("ideas")).getByTestId("empty-ideas")).toBeTruthy());
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/workbench/documents/restore", "/workbench/documents/unarchive", "/workbench/ideas/i1/reopen"]);
  });
  it("Delete forever (a trashed document): typed word, POST documents/delete-forever with confirm, then a 'Deleted forever ... You' line", async () => {
    await open();
    fireEvent.click(within(sec("trashed")).getByTestId("delete-forever"));
    expect(screen.getByTestId("lost-stays").textContent).toMatch(/What is lost/);
    typeWord("delete");
    expect((screen.getByTestId("typed-ok") as HTMLButtonElement).disabled).toBe(true);
    typeWord("DELETE");
    fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(within(sec("trashed")).getByTestId("empty-trashed")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/workbench/documents/delete-forever"); expect(post.body).toEqual({ path: "documents/k-a/.trash/memo.md", confirm: true });
    await goTrail();
    const l = lines().find((x) => /Deleted forever: memo/.test(x))!;
    expect(l).toBeTruthy(); expect(l).toMatch(/You/);
  });
});

describe("erase is offered only when nothing depends on the item, and needs the exact word (acceptance 2, 3)", () => {
  it("a blocked source has no Erase button, and says what keeps it", async () => {
    await open();
    const [s1, , s3] = within(sec("sources")).getAllByTestId("row-source");
    for (const row of [s1, s3]) {
      expect(within(row).queryByTestId("erase")).toBeNull();
      expect(within(row).getByTestId("erase-blocked").textContent).toMatch(/Erasing is not possible yet/);
    }
    expect(within(s1).getByTestId("depended").textContent).toMatch(/2 claims/);
    expect(calls.some((c) => /erase/.test(c.url))).toBe(false);
  });
  it("the unblocked source offers Erase for good, with what is lost and what stays", async () => {
    await open();
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[1]).getByTestId("erase"));
    const t = screen.getByTestId("lost-stays").textContent!;
    expect(t).toMatch(/What is lost/); expect(t).toMatch(/What stays/); expect(t).toMatch(/marker/i);
  });
  it("the button works only for the exact word ERASE", async () => {
    await open();
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[1]).getByTestId("erase"));
    const ok = () => (screen.getByTestId("typed-ok") as HTMLButtonElement).disabled;
    expect(ok()).toBe(true);
    for (const w of ["erase", "Erase", "ERAS", "ERASEE", "ERASE it", "E R A S E", ""]) { typeWord(w); expect(ok(), w).toBe(true); }
    fireEvent.submit(screen.getByTestId("typed-confirm"));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    typeWord("ERASE"); expect(ok()).toBe(false);
  });
  it("cancel leaves everything as it was and sends nothing", async () => {
    await open();
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[1]).getByTestId("erase"));
    fireEvent.click(screen.getByTestId("typed-cancel"));
    expect(screen.queryByTestId("erase-panel")).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("a server that refuses the erase (it changed meanwhile) leaves the row and says nothing was changed", async () => {
    await open();
    SRC[1].erase_allowed = false; // the world changed after the list was read
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[1]).getByTestId("erase"));
    typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(screen.getByTestId("row-error").textContent).toMatch(/no longer possible.*Nothing was changed/));
    expect(titles("sources")).toContain("Cut loose source two");
  });
});

describe("a marker is lifted only by the one who erased it (or an administrator)", () => {
  it("bob sees no Lift button on alice's marker, only why", async () => {
    await open("bob");
    expect(within(sec("erased")).queryByTestId("lift")).toBeNull();
    expect(within(sec("erased")).getByTestId("lift-not-yours")).toBeTruthy();
    expect(within(sec("erased")).getByTestId("by").textContent).toBe("Someone else");
  });
  it("a lift the server refuses shows a plain sentence", async () => {
    await open();
    failNext["POST /workbench/contract/cleanup/tombstones/t1/lift"] = 403;
    fireEvent.click(within(sec("erased")).getByTestId("lift")); fireEvent.click(screen.getByTestId("lift-ok"));
    await waitFor(() => expect(screen.getByTestId("row-error").textContent).toMatch(/Only the person who erased this/));
  });
});

describe("the trail is read only (acceptance 4)", () => {
  it("has no button, link-to-action or form control beyond its three filters, and sends nothing but GETs", async () => {
    await open();
    clearRequestLog(); calls.length = 0;
    await goTrail();
    const tab = screen.getByTestId("trail-tab");
    expect(within(tab).queryAllByRole("button")).toHaveLength(0);
    expect([...tab.querySelectorAll("textarea, select, [contenteditable], form")]).toHaveLength(0);
    expect([...tab.querySelectorAll("input")].every((i) => i.getAttribute("type") === "radio")).toBe(true);
    expect([...tab.querySelectorAll("fieldset")].map((s) => s.getAttribute("data-testid"))).toEqual(["f-show", "f-what", "f-who"]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(tab.textContent).toMatch(/Nothing on this screen can change or delete a line/);
    expect(tab.textContent).not.toMatch(/only grows/);
  });
  it("lists newest first, source lines and document lines, and the filters narrow it", async () => {
    await open();
    await goTrail();
    expect(lines().length).toBeGreaterThanOrEqual(8);
    const times = within(screen.getByTestId("trail-tab")).getAllByTestId("trail-line").map((l) => l.querySelector(".meta")!.textContent!);
    expect([...times].sort().reverse()).toEqual(times);
    fireEvent.click(screen.getByTestId("f-show-Documents"));
    expect(lines().every((l) => /Deleted forever|Removed after 30 days/.test(l))).toBe(true);
    expect(lines()).toHaveLength(2);
    expect(lines().find((l) => /Removed after 30 days/.test(l))).toMatch(/The nightly clean-up/);
    fireEvent.click(screen.getByTestId("f-show-all"));
    fireEvent.click(screen.getByTestId("f-what-suppressed"));
    expect(lines()).toHaveLength(3);
    fireEvent.click(screen.getByTestId("f-who-me"));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/Hidden: Hidden source one/);
    fireEvent.click(screen.getByTestId("f-what-lifted"));
    expect(screen.getByTestId("trail-empty")).toBeTruthy();
  });
  it("names only You, Someone else, the nightly clean-up or an administrator: never a subject or name", async () => {
    await open();
    await goTrail();
    const t = screen.getByTestId("trail-tab").textContent!;
    expect(t).not.toMatch(/u-alice|u-bob|cleanup-action/);
    const who = within(screen.getByTestId("trail-tab")).getAllByTestId("trail-line").map((l) => l.getAttribute("data-who"));
    expect(new Set(who)).toEqual(new Set(["You", "Someone else", "The nightly clean-up"]));
  });
});

describe("private rows show only to their owner, and user B never sees user A's data (acceptance 4-6)", () => {
  const everything = () => document.body.textContent ?? "";
  it("bob's Removed tab holds bob's rows only: none of alice's documents, ideas or document trail", async () => {
    await open("bob");
    expect(titles("trashed")).toEqual(["BRAVO trashed draft"]);
    expect(titles("archived")).toEqual([]);
    expect(titles("ideas")).toEqual(["BRAVO archived idea"]);
    expect(everything()).not.toMatch(/ALPHA/);
    await goTrail();
    expect(everything()).not.toMatch(/ALPHA/);
    expect(lines().filter((l) => /BRAVO-gone/.test(l))).toHaveLength(1);
    expect(everything()).not.toMatch(/u-alice/);
  });
  it("alice's tabs never hold bob's rows", async () => {
    await open("alice");
    await goTrail();
    expect(everything()).not.toMatch(/BRAVO|u-bob/);
  });
  it("a refusal for another user's row reads exactly like a missing row, and never echoes the server's words", async () => {
    await open("bob");
    // bob asks to restore a document that is alice's (the server answers its ordinary 404) and one that is gone: same words
    DOCS.bob.push({ title: "BRAVO second", path: "documents/k-b/.trash/second.md", updated: iso(H), outbound_links: [] });
    const refuse = async (key: string) => {
      failNext["POST /workbench/documents/restore"] = 404;
      fireEvent.click(within(within(sec("trashed")).getAllByTestId("row-trashed")[0]).getByTestId("show-again"));
      await waitFor(() => expect(screen.getAllByTestId("row-error").length).toBeGreaterThan(0));
      const text = screen.getAllByTestId("row-error")[0].textContent!;
      cleanup(); world(); stub();
      await open("bob"); void key;
      return text;
    };
    const a = await refuse("foreign"), b = await refuse("missing");
    expect(a).toBe(b);
    expect(a).toBe("That is not there any more, so nothing was changed.");
    expect(a).not.toMatch(/SECRET|u-alice|ALPHA/);
  });
  it("another person's erased marker can be seen as shared knowledge but the actor is only 'Someone else', and no private count shows", async () => {
    await open("bob");
    expect(everything()).not.toMatch(/\b4 references|document_link/);
    expect(everything()).not.toMatch(/cleanup-action:/);
  });
  it("a planted marker string in private rows reaches no request URL, no storage, no title and no console call", async () => {
    const log = vi.spyOn(console, "log"), err = vi.spyOn(console, "error"), warn = vi.spyOn(console, "warn");
    await open("alice");
    await goTrail();
    expect(requestLog().every((r) => !/ALPHA/.test(r.url))).toBe(true);
    expect(calls.every((c) => !/ALPHA/.test(c.url))).toBe(true);
    expect(window.location.href + window.location.search + document.title).not.toMatch(/ALPHA/);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(log).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });
  it("the source holds no storage, cookie, cache, console, raw fetch or search box", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const f of readdirSync("src/screens/removals")) {
      const s = readFileSync("src/screens/removals/" + f, "utf8").split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join(" ");
      expect(s, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|console\.|fetch\(|XMLHttpRequest|sendBeacon/);
      expect(s, f).not.toMatch(/type="search"|role="search"|type="text"|<select|<datalist|role="listbox"/); // no search or list-search component here
    }
  });
  it("every read is a GET and every action a POST to a /workbench/ route the lifecycle items own; nothing names a person in a URL", async () => {
    await open("alice");
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[0]).getByTestId("show-again"));
    await waitFor(() => expect(titles("sources")).not.toContain("Hidden source one"));
    const posts = requestLog().filter((r) => r.method === "POST").map((r) => r.url);
    expect(posts.every((u) => /^\/workbench\/(sources\/[^/]+\/restore|contract\/cleanup\/(sources\/[^/]+\/erase|tombstones\/[^/]+\/lift)|documents\/(restore|unarchive|delete-forever)|ideas\/[^/]+\/reopen)$/.test(u))).toBe(true);
    expect(requestLog().some((r) => /alice|bob|u-|subject|owner/i.test(r.url))).toBe(false);
  });
});

describe("who did it is answered from the caller's own action log", () => {
  it("isMine: a suppression by one of my action refs, a lift by tombstone, a sever by source and time; never a stranger's", () => {
    const mine = [{ id: AID(1), kind: "suppress", sourceId: "s1", tombstoneId: null, at: iso(5 * H) }, { id: AID(2), kind: "lift", sourceId: null, tombstoneId: "t1", at: iso(H) }, { id: AID(3), kind: "sever", sourceId: "s2", tombstoneId: null, at: iso(3.5 * H) }];
    const e = (kind: string, over: object = {}) => ({ kind, sourceId: "s1", tombstoneId: null, state: "current", reason: "", context: {}, at: iso(5 * H), ...over });
    expect(isMine(e("suppressed", { context: { suppressed_by: "cleanup-action:" + AID(1) } }), mine)).toBe(true);
    expect(isMine(e("suppressed", { context: { suppressed_by: "cleanup-action:" + BID(1) } }), mine)).toBe(false);
    expect(isMine(e("lifted", { tombstoneId: "t1", sourceId: "x" }), mine)).toBe(true);
    expect(isMine(e("severed", { sourceId: "s2", at: iso(3.5 * H) }), mine)).toBe(true);
    expect(isMine(e("severed", { sourceId: "s2", at: iso(10 * H) }), mine)).toBe(false);
    expect(isMine(e("suppressed", { context: { suppressed_by: "operator" } }), mine)).toBe(false);
    expect(isMine(e("suppressed"), [])).toBe(false);
  });
});

describe("fix round 1 (tester t-removals, attempt 1): the screen against the real route shapes", () => {
  it("F1 (T1): a lift whose real trail line has tombstone_id NULL still leaves Erased sources and reads You", async () => {
    await open();
    fireEvent.click(within(sec("erased")).getByTestId("lift"));
    fireEvent.click(screen.getByTestId("lift-ok"));
    await waitFor(() => expect(within(sec("erased")).getByTestId("empty-erased")).toBeTruthy());
    expect(within(sec("erased")).queryAllByTestId("row-erased")).toHaveLength(0);
    await goTrail();
    expect(lines().find((x) => /Marker lifted/.test(x))).toMatch(/You/);
    expect(TRAIL.find((e) => e.kind === "lifted")!.tombstone_id).toBeNull(); // the fake is the real shape
  });
  it("F1: isMine matches a lifted line by the id in its detail; another person's tombstone id does not match", () => {
    const mine = [{ id: AID(2), kind: "lift", sourceId: null, tombstoneId: "t1", at: iso(H) }];
    const line = (tid: string) => ({ kind: "lifted", sourceId: "gone1", tombstoneId: null, state: "current", reason: "", context: { tombstone_id: tid, note: null }, at: iso(H) });
    expect(isMine(line("t1"), mine)).toBe(true);
    expect(isMine(line("t9"), mine)).toBe(false);
  });
  it("F2 (T3): a document put back from the trash or the archive reads as put back, never 'Removed'", async () => {
    await open();
    fireEvent.click(within(within(sec("trashed")).getAllByTestId("row-trashed")[0]).getByTestId("show-again"));
    await waitFor(() => expect(within(sec("trashed")).queryAllByTestId("row-trashed").length).toBe(0));
    fireEvent.click(within(within(sec("archived")).getAllByTestId("row-archived")[0]).getByTestId("show-again"));
    await waitFor(() => expect(within(sec("archived")).queryAllByTestId("row-archived").length).toBe(0));
    await goTrail();
    const memo = lines().find((x) => /memo/.test(x) && /Shown again/.test(x))!;
    expect(memo, lines().join("\n")).toBeTruthy(); expect(memo).toMatch(/You/);
    const notes = lines().find((x) => /notes/.test(x))!;
    expect(notes).toMatch(/Taken out of the archive/); expect(notes).toMatch(/You/);
    expect(lines().some((x) => /^.*Removed: (memo|notes)/.test(x))).toBe(false);
    // and the What filter offers the new kind
    fireEvent.click(screen.getByTestId("f-what-unarchived"));
    expect(lines()).toHaveLength(1);
  });
  it("F3 (T2): a source shown again reads from what the real lines carry; no title is invented, the old reason is kept", async () => {
    await open();
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[0]).getByTestId("show-again"));
    await waitFor(() => expect(titles("sources")).toEqual(["Cut loose source two", "Held by private work"]));
    await goTrail();
    const l = lines().find((x) => /Shown again/.test(x))!;
    expect(l).toMatch(/Shown again \(it had been hidden\): a source/);
    expect(l).toMatch(/It had been taken out because: misattributed quote/);
    expect(l).not.toMatch(/Hidden source one/);
  });
  it("Case 10 (T4): while one Erase confirmation is open, every other destructive button is off", async () => {
    await open();
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[1]).getByTestId("erase"));
    expect(screen.getByTestId("erase-panel")).toBeTruthy();
    expect((within(sec("trashed")).getByTestId("delete-forever") as HTMLButtonElement).disabled).toBe(true);
    expect((within(sec("erased")).getByTestId("lift") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("typed-cancel"));
    expect((within(sec("trashed")).getByTestId("delete-forever") as HTMLButtonElement).disabled).toBe(false);
    expect((within(sec("erased")).getByTestId("lift") as HTMLButtonElement).disabled).toBe(false);
  });
  it("Case 10 (T5): two confirmations are never open together, whichever is opened first", async () => {
    await open();
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[1]).getByTestId("erase"));
    fireEvent.click(within(sec("trashed")).getByTestId("delete-forever"));
    expect(screen.queryAllByTestId("typed-confirm").length).toBe(1);
    fireEvent.click(screen.getByTestId("typed-cancel"));
    fireEvent.click(within(sec("trashed")).getByTestId("delete-forever"));
    expect((within(sec("sources")).getAllByTestId("erase")[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sec("sources")).getAllByTestId("erase")[0]);
    fireEvent.click(within(sec("erased")).getByTestId("lift"));
    expect(screen.queryAllByTestId("typed-confirm").length).toBe(1);
    expect(screen.queryByTestId("lift-panel")).toBeNull();
  });
  it("Case 10: a lift panel open also turns the Erase and Delete forever buttons off", async () => {
    await open();
    fireEvent.click(within(sec("erased")).getByTestId("lift"));
    expect((within(sec("trashed")).getByTestId("delete-forever") as HTMLButtonElement).disabled).toBe(true);
    expect((within(sec("sources")).getAllByTestId("erase")[0] as HTMLButtonElement).disabled).toBe(true);
  });
  it("Case 13: the screen holds no <select> or <datalist>; the choices are radios, and the erase reason is sent", async () => {
    await open();
    expect(document.querySelectorAll("select, datalist")).toHaveLength(0);
    fireEvent.click(within(within(sec("sources")).getAllByTestId("row-source")[1]).getByTestId("erase"));
    expect(document.querySelectorAll("select, datalist")).toHaveLength(0);
    expect((screen.getByTestId("erase-reason-deliberate") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("erase-reason-debunked"));
    expect((screen.getByTestId("erase-reason-debunked") as HTMLInputElement).checked).toBe(true);
    typeWord("ERASE"); fireEvent.click(screen.getByTestId("typed-ok"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ reason_type: "debunked" });
  });
  it("T9: 'Only me' shows only the caller's own lines, not the nightly clean-up or an administrator's", async () => {
    DTRAIL.alice.push({ id: "l3", kind: "delete_forever", path: "documents/k-a/.trash/ALPHA-admin.md", actor_sub: "u-admin", trashed_at: iso(H), created_at: iso(10 * H) });
    await open();
    await goTrail();
    expect(lines().some((l) => /The nightly clean-up/.test(l))).toBe(true);
    expect(lines().some((l) => /An administrator/.test(l))).toBe(true);
    fireEvent.click(screen.getByTestId("f-who-me"));
    for (const l of lines()) expect(l).not.toMatch(/nightly clean-up|Someone else|An administrator/);
    expect(lines().some((l) => /Deleted forever: ALPHA-old/.test(l))).toBe(true);
  });
  it("the fallback line for an action with no shared trail line uses readable words, never the raw kind", async () => {
    ACTS.alice.push({ id: AID(7), kind: "lift", source_id: null, tombstone_id: "t77", created_at: iso(H) }, { id: AID(8), kind: "mystery", source_id: null, tombstone_id: null, created_at: iso(2 * H) });
    await open();
    await goTrail();
    expect(lines().some((l) => /You lifted a marker/.test(l))).toBe(true);
    expect(lines().some((l) => /An action of yours/.test(l))).toBe(true);
    expect(lines().some((l) => /Action recorded in your log|\blift\b|\bmystery\b/.test(l))).toBe(false);
  });
});

describe("review D1: every archived idea reopens by its id, with or without a document", () => {
  it("bob's idea with no document (i9) has Show it again and reopens through POST ideas/:id/reopen", async () => {
    await open("bob");
    const row = within(sec("ideas")).getByTestId("row-idea");
    expect(row.textContent).not.toMatch(/no document/i);
    expect(sec("ideas").textContent).not.toMatch(/not recorded in the Trail/); // the rwr-removals exception is gone: the server writes the line
    expect(sec("ideas").textContent).toMatch(/the Trail tab records it/);
    fireEvent.click(within(row).getByTestId("show-again"));
    await waitFor(() => expect(within(sec("ideas")).getByTestId("empty-ideas")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/workbench/ideas/i9/reopen"); expect(post.body).toEqual({});
  });
  it("a reopen the server refuses reads as the plain sentences: 404 not there any more, 409 no longer possible", async () => {
    await open("bob");
    failNext["POST /workbench/ideas/i9/reopen"] = 404;
    fireEvent.click(within(within(sec("ideas")).getByTestId("row-idea")).getByTestId("show-again"));
    await waitFor(() => expect(screen.getByTestId("row-error").textContent).toBe("That is not there any more, so nothing was changed."));
    failNext["POST /workbench/ideas/i9/reopen"] = 409;
    fireEvent.click(within(within(sec("ideas")).getByTestId("row-idea")).getByTestId("show-again"));
    await waitFor(() => expect(screen.getByTestId("row-error").textContent).toMatch(/no longer possible.*Nothing was changed/));
    expect(document.body.textContent).not.toMatch(/SECRET|ALPHA/);
  });
  it("rw-idea-reopen-trail: Show it again leaves one 'Reopened an idea' line for you, none for the other person, and no idea text", async () => {
    await open("alice");
    fireEvent.click(within(within(sec("ideas")).getByTestId("row-idea")).getByTestId("show-again"));
    await waitFor(() => expect(within(sec("ideas")).getByTestId("empty-ideas")).toBeTruthy());
    await goTrail();
    const mineLines = lines().filter((l) => /Reopened an idea/.test(l));
    expect(mineLines.length).toBe(1);
    expect(mineLines[0]).toMatch(/You/);
    expect(mineLines[0]).not.toMatch(/ALPHA parked idea|i1/); // the line names no idea text
    expect(within(screen.getByTestId("trail-tab")).queryAllByTestId("trail-line").some((l) => l.getAttribute("data-kind") === "reopened")).toBe(true);
    cleanup(); who = "bob";
    await open("bob"); await goTrail();
    expect(lines().some((l) => /Reopened an idea/.test(l))).toBe(false);
  });
  it("rw-idea-reopen-trail: a refused reopen leaves no line (the fake writes none, as the server)", async () => {
    await open("alice");
    const { api } = await import("../src/lib/api");
    await expect(api("POST", "/workbench/ideas/i2/reopen", {})).rejects.toMatchObject({ status: 409 });
    await expect(api("POST", "/workbench/ideas/i9/reopen", {})).rejects.toMatchObject({ status: 404 });
    expect(DTRAIL.alice.some((l) => l.kind === "reopened")).toBe(false);
  });
  it("the real route's refusals: another user's idea is 404, an idea that is not archived is 409 (the fake behaves as the server)", async () => {
    await open("alice");
    who = "bob"; IDEAS.bob[0].status = "engaged";
    const { api } = await import("../src/lib/api");
    await expect(api("POST", "/workbench/ideas/i9/reopen", {})).rejects.toMatchObject({ status: 409 });
    who = "alice";
    await expect(api("POST", "/workbench/ideas/i9/reopen", {})).rejects.toMatchObject({ status: 404 });
  });
});
