// research-workbench P6b (rw-p6b-gate): the export panel over a fake back end (helpers.ts). It lists
// MY documents and MY exports as the owner-scoped routes answer them, sends no user of its own, shows a
// blocked export's findings (and offers no download for it), and downloads a passed one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { ExportPanel } from "../src/panels/export/ExportPanel";
import { resetState, setState } from "../src/lib/store";
import { panels, navEntries } from "../src/shell/registry";
import { setFetcher } from "../src/lib/api";
import { fakeApi, settle } from "./helpers";

const MINE = "documents/user-a/report.md";
const RUNS = [
  { id: "e1000000-0000-4000-8000-000000000001", path: MINE, format: "pdf", style: "ieee", status: "blocked", filename: "report.pdf", created_at: new Date().toISOString(),
    blocking_findings: [{ code: "overflow", page: 1, detail: "12 glyph(s) outside the text area", stage: "structure" }], warnings: [{ code: "vision-not-configured", detail: "off" }] },
  { id: "e1000000-0000-4000-8000-000000000002", path: MINE, format: "pdf", style: "ieee", status: "passed", filename: "report.pdf", created_at: new Date().toISOString(),
    blocking_findings: [], warnings: [] },
];
const routes = (extra: any[] = []) => [
  ...extra,
  ["GET", "/workbench/contract/documents", () => ({ documents: [{ title: "My report", path: MINE, updated: new Date().toISOString(), outbound_links: [] }] })],
  ["GET", "/workbench/exports", () => ({ exports: RUNS })],
];

beforeEach(() => resetState());
afterEach(() => cleanup());

const openLeaf = async (container: HTMLElement, sel: string) => {
  await act(async () => { fireEvent.click(container.querySelector(".ws-summary") as HTMLElement); await settle(); });
  const leaf = container.querySelector(sel)!.closest(".ws-leaf-label") ?? container.querySelector(sel)!;
  await act(async () => { fireEvent.click(leaf as HTMLElement); await settle(); });
};

describe("P6b: the export panel", () => {
  it("is a registered side panel and nav entry", () => {
    expect(panels().find((p) => p.id === "export")?.kind).toBe("side");
    expect(navEntries().find((n) => n.id === "export")?.panel).toBe("export");
  });

  it("lists only what the owner-scoped routes answer (my documents, my exports) and names no user in any request", async () => {
    const { log } = fakeApi(routes() as any);
    const { container } = render(<ExportPanel params={{}} />);
    await act(async () => settle(10));
    expect(container.textContent).toContain("2 export(s), 1 blocked");
    for (const r of log) expect(r.url, "no caller-supplied user").not.toMatch(/[?&](user|sub|owner|owner_sub|subject)=/i);
    expect(log.map((r) => r.url.split("?")[0]).sort()).toEqual(["/workbench/contract/documents", "/workbench/exports"]);
  });

  it("a blocked run shows its blocking findings and offers no download; a passed one offers its file", async () => {
    fakeApi(routes() as any);
    const { container } = render(<ExportPanel params={{}} />);
    await act(async () => settle(10));
    await openLeaf(container, `[data-export="${RUNS[0].id}"]`);
    expect(screen.getByTestId("run-blocking").textContent).toContain("overflow (page 1): 12 glyph(s) outside the text area");
    expect(container.querySelector('[data-action="download"]')).toBeNull();
    cleanup();
    fakeApi(routes() as any);
    const again = render(<ExportPanel params={{}} />);
    await act(async () => settle(10));
    await openLeaf(again.container, `[data-export="${RUNS[1].id}"]`);
    const a = again.container.querySelector('[data-action="download"]') as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(`/workbench/exports/${RUNS[1].id}/file`);
  });

  it("Export PDF on the open document: a gate refusal shows the findings, never a file", async () => {
    setState({ documentPath: MINE });
    const seen: string[] = [];
    const api = fakeApi(routes() as any);
    void api;
    setFetcher(async (url) => {
      seen.push(url);
      if (url.startsWith("/workbench/export?")) {
        return new Response(JSON.stringify({ code: "layout-gate", export_id: RUNS[0].id, blocking_findings: RUNS[0].blocking_findings, warnings: [] }), { status: 422, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("/workbench/exports")) return Response.json({ exports: RUNS });
      if (url.startsWith("/workbench/contract/documents")) return Response.json({ documents: [{ title: "My report", path: MINE, updated: "", outbound_links: [] }] });
      return new Response("{}", { status: 404 });
    });
    const { container } = render(<ExportPanel params={{}} />);
    await act(async () => settle(10));
    await openLeaf(container, "[data-leaf-new]");
    await act(async () => { fireEvent.click(container.querySelector('[data-action="export-pdf"]') as HTMLElement); await settle(10); });
    expect(seen).toContain(`/workbench/export?path=${encodeURIComponent(MINE)}&format=pdf`);
    expect(screen.getByTestId("export-verdict").dataset.status).toBe("blocked");
    expect(screen.getByTestId("export-blocking").textContent).toContain("overflow");
    expect(screen.getByTestId("export-msg").textContent).toContain("the file was not served");
  });
});

describe("P6b round 2 (tester D4): the reference panel lists what the export's reference list holds", () => {
  it("one entry per source, in citation order, numbered and titled as the file prints it; Copy the list equals the file's list", async () => {
    const { DocReferencesPanel } = await import("../src/panels/docrefs/DocReferencesPanel");
    const S = (n: number) => `c1000000-0000-4000-8000-00000000000${n}`;
    const R = (n: number) => `d1000000-0000-4000-8000-00000000000${n}`;
    fakeApi([
      ["GET", "/workbench/documents/references", () => ({
        path: MINE,
        // holder rows: two chips on source 2, source 1 cited AND added, first seen in another order
        references: [
          { origin: "cited", reference_id: R(1), source_id: S(2), pinned_revision: 1, scope: "span", title: "Two" },
          { origin: "cited", reference_id: R(2), source_id: S(2), pinned_revision: 1, scope: "span", title: "Two" },
          { origin: "cited", reference_id: R(3), source_id: S(1), pinned_revision: 1, scope: "source", title: "One" },
          { origin: "added", reference_id: R(4), source_id: S(1), pinned_revision: 1, scope: "source", title: "One" },
        ],
        listed: [
          { number: 1, source_id: S(1), title: "One printed", reference_ids: [R(3), R(4)] },
          { number: 2, source_id: S(2), title: "Two printed", reference_ids: [R(1), R(2)] },
        ],
      })],
    ] as any);
    setState({ documentPath: MINE });
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => { copied = t; return Promise.resolve(); } } });
    const { container } = render(<DocReferencesPanel params={{}} />);
    await act(async () => settle(10));
    await act(async () => { fireEvent.click(container.querySelector(".ws-summary") as HTMLElement); await settle(); });
    const rows = [...container.querySelectorAll("[data-source]")].map((e) => e.textContent);
    expect(rows).toEqual(["One printed", "Two printed"]);
    await act(async () => { fireEvent.click(container.querySelector("[data-source] ")!.closest(".ws-leaf-label") as HTMLElement); await settle(); });
    await act(async () => { fireEvent.click(container.querySelector('[data-action="copy-list"]') as HTMLElement); await settle(); });
    expect(copied).toBe("[1] One printed\n[2] Two printed");
  });
});

