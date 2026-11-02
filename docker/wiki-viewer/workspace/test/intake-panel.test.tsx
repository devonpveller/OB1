// research-workbench P5a (rw-p5a-intake): the intake and queue panel and the panel's add, over a fake back end.
// Every queue's job shows with its phase; retry and cancel are the job's own actions and call its own route;
// the general add (title bar) asks for a refinery, the contextual adds (a refinery, a document) have it; both
// send only the link (or a file) - no title, no text, no user.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { IntakePanel } from "../src/panels/intake/IntakePanel";
import { IntakeAdd } from "../src/panels/intake/IntakeAdd";
import { resetState } from "../src/lib/store";
import { navEntries, panels } from "../src/shell/registry";
import { clearRequestLog, requestLog, setFetcher } from "../src/lib/api";
import { settle } from "./helpers";

const now = new Date().toISOString();
const job = (kind: string, id: string, status: string, actions: string[], primary: string, detail: Record<string, unknown> = {}) => ({
  kind, id, status, state: ["queued", "fetching", "extracting", "pending", "processing", "holding"].includes(status) ? "loading" : "current",
  created_at: now, updated_at: now, detail: { phase: status, actions, primary, ...detail },
});
const JOBS = [
  job("add", "a0000000-0000-4000-8000-000000000001", "fetching", ["cancel"], "cancel", { url: "https://e.org/paper.pdf", origin: "owui" }),
  job("add", "a0000000-0000-4000-8000-000000000002", "failed", ["retry"], "retry", { url: "https://youtu.be/dQw4w9WgXcQ", error: "the video has no transcript that can be read" }),
  job("import", "a0000000-0000-4000-8000-000000000003", "failed", ["retry"], "retry", { filename: "notes.pdf" }),
  job("chunk", "a0000000-0000-4000-8000-000000000004", "pending", ["cancel"], "cancel", { title: "A shared source" }),
  job("extract", "a0000000-0000-4000-8000-000000000005", "failed", ["retry"], "retry", { title: "Another source" }),
  job("entity", "77", "pending", ["cancel"], "cancel", { thought_id: 77 }),
];

