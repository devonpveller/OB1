// research-workbench P4b (rw-p4b-sessions), the component half, over a fake back end (helpers.ts) and a
// fake session stream: the running-session card (P1), a steer shown pending at once and refusals said
// (P2), no steer affordance on a due-process event (P3), the research flow with its trail (P4), one card
// shape and a badge for every origin with its link back (P5/P9), an idea's room (P6), another user's
// card (P7) and a card the viewer may not act on (P8).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "../src/panels";
import { SessionsPanel } from "../src/panels/sessions/SessionsPanel";
import { ResearchFlowPanel } from "../src/panels/flow/ResearchFlowPanel";
import { setStreamOpener, type StreamMessage } from "../src/panels/sessions/stream";
import { resetState } from "../src/lib/store";
import { fakeApi, settle } from "./helpers";

const id = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;
function card(n: number, o: Record<string, any> = {}) {
  return {
    id: id(n), status: "running", state: "loading", origin: "workspace", badge: { key: "workspace", label: "Workspace" },
    link: null, caller: "workspace", query: `question ${n}`, phase: "gather", current_artifact: { kind: "source", label: "https://ex.org/a" },
    waiting_on: { kind: "stage", detail: "gather" }, next_steering_point: { step_id: "s2", phase: "plan" },
    tree: [
      { id: id(n), parent_job_id: null, branch_kind: "root", status: "running", open: true, pending: false, rooted_step_id: null, query: `question ${n}` },
      { id: `d${n}000000-0000-4000-8000-000000000001`, parent_job_id: id(n), branch_kind: "gap", status: "done", open: false, pending: false, rooted_step_id: "s2", query: "a closed gap" },
    ],
    can_act: true, created_at: "2026-10-30T00:00:00Z", started_at: null, finished_at: null, ...o,
  };
}
const ORIGINS = [
  card(1, { origin: "workspace", badge: { key: "workspace", label: "Workspace" }, link: { kind: "panel", href: null, panel: "document", params: { path: "documents/u/a.md" } } }),
  card(2, { origin: "owui", badge: { key: "owui", label: "Open WebUI" }, link: { kind: "external", href: "https://chat.example/c/chat-1", panel: null, params: {} } }),
  card(3, { origin: "mattermost", badge: { key: "mattermost", label: "Mattermost" }, link: null }),
  card(4, { origin: "notebook", badge: { key: "notebook", label: "Notebook" }, link: null }),
  card(5, { origin: "mattermost", badge: { key: "idea_refinery", label: "Idea Refinery" }, link: { kind: "panel", href: null, panel: "refinery", params: { idea_id: "i1", focus: "room" } } }),
  card(6, { origin: "manual", badge: { key: "manual", label: "Manual" }, link: { kind: "panel", href: null, panel: "sessions", params: { session: id(6) } } }),
];

let streams: { url: string; on: (m: StreamMessage) => void }[] = [];
beforeEach(() => {
  resetState();
  streams = [];
  setStreamOpener((url, on) => {
    streams.push({ url, on });
    return () => {};
  });
});
afterEach(() => {
  cleanup();
  setStreamOpener(null);
});

async function openCard(container: HTMLElement, cid: string) {
  await act(async () => { fireEvent.click(container.querySelector(".ws-summary")!); await settle(); });
  const leaf = container.querySelector(`[data-leaf="${cid}"] .ws-leaf-label`) as HTMLElement;
  expect(leaf, `card ${cid}`).toBeTruthy();
  await act(async () => { fireEvent.click(leaf); await settle(); });
  return container.querySelector(`[data-leaf="${cid}"]`) as HTMLElement;
}

