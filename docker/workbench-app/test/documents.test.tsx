// The Documents screen (rwr-docs-list) and the route table's `screen` field, against the shared fake documents
// back end (e2e/docs-fake.mjs, the same one the e2e stub runs). One describe per acceptance item.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { App } from "../src/App";
import { ROUTES, matchRoute, routeParams, type RouteDef, type ScreenProps } from "../src/routes";
import { parseRoute, navigate } from "../src/lib/router";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState, getLastDocument, setLastDocument } from "../src/lib/state";
import { daysLeft, folderOf, goesText, linkedText, tabOf, NOT_FOUND } from "../src/screens/documents/docs-data";
import { createFake, PEOPLE } from "../e2e/docs-fake.mjs";

const NOW = Date.now();
const fake = createFake({ now: () => NOW });
let who: "alice" | "bob" = "alice";
let bodies: { method: string; url: string; body: any }[] = [];
const settings = new Map<string, { value: unknown; version: number }>();

function stub() {
  bodies = [];
  setFetcher(async (u, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push({ method, url: u, body });
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    const path = u.split("?")[0];
    const me = PEOPLE[who];
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: me.sub, actor_sub: me.sub, name: me.name });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth", kind: "user", subject_sub: me.sub });
    if (path === "/workbench/settings") return j({ settings: [...settings].map(([key, v]) => ({ key, ...v })) });
    const sm = /^\/workbench\/settings\/(.+)$/.exec(path);
    if (sm) {
      const k = decodeURIComponent(sm[1]);
      const n = (settings.get(k)?.version ?? 0) + 1;
      if (method === "DELETE") { settings.set(k, { value: null, version: n }); return j({ key: k, value: null, version: n }); }
      settings.set(k, { value: body.value, version: n });
      return j({ key: k, value: body.value, version: n });
    }
    const r = fake.handle(who, method, u, body ?? {});
    if (r) return j(r.body, r.status);
    if (path === "/workbench/contract/sessions") return j({ sessions: [] });
    if (path === "/workbench/intake/jobs") return j({ jobs: [] });
    if (path === "/workbench/contract/cleanup/sources") return j({ sources: [], total: 0 });
    if (path === "/workbench/contract/cleanup/reopen-candidates") return j({ candidates: [] });
    return j({ error: "not found" }, 404);
  });
}

const settle = async () => {
  await waitFor(() => expect(screen.queryAllByRole("status").filter((e) => /Loading|Checking/.test(e.textContent ?? "")).length).toBe(0));
};
const openDocs = async () => {
  window.history.pushState({}, "", "/documents");
  render(<App />);
  await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBeGreaterThan(0));
};
const rows = () => screen.queryAllByTestId("doc-row").map((r) => within(r).getByTestId("doc-title").textContent);
const row = (title: string) => screen.getAllByTestId("doc-row").find((r) => within(r).getByTestId("doc-title").textContent === title)!;
const tab = async (t: "active" | "archived" | "trash") => { fireEvent.click(screen.getByTestId("tab-" + t)); await settle(); };
// the writing surface's text (rwr-doc-editor): an ACTIVE document opens in the editor, whose text is in .cm-content
const edText = () => screen.getByTestId("doc-editor").querySelector(".cm-content")?.textContent ?? "";
const noEditable = () => {
  const m = screen.getByTestId("main");
  return m.querySelectorAll("input, textarea, [contenteditable]:not([contenteditable=false])").length === 0;
};

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); fake.reset(); settings.clear(); who = "alice";
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the route table's screen field (the shared seam later screens plug into)", () => {
  it("App renders a route's `screen` when it has one, else its placeholder", () => {
    for (const r of ROUTES) expect(r.path === "/" || r.path.startsWith("/documents") ? !!r.screen : !r.screen, r.path).toBe(true);
  });
  it("giving an entry a `screen` is the whole change: App renders it with the route's params", () => {
    const def = ROUTES.find((r) => r.path === "/research/start")!;
    const seen: ScreenProps[] = [];
    const Probe = (p: ScreenProps) => { seen.push(p); return <h1 data-testid="probe">probe</h1>; };
    def.screen = Probe;
    try {
      window.history.pushState({}, "", "/research/start");
      render(<App />);
      expect(screen.getByTestId("probe")).toBeTruthy();
      expect(screen.queryByTestId("placeholder")).toBeNull();
      expect(seen[0].route.path).toBe("/research/start");
    } finally { delete def.screen; }
    cleanup();
    window.history.pushState({}, "", "/research/start");
    render(<App />);
    expect(screen.getByTestId("coming").textContent).toMatch(/phase 3/);
  });
  it("params are the decoded `:name` segments (an encoded slash stays inside its segment)", () => {
    const r = parseRoute("/documents/documents%2Fk-a%2FStack%2Fa%20b.md");
    const def = matchRoute(r.path) as RouteDef;
    expect(def.path).toBe("/documents/:id");
    expect(routeParams(def, r)).toEqual({ id: "documents/k-a/Stack/a b.md" });
    expect(routeParams(matchRoute("/documents") as RouteDef, parseRoute("/documents"))).toEqual({});
  });
});

