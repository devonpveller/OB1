// C3 C4 C6 C7 C10 C20 C21 C22 (component half), over a fake back end (helpers.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../src/panels";
import { panels, navEntries, registerNav, registerPanel } from "../src/shell/registry";
import { LeftNav } from "../src/shell/Shell";
import { Bell, jumpOf } from "../src/shell/Bell";
import { TitleBar } from "../src/shell/TitleBar";
import { DocumentPanel } from "../src/panels/document/DocumentPanel";
import { ReferencePanel } from "../src/panels/reference/ReferencePanel";
import { SearchPanel } from "../src/panels/search/SearchPanel";
import { resetState, setState } from "../src/lib/store";
import { renderDocument, sectionOf } from "../src/lib/render";
import { fakeApi, R1, R2, S1, S2, settle } from "./helpers";

const PATH = "documents/test-doc.md";
const DOC = `---\ntitle: "Test doc"\nidea: "an idea"\n---\n\n# Test doc\n\nCites [@ref:${R1}] and {{ref:${R2}}}quoted{{/ref}} and [[source:${S2}|a source]].\n`;

function backend(extra: any[] = []) {
  return fakeApi([
    ...extra,
    ["GET", "/workbench/documents/file", () => ({ path: PATH, content: DOC, hash: "h1" })],
    ["GET", "/workbench/documents/state", () => ({ path: PATH, listed: true, trashed: false, archived: false, carries_idea: true, refinery: null, tags: [] })],
    ["POST", "/workbench/contract/diff-check", () => ({ results: [{ reference_id: R1, out_of_date: true }, { reference_id: R2, out_of_date: false }] })],
    ["GET", "/workbench/contract/references/", (u) => ({
      state: "current", version: 1, source: { title: "Source one", excerpt: "x" },
      record: { id: u.split("/").pop(), source_id: S1, pinned_revision: 1, chunk_idx: 0, selectors: { quote: { exact: "pinned" } } },
    })],
    ["GET", "/workbench/contract/neighbours", () => ({ nodes: [{ id: `content/source/${S1}`, title: "self", page_class: "source", distance: 0 }, { id: "content/tool/t", title: "Tool", page_class: "entity", distance: 1 }] })],
    ["GET", "/workbench/contract/sources/", () => ({ score: { value: 0.5 }, factors: [{ name: "family", value: 0.5, reason: "because" }] })],
    ["GET", "/workbench/contract/chunks/", () => ({ chunks: [{ idx: 0, content: "the pinned text", is_target: true }] })],
    ["GET", "/workbench/documents/citations", () => ({ documents: [{ path: PATH, title: "Test doc" }] })],
    ["GET", "/workbench/documents/candidates", (u) => ({ candidates: [{ kind: "source", id: S1, title: `hit for ${new URL(u, "http://x").searchParams.get("q")}`, snippet: "", insert: "[[source:x]]", tags: [] }] })],
    ["POST", "/workbench/documents/references", (_u, b) => ({ record: { id: "new-ref" }, form: b.form, insert: `[@ref:new-ref]` })],
  ]);
}

beforeEach(() => {
  resetState();
  try {
    localStorage.clear();
  } catch { /* none */ }
});
afterEach(() => cleanup());

describe("C22: panels and navigation areas are registered", () => {
  it("a new area registered in a test appears in the shell; the existing entries are unchanged", () => {
    const before = panels().map((p) => [p.id, p.version, p.title, p.kind]);
    const navBefore = navEntries().map((n) => [n.id, n.version, n.label]);
    registerPanel({ id: "test-area", version: 1, title: "Test area", kind: "side", component: () => <p>test area</p> });
    registerNav({ id: "test-area", version: 1, label: "Test area", order: 99, panel: "test-area" });
    render(<LeftNav />);
    expect(screen.getByText("Test area")).toBeTruthy();
    expect(panels().map((p) => [p.id, p.version, p.title, p.kind]).filter(([id]) => id !== "test-area")).toEqual(before);
    expect(navEntries().map((n) => [n.id, n.version, n.label]).filter(([id]) => id !== "test-area")).toEqual(navBefore);
    for (const [id] of navBefore) expect(document.querySelector(`[data-nav="${id}"]`)).toBeTruthy();
  });

  it("the shell names no panel: its source holds no panel id", async () => {
    const fs = await import("node:fs");
    for (const f of ["src/shell/Shell.tsx", "src/shell/dock.ts"]) {
      const src = fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      for (const p of panels()) expect(src.includes(`"${p.id}"`), `${f} names "${p.id}"`).toBe(false);
    }
  });
});

