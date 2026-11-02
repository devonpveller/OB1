// rw-p8a4-ideas (front end): the ideas panel, the idea view (= the refinery view) and the refinery's context graph,
// over a fake back end (helpers.ts). Runs with the workspace's vitest suite in the viewer image's workspace stage.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { IdeasPanel } from "../src/panels/ideas/IdeasPanel";
import { IdeaPanel, RefineryGraphPanel } from "../src/panels/ideas/IdeaPanel";
import { panel } from "../src/shell/registry";
import { getState, resetState } from "../src/lib/store";
import { fakeApi, settle } from "./helpers";

const ID = "a1000000-0000-4000-8000-0000000000a1";
const HELD = "c1000000-0000-4000-8000-0000000000c1";
const FOLDED = "c1000000-0000-4000-8000-0000000000c2";
const JOB = "b1000000-0000-4000-8000-0000000000b1";
const row = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), title: "t", status: "new", summary: "s", current_revision: 1, updated_at: "2026-11-01T00:00:00Z",
  document_path: null, last_session_at: null, dossier_at: null, resurfaced_at: null, ...over,
});
const LIST = [
  row({ title: "Fresh", status: "researched", last_session_at: "2026-10-30T10:00:00Z", dossier_at: "2026-10-31T10:00:00Z" }),
  row({ title: "Parked", status: "dormant" }),
  row({ title: "Came back", status: "dormant", resurfaced_at: "2026-11-01T09:00:00Z" }),
  row({ title: "Promoted one", status: "promoted", document_path: "documents/u/p.md" }),
  row({ title: "Resting", status: "archived", document_path: "documents/u/r.md" }),
];

const ideaView = (over: Record<string, any> = {}) => ({
  id: ID, title: "The idea", state: "current", status: "researched", summary: "what it is", current_revision: 2,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
  revisions: [{ revision: 1, summary: "first", research_job_id: JOB, created_at: "2026-10-01T00:00:00Z" },
    { revision: 2, summary: "what it is", research_job_id: null, created_at: "2026-10-02T00:00:00Z" }],
  sessions: [{ id: JOB, status: "done", origin: "workspace", query: "the session question", refinery_id: ID, created_at: "", finished_at: null }],
  dossier: { source_id: "d1000000-0000-4000-8000-0000000000d1", title: "Dossier", lifecycle: "active" },
  draft: { state: "current", text: "the accreting draft", updated_at: null },
  room: { state: "current", room_id: "e1000000-0000-4000-8000-0000000000e1", thread_root: "root1", inlet: "mattermost:thread:root1", entries: 3, dossiers: 2 },
  produced: { sources: [], claims: [] },
  refinery: {
    origin: { kind: "captured_idea", document_path: null },
    members: { sessions: [JOB], document: null, podcasts: ["p1000000-0000-4000-8000-0000000000p1"], exports: [], room: "e1000000-0000-4000-8000-0000000000e1", chats: ["e1000000-0000-4000-8000-0000000000e1"] },
    context_graph: { nodes: [{ kind: "source", id: HELD, title: "Held one", state: "held", hidden: false }, { kind: "source", id: FOLDED, title: "Folded one", state: "active", hidden: true }], links: [] },
    hidden: [{ node_kind: "source", node_ref: FOLDED, hidden_at: "" }],
    user_sources: [
      { source_id: HELD, refinery_id: ID, status: "held", state: "held", title: "Held one", url: null, revision: 1, corroboration: { state: "not_run", givers: 0, amount: 0 }, found_via: [{ trail_id: "t1", url: "https://example.org/via", source_id: null, at: "" }] },
      { source_id: FOLDED, refinery_id: ID, status: "active", state: "active", title: "Folded one", url: "https://example.org/f", revision: 1, corroboration: { state: "scoped", givers: 2, amount: 0.7 }, found_via: [] },
    ],
    archived: false,
  },
  ...over,
});

const open = async (testId: string) => {
  await act(async () => { fireEvent.click(screen.getByTestId(testId).querySelector(".ws-summary")!); await settle(); });
};
const pick = async (leaf: string) => {
  await act(async () => { fireEvent.click(document.querySelector(`[data-leaf="${leaf}"] .ws-leaf-label`) as HTMLElement); await settle(); });
};
const click = async (action: string) => {
  await act(async () => { fireEvent.click(document.querySelector(`[data-action="${action}"]`) as HTMLElement); await settle(); });
};

beforeEach(() => resetState());
afterEach(() => cleanup());