describe("the list: folders with counts, the table, the tabs", () => {
  it("Active lists the person's active documents, newest edit first, with folder, edited and linked to", async () => {
    await openDocs();
    expect(rows()).toEqual(["ALPHA Upgrading the CPU", "ALPHA One gateway", "ALPHA Untitled draft"]);
    const cells = [...row("ALPHA Upgrading the CPU").querySelectorAll("td")].map((c) => c.textContent);
    expect(cells[1]).toBe("Hardware");
    expect(cells[2]).toBe("2 h ago");
    expect(cells[3]).toBe("2 sources · 1 idea");
    expect([...row("ALPHA Untitled draft").querySelectorAll("td")][3].textContent).toBe("nothing yet");
    expect([...row("ALPHA Untitled draft").querySelectorAll("td")][1].textContent).toBe("Unfiled");
  });
  it("folders carry the count of the tab's documents; a folder filters the table", async () => {
    await openDocs();
    const counts = () => [screen.getByTestId("folder-all"), ...screen.getAllByTestId("folder")].map((b) => b.textContent);
    expect(counts()).toEqual(["All documents3", "Hardware1", "Recipes0", "Stack1", "Unfiled1"]);
    fireEvent.click(screen.getAllByTestId("folder").find((b) => b.textContent === "Stack1")!);
    expect(rows()).toEqual(["ALPHA One gateway"]);
    await tab("archived");
    expect(counts()).toEqual(["All documents1", "Hardware0", "Recipes0", "Stack1", "Unfiled0"]);
    expect(rows()).toEqual(["ALPHA Old wiki plan"]);
  });
  it("tabs split by where the document is; the path decides", async () => {
    expect([tabOf("documents/k/a.md"), tabOf("documents/k/.archive/a.md"), tabOf("documents/k/.trash/x/a.md"), tabOf("documents/.trash/a.md")])
      .toEqual(["active", "archived", "trash", "trash"]);
    expect(folderOf("documents/k/.trash/Hardware/a.md", "documents/k")).toBe("Hardware");
    expect(folderOf("documents/legacy.md", "documents/k")).toBe("");
    await openDocs();
    await tab("trash");
    expect(rows()).toEqual(["ALPHA CPU duplicate"]);
    await tab("archived");
    expect(rows()).toEqual(["ALPHA Old wiki plan"]);
  });
  it("+ Folder makes a folder; + New document makes one in the chosen folder and opens it", async () => {
    await openDocs();
    fireEvent.click(screen.getByTestId("new-folder"));
    fireEvent.change(screen.getByTestId("folder-name"), { target: { value: "Reading" } });
    fireEvent.click(screen.getByTestId("folder-ok"));
    await waitFor(() => expect(screen.getAllByTestId("folder").map((b) => b.textContent)).toContain("Reading0"));
    fireEvent.click(screen.getByTestId("new-doc"));
    expect(screen.getByTestId("doc-folder").textContent).toMatch(/In the folder: Reading\./);
    fireEvent.change(screen.getByTestId("doc-name"), { target: { value: "ALPHA fresh notes" } });
    fireEvent.click(screen.getByTestId("doc-ok"));
    await waitFor(() => expect(window.location.pathname).toBe("/documents/" + encodeURIComponent("documents/k-a/Reading/alpha-fresh-notes.md")));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ALPHA fresh notes"));
    expect(bodies.find((b) => b.method === "POST" && b.url === "/workbench/documents")?.body).toEqual({ title: "ALPHA fresh notes", folder: "Reading" });
  });
});