describe("P1/P5: one card per session, one shape for every origin", () => {
  it("each card shows phase, current artifact, waiting-on, next steering point and its tree with open and closed branches", async () => {
    fakeApi([["GET", "/workbench/contract/sessions", () => ({ sessions: ORIGINS })]]);
    const { container } = render(<SessionsPanel params={{}} />);
    await act(async () => settle(10));
    await act(async () => { fireEvent.click(container.querySelector(".ws-summary")!); await settle(); });
    const shapes = new Set<string>();
    for (const c of ORIGINS) {
      const el = container.querySelector(`[data-card="${c.id}"]`) as HTMLElement;
      expect(el, c.id).toBeTruthy();
      for (const f of ["phase", "artifact", "waiting", "next-steer"]) expect(el.querySelector(`[data-field="${f}"]`)?.textContent, `${c.id} ${f}`).toBeTruthy();
      expect(el.querySelector(`[data-field="next-steer"]`)!.textContent).toContain("plan (s2)");
      const branches = [...el.querySelectorAll("[data-branch]")].map((b) => (b as HTMLElement).dataset.open);
      expect(branches, `${c.id}: the tree`).toEqual(["1", "0"]);
      expect((el.querySelector("[data-badge]") as HTMLElement).dataset.badge).toBe(c.badge.key);
      expect(el.querySelector("[data-badge]")!.textContent).toBe(c.badge.label);
      shapes.add([...el.querySelectorAll("[data-field], [data-testid=tree], [data-badge]")].map((x) => (x as HTMLElement).dataset.field ?? (x as HTMLElement).dataset.testid ?? "badge").join(","));
    }
    expect(shapes.size).toBe(1);
  });

  it("each card links back where its job has a reference; Mattermost and notebook show the badge only", async () => {
    fakeApi([["GET", "/workbench/contract/sessions", () => ({ sessions: ORIGINS })]]);
    const { container } = render(<SessionsPanel params={{}} />);
    await act(async () => settle(10));
    const want: Record<string, string> = { [id(1)]: "document", [id(2)]: "external", [id(3)]: "none", [id(4)]: "none", [id(5)]: "refinery", [id(6)]: "sessions" };
    for (const [cid, kind] of Object.entries(want)) {
      const li = await openCard(container, cid);
      const link = li.querySelector("[data-link]") as HTMLElement;
      expect(link?.dataset.link, cid).toBe(kind);
      if (kind === "external") expect((link as HTMLAnchorElement).href).toBe("https://chat.example/c/chat-1");
      // collapse the summary again for the next card
      await act(async () => { fireEvent.click(container.querySelector(".ws-summary")!); await settle(); });
    }
  });

  it("P6: an idea's session links to its refinery room", async () => {
    fakeApi([["GET", "/workbench/contract/sessions", () => ({ sessions: [ORIGINS[4]] })]]);
    const { container } = render(<SessionsPanel params={{}} />);
    await act(async () => settle(10));
    const li = await openCard(container, id(5));
    expect(li.querySelector("[data-badge]")!.textContent).toBe("Idea Refinery");
    expect(li.querySelector("[data-link=refinery]")!.textContent).toBe("open the refinery room");
  });
});