describe("rw-p8a4-ideas: the ideas panel", () => {
  it("I-V0: the ideas panel, the idea view and the context graph are registered side panels", () => {
    expect(panel("ideas")?.kind).toBe("side");
    expect(panel("idea")?.kind).toBe("side");
    expect(panel("refinery-graph")?.kind).toBe("side");
  });

  it("I-V1: lists ideas by state incl. dormant and resurfaced, with last session and dossier date; archived in its own collapsible list", async () => {
    const b = fakeApi([["GET", "/workbench/contract/ideas", () => ({ ideas: LIST })]]);
    render(<IdeasPanel params={{}} />);
    await act(async () => settle());
    expect(b.log[0].url).toBe("/workbench/contract/ideas?limit=200");
    expect(screen.getByTestId("ideas-disclosure").getAttribute("data-open")).toBe("0"); // at rest: the summary
    expect(screen.getByTestId("ideas-disclosure").textContent).toContain("4 ideas");
    await open("ideas-disclosure");
    const states = [...screen.getByTestId("ideas-disclosure").querySelectorAll("[data-idea-state]")].map((e) => e.getAttribute("data-idea-state"));
    expect(states).toEqual(["researched", "resurfaced", "dormant", "promoted"]);
    const fresh = screen.getByTestId("ideas-disclosure").querySelector(`[data-leaf="${LIST[0].id}"]`)!.textContent!;
    expect(fresh).toContain("last session 2026-10-30");
    expect(fresh).toContain("dossier 2026-10-31");
    // the archived refinery is NOT among the active ones; it is in the collapsible archived list
    expect(screen.getByTestId("ideas-disclosure").textContent).not.toContain("Resting");
    expect(screen.getByTestId("ideas-archived").getAttribute("data-open")).toBe("0");
    expect(screen.getByTestId("ideas-archived").textContent).toContain("archived (1)");
    await open("ideas-archived");
    expect(screen.getByTestId("ideas-archived").textContent).toContain("Resting");
  });
});

