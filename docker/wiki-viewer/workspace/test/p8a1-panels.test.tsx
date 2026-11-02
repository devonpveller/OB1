// research-workbench P8a-1 (rw-p8a1-core), the component half, over a fake back end (helpers.ts):
//   T1 the timeline, trail, page graph and search panels are registered (and in the left nav)
//   T2 the trail renders P4a's per-source events and P3a's lead entries with their found_via path
//   T3 a tombstone opens from the trail with its link, reason and note, and lifts
//   T4 every panel that lists a source shows a suppressed source's status
//   T5 a user document is a node with outbound edges only (D12)
//   T6 hubs are density neighbourhoods with no fence; thin / contested edges between them are marked (D1)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "../src/panels";
import { navEntries, panel } from "../src/shell/registry";
import { resetState, setState } from "../src/lib/store";
import { fakeApi, settle } from "./helpers";
import { buildGraph, layout, markEdges, neighbourhoods, THIN_BRIDGES } from "../src/panels/graph/model";

const A = "e1000000-0000-4000-8000-000000000001"; // an active source
const SUP = "e1000000-0000-4000-8000-000000000002"; // a suppressed source
const ERA = "e1000000-0000-4000-8000-000000000003"; // an erased source
const TOMB = "e2000000-0000-4000-8000-000000000001";
const LEAD = "e3000000-0000-4000-8000-000000000001";
const PATHID = "e3000000-0000-4000-8000-000000000002";
const JOB = "e4000000-0000-4000-8000-000000000001";
const leaf = (id: string) => `content/source/${id}`;

const TRAIL = {
  entries: [
    { kind: "suppressed", source_id: SUP, tombstone_id: null, state: "suppressed", reason: "misattributed", context: { title: "Suppressed one", url: "https://ex.org/s" }, at: "2026-10-30T10:00:00Z", counts_as_evidence: false, lifecycle: "suppressed" },
    { kind: "erased", source_id: ERA, tombstone_id: TOMB, state: "erased", reason: "deliberate", context: { title: "Erased one", url: "https://ex.org/e", note: "gone" }, at: "2026-10-30T09:00:00Z", counts_as_evidence: false, lifecycle: "erased" },
  ],
  leads: [
    { id: PATHID, origin: "admission", stage: "lead_path", url: "https://ex.org/target", source_id: A, lifecycle: "active", found_via: LEAD, path: [{ kind: "lead", url: "https://ex.org/lead" }, { kind: "lead_path", url: "https://ex.org/target" }], score: 0.7, floor: 0.4, family: "general", reasons: ["reached through a lead"], job_id: JOB, at: "2026-10-30T08:00:00Z", counts_as_evidence: false },
    { id: "ev-1", origin: "session", stage: "lead", url: "https://ex.org/a-hit", source_id: SUP, lifecycle: "suppressed", found_via: null, path: [], score: 0.2, floor: 0.4, family: "general", reasons: ["below floor"], job_id: JOB, at: "2026-10-30T07:00:00Z", counts_as_evidence: false },
  ],
};
const TOMBSTONE = {
  id: TOMB, source_id: ERA, url: "https://ex.org/e", title: "Erased one", reason_type: "deliberate", note: "removed on purpose",
  batch_run_id: null, eraser_kind: "user", eraser_run_id: null, eraser_user: "op", confidence: null, score_version: null, fingerprint: null,
  erased_at: "2026-10-30T09:00:00Z", lifted_at: null, lifted_by: null, readmitted_source_id: null, attempts: [],
};

beforeEach(() => {
  resetState();
  try {
    localStorage.clear();
  } catch { /* none */ }
});
afterEach(() => cleanup());

async function openAll(container: HTMLElement) {
  await act(async () => { fireEvent.click(container.querySelector(".ws-summary")!); await settle(); });
}
async function pickLeaf(container: HTMLElement, sel: string) {
  const el = container.querySelector(sel)?.closest(".ws-leaf")?.querySelector(".ws-leaf-label") as HTMLElement;
  expect(el, sel).toBeTruthy();
  await act(async () => { fireEvent.click(el); await settle(); });
  return el.closest(".ws-leaf") as HTMLElement;
}

