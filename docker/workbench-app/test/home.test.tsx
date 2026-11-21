// The Home screen (rwr-home): each card against its source read, empty states, every card title, the two-identity
// planted-data test, a failing read, nothing kept in the browser, and the ask box.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { App } from "../src/App";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { ago } from "../src/screens/home/home-data";

type Id = "alice" | "bob" | "nobody";
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3600 * 1000, D = 24 * H;

// What the stub back end holds. Alice's and Bob's items carry their own marker so a leak is a string match.
const DB = {
  alice: {
    documents: [
      { title: "ALPHA older note", path: "documents/alpha-old.md", updated: iso(3 * D), outbound_links: [] },
      { title: "ALPHA newest draft", path: "documents/alpha-new.md", updated: iso(2 * H), outbound_links: [{ kind: "source" }, { kind: "source" }] },
      { title: "ALPHA middle", path: "documents/alpha-mid.md", updated: iso(D), outbound_links: [{ kind: "source" }] },
    ],
    ideas: [{ id: "i1", title: "ALPHA pantry idea", status: "researched", updated_at: iso(D) }],
    episodes: [{ id: "e1", title: "ALPHA digest episode", team_id: "t", audio_format: "mp3", seconds: 840, shared: false, mine: true, created_at: iso(H) }],
    requests: [
      { id: "r1", team_id: "t", title: "ALPHA rendering now", state: "rendering", episode_id: null, error: null, turns: 3, created_at: iso(H), updated_at: iso(H) },
      { id: "r2", team_id: "t", title: "ALPHA digest episode", state: "done", episode_id: "e1", error: null, turns: 3, created_at: iso(H), updated_at: iso(H) },
    ],
    sessions: [
      { id: "s1", status: "running", query: "ALPHA which CPUs fit", can_act: true, waiting_on: { kind: "branches", detail: "2 open branches" }, tree: [{}, {}, {}], created_at: iso(H), started_at: iso(H), finished_at: null },
      { id: "s2", status: "done", query: "ALPHA finished question", can_act: true, waiting_on: { kind: "nothing", detail: "done" }, tree: [{}], created_at: iso(D), started_at: iso(D), finished_at: iso(5 * H) },
    ],
  },
  bob: {
    documents: [{ title: "BRAVO plan", path: "documents/bravo.md", updated: iso(H), outbound_links: [] }],
    ideas: [], episodes: [], requests: [],
    sessions: [{ id: "s9", status: "running", query: "BRAVO own question", can_act: true, waiting_on: { kind: "stage", detail: "plan" }, tree: [{}], created_at: iso(H), started_at: iso(H), finished_at: null }],
  },
  nobody: { documents: [], ideas: [], episodes: [], requests: [], sessions: [] },
} as const;

// The shared library: the same for every identity.
const LIB = {
  timeline: [
    { at: iso(D), kind: "source_revision", ref: "a@1", summary: "revision 1 by original", source_id: "a", lifecycle: "active" },
    { at: iso(D), kind: "source_revision", ref: "a@2", summary: "revision 2 by operator", source_id: "a", lifecycle: "active" },
    { at: iso(D), kind: "source_revision", ref: "b@1", summary: "revision 1 by original", source_id: "b", lifecycle: "active" },
    { at: iso(D), kind: "source_revision", ref: "c@1", summary: "revision 1 by original", source_id: "c", lifecycle: "suppressed" },
    { at: iso(D), kind: "claim_created", ref: "k1", summary: "a claim", source_id: null, lifecycle: null },
    { at: iso(D), kind: "session_started", ref: "s", summary: "", source_id: null, lifecycle: null },
  ],
  claims: [
    { id: "k1", text: "Shared claim one source", status: "active", corroborations: 0, contradicted: false, contradicted_by_newer: false, sources: [{ source_id: "a", lifecycle: "active", edge_type: "states" }] },
    { id: "k2", text: "Shared claim corroborated", status: "active", corroborations: 1, contradicted: false, contradicted_by_newer: false, sources: [{ source_id: "a", lifecycle: "active", edge_type: "states" }, { source_id: "b", lifecycle: "active", edge_type: "corroborates" }] },
    { id: "k3", text: "Shared claim one suppressed source", status: "active", corroborations: 0, contradicted: false, contradicted_by_newer: false, sources: [{ source_id: "a", lifecycle: "suppressed", edge_type: "states" }] },
    { id: "k4", text: "Shared claim contradicted", status: "active", corroborations: 0, contradicted: true, contradicted_by_newer: false, sources: [{ source_id: "a", lifecycle: "active", edge_type: "states" }] },
  ],
};
// Alice's running session as Bob's read returns it: another user's card has an empty question and can_act false.
const FOREIGN = { id: "s1", status: "running", query: "", can_act: false, waiting_on: { kind: "branches", detail: "2 open branches" }, tree: [{}, {}, {}], created_at: iso(H), started_at: iso(H), finished_at: null };