describe("acceptance 1: clicking a title always opens the document screen", () => {
  it("open, Close, open again, then after a reload: the same title opens the document every time", async () => {
    await openDocs();
    const href = "/documents/" + encodeURIComponent("documents/k-a/Hardware/cpu.md");
    for (let i = 0; i < 3; i++) {
      const t = within(row("ALPHA Upgrading the CPU")).getByTestId("doc-title");
      expect(t.getAttribute("href")).toBe(href);
      fireEvent.click(t);
      expect(window.location.pathname).toBe(href);
      await waitFor(() => expect(edText()).toMatch(/ALPHA body of the CPU plan/));
      fireEvent.click(screen.getByTestId("doc-close")); // Close saves first (nothing changed here), then returns to Documents
      await waitFor(() => expect(window.location.pathname).toBe("/documents"));
      await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(3));
    }
    cleanup(); // a reload: a fresh App on the same URL
    resetState();
    await openDocs();
    fireEvent.click(within(row("ALPHA Upgrading the CPU")).getByTestId("act-open"));
    await waitFor(() => expect(edText()).toMatch(/ALPHA body/));
    cleanup(); // a reload ON the document's URL
    render(<App />);
    await waitFor(() => expect(edText()).toMatch(/ALPHA body/));
  });
  it("an active document opens in the writing surface (rwr-doc-editor) and becomes the Last document", async () => {
    window.history.pushState({}, "", "/documents/" + encodeURIComponent("documents/k-a/Stack/gateway.md"));
    render(<App />);
    await waitFor(() => expect(edText()).toBe("ALPHA gateway notes."));
    expect(screen.getByTestId("document").dataset.docState).toBe("active");
    await waitFor(() => expect(getLastDocument()?.id).toBe("documents/k-a/Stack/gateway.md"));
    await waitFor(() => expect(settings.get("ui.last_document")?.value).toBe("documents/k-a/Stack/gateway.md"));
  });
  it("the Last document slot follows a document that is archived, so its title still opens it", async () => {
    setLastDocument({ id: "documents/k-a/Stack/gateway.md", title: "ALPHA One gateway" });
    await openDocs();
    fireEvent.click(within(row("ALPHA One gateway")).getByTestId("act-archive"));
    await waitFor(() => expect(getLastDocument()?.id).toBe("documents/k-a/.archive/Stack/gateway.md"));
    fireEvent.click(screen.getByTestId("doc-slot"));
    await waitFor(() => expect(screen.getByTestId("document").dataset.docState).toBe("archived"));
  });
});

describe("acceptance 2: archived documents open read-only with an Unarchive button", () => {
  it("no input, text area or editable region; Unarchive returns it to its folder and opens it there", async () => {
    await openDocs();
    await tab("archived");
    fireEvent.click(within(row("ALPHA Old wiki plan")).getByTestId("doc-title"));
    await waitFor(() => expect(screen.getByTestId("doc-archived")).toBeTruthy());
    expect(screen.getByTestId("doc-body").textContent).toBe("ALPHA archived text.");
    expect(noEditable()).toBe(true);
    expect(screen.getByTestId("doc-body").isContentEditable).toBe(false);
    expect(bodies.some((b) => b.method !== "GET" && /\/documents\/file/.test(b.url))).toBe(false);
    fireEvent.click(screen.getByTestId("doc-unarchive"));
    await waitFor(() => expect(window.location.pathname).toBe("/documents/" + encodeURIComponent("documents/k-a/Stack/old-wiki.md")));
    await waitFor(() => expect(screen.getByTestId("document").dataset.docState).toBe("active"));
    expect(fake.db().docs.get("documents/k-a/Stack/old-wiki.md")!.history.length).toBe(2);
  });
});