describe("T1: the minimum set is registered", () => {
  it("timeline, trail, page graph and search are side panels with a nav entry", () => {
    for (const id of ["timeline", "trail", "graph", "search"]) {
      expect(panel(id)?.kind, id).toBe("side");
      expect(navEntries().some((n) => n.panel === id), `${id} in the nav`).toBe(true);
    }
  });
});

describe("T2/T3: the trail", () => {
  it("renders P3a's lead entries with the found_via path and P4a's per-source events", async () => {
    fakeApi([["GET", "/workbench/contract/trail", () => TRAIL]]);
    const P = panel("trail")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(); });
    await openAll(container);
    expect(container.querySelector('[data-trail-origin="admission"][data-stage="lead_path"]')).toBeTruthy();
    expect(container.querySelector('[data-trail-origin="session"]')).toBeTruthy();
    const row = await pickLeaf(container, '[data-trail-origin="admission"]');
    expect(row.querySelector('[data-testid="found-via"]')?.textContent).toBe(LEAD);
    expect(row.querySelectorAll('[data-testid="found-via-path"] li').length).toBe(2);
    expect(container.querySelector('[data-testid="trail-summary"]')?.textContent).toContain("2 lead entries");
  });

  it("opens a tombstone from the trail: link, reason and note, and the lift action posts", async () => {
    const { bodies } = fakeApi([
      ["GET", "/workbench/contract/trail", () => TRAIL],
      ["GET", `/workbench/contract/tombstones/${TOMB}`, () => TOMBSTONE],
      ["POST", `/workbench/contract/tombstones/${TOMB}/lift`, () => ({ ...TOMBSTONE, lifted_at: "2026-10-31T00:00:00Z", lifted_by: "op" })],
    ]);
    const P = panel("trail")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(); });
    await openAll(container);
    const row = await pickLeaf(container, `[data-tombstone="${TOMB}"]`);
    await act(async () => { fireEvent.click(row.querySelector('[data-action="open-tombstone"]')!); await settle(); });
    const t = container.querySelector('[data-testid="tombstone"]')!;
    expect(t.querySelector('[data-testid="tombstone-link"]')?.getAttribute("href")).toBe("https://ex.org/e");
    expect(t.querySelector('[data-testid="tombstone-reason"]')?.textContent).toBe("deliberate");
    expect(t.querySelector('[data-testid="tombstone-note"]')?.textContent).toBe("removed on purpose");
    vi.spyOn(window, "prompt").mockReturnValue("reconsidered");
    await act(async () => { fireEvent.click(t.querySelector('[data-action="lift"]')!); await settle(); });
    const lift = bodies.find((b) => b.method === "POST" && b.url.endsWith("/lift"));
    expect(lift?.body.note).toBe("reconsidered");
    expect(typeof lift?.body.by).toBe("string");
  });
});