let who: Id = "alice";
let failing: string[] = [];
let seenInit: RequestInit[] = [];
function stub() {
  seenInit = [];
  setFetcher(async (u, init) => {
    seenInit.push(init ?? {});
    const path = u.split("?")[0];
    if (failing.some((f) => path.endsWith(f))) return new Response("{}", { status: 500 });
    const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    const me = DB[who];
    if (path === "/workbench/workspace/whoami") return j({ subject_sub: "u-" + who, actor_sub: "u-" + who, name: who });
    if (path === "/workbench/auth/me") return j({ mode: "forward-auth" });
    if (path === "/workbench/contract/documents") return j({ documents: me.documents });
    if (path === "/workbench/contract/ideas") return j({ ideas: me.ideas });
    if (path === "/workbench/contract/podcasts") return j({ podcasts: me.episodes });
    if (path === "/workbench/contract/podcasts/requests") return j({ requests: me.requests });
    if (path === "/workbench/contract/sessions") {
      const own = me.sessions as readonly unknown[];
      return j({ sessions: who === "bob" ? [...own, FOREIGN] : who === "nobody" ? [FOREIGN] : own });
    }
    if (path === "/workbench/contract/timeline") return j({ events: LIB.timeline });
    if (path === "/workbench/contract/claims") return j({ count: LIB.claims.length, claims: LIB.claims });
    if (path === "/workbench/contract/search") {
      const q = new URL(u, "http://x").searchParams.get("q");
      if (q === "zzzz") return j({ results: [] });
      return j({ results: [{ kind: "source", id: "a", title: "Shared source about " + q, snippet: "text with <<HL>>" + q + "<</HL>> in it" }] });
    }
    return new Response("{}", { status: 404 });
  });
}

const renderHome = async () => {
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll('[data-testid^="loading-"]').length).toBe(0));
  await waitFor(() => expect(screen.queryAllByText("Loading...").length).toBe(0));
};
const card = (id: string) => screen.getByTestId("card-" + id);
const rowTitles = (id: string) => within(card(id)).queryAllByTestId(/^row-/).map((r) => r.querySelector(".row-title")!.textContent);

beforeEach(() => {
  cleanup(); clearRequestLog(); resetState(); who = "alice"; failing = [];
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => vi.restoreAllMocks());

describe("each card lists the same items as its source read (acceptance 1)", () => {
  it("Continue writing: the document listing, newest edit first, with reference counts", async () => {
    await renderHome();
    expect(rowTitles("docs")).toEqual(["ALPHA newest draft", "ALPHA middle", "ALPHA older note"]);
    expect(within(card("docs")).getAllByTestId("row-doc")[0].textContent).toMatch(/edited 2 h ago · 2 references/);
    expect(within(card("docs")).getAllByTestId("row-doc")[0].getAttribute("href")).toBe("/documents/documents%2Falpha-new.md");
  });
  it("Research: the subject's own sessions with their state", async () => {
    await renderHome();
    expect(rowTitles("research")).toEqual(["ALPHA which CPUs fit", "ALPHA finished question"]);
    const [a, b] = within(card("research")).getAllByTestId("row-session");
    expect(a.textContent).toMatch(/2 branches · 2 open branches/);
    expect(a.textContent).toMatch(/running/);
    expect(b.textContent).toMatch(/report ready/);
    expect(b.textContent).toMatch(/finished/);
  });
  it("Podcasts: episodes and requests still in flight (a request that became an episode is listed once)", async () => {
    await renderHome();
    expect(rowTitles("podcasts")).toEqual(["ALPHA rendering now", "ALPHA digest episode"]);
    const t = card("podcasts").textContent!;
    expect(t).toMatch(/rendering/);
    expect(t).toMatch(/yours · 14 min/);
  });
  it("Ideas: the subject's ideas", async () => {
    await renderHome();
    expect(rowTitles("ideas")).toEqual(["ALPHA pantry idea"]);
    expect(card("ideas").textContent).toMatch(/researched/);
  });
  it("the two library cards: this week's new sources and claims, and claims backed by one active source only", async () => {
    await renderHome();
    // sources a and b have a revision 1 in the window; c is suppressed; a's revision 2 is not new
    expect(screen.getByTestId("new-counts").textContent).toMatch(/2 new sources, 1 new claim/);
    const w = screen.getByTestId("claims-waiting").textContent!;
    expect(w).toMatch(/1 claim backed by one source only/);
    expect(w).toMatch(/Shared claim one source/);
    expect(w).not.toMatch(/corroborated|suppressed source|contradicted/);
  });
  it("the library card asks the timeline for the last seven days", async () => {
    await renderHome();
    const u = requestLog().find((r) => r.url.startsWith("/workbench/contract/timeline"))!.url;
    const from = Date.parse(decodeURIComponent(new URL(u, "http://x").searchParams.get("from")!));
    expect(Math.abs(NOW - 7 * D - from)).toBeLessThan(60_000);
  });
  it("a card lists at most five rows; its title opens the rest", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: "i" + i, title: "ALPHA idea " + i, status: "new", updated_at: iso(i * H) }));
    (DB.alice as any).ideas = many;
    try { await renderHome(); expect(rowTitles("ideas")).toHaveLength(5); }
    finally { (DB.alice as any).ideas = [{ id: "i1", title: "ALPHA pantry idea", status: "researched", updated_at: iso(D) }]; }
  });
});