describe("P6b round 5 (operator 2026-10-31): a reference-list mismatch is advisory", () => {
  it("a served export whose run carries a reference-mismatch warning shows 'reference list may differ from the panel'", async () => {
    resetState();
    setState({ documentPath: MINE });
    const RUN = { ...RUNS[1], id: "e1000000-0000-4000-8000-000000000009", warnings: [{ code: "reference-mismatch", detail: "entry [2] in the file differs", stage: "references" }] };
    setFetcher(async (url) => {
      if (url.startsWith("/workbench/export?")) {
        return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf", "x-export-id": RUN.id, "x-export-gate": "passed", "x-export-warnings": "1", "x-export-reference-parity": "mismatch" } });
      }
      if (url.startsWith(`/workbench/exports/${RUN.id}`)) return Response.json(RUN);
      if (url.startsWith("/workbench/exports")) return Response.json({ exports: [RUN] });
      if (url.startsWith("/workbench/contract/documents")) return Response.json({ documents: [{ title: "My report", path: MINE, updated: "", outbound_links: [] }] });
      return new Response("{}", { status: 404 });
    });
    const { container } = render(<ExportPanel params={{}} />);
    await act(async () => settle(10));
    await openLeaf(container, "[data-leaf-new]");
    await act(async () => { fireEvent.click(container.querySelector('[data-action="export-pdf"]') as HTMLElement); await settle(10); });
    expect(screen.getByTestId("export-verdict").dataset.status).toBe("passed");
    expect(screen.getByTestId("export-parity-warning").textContent).toBe("reference list may differ from the panel");
    expect(screen.getByTestId("export-msg").textContent).toContain("reference list may differ from the panel");
    cleanup();
    const again = render(<ExportPanel params={{}} />);
    await act(async () => settle(10));
    await openLeaf(again.container, `[data-export="${RUN.id}"]`);
    expect(again.container.querySelector('[data-testid="run-parity-warning"]')?.textContent).toBe("reference list may differ from the panel");
    expect(again.container.querySelector('[data-action="download"]')).toBeTruthy();
  });
});