describe("T4: a listed suppressed source shows its status in every panel", () => {
  const states = (_u: string, b: any) => ({
    by_id: Object.fromEntries((b.ids ?? []).filter((i: string) => i === SUP).map((i: string) => [i, { id: i, url: "https://ex.org/s", lifecycle: "suppressed", tombstone_id: null }])),
    by_url: Object.fromEntries((b.urls ?? []).filter((u: string) => u === "https://ex.org/s").map((u: string) => [u, { id: SUP, url: u, lifecycle: "suppressed", tombstone_id: null }])),
  });
  const badge = (c: HTMLElement) => c.querySelector(".ws-badge-suppressed");

  it("trail", async () => {
    fakeApi([["GET", "/workbench/contract/trail", () => TRAIL]]);
    const P = panel("trail")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(); });
    await openAll(container);
    expect(container.querySelector(`[data-source="${SUP}"]`)?.closest(".ws-leaf")?.querySelector(".ws-badge-suppressed")).toBeTruthy();
  });

  it("timeline", async () => {
    fakeApi([["GET", "/workbench/contract/timeline", () => ({ from: null, to: null, events: [{ at: "2026-10-30T00:00:00Z", kind: "source_revision", ref: `${SUP}@2`, summary: "revision 2 by op", source_id: SUP, lifecycle: "suppressed" }] })]]);
    const P = panel("timeline")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(); });
    await openAll(container);
    expect(container.querySelector(`[data-source="${SUP}"]`)?.closest(".ws-leaf")?.querySelector(".ws-badge-suppressed")).toBeTruthy();
  });

  it("search", async () => {
    fakeApi([["GET", "/workbench/documents/candidates", () => ({ candidates: [{ kind: "source", id: SUP, title: "Suppressed one", snippet: "", insert: "", tags: [], state: "suppressed" }] })]]);
    const P = panel("search")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="search-input"]')!, { target: { value: "supp" } });
      fireEvent.submit(container.querySelector("form")!);
      await settle();
    });
    await openAll(container);
    expect(badge(container)).toBeTruthy();
  });

  // round 2 (tester t-p8a1-core D1): a source's LEAF PAGE is listed with its source's state too
  it("search (a source's leaf page hit)", async () => {
    fakeApi([["GET", "/workbench/documents/candidates", () => ({ candidates: [{ kind: "page", id: leaf(SUP), title: "Suppressed one", snippet: "", insert: "", tags: [], state: "current", lifecycle: "suppressed" }] })]]);
    const P = panel("search")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => {
      fireEvent.change(container.querySelector('[data-testid="search-input"]')!, { target: { value: "supp" } });
      fireEvent.submit(container.querySelector("form")!);
      await settle();
    });
    await openAll(container);
    expect(container.querySelector(`[data-result="${leaf(SUP)}"]`)?.closest(".ws-leaf")?.querySelector(".ws-badge-suppressed")).toBeTruthy();
  });

  it("hubs (a hub centred on a source's leaf page)", async () => {
    fakeApi([["GET", "/workbench/documents/hub-context", () => ({ hubs: [{ centre: { slug: leaf(SUP), title: "Suppressed one", page_class: "source", lifecycle: "unlinked" }, seeds: [], links: [], sources: 1, thin: true, contested: false, why: ["thin"] }] })]]);
    setState({ documentPath: "documents/u/a.md" });
    const P = panel("hubs")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(); });
    await openAll(container);
    expect(container.querySelector(`[data-hub="${leaf(SUP)}"]`)?.closest(".ws-leaf")?.querySelector(".ws-badge-unlinked")).toBeTruthy();
  });

  it("coverage (a document's hub centred on a source's leaf page)", async () => {
    fakeApi([["GET", "/workbench/contract/documents/coverage", () => ({ hubs: [{ centre: { slug: leaf(SUP), title: "Suppressed one", page_class: "source", in_degree: 0, lifecycle: "suppressed" }, seeds: [], links: [], sources: 1, thin: true, contested: false, contested_claims: [], why: [] }], sessions: [] })]]);
    setState({ documentPath: "documents/u/a.md" });
    const P = panel("coverage")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(); });
    await openAll(container);
    expect(container.querySelector(`[data-hub="${leaf(SUP)}"]`)?.closest(".ws-leaf")?.querySelector(".ws-badge-suppressed")).toBeTruthy();
  });

  it("page graph (the node, its label, and the flagged list)", async () => {
    fakeApi([
      ["GET", "/workbench/contract/neighbours", () => ({ root: "content/tool/r", depth: 2, truncated: false, nodes: [
        { kind: "page", id: "content/tool/r", title: "Root", page_class: "entity", state: "current", distance: 0, lifecycle: null, contested: false },
        { kind: "page", id: leaf(SUP), title: "Suppressed one", page_class: "source", state: "current", distance: 1, lifecycle: "suppressed", contested: false },
      ], links: [{ source: "content/tool/r", target: leaf(SUP) }] })],
      ["GET", "/workbench/contract/documents", () => ({ documents: [] })],
    ]);
    const P = panel("graph")!.component;
    const { container } = render(<P params={{ root: "content/tool/r" }} />);
    await act(async () => { await settle(); });
    const node = container.querySelector(`[data-node="${leaf(SUP)}"]`)!;
    expect(node.getAttribute("data-lifecycle")).toBe("suppressed");
    expect(node.classList.contains("ws-g-status-suppressed")).toBe(true);
    expect(node.textContent).toContain("[suppressed]");
    await openAll(container);
    expect(container.querySelector(`[data-status-node="${leaf(SUP)}"]`)?.closest(".ws-leaf")?.querySelector(".ws-badge-suppressed")).toBeTruthy();
  });

  it("refinery (a folded-in user source suppressed since)", async () => {
    fakeApi([
      ["GET", "/workbench/documents/state", () => ({ path: "documents/u/a.md", carries_idea: true, refinery: { id: "i1", archived: false }, tags: [] })],
      ["GET", "/workbench/contract/ideas/i1", () => ({ id: "i1", title: "Idea", status: "researched", room: { state: "external", location: null, note: "" },
        refinery: { members: { sessions: [] }, user_sources: [{ source_id: SUP, refinery_id: "i1", status: "admitted", state: "suppressed", title: "Folded one", url: null, revision: 1 }] } })],
    ]);
    setState({ documentPath: "documents/u/a.md" });
    const P = panel("refinery")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(); });
    await openAll(container);
    expect(container.querySelector(`[data-user-source="${SUP}"]`)?.closest(".ws-leaf")?.querySelector(".ws-badge-suppressed")).toBeTruthy();
  });

  it("the document's references", async () => {
    fakeApi([
      ["GET", "/workbench/documents/references", () => ({ references: [{ origin: "cited", reference_id: "r1", source_id: SUP, pinned_revision: 1, scope: "source", title: "Suppressed one" }], listed: [{ number: 1, source_id: SUP, title: "Suppressed one", reference_ids: ["r1"] }] })],
      ["POST", "/workbench/contract/source-states", states],
    ]);
    setState({ documentPath: "documents/u/a.md" });
    const P = panel("doc-references")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(); });
    await openAll(container);
    expect(container.querySelector(`[data-source="${SUP}"]`)?.closest(".ws-leaf")?.querySelector(".ws-badge-suppressed")).toBeTruthy();
  });

  it("source quality (the focus and a corroborating source)", async () => {
    fakeApi([
      ["GET", `/workbench/contract/sources/${A}/quality`, () => ({ source_id: A, state: "active", family: "general", score: { value: 0.5 }, factors: [], history: [],
        corroborated_by: [{ source_id: SUP, title: "Suppressed one", family: "general", relation: "corroborates", amount: 0.1, claim: null }], contradicted_by: [] })],
      ["GET", "/workbench/contract/references/", () => ({ source: { title: "Active one" } })],
      ["GET", "/workbench/contract/claims", () => ({ count: 0, claims: [] })],
      ["POST", "/workbench/contract/source-states", states],
    ]);
    setState({ reference: { reference_id: null, source_id: A, chunk_idx: 0 } });
    const P = panel("source-quality")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(8); });
    expect(container.querySelector('[data-leaf^="src:' + SUP + '"] .ws-badge-suppressed')).toBeTruthy();
  });

  it("the research flow (a hit that is a suppressed source, by URL)", async () => {
    fakeApi([
      ["GET", `/workbench/contract/sessions/${JOB}/flow`, () => ({ session_id: JOB, running: false, withheld: false, sources: [{ url: "https://ex.org/s", job_id: JOB, stages: [{ kind: "admitted", at: "2026-10-30T00:00:00Z", trail: { kind: "admitted" } }] }] })],
      ["POST", "/workbench/contract/source-states", states],
    ]);
    const P = panel("flow")!.component;
    const { container } = render(<P params={{ session: JOB }} />);
    await act(async () => { await settle(8); });
    await openAll(container);
    expect(container.querySelector('[data-source="https://ex.org/s"]')?.closest(".ws-leaf")?.querySelector(".ws-badge-suppressed")).toBeTruthy();
  });

  it("the reference panel (the focused source)", async () => {
    fakeApi([
      ["GET", `/workbench/contract/references/${SUP}`, () => ({ id: SUP, kind: "source", state: "suppressed", lifecycle: "suppressed", version: 1, source: { title: "Suppressed one", excerpt: "x" } })],
      ["GET", "/workbench/contract/chunks/", () => ({ chunks: [] })],
      ["GET", "/workbench/contract/neighbours", () => ({ nodes: [] })],
      ["GET", "/workbench/documents/citations", () => ({ documents: [] })],
    ]);
    setState({ reference: { reference_id: null, source_id: SUP, chunk_idx: 0 } });
    const P = panel("reference")!.component;
    const { container } = render(<P params={{}} />);
    await act(async () => { await settle(8); });
    expect(container.querySelector('[data-testid="reference-disclosure"] .ws-badge-suppressed')).toBeTruthy();
  });
});