describe("a card with nothing in it shows a one-line empty state with its action (acceptance 2)", () => {
  it("every card, for a subject with nothing", async () => {
    who = "nobody";
    (LIB as any).savedT = LIB.timeline.slice(); (LIB as any).savedC = LIB.claims.slice(); LIB.timeline.length = 0; LIB.claims.length = 0;
    try {
      await renderHome();
      const want: [string, RegExp, string][] = [
        ["docs", /You have no documents yet\./, "/documents"], ["research", /No research running or finished lately\./, "/research/start"],
        ["podcasts", /No episodes yet\./, "/podcasts"], ["ideas", /No ideas captured yet\./, "/ideas"],
        ["library", /Nothing new in the library this week\./, "/library"], ["claims", /No claim waits for a second source\./, "/library"],
      ];
      for (const [id, text, to] of want) {
        const el = screen.getByTestId("empty-" + id);
        expect(el.textContent).toMatch(text);
        expect(el.querySelector("a")!.getAttribute("href")).toBe(to);
        expect(el.textContent!.split("\n")).toHaveLength(1);
      }
    } finally {
      LIB.timeline.push(...(LIB as any).savedT); LIB.claims.push(...(LIB as any).savedC);
    }
  });
});

describe("every card title opens the right screen (acceptance 4)", () => {
  const titles: [string, string][] = [
    ["title-docs", "/documents"], ["title-research", "/research"], ["title-podcasts", "/podcasts"], ["title-ideas", "/ideas"],
    ["title-library", "/library"], ["title-claims", "/library"],
  ];
  for (const [t, path] of titles) {
    it(`${t} opens ${path}, which shows its heading or its coming-in-phase state`, async () => {
      await renderHome();
      fireEvent.click(screen.getByTestId(t));
      expect(window.location.pathname).toBe(path);
      expect(screen.getByTestId("coming")).toBeTruthy();
    });
  }
  it("Start research, and a row, open their screens", async () => {
    await renderHome();
    fireEvent.click(screen.getByText("Start research", { selector: "a" }));
    expect(window.location.pathname).toBe("/research/start");
    window.history.pushState({}, "", "/");
    cleanup(); await renderHome();
    fireEvent.click(within(card("docs")).getAllByTestId("row-doc")[0]);
    expect(window.location.pathname).toBe("/documents/documents%2Falpha-new.md");
  });
});

describe("two identities, planted data (acceptance 3)", () => {
  const A = /ALPHA|u-alice|alice/i;
  it("Bob's Home shows none of Alice's items, counts or hints, though the sessions read returns her card", async () => {
    who = "bob";
    await renderHome();
    const text = document.body.textContent!;
    expect(text).not.toMatch(A);
    expect(rowTitles("docs")).toEqual(["BRAVO plan"]);
    // Alice's running session came back from the read (blank question, can_act false): it is neither listed nor counted
    expect(rowTitles("research")).toEqual(["BRAVO own question"]);
    expect(card("research").textContent).not.toMatch(/3 branches|2 open branches|2 running/);
    expect(screen.getByTestId("empty-ideas")).toBeTruthy();
    expect(screen.getByTestId("empty-podcasts")).toBeTruthy();
    expect(within(card("research")).getAllByTestId("row-session")).toHaveLength(1);
  });
  it("Bob after Alice in the same browser: Alice's text is gone and nothing of hers is kept", async () => {
    await renderHome();
    expect(document.body.textContent).toMatch(/ALPHA/);
    cleanup(); who = "bob";
    await renderHome();
    expect(document.body.textContent).not.toMatch(A);
  });
  it("a subject with nothing sees Alice's session neither as a row nor as a count", async () => {
    who = "nobody";
    await renderHome();
    expect(screen.getByTestId("empty-research")).toBeTruthy();
    expect(card("research").textContent).not.toMatch(/[0-9]/);
  });
});