describe("P2: a steer from the card", () => {
  it("is shown as a pending branch from the server's answer at once, and the stream's next card keeps it", async () => {
    const child = "e0000000-0000-4000-8000-000000000009";
    const steered = card(3, { origin: "mattermost", badge: { key: "mattermost", label: "Mattermost" } });
    steered.tree.push({ id: child, parent_job_id: id(3), branch_kind: "steer", status: "queued", open: true, pending: true, rooted_step_id: "s2", query: "clay soils" });
    const { bodies } = fakeApi([
      ["GET", "/workbench/contract/sessions", () => ({ sessions: [ORIGINS[2]] })],
      ["POST", `/workbench/contract/sessions/${id(3)}/steer`, () => ({ steer: { child_job_id: child, steer_id: "x", root_job_id: id(3), parent_job_id: id(3), step_id: "s2", steer_kind: "human" }, card: steered }), 201],
    ]);
    const { container } = render(<SessionsPanel params={{}} />);
    await act(async () => settle(10));
    const li = await openCard(container, id(3));
    expect(streams.map((s) => s.url)).toEqual([`/workbench/contract/sessions/${id(3)}/stream`]);
    fireEvent.change(li.querySelector("[data-input=text]")!, { target: { value: "clay soils" } });
    await act(async () => { fireEvent.click(li.querySelector("[data-action=steer]")!); await settle(); });
    expect(bodies.find((b) => b.method === "POST")!.body).toEqual({ step_id: "s2", text: "clay soils" });
    const pending = container.querySelector(`[data-branch="${child}"]`) as HTMLElement;
    expect(pending?.dataset.pending).toBe("1");
    expect(container.querySelector("[data-testid=sessions-msg]")!.textContent).toContain("pending");
    await act(async () => { streams[0].on({ event: "card", data: { card: steered, events: [] } }); await settle(); });
    expect((container.querySelector(`[data-branch="${child}"]`) as HTMLElement).dataset.pending).toBe("1");
  });

  it("a refused steer says so - never a silent acceptance", async () => {
    fakeApi([
      ["GET", "/workbench/contract/sessions", () => ({ sessions: [ORIGINS[0]] })],
      ["POST", `/workbench/contract/sessions/${id(1)}/steer`, () => ({ error: "not a steering point: a due-process stage is not steered" }), 409],
    ]);
    const { container } = render(<SessionsPanel params={{}} />);
    await act(async () => settle(10));
    const li = await openCard(container, id(1));
    fireEvent.change(li.querySelector("[data-input=text]")!, { target: { value: "x" } });
    await act(async () => { fireEvent.click(li.querySelector("[data-action=steer]")!); await settle(); });
    expect(container.querySelector("[data-testid=sessions-msg]")!.textContent).toContain("refused: not a steering point");
  });

  it("narrow and add-source are steers with a contract / a source", async () => {
    const { bodies } = fakeApi([
      ["GET", "/workbench/contract/sessions", () => ({ sessions: [ORIGINS[0]] })],
      ["POST", `/workbench/contract/sessions/${id(1)}/steer`, () => ({ steer: { child_job_id: "y" }, card: ORIGINS[0] }), 201],
      ["POST", `/workbench/contract/sessions/${id(1)}/cancel`, () => ({ job_id: id(1), status: "cancelling" })],
    ]);
    const { container } = render(<SessionsPanel params={{}} />);
    await act(async () => settle(10));
    let li = await openCard(container, id(1));
    fireEvent.change(li.querySelector("[data-input=deny]")!, { target: { value: "example.com" } });
    fireEvent.change(li.querySelector("[data-input=maxFetch]")!, { target: { value: "3" } });
    await act(async () => { fireEvent.click(li.querySelector("[data-action=narrow]")!); await settle(); });
    li = container.querySelector(`[data-leaf="${id(1)}"]`) as HTMLElement;
    fireEvent.change(li.querySelector("[data-input=url]")!, { target: { value: "https://example.org/x" } });
    await act(async () => { fireEvent.click(li.querySelector("[data-action=add-source]")!); await settle(); });
    await act(async () => { fireEvent.click(li.querySelector("[data-action=cancel]")!); await settle(); });
    const posts = bodies.filter((b) => b.method === "POST");
    expect(posts[0].body.contract).toEqual({ sources: { deny: ["example.com"] }, budget: { max_fetch: 3 } });
    expect(posts[1].body.add_source).toEqual({ url: "https://example.org/x" });
    expect(posts[2].url).toBe(`/workbench/contract/sessions/${id(1)}/cancel`);
  });
});

describe("P3: due-process events carry no steer affordance", () => {
  it("only a steering stage offers 'steer here'; a fetch, a screen or a source never does", async () => {
    fakeApi([["GET", "/workbench/contract/sessions", () => ({ sessions: [ORIGINS[0]] })]]);
    const { container } = render(<SessionsPanel params={{}} />);
    await act(async () => settle(10));
    await openCard(container, id(1));
    const ev = (n: number, type: string, kind: string, phase: string | null, step: string | null) =>
      ({ id: n, job_id: id(1), step_id: step, type, kind, payload: phase ? { phase } : { url: "https://ex.org/a" }, trail: type === "source" ? { kind: "admitted" } : null });
    await act(async () => {
      streams[0].on({ event: "card", data: { card: ORIGINS[0], events: [
        ev(1, "stage", "due_process", "reuse", "s1"), ev(2, "stage", "steering", "plan", "s2"), ev(3, "stage", "due_process", "gather", "s3"),
        ev(4, "source", "due_process", null, null), ev(5, "stage", "due_process", "screen", "s4"),
      ] } });
      await settle();
    });
    const rows = [...container.querySelectorAll("[data-event]")] as HTMLElement[];
    expect(rows.length).toBe(5);
    for (const r of rows) {
      const has = !!r.querySelector("[data-action=steer-at]");
      expect(has, `event ${r.dataset.event} (${r.dataset.kind})`).toBe(r.dataset.kind === "steering");
    }
  });
});