describe("T5: a user document links out only (D12)", () => {
  const nodes = [
    { id: "content/tool/r", title: "Root", page_class: "entity" },
    { id: leaf(A), title: "A", page_class: "source" },
    { id: "documents/u/sneaky.md", title: "a document the API should never hold", page_class: null },
  ];
  const links = [{ source: "content/tool/r", target: leaf(A) }, { source: "content/tool/r", target: "documents/u/sneaky.md" }, { source: leaf(A), target: "doc:documents/u/mine.md" }];
  const docs = [{ title: "Mine", path: "documents/u/mine.md", outbound_links: [{ kind: "source", id: A }, { kind: "page", id: "content/tool/r" }, { kind: "claim", id: "c1" }] }];

  it("the document is a node with edges from it to the pages it links, and no edge into any document", () => {
    const g = buildGraph(nodes, links, docs);
    const doc = g.nodes.find((n) => n.kind === "document")!;
    expect(doc.id).toBe("doc:documents/u/mine.md");
    expect(g.nodes.some((n) => n.id === "documents/u/sneaky.md")).toBe(false);
    const docEdges = g.edges.filter((e) => e.source === doc.id || e.target === doc.id);
    expect(docEdges.map((e) => [e.source, e.target]).sort()).toEqual([[doc.id, "content/tool/r"], [doc.id, leaf(A)]].sort());
    for (const e of g.edges) expect(e.target.startsWith("doc:") || e.target.startsWith("documents/"), `${e.source} -> ${e.target}`).toBe(false);
  });

  it("the panel draws the document's edges outbound (arrow from the document), from its listing record", async () => {
    fakeApi([
      ["GET", "/workbench/contract/neighbours", () => ({ root: "content/tool/r", depth: 2, truncated: false, nodes: nodes.slice(0, 2).map((n) => ({ ...n, kind: "page", state: "current", distance: 0, lifecycle: null, contested: false })), links: links.slice(0, 1) })],
      ["GET", "/workbench/contract/documents", () => ({ documents: docs.map((d) => ({ ...d, updated: "2026-10-30T00:00:00Z" })) })],
    ]);
    const P = panel("graph")!.component;
    const { container } = render(<P params={{ root: "content/tool/r" }} />);
    await act(async () => { await settle(); });
    const docNode = container.querySelector('[data-node="doc:documents/u/mine.md"]')!;
    expect(docNode.getAttribute("data-kind")).toBe("document");
    expect(docNode.getAttribute("data-neighbourhood")).toBe("");
    const edges = [...container.querySelectorAll('[data-kind="document_link"]')].map((e) => e.getAttribute("data-edge"));
    expect(edges.sort()).toEqual(["doc:documents/u/mine.md>content/tool/r", `doc:documents/u/mine.md>${leaf(A)}`].sort());
    expect([...container.querySelectorAll("[data-edge]")].some((e) => (e.getAttribute("data-edge") ?? "").split(">")[1].startsWith("doc:"))).toBe(false);
  });
});