interface Seen { method: string; url: string; body: unknown }
function backend(extra: (s: Seen) => Response | null = () => null) {
  clearRequestLog();
  const seen: Seen[] = [];
  setFetcher(async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).name}`]))
      : init?.body ? JSON.parse(String(init.body)) : undefined;
    const s = { method, url, body };
    seen.push(s);
    const x = extra(s);
    if (x) return x;
    if (method === "GET" && url.startsWith("/workbench/intake/jobs")) return Response.json({ jobs: JOBS });
    if (method === "GET" && url.startsWith("/workbench/intake/content-types")) {
      return Response.json({ content_types: [{ key: "web_article", label: "web page", link: true, file: true }, { key: "pdf", label: "PDF", link: true, file: true }, { key: "youtube_transcript", label: "YouTube transcript", link: true, file: false }] });
    }
    if (method === "GET" && url.startsWith("/workbench/contract/ideas")) return Response.json({ ideas: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", title: "My refinery", status: "engaged" }] });
    if (method === "POST" && /\/workbench\/intake\/jobs\/.+\/(retry|cancel)$/.test(url)) return Response.json({ job: {} }, { status: 202 });
    if (method === "POST" && url === "/workbench/intake/add") return Response.json({ job_id: "a0000000-0000-4000-8000-0000000000aa", kind: "add", status: "queued" }, { status: 202 });
    return Response.json({ error: `no fake for ${method} ${url}` }, { status: 404 });
  });
  return seen;
}

beforeEach(() => resetState());
afterEach(() => cleanup());

const openJob = async (container: HTMLElement, key: string) => {
  const d = container.querySelector('[data-testid="intake-disclosure"] .ws-summary') as HTMLElement;
  if (d.getAttribute("aria-expanded") !== "true") await act(async () => { fireEvent.click(d); await settle(); });
  const leaf = container.querySelector(`[data-job="${key}"]`)!.closest(".ws-leaf-label") as HTMLElement;
  await act(async () => { fireEvent.click(leaf); await settle(); });
  return container.querySelector(`[data-actions="${key}"]`) as HTMLElement;
};

describe("P5a: the intake and queue panel", () => {
  it("is a registered side panel and nav entry", () => {
    expect(panels().find((p) => p.id === "intake")?.kind).toBe("side");
    expect(navEntries().find((n) => n.id === "intake")?.panel).toBe("intake");
  });

  it("every queued job of every queue appears with its phase (import, add, chunk, extract, entity)", async () => {
    backend();
    const { container } = render(<IntakePanel params={{}} />);
    await act(async () => settle(10));
    expect(screen.getByTestId("intake-summary").textContent).toContain("6 job(s)");
    await act(async () => { fireEvent.click(container.querySelector('[data-testid="intake-disclosure"] .ws-summary')!); await settle(); });
    const shown = [...container.querySelectorAll("[data-job]")].map((e) => `${(e as HTMLElement).dataset.job} ${(e as HTMLElement).dataset.phase}`);
    expect(shown.sort()).toEqual(JOBS.map((j) => `${j.kind}:${j.id} ${j.status}`).sort());
    expect(container.textContent).toContain("from OWUI");
  });

  it("cancel and retry are the job's own actions, one primary each, and call that job's route", async () => {
    const seen = backend();
    const { container } = render(<IntakePanel params={{}} />);
    await act(async () => settle(10));
    for (const j of JOBS) {
      const box = await openJob(container, `${j.kind}:${j.id}`);
      const buttons = [...box.querySelectorAll("button[data-action]")].map((b) => (b as HTMLElement).dataset.action);
      expect(buttons).toEqual(j.detail.actions);
      const primary = box.querySelector("button.ws-primary") as HTMLElement;
      expect(primary.dataset.action).toBe(j.detail.primary);
      await act(async () => { fireEvent.click(primary); await settle(); });
      expect(seen.some((s) => s.method === "POST" && s.url === `/workbench/intake/jobs/${j.kind}/${j.id}/${j.detail.primary}`)).toBe(true);
    }
    for (const r of requestLog()) expect(r.url, "no caller-supplied user").not.toMatch(/[?&](user|sub|owner|owner_sub|subject)=/i);
  });

  it("the general add asks which refinery and sends only the link", async () => {
    const seen = backend();
    render(<IntakeAdd />);
    await act(async () => settle(10));
    const submit = screen.getByTestId("intake-add").querySelector("button[type=submit]") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("intake-add-url"), { target: { value: "https://www.ncbi.nlm.nih.gov/pubmed/40128952" } });
    expect(submit.disabled, "no refinery chosen yet").toBe(true);
    fireEvent.change(screen.getByTestId("intake-add-refinery"), { target: { value: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" } });
    await act(async () => { fireEvent.click(submit); await settle(); });
    const add = seen.find((s) => s.method === "POST" && s.url === "/workbench/intake/add")!;
    expect(add.body).toEqual({ url: "https://www.ncbi.nlm.nih.gov/pubmed/40128952", refinery_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" });
  });

  it("the contextual adds have their refinery: from a refinery (its id) and from a document (its path), a link or a file", async () => {
    const seen = backend();
    const { unmount } = render(<IntakeAdd refineryId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" />);
    await act(async () => settle(10));
    expect(screen.queryByTestId("intake-add-here-refinery")).toBeNull();
    fireEvent.change(screen.getByTestId("intake-add-here-url"), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
    await act(async () => { fireEvent.submit(screen.getByTestId("intake-add-here")); await settle(); });
    unmount();
    render(<IntakeAdd path="documents/user-a/report.md" />);
    await act(async () => settle(10));
    const file = new File([new Uint8Array([37, 80, 68, 70, 45])], "paper.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("intake-add-here-file"), { target: { files: [file] } });
    await act(async () => { fireEvent.submit(screen.getByTestId("intake-add-here")); await settle(); });
    const adds = seen.filter((s) => s.method === "POST" && s.url === "/workbench/intake/add").map((s) => s.body);
    expect(adds).toEqual([
      { url: "https://youtu.be/dQw4w9WgXcQ", refinery_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" },
      { file: "file:paper.pdf", path: "documents/user-a/report.md" },
    ]);
    expect(seen.some((s) => s.url.startsWith("/workbench/contract/ideas")), "a contextual add lists no refineries").toBe(false);
  });

  it("a dropped file goes through the same add", async () => {
    const seen = backend();
    render(<IntakeAdd refineryId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" />);
    await act(async () => settle(10));
    const file = new File([new Uint8Array([37, 80, 68, 70, 45])], "dropped.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.drop(screen.getByTestId("intake-add-here"), { dataTransfer: { files: [file], getData: () => "" } });
      await settle();
    });
    expect(seen.find((s) => s.url === "/workbench/intake/add")?.body).toEqual({ file: "file:dropped.pdf", refinery_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1" });
  });

  it("the title bar's + carries the general add", async () => {
    backend();
    const { TitleBar } = await import("../src/shell/TitleBar");
    render(<TitleBar />);
    await act(async () => { fireEvent.click(screen.getByTestId("plus")); await settle(10); });
    expect(screen.getByTestId("intake-add").dataset.contextual).toBe("0");
  });
});
