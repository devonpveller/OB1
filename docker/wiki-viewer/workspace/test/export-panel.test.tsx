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