describe("acceptance 3: trashed documents do not open until restored and say when they go", () => {
  it("in the list: no link, 'goes by itself in N days' from the 30-day rule", async () => {
    await openDocs();
    await tab("trash");
    const r = row("ALPHA CPU duplicate");
    expect(within(r).getByTestId("doc-title").tagName).toBe("SPAN");
    expect(r.querySelector("a")).toBeNull();
    expect(within(r).getByTestId("doc-when").textContent).toBe("2 days ago · goes by itself in 28 days");
    expect(daysLeft(new Date(NOW - 29.5 * 86400000).toISOString(), NOW)).toBe(1);
    expect(daysLeft(new Date(NOW - 31 * 86400000).toISOString(), NOW)).toBe(0);
    expect(goesText(new Date(NOW - 29 * 86400000).toISOString(), NOW)).toBe("goes by itself in 1 day");
    expect(goesText("", NOW)).toBe("goes by itself 30 days after it was trashed");
  });
  it("its URL does not open it: the text is never read; Restore brings it back to its folder and then it opens", async () => {
    window.history.pushState({}, "", "/documents/" + encodeURIComponent("documents/k-a/.trash/Hardware/dup.md"));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("doc-trashed").textContent).toMatch(/opens only after you restore it; it goes by itself in 28 days/));
    expect(screen.queryByTestId("doc-body")).toBeNull();
    expect(requestLog().some((r) => r.url.startsWith("/workbench/documents/file"))).toBe(false);
    expect(screen.getByTestId("main").textContent).not.toMatch(/ALPHA trashed text/);
    fireEvent.click(screen.getByTestId("doc-restore"));
    await waitFor(() => expect(edText()).toBe("ALPHA trashed text."));
    expect(window.location.pathname).toBe("/documents/" + encodeURIComponent("documents/k-a/Hardware/dup.md"));
  });
  it("Restore from the Trash tab puts it back in Active, in its folder", async () => {
    await openDocs();
    await tab("trash");
    fireEvent.click(within(row("ALPHA CPU duplicate")).getByTestId("act-restore"));
    await waitFor(() => expect(screen.queryByTestId("docs-empty")).toBeTruthy());
    await tab("active");
    expect([...row("ALPHA CPU duplicate").querySelectorAll("td")][1].textContent).toBe("Hardware");
  });
});

describe("acceptance 4: Delete forever needs the typed word and shows what is lost and what stays", () => {
  it("the button stays off until DELETE is typed exactly; nothing is sent before; the summary is there", async () => {
    await openDocs();
    await tab("trash");
    fireEvent.click(within(row("ALPHA CPU duplicate")).getByTestId("act-delete"));
    const ask = screen.getByTestId("delete-ask");
    expect(ask.textContent).toMatch(/Delete "ALPHA CPU duplicate" forever\?/);
    expect(within(ask).getByTestId("lost").textContent).toMatch(/text and every saved version/);
    expect(within(ask).getByTestId("stays").textContent).toMatch(/stay in the Library.*Removals and trail/);
    const ok = within(ask).getByTestId("typed-ok") as HTMLButtonElement;
    for (const w of ["", "delete", "DELET", "DELETE NOW", "Delete"]) {
      fireEvent.change(within(ask).getByTestId("typed-input"), { target: { value: w } });
      expect(ok.disabled, w).toBe(true);
      fireEvent.submit(ok.closest("form")!);
    }
    expect(bodies.some((b) => /delete-forever/.test(b.url))).toBe(false);
    fireEvent.change(within(ask).getByTestId("typed-input"), { target: { value: "DELETE" } });
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok);
    await waitFor(() => expect(screen.getByTestId("toast").textContent).toMatch(/Deleted forever: 1 document/));
    expect(bodies.filter((b) => /delete-forever/.test(b.url)).map((b) => b.body)).toEqual([{ path: "documents/k-a/.trash/Hardware/dup.md", confirm: true }]);
    expect(fake.db().docs.has("documents/k-a/.trash/Hardware/dup.md")).toBe(false);
    expect(screen.queryByTestId("toast-undo")).toBeNull();
    expect(fake.db().trail.map((t) => t.kind)).toEqual(["delete_forever"]);
  });
  it("Cancel leaves the document where it was", async () => {
    await openDocs();
    await tab("trash");
    fireEvent.click(within(row("ALPHA CPU duplicate")).getByTestId("act-delete"));
    fireEvent.click(screen.getByTestId("typed-cancel"));
    expect(screen.queryByTestId("delete-ask")).toBeNull();
    expect(fake.db().docs.has("documents/k-a/.trash/Hardware/dup.md")).toBe(true);
  });
});