describe("T6: hubs as density neighbourhoods; thin and contested entry points (D1)", () => {
  // two cliques of four, joined by ONE link (thin); a third clique joined to the first by two links, one of
  // them touching a contested source page
  const clique = (p: string) => [0, 1, 2, 3].map((i) => `${p}${i}`);
  const c1 = clique("content/a/"), c2 = clique("content/b/"), c3 = [leaf(SUP), "content/c/1", "content/c/2", "content/c/3"];
  const all = [...c1, ...c2, ...c3];
  const nodes = all.map((id) => ({ id, title: id, page_class: "entity", contested: id === leaf(SUP), lifecycle: id === leaf(SUP) ? "active" : null }));
  const full = (c: string[]) => c.flatMap((a, i) => c.slice(i + 1).map((b) => ({ source: a, target: b })));
  const links = [...full(c1), ...full(c2), ...full(c3), { source: c1[0], target: c2[0] }, { source: c1[1], target: c3[0] }, { source: c1[2], target: c3[1] }];
  const docs = [{ title: "Mine", path: "documents/u/m.md", outbound_links: [{ kind: "page", id: c1[0] }, { kind: "page", id: c2[0] }, { kind: "page", id: c3[1] }] }];

  it("the pages fall into three neighbourhoods; the user document belongs to none", () => {
    const g = buildGraph(nodes, links, docs);
    const nb = neighbourhoods(g);
    expect(nb.list.filter((h) => h.members.length > 1).length).toBe(3);
    expect(new Set(c1.map((x) => nb.of.get(x))).size).toBe(1);
    expect(nb.of.get(c1[0])).not.toBe(nb.of.get(c2[0]));
    expect(nb.of.has("doc:documents/u/m.md")).toBe(false);
  });

  it("the lone link between two neighbourhoods is thin; a link touching a contested source is contested", () => {
    const g = buildGraph(nodes, links, docs);
    const nb = neighbourhoods(g);
    const m = markEdges(g, nb.of);
    const e = (a: string, b: string) => m.find((x) => x.source === a && x.target === b)!;
    expect(THIN_BRIDGES).toBe(1);
    expect([e(c1[0], c2[0]).thin, e(c1[0], c2[0]).contested]).toEqual([true, false]);
    expect([e(c1[1], c3[0]).thin, e(c1[1], c3[0]).contested]).toEqual([false, true]);
    expect([e(c1[2], c3[1]).thin, e(c1[2], c3[1]).contested]).toEqual([false, false]);
    expect(e(c1[0], c1[1]).between).toBeNull(); // inside a neighbourhood: no mark
    expect(m.filter((x) => x.kind === "document_link").every((x) => !x.thin && !x.contested && x.between === null)).toBe(true);
  });

  it("the panel draws blurred density clouds and no fence (no outline shape) and marks the entry points", async () => {
    fakeApi([
      ["GET", "/workbench/contract/neighbours", () => ({ root: c1[0], depth: 2, truncated: false, nodes: nodes.map((n) => ({ ...n, kind: "page", state: "current", distance: 1 })), links })],
      ["GET", "/workbench/contract/documents", () => ({ documents: docs.map((d) => ({ ...d, updated: "2026-10-30T00:00:00Z" })) })],
    ]);
    const P = panel("graph")!.component;
    const { container } = render(<P params={{ root: c1[0] }} />);
    await act(async () => { await settle(); });
    const density = container.querySelector('[data-testid="graph-density"]')!;
    expect(density.getAttribute("filter")).toBe("url(#ws-g-blur)");
    expect(container.querySelector("#ws-g-blur feGaussianBlur")).toBeTruthy();
    // a cloud is made of soft discs only - no polygon, path or stroked hull around a group
    expect(density.querySelectorAll("polygon, path, polyline, rect").length).toBe(0);
    for (const c of density.querySelectorAll("circle")) expect(c.getAttribute("stroke")).toBeNull();
    // the document draws no cloud (it is no hub)
    expect(density.querySelectorAll("circle").length).toBe(all.length);
    expect(container.querySelector(`[data-edge="${c1[0]}>${c2[0]}"]`)?.classList.contains("ws-g-thin")).toBe(true);
    expect(container.querySelector(`[data-edge="${c1[1]}>${leaf(SUP)}"]`)?.classList.contains("ws-g-contested")).toBe(true);
    await openAll(container);
    expect(container.querySelectorAll('[data-entry]').length).toBe(2);
    expect(container.querySelector('[data-testid="graph-summary"]')?.textContent).toContain("3 neighbourhoods");
  });

  it("the model lays out 800 pages quickly enough to stay interactive (a budget, not the operator's laptop)", () => {
    const n = 800;
    const big = Array.from({ length: n }, (_x, i) => ({ id: `content/p/${i}`, title: `p${i}`, page_class: "entity" }));
    const bl = Array.from({ length: n * 2 }, (_x, i) => ({ source: `content/p/${i % n}`, target: `content/p/${(i * 7 + 13) % n}` }));
    const t0 = performance.now();
    const g = buildGraph(big, bl, []);
    const nb = neighbourhoods(g);
    markEdges(g, nb.of);
    const pos = layout(g, nb.of);
    const ms = performance.now() - t0;
    expect(pos.size).toBe(n);
    expect(ms).toBeLessThan(4000);
  });
});