describe("P7/P8: another user's card, and a card the viewer may not act on", () => {
  it("shows no question, no steer, no cancel - and no step to steer at", async () => {
    const foreign = card(7, { query: "", can_act: false, next_steering_point: { step_id: null, phase: "plan" }, origin: "mattermost", badge: { key: "mattermost", label: "Mattermost" } });
    foreign.tree = foreign.tree.map((b: any) => ({ ...b, query: "", rooted_step_id: null }));
    fakeApi([["GET", "/workbench/contract/sessions", () => ({ sessions: [foreign] })]]);
    const { container } = render(<SessionsPanel params={{}} />);
    await act(async () => settle(10));
    const li = await openCard(container, id(7));
    expect(li.querySelector(".ws-card-query")!.textContent).toBe("(another user's session)");
    await act(async () => {
      streams[0].on({ event: "card", data: { card: foreign, events: [{ id: 1, job_id: id(7), step_id: null, type: "stage", kind: "steering", payload: { phase: "plan" }, trail: null }] } });
      await settle();
    });
    expect(li.querySelector("[data-action]")).toBeNull();
    expect(li.querySelector("[data-testid=no-act]")).toBeTruthy();
  });
});

describe("P4: the research flow panel", () => {
  const trail = (kind: string) => ({ id: `t-${kind}`, url: "https://ex.org/a", kind, score: 0.71, floor: 0.4, family: "general", reasons: ["lab"], found_via: null });
  it("shows every source's stages, each with its trail, animating in, the latest pulsing while running", async () => {
    fakeApi([["GET", `/workbench/contract/sessions/${id(1)}/flow`, () => ({ session_id: id(1), running: true, withheld: false, sources: [
      { url: "https://ex.org/a", job_id: id(1), stages: [{ kind: "admitted", at: "2026-10-30T00:00:00Z", trail: trail("admitted") }, { kind: "lead_path", at: "2026-10-30T00:00:01Z", trail: trail("lead_path") }] },
      { url: "https://ex.org/b", job_id: id(1), stages: [{ kind: "lead", at: "2026-10-30T00:00:02Z", trail: { ...trail("lead"), url: "https://ex.org/b" } }] },
    ] })]]);
    const { container } = render(<ResearchFlowPanel params={{ session: id(1) }} />);
    await act(async () => settle(10));
    await act(async () => { fireEvent.click(container.querySelector(".ws-summary")!); await settle(); });
    const sources = [...container.querySelectorAll("[data-source]")] as HTMLElement[];
    expect(sources.map((s) => s.dataset.source)).toEqual(["https://ex.org/a", "https://ex.org/b"]);
    const stages = [...container.querySelectorAll("[data-stage]")] as HTMLElement[];
    expect(stages.map((s) => s.dataset.stage)).toEqual(["admitted", "lead_path", "lead"]);
    for (const s of stages) {
      expect(s.querySelector("[data-trail]"), `${s.dataset.stage}: its trail`).toBeTruthy();
      expect(s.textContent).toContain("score 0.71 / floor 0.40");
      expect(s.classList.contains("ws-flow-enter")).toBe(true);
    }
    expect(stages[1].classList.contains("ws-flow-current")).toBe(true);
    expect(stages[0].classList.contains("ws-flow-current")).toBe(false);
  });

  it("another user's session withholds its flow", async () => {
    fakeApi([["GET", `/workbench/contract/sessions/${id(1)}/flow`, () => ({ session_id: id(1), running: true, withheld: true, sources: [] })]]);
    const { container } = render(<ResearchFlowPanel params={{ session: id(1) }} />);
    await act(async () => settle(10));
    expect(container.querySelector(".ws-summary")!.textContent).toContain("another user's session");
  });
});