describe("acceptance 5: Empty the trash needs a typed word and empties only the caller's trash", () => {
  it("typed DELETE, a body of {confirm: true} only, and bob's trash is untouched", async () => {
    fake.db().docs.set("documents/k-a/.trash/second.md", { owner: "u-alice", title: "ALPHA second", body: "", updated: new Date(NOW).toISOString(), links: [], history: [] });
    await openDocs();
    await tab("trash");
    expect(screen.queryByTestId("empty-trash")).toBeTruthy();
    fireEvent.click(screen.getByTestId("empty-trash"));
    const ask = screen.getByTestId("delete-ask");
    expect(ask.textContent).toMatch(/Empty the trash: delete 2 documents forever\?/);
    expect(within(ask).getByTestId("stays")).toBeTruthy();
    expect((within(ask).getByTestId("typed-ok") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(ask).getByTestId("typed-input"), { target: { value: "DELETE" } });
    fireEvent.click(within(ask).getByTestId("typed-ok"));
    await waitFor(() => expect(screen.getByTestId("toast").textContent).toMatch(/Deleted forever: 2 documents/));
    expect(bodies.filter((b) => /empty-trash/.test(b.url)).map((b) => b.body)).toEqual([{ confirm: true }]);
    expect(fake.db().docs.has("documents/k-b/.trash/bravo-old.md")).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("empty-trash")).toBeNull());
  });
});

describe("acceptance 6: Undo after archive or trash restores the previous state (folder and history)", () => {
  for (const [act0, kind] of [["act-archive", "archive"], ["act-trash", "trash"]] as const) {
    it(`${kind}, then Undo: back in Active, in its folder, with every history line`, async () => {
      await openDocs();
      const before = fake.db().docs.get("documents/k-a/Hardware/cpu.md")!;
      fireEvent.click(within(row("ALPHA Upgrading the CPU")).getByTestId(act0));
      await waitFor(() => expect(rows()).not.toContain("ALPHA Upgrading the CPU"));
      expect(screen.getByTestId("toast").textContent).toMatch(kind === "archive" ? /Archived "ALPHA Upgrading the CPU"/ : /to the trash/);
      fireEvent.click(screen.getByTestId("toast-undo"));
      await waitFor(() => expect(rows()).toContain("ALPHA Upgrading the CPU"));
      expect([...row("ALPHA Upgrading the CPU").querySelectorAll("td")][1].textContent).toBe("Hardware");
      const after = fake.db().docs.get("documents/k-a/Hardware/cpu.md")!;
      expect(after.history.slice(0, before.history.length)).toEqual(before.history);
      expect(after.history.length).toBe(before.history.length + 2);
      expect(after.links).toEqual(before.links);
      const back = bodies.filter((b) => b.method === "POST").map((b) => b.url);
      expect(back).toEqual(kind === "archive"
        ? ["/workbench/documents/archive", "/workbench/documents/unarchive"] : ["/workbench/documents/trash", "/workbench/documents/restore"]);
    });
  }
  it("Undo restores the Last document slot that a trash move cleared", async () => {
    setLastDocument({ id: "documents/k-a/Hardware/cpu.md", title: "ALPHA Upgrading the CPU" });
    await openDocs();
    fireEvent.click(within(row("ALPHA Upgrading the CPU")).getByTestId("act-trash"));
    await waitFor(() => expect(getLastDocument()).toBeNull());
    fireEvent.click(screen.getByTestId("toast-undo"));
    await waitFor(() => expect(getLastDocument()?.id).toBe("documents/k-a/Hardware/cpu.md"));
  });
});