describe("rw-p8a4-ideas: the idea view (= the refinery view)", () => {
  it("I-V2: shows the idea, its revisions, dossier, draft, sessions, its one room and the members; at rest only the summary", async () => {
    const b = fakeApi([["GET", `/workbench/contract/ideas/${ID}`, () => ideaView()]]);
    render(<IdeaPanel params={{ idea_id: ID }} />);
    await act(async () => settle());
    expect(document.querySelector("[data-action]")).toBeNull();
    await open("idea-disclosure");
    const keys = [...document.querySelectorAll("[data-leaf]")].map((e) => e.getAttribute("data-leaf"));
    for (const k of ["idea", "rev:1", "rev:2", "dossier", "draft", "room", "graph", "document", `session:${JOB}`,
      "podcast:p1000000-0000-4000-8000-0000000000p1", "chat:e1000000-0000-4000-8000-0000000000e1", `user:${HELD}`, `user:${FOLDED}`]) {
      expect(keys, k).toContain(k);
    }
    expect(document.querySelector('[data-leaf="room"]')!.textContent).toContain("mattermost inlet");
    expect(document.querySelector('[data-leaf="dossier"]')!.textContent).toContain("2 in the room");
    // only the contract's idea read - no Mattermost, no MCP
    expect(b.log.every((l) => l.url.startsWith("/workbench/contract/ideas/"))).toBe(true);
  });

  it("I-V3: edit and research now go to /workbench/ideas (the owner-checked functions); no request names a user", async () => {
    const b = fakeApi([
      ["POST", `/workbench/ideas/${ID}/edit`, () => ({ outcome: "changed", revision: 3 })],
      ["POST", `/workbench/ideas/${ID}/research-now`, () => ({ outcome: "queued", job_id: "j" }), 202],
      ["PUT", `/workbench/ideas/${ID}/draft`, () => ({ draft: { text: "x" } })],
      ["GET", `/workbench/contract/ideas/${ID}`, () => ideaView()],
    ]);
    render(<IdeaPanel params={{ idea_id: ID }} />);
    await act(async () => settle());
    await open("idea-disclosure");
    await pick("idea");
    fireEvent.change(document.querySelector('[data-input="edit-idea"]')!, { target: { value: "a sharper idea" } });
    await click("edit-idea");
    await click("research-now");
    await pick("draft");
    fireEvent.change(document.querySelector('[data-input="save-draft"]')!, { target: { value: "more draft" } });
    await click("save-draft");
    const writes = b.bodies.filter((x) => x.method !== "GET");
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      `POST /workbench/ideas/${ID}/edit`, `POST /workbench/ideas/${ID}/research-now`, `PUT /workbench/ideas/${ID}/draft`]);
    expect(writes[0].body).toEqual({ summary: "a sharper idea" });
    expect(writes[2].body).toEqual({ text: "more draft" });
    for (const w of writes) expect(JSON.stringify(w.body ?? {})).not.toMatch(/owner|sub"|user/);
  });

  it("I-V4: create document is the P2b seed; once the document exists the action is go to document (and archive)", async () => {
    let view = ideaView();
    const b = fakeApi([
      ["POST", "/workbench/documents/seed", () => { view = ideaView({ status: "promoted", refinery: { ...ideaView().refinery, members: { ...ideaView().refinery.members, document: { path: "documents/u/new.md", title: "New" } } } }); return { path: "documents/u/new.md" }; }, 201],
      ["GET", `/workbench/contract/ideas/${ID}`, () => view],
    ]);
    render(<IdeaPanel params={{ idea_id: ID }} />);
    await act(async () => settle());
    await open("idea-disclosure");
    await pick("document");
    await click("create-document");
    expect(b.bodies.find((x) => x.url === "/workbench/documents/seed")!.body).toEqual({ idea_id: ID });
    expect(getState().documentPath).toBe("documents/u/new.md");
    await act(async () => settle(10)); // the view re-reads; the document leaf stays selected
    expect(document.querySelector('[data-action="create-document"]')).toBeNull();
    expect(document.querySelector('[data-action="go-to-document"]')).not.toBeNull();
    expect(document.querySelector('[data-action="archive-refinery"]')).not.toBeNull();
  });

  it("I-V5: the user source list shows fold status, scoped corroboration and found_via; remove only on a held one", async () => {
    const b = fakeApi([
      ["DELETE", `/workbench/documents/user-sources/${HELD}`, () => ({ removed: true, tombstoned: false })],
      ["GET", `/workbench/contract/ideas/${ID}`, () => ideaView()],
    ]);
    render(<IdeaPanel params={{ idea_id: ID }} />);
    await act(async () => settle());
    await open("idea-disclosure");
    const held = document.querySelector(`[data-leaf="user:${HELD}"]`)!.textContent!;
    expect(held).toContain("held");
    expect(held).toContain("not corroborated yet");
    expect(held).toContain("found via: 1");
    const folded = document.querySelector(`[data-leaf="user:${FOLDED}"]`)!.textContent!;
    expect(folded).toContain("admitted");
    expect(folded).toContain("corroborated by 2");
    await pick(`user:${FOLDED}`);
    expect(document.querySelector('[data-action="remove"]')).toBeNull();
    expect(document.querySelector('[data-action="trail"]')).not.toBeNull();
    await pick(`user:${HELD}`);
    expect(document.querySelector(`[data-leaf="user:${HELD}"]`)!.textContent).toContain("https://example.org/via");
    await click("remove");
    expect(b.bodies.some((x) => x.method === "DELETE" && x.url === `/workbench/documents/user-sources/${HELD}?refinery_id=${ID}`)).toBe(true);
  });

  it("I-V6: an archived refinery offers no engagement - no edit, no research now, no create document - and reopens from its document", async () => {
    const base = ideaView();
    fakeApi([["GET", `/workbench/contract/ideas/${ID}`, () => ideaView({
      status: "archived", refinery: { ...base.refinery, archived: true, members: { ...base.refinery.members, document: { path: "documents/u/r.md", title: "R" } } },
    })]]);
    render(<IdeaPanel params={{ idea_id: ID }} />);
    await act(async () => settle());
    expect(screen.getByTestId("idea-disclosure").textContent).toContain("refinery archived");
    await open("idea-disclosure");
    await pick("idea");
    expect(document.querySelector('[data-action="edit-idea"]')).toBeNull();
    expect(document.querySelector('[data-action="research-now"]')).toBeNull();
    await pick("document");
    expect(document.querySelector('[data-action="open-refinery"]')).not.toBeNull();
    expect(document.querySelector('[data-action="archive-refinery"]')).toBeNull();
  });
});

describe("rw-p8a4-ideas: the refinery's context graph", () => {
  it("I-V7: draws the refinery's subgraph; hide / unhide is a refinery view setting through the contract", async () => {
    const b = fakeApi([
      ["POST", `/workbench/contract/ideas/${ID}/hidden`, (_u, body) => ({ refinery_id: ID, ...body })],
      ["GET", `/workbench/contract/ideas/${ID}`, () => ideaView()],
    ]);
    render(<RefineryGraphPanel params={{ idea_id: ID }} />);
    await act(async () => settle());
    expect(screen.getByTestId("refinery-graph-disclosure").textContent).toContain("2 nodes, 1 hidden");
    expect(screen.getByTestId("refinery-graph-canvas").querySelectorAll("circle").length).toBe(2);
    expect(screen.getByTestId("refinery-graph-canvas").querySelector('[data-hidden="1"]')).not.toBeNull();
    await open("refinery-graph-disclosure");
    await pick(`source:${HELD}`);
    await click("hide");
    await pick(`source:${FOLDED}`);
    await click("unhide");
    const hides = b.bodies.filter((x) => x.method === "POST").map((x) => x.body);
    expect(hides).toEqual([{ node_kind: "source", node_ref: HELD, hidden: true }, { node_kind: "source", node_ref: FOLDED, hidden: false }]);
  });
});