describe("a failing read blanks one card, never the screen", () => {
  it("podcasts fail: the card says so and retries; the others still load", async () => {
    failing = ["/contract/podcasts/requests"];
    await renderHome();
    expect(screen.getByTestId("failed-podcasts").textContent).toMatch(/Could not load this card/);
    expect(rowTitles("docs")).toHaveLength(3);
    expect(rowTitles("ideas")).toHaveLength(1);
    failing = [];
    fireEvent.click(within(screen.getByTestId("failed-podcasts")).getByText("Try again"));
    await waitFor(() => expect(rowTitles("podcasts")).toHaveLength(2));
  });
  it("the claims read fails: no invented number", async () => {
    failing = ["/contract/claims"];
    await renderHome();
    expect(screen.getByTestId("failed-claims")).toBeTruthy();
    expect(screen.queryByTestId("claims-waiting")).toBeNull();
    expect(screen.getByTestId("new-counts")).toBeTruthy();
  });
});

describe("nothing private is kept or shared (acceptance 6)", () => {
  it("storage, cookies, the Cache API and the console stay clean; reads are GET only, same door, no person in a URL, never cached", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await renderHome();
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "alpha secret question" } });
    fireEvent.click(screen.getByTestId("ask-go"));
    await waitFor(() => expect(screen.getAllByTestId("hit").length).toBe(1));
    expect(JSON.stringify({ ...window.localStorage })).toBe("{}");
    expect(JSON.stringify({ ...window.sessionStorage })).toBe("{}");
    expect(document.cookie).toBe("");
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true);
    expect(seenInit.every((i) => i.cache === "no-store" && (i.method ?? "GET") === "GET")).toBe(true);
    const log = requestLog();
    expect(log.every((r) => r.method === "GET" && r.url.startsWith("/workbench/"))).toBe(true);
    expect(log.some((r) => /alice|bob|u-|subject|owner/i.test(r.url.replace(/alpha secret question/g, "")))).toBe(false);
    // no history entry or title carries the question
    expect(window.location.search).toBe("");
    expect(document.title).not.toMatch(/alpha/i);
  });
  it("the source holds no storage, cookie, cache, indexedDB or console call", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const f of readdirSync("src/screens/home")) {
      const s = readFileSync("src/screens/home/" + f, "utf8").split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join(" "); // code, not comments
      expect(s, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|console\.|fetch\(|XMLHttpRequest|sendBeacon/);
    }
  });
});

describe("the ask box runs a search (phase 0)", () => {
  it("needs two characters; asks contract/search; lists the hits without highlight markers; a hit opens the Library", async () => {
    await renderHome();
    const go = screen.getByTestId("ask-go") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "cpu" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(screen.getAllByTestId("hit")).toHaveLength(1));
    const hit = screen.getByTestId("hit");
    expect(hit.textContent).toMatch(/Shared source about cpu/);
    expect(hit.textContent).toMatch(/text with cpu in it/);
    expect(hit.textContent).not.toMatch(/<<|HL/);
    expect(requestLog().some((r) => r.url === "/workbench/contract/search?q=cpu&limit=10")).toBe(true);
    fireEvent.click(hit);
    expect(window.location.pathname).toBe("/library");
  });
  it("says so when nothing matches, and when the search fails", async () => {
    await renderHome();
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "zzzz" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(screen.getByTestId("ask-none").textContent).toMatch(/Nothing in the library matches "zzzz"/));
    failing = ["/contract/search"];
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "cpu" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(screen.getByTestId("ask-failed")).toBeTruthy());
  });
  it("is labelled, and the page has one h1", async () => {
    await renderHome();
    expect(screen.getByLabelText(/Search the library/)).toBe(screen.getByTestId("ask-input"));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("ago()", () => {
  it("reads plainly", () => {
    const n = Date.parse("2026-11-20T12:00:00Z");
    expect(ago("2026-11-20T11:59:50Z", n)).toBe("just now");
    expect(ago("2026-11-20T11:30:00Z", n)).toBe("30 min ago");
    expect(ago("2026-11-20T10:00:00Z", n)).toBe("2 h ago");
    expect(ago("2026-11-19T12:00:00Z", n)).toBe("yesterday");
    expect(ago("2026-11-17T12:00:00Z", n)).toBe("3 days ago");
    expect(ago("", n)).toBe("");
  });
});