describe("acceptance 7: two identities - bob never sees alice's documents, folders, counts or titles", () => {
  const A = /ALPHA|k-a|u-alice|Hardware|Stack|Recipes/;
  it("bob's Documents: only his rows, his folders, his counts; nothing of alice in the page", async () => {
    await openDocs();
    cleanup(); resetState(); who = "bob";
    await openDocs();
    expect(rows()).toEqual(["BRAVO plan"]);
    expect([screen.getByTestId("folder-all"), ...screen.getAllByTestId("folder")].map((b) => b.textContent)).toEqual(["All documents1", "Unfiled1"]);
    for (const t of ["active", "archived", "trash"] as const) {
      await tab(t);
      expect(document.body.innerHTML.match(A)?.[0] ?? null, t).toBeNull();
    }
  });
  it("alice's document opened by bob looks exactly like a missing one (same sentence, no detail)", async () => {
    who = "bob";
    const seen: string[] = [];
    for (const p of ["documents/k-a/Hardware/cpu.md", "documents/k-a/.trash/Hardware/dup.md", "documents/k-b/no-such.md"]) {
      cleanup(); resetState();
      window.history.pushState({}, "", "/documents/" + encodeURIComponent(p));
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("doc-gone")).toBeTruthy());
      seen.push(screen.getByTestId("main").innerHTML.replace(/documents%2F[^"]*/g, ""));
      expect(screen.getByTestId("doc-gone").textContent).toBe(NOT_FOUND);
      expect(screen.getByTestId("main").textContent).not.toMatch(/ALPHA/);
    }
    expect(new Set(seen).size).toBe(1);
  });
  it("a live switch from alice to bob on the Documents page drops alice's rows", async () => {
    await openDocs();
    expect(rows()).toContain("ALPHA Upgrading the CPU");
    // the screen is keyed by the subject: a different subject mounts a fresh list
    cleanup(); resetState(); who = "bob";
    window.history.pushState({}, "", "/documents");
    render(<App />);
    await waitFor(() => expect(rows()).toEqual(["BRAVO plan"]));
    expect(document.body.innerHTML).not.toMatch(/ALPHA/);
  });
});

describe("acceptance 8: nothing private is cached in the browser or put on a shared surface", () => {
  it("after a full round: no storage, cookie or console output; the page title names no document", async () => {
    const con = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m as "log"));
    await openDocs();
    fireEvent.click(within(row("ALPHA Upgrading the CPU")).getByTestId("doc-title"));
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toBeTruthy());
    expect(document.title).toBe("Document - Research workbench");
    act(() => navigate("/documents"));
    await waitFor(() => expect(screen.getAllByTestId("doc-row").length).toBe(3));
    expect(document.title).toBe("Documents - Research workbench");
    fireEvent.click(within(row("ALPHA One gateway")).getByTestId("act-archive"));
    await waitFor(() => expect(screen.getByTestId("toast")).toBeTruthy());
    expect(JSON.stringify({ ...window.localStorage })).toBe("{}");
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    for (const c of con) expect(c).not.toHaveBeenCalled();
    // only the account keys carry anything of the person, and only identifiers (never a title)
    for (const [, v] of settings) expect(JSON.stringify(v)).not.toMatch(/ALPHA/);
    // every request is a same-origin /workbench/* call through the one door, never cached
    expect(requestLog().every((r) => r.url.startsWith("/workbench/"))).toBe(true);
  });
  it("the screen's code reaches the back end only through lib/api.ts and keeps nothing in the browser", () => {
    for (const f of readdirSync("src/screens/documents")) {
      const src = readFileSync("src/screens/documents/" + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
    }
  });
  it("adds no search or list-search component (the one picker is components/picker)", () => {
    for (const f of readdirSync("src/screens/documents")) {
      const src = readFileSync("src/screens/documents/" + f, "utf8");
      expect(src, f).not.toMatch(/type="search"|role="search"|placeholder="(Filter|Search)|<select|<datalist/i);
    }
  });
});

describe("linked to", () => {
  it("counts links by kind in a fixed order", () => {
    expect(linkedText([{ kind: "idea", id: "1" }, { kind: "source", id: "a" }, { kind: "source", id: "b" }, { kind: "session", id: "r" }]))
      .toBe("2 sources · 1 idea · 1 research run");
    expect(linkedText([])).toBe("nothing yet");
    expect(linkedText([{ kind: "claim", id: "c" }])).toBe("1 claim");
  });
});

describe("a failed read says so, never an empty list", () => {
  it("a 500 on the listing shows 'Could not load' with Try again", async () => {
    setFetcher(async (u) => {
      if (u.startsWith("/workbench/contract/documents")) return new Response("{}", { status: 500 });
      if (u.startsWith("/workbench/workspace/whoami")) return new Response(JSON.stringify({ subject_sub: "u-alice", name: "a" }), { status: 200 });
      return new Response(JSON.stringify({ settings: [], folders: [""], root: "documents/k-a" }), { status: 200 });
    });
    window.history.pushState({}, "", "/documents");
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("docs-failed")).toBeTruthy());
    expect(screen.queryByTestId("docs-empty")).toBeNull();
  });
});