describe("C21: side panels follow the at-rest rule", () => {
  it("every registered side panel opens on its summary - no leaves, no actions - and shows actions only on a selected leaf", async () => {
    backend([
      ["GET", "/workbench/contract/documents", () => ({ documents: [{ title: "Doc A", path: "documents/a.md", updated: new Date().toISOString(), outbound_links: [] }] })],
      ["GET", "/workbench/documents/folders", () => ({ folders: ["", "f1"] })],
      ["GET", "/workbench/documents/references", () => ({ references: [{ origin: "cited", reference_id: R1, source_id: S1, pinned_revision: 1, scope: "span", title: "S" }] })],
      ["GET", "/workbench/documents/hub-context", () => ({ hubs: [{ centre: { slug: "content/tool/t", title: "Tool", page_class: "entity" }, seeds: [], links: [], sources: 1, thin: true, contested: false, why: ["thin"] }] })],
      ["GET", "/workbench/documents/history", () => ({ commits: [{ hash: "abc1234", author: "op", date: new Date().toISOString(), message: "edit" }] })],
      ["GET", "/workbench/contract/ideas/", () => null],
    ]);
    setState({ documentPath: PATH });
    const side = panels().filter((p) => p.kind === "side" && p.id !== "test-area");
    expect(side.length).toBeGreaterThanOrEqual(7);
    for (const p of side) {
      const C = p.component;
      const { container, unmount } = render(<C params={{}} />);
      await act(async () => settle(10));
      expect(container.querySelector(".ws-actions"), `${p.id}: actions at rest`).toBeNull();
      expect(container.querySelector("[data-action]"), `${p.id}: an action at rest`).toBeNull();
      expect(container.querySelector(".ws-leaves"), `${p.id}: opened expanded`).toBeNull();
      const summary = container.querySelector(".ws-summary") as HTMLElement | null;
      if (summary) {
        await act(async () => { fireEvent.click(summary); await settle(); });
        expect(container.querySelector(".ws-actions"), `${p.id}: actions before a leaf is selected`).toBeNull();
        const leaf = container.querySelector(".ws-leaf-label") as HTMLElement | null;
        if (leaf) {
          await act(async () => { fireEvent.click(leaf); await settle(); });
          expect(container.querySelector(".ws-actions"), `${p.id}: no actions on a selected leaf`).toBeTruthy();
        }
      }
      unmount();
    }
  });
});

describe("C3 / C10: opening a document", () => {
  it("renders the file itself, flags only the stale reference, and fetches no reference text", async () => {
    const { log } = backend();
    setState({ documentPath: PATH });
    const { container } = render(<DocumentPanel params={{}} />);
    await act(async () => settle(10));
    expect(container.querySelector("[data-testid=rendered]")).toBeTruthy();
    const urls = log.map((r) => r.url);
    expect(urls.some((u) => u.startsWith("/workbench/documents/file"))).toBe(true);
    for (const u of urls) {
      expect(u, "no reference text on open").not.toMatch(/\/contract\/(references|chunks)\//);
      expect(u, "no page route / render module / contract page call").not.toMatch(/^\/(?!workbench\/)|\/contract\/(neighbours|search)/);
    }
    const stale = [...container.querySelectorAll(".ws-chip.ws-stale")].map((e) => (e as HTMLElement).dataset.ref);
    expect(stale).toEqual([R1]);
    // the edit button swaps the view for the editor in place
    await act(async () => { fireEvent.click(screen.getByTestId("edit")); await settle(); });
    expect(container.querySelector("[data-testid=editor] .cm-editor")).toBeTruthy();
    expect(container.querySelector("[data-testid=rendered]")).toBeNull();
  });

  it("start refinery is greyed out with a tooltip until the document carries an idea", async () => {
    backend([["GET", "/workbench/documents/state", () => ({ path: PATH, listed: true, carries_idea: false, refinery: null, tags: [] })]]);
    setState({ documentPath: PATH });
    const { container } = render(<DocumentPanel params={{}} />);
    await act(async () => settle(10));
    const b = container.querySelector("[data-tool=refinery]") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe("add an idea to the document to get started");
  });

  it("a document whose refinery is archived carries the 'refinery archived' tag", async () => {
    backend([["GET", "/workbench/documents/state", () => ({ path: PATH, listed: true, carries_idea: true, refinery: { id: "r", status: "archived", archived: true }, tags: ["refinery archived"] })]]);
    setState({ documentPath: PATH });
    const { container } = render(<DocumentPanel params={{}} />);
    await act(async () => settle(10));
    expect([...container.querySelectorAll(".ws-tag")].map((t) => t.textContent)).toEqual(["refinery archived"]);
  });
});

describe("C4 / C6: the reference panel", () => {
  it("selecting a chip focuses the panel on that record; the strip is relative to the reference's source", async () => {
    const { log } = backend();
    setState({ documentPath: PATH, reference: { reference_id: R1, source_id: "", chunk_idx: null } });
    render(<ReferencePanel params={{}} />);
    await act(async () => settle(10));
    const nb = log.find((r) => r.url.includes("/contract/neighbours"))!;
    expect(decodeURIComponent(nb.url)).toContain(`id=content/source/${S1}`);
    expect(nb.url).not.toContain(encodeURIComponent(PATH));
    expect(log.some((r) => r.url.includes(`/contract/references/${R1}`))).toBe(true);
  });

  it("inject creates a reference at the cursor from the panel's selection", async () => {
    const { bodies } = backend();
    const inserted: string[] = [];
    setState({
      documentPath: PATH,
      reference: { reference_id: R1, source_id: "", chunk_idx: null },
      editor: { path: PATH, insertAtCursor: (t) => inserted.push(t), selection: () => "", focusAt: () => {}, replaceText: () => true },
    });
    const { container } = render(<ReferencePanel params={{}} />);
    await act(async () => settle(10));
    const chunk = container.querySelector('[data-leaf="chunk:0"] .ws-leaf-label') as HTMLElement;
    await act(async () => { fireEvent.click(chunk); await settle(); });
    await act(async () => { fireEvent.click(container.querySelector("[data-action=inject]")!); await settle(); });
    const post = bodies.find((b) => b.method === "POST" && b.url === "/workbench/documents/references")!;
    expect(post.body).toMatchObject({ path: PATH, source_id: S1, form: "chip", chunk_idx: 0 });
    expect(inserted).toEqual(["[@ref:new-ref]"]);
  });

  it("mirror sends the editor's selection to the search panel as a search", async () => {
    const { log } = backend();
    render(<SearchPanel params={{}} />);
    await act(async () => { setState({ mirror: { query: "selected words", at: Date.now() } }); await settle(10); });
    expect(log.some((r) => r.url.startsWith("/workbench/documents/candidates") && r.url.includes("q=selected%20words"))).toBe(true);
    expect(screen.getByTestId("search-summary").textContent).toContain('"selected words"');
  });
});

describe("C7 / C20: the title bar and the bell", () => {
  it("the title bar holds Settings, Theme, the bell and the universal +", () => {
    backend([
      ["GET", "/workbench/contract/notifications", () => ({ notifications: [] })],
      ["GET", "/workbench/workspace/notifications", () => ({ acknowledged: [] })],
      ["GET", "/workbench/contract/registries/progress_indicators", () => ({ entries: [] })],
    ]);
    render(<TitleBar />);
    for (const id of ["settings", "theme", "bell", "plus"]) expect(screen.getByTestId(id)).toBeTruthy();
    expect(document.querySelectorAll(".ws-bell").length).toBe(1);
  });

  it("the universal + with no refinery creates none and points at the document path", async () => {
    const { bodies } = backend([
      ["GET", "/workbench/contract/ideas", () => ({ ideas: [] })],
      ["GET", "/workbench/contract/notifications", () => ({ notifications: [] })],
      ["GET", "/workbench/workspace/notifications", () => ({ acknowledged: [] })],
      ["GET", "/workbench/contract/registries/progress_indicators", () => ({ entries: [] })],
    ]);
    render(<TitleBar />);
    await act(async () => { fireEvent.click(screen.getByTestId("plus")); await settle(); });
    expect(screen.getByTestId("plus-none").textContent).toContain("paste the source there, then open that document's refinery");
    expect(bodies.filter((b) => b.method === "POST")).toEqual([]);
  });

  it("notifications: unread count, class, subject, jumps; an acknowledgement clears it and holds after a remount", async () => {
    const acked = new Set<string>();
    const notes = [
      { id: "n1", class: "transient", subject: "LLM call failing", slug: "content/tool/t", entity: null, origin: "workspace", error: null, last_seen: "", count: 1 },
      { id: "n2", class: "structural", subject: "a structural failure", slug: null, entity: "idea:abc", origin: null, error: null, last_seen: "", count: 1 },
    ];
    backend([
      ["GET", "/workbench/contract/notifications", () => ({ notifications: notes })],
      ["GET", "/workbench/workspace/notifications", () => ({ acknowledged: [...acked].map((id) => ({ id })) })],
      ["POST", /\/workbench\/workspace\/notifications\/.+\/ack/, (u: string) => { acked.add(u.split("/")[4]); return { id: u.split("/")[4] }; }],
    ]);
    const { unmount } = render(<Bell />);
    await act(async () => settle(10));
    expect(screen.getByTestId("unread").textContent).toBe("2");
    await act(async () => { fireEvent.click(screen.getByTestId("bell")); await settle(); });
    expect([...document.querySelectorAll("[data-class]")].map((e) => (e as HTMLElement).dataset.class)).toEqual(["transient", "structural"]);
    expect((document.querySelector('[data-notification="n1"] a.ws-jump') as HTMLAnchorElement).getAttribute("href")).toBe("/content/tool/t");
    expect(document.querySelector('[data-notification="n2"] button.ws-jump')).toBeTruthy();
    await act(async () => { fireEvent.click(document.querySelector('[data-notification="n1"] .ws-ack')!); await settle(); });
    expect(screen.getByTestId("unread").textContent).toBe("1");
    unmount();
    render(<Bell />);
    await act(async () => settle(10));
    expect(screen.getByTestId("unread").textContent).toBe("1");
  });

  it("an entity the workspace has no view for gets no jump (never a dead link)", () => {
    expect(jumpOf({ id: "x", class: "structural", subject: "s", slug: null, entity: "p2b:test", origin: null, error: null, last_seen: "", count: 1 })).toBeNull();
  });
});

describe("C10 / C12: the rendered view", () => {
  it("escapes raw HTML, renders chips, transclusions and typed links, and gives each heading a copy", () => {
    const r = renderDocument(`# H\n\n<script>alert(1)</script> [[content/tool/t|tool]] [@ref:${R1}]\n\n## Two\n\ntext`, "documents/x.md", { stale: new Set([R1]) });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).toContain('href="/content/tool/t"');
    expect(r.html).toContain(`data-ref="${R1}"`);
    expect(r.html).toContain("ws-stale");
    expect((r.html.match(/ws-copy-heading/g) ?? []).length).toBe(2);
    expect(sectionOf("# H\n\na\n\n## Two\n\ntext\n# Three", 1)).toBe("## Two\n\ntext");
  });

  it("the copy of the grammar is byte-identical to the documents API's", async () => {
    const fs = await import("node:fs");
    const theirs = "../../workbench/src/documents/grammar.ts";
    if (!fs.existsSync(theirs)) return; // the image build context has only the viewer; the runner checks it
    expect(fs.readFileSync("src/lib/grammar.ts", "utf8")).toBe(fs.readFileSync(theirs, "utf8"));
  });
});

vi.setConfig({ testTimeout: 20000 });

describe("per-user browser state (the identity seam's subject)", () => {
  it("two users on one browser keep two layouts, two themes", async () => {
    const { setOwner, ownedKey } = await import("../src/lib/owner");
    const { layoutKey } = await import("../src/shell/dock");
    const { applyTheme, readTheme } = await import("../src/shell/TitleBar");
    setOwner("user-a");
    const ka = layoutKey();
    applyTheme("dark");
    setOwner("user-b");
    const kb = layoutKey();
    expect(ka).not.toBe(kb);
    expect(readTheme()).toBe("light");
    setOwner("user-a");
    expect(readTheme()).toBe("dark");
    expect(ownedKey("x")).toBe("x:user-a");
  });
});
