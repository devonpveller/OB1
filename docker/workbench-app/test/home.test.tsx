// The Home screen (rwr-home): each card against its source read, empty states, every card title, the two-identity
// planted-data test, a failing read, nothing kept in the browser, and the ask box.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { App } from "../src/App";
import { setFetcher, requestLog, clearRequestLog } from "../src/lib/api";
import { resetState } from "../src/lib/state";
import { ago } from "../src/screens/home/home-data";
import { parseRoute } from "../src/lib/router";
import { matchRoute, type RouteDef } from "../src/routes";

type Id = "alice" | "bob" | "nobody" | "admin";
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
      { id: "s1", status: "running", query: "ALPHA which CPUs fit", can_act: true, mine: true, waiting_on: { kind: "branches", detail: "2 open branches" }, tree: [{}, {}, {}], created_at: iso(H), started_at: iso(H), finished_at: null },
      { id: "s2", status: "done", query: "ALPHA finished question", can_act: true, mine: true, waiting_on: { kind: "nothing", detail: "done" }, tree: [{}], created_at: iso(D), started_at: iso(D), finished_at: iso(5 * H) },
    ],
  },
  bob: {
    documents: [{ title: "BRAVO plan", path: "documents/bravo.md", updated: iso(H), outbound_links: [] }],
    ideas: [], episodes: [], requests: [],
    sessions: [{ id: "s9", status: "running", query: "BRAVO own question", can_act: true, mine: true, waiting_on: { kind: "stage", detail: "plan" }, tree: [{}], created_at: iso(H), started_at: iso(H), finished_at: null }],
  },
  nobody: { documents: [], ideas: [], episodes: [], requests: [], sessions: [] },
  admin: { documents: [], ideas: [], episodes: [], requests: [], sessions: [] },
} as const;

// The shared library: the same for every identity. The two library reads are the server's own (totals are exact
// over the whole library; the page is the limit). The default holds live-like volume: thousands of waiting claims.
const claimRow = (i: number) => ({ id: "k" + i, text: "Shared claim one source " + i, created_at: iso(i * H) });
const LIB0 = {
  recent: { days: 7, sources_total: 2, claims_total: 682, sources: [
    { id: "a", title: "Shared source first", url: "https://example.org/a", content_type: "web_article", created_at: iso(H) },
    { id: "b", title: "Shared source second", url: null, content_type: "pdf", created_at: iso(D) } ] },
  waiting: { total: 14292, claims: [1, 2, 3, 4, 5].map(claimRow) },
};
let LIB: typeof LIB0 = LIB0;
// Alice's running session as Bob's read returns it: another user's card has an empty question and can_act false.
// a service job an admin may act on: can_act true, question visible, but not the admin's own
const SERVICE = { id: "s7", status: "running", query: "SERVICE job text", can_act: true, mine: false, waiting_on: { kind: "stage", detail: "plan" }, tree: [{}], created_at: iso(H), started_at: iso(H), finished_at: null };
const FOREIGN = { id: "s1", status: "running", query: "", can_act: false, mine: false, waiting_on: { kind: "branches", detail: "2 open branches" }, tree: [{}, {}, {}], created_at: iso(H), started_at: iso(H), finished_at: null };

let who: Id = "alice";
let failing: string[] = [];
let malformed: string[] = []; // answers 200 with something that is not the expected JSON
let hanging: string[] = [];   // never answers
let seenInit: RequestInit[] = [];
function stub() {
  seenInit = [];
  setFetcher(async (u, init) => {
    seenInit.push(init ?? {});
    const path = u.split("?")[0];
    if (failing.some((f) => path.endsWith(f))) return new Response("{}", { status: 500 });
    if (malformed.some((f) => path.endsWith(f))) return new Response("<html>please sign in</html>", { status: 200 });
    if (hanging.some((f) => path.endsWith(f))) return new Promise<Response>(() => {});
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
      return j({ sessions: who === "bob" ? [...own, FOREIGN] : who === "nobody" ? [FOREIGN] : who === "admin" ? [{ ...FOREIGN, query: "ALPHA admin can read this", can_act: true }, SERVICE] : own });
    }
    if (path === "/workbench/contract/library/recent") return j(LIB.recent);
    if (path === "/workbench/contract/library/waiting-claims") return j(LIB.waiting);
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
  cleanup(); clearRequestLog(); resetState(); LIB = LIB0; who = "alice"; failing = []; malformed = []; hanging = [];
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  stub();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("each card lists the same items as its source read (acceptance 1)", () => {
  it("Continue writing: the document listing, newest edit first, with reference counts", async () => {
    await renderHome();
    expect(rowTitles("docs")).toEqual(["ALPHA newest draft", "ALPHA middle", "ALPHA older note"]);
    expect(within(card("docs")).getAllByTestId("row-doc")[0].textContent).toMatch(/edited 2 h ago · 2 references/);
    expect(within(card("docs")).getAllByTestId("row-doc")[0].getAttribute("href")).toBe("/documents/documents%2Falpha-new.md");
  });
  it("Continue writing: a trashed or archived document is never listed, only the active one", async () => {
    const keep = DB.alice.documents;
    (DB.alice as any).documents = [
      ...keep,
      { title: "ALPHA trashed", path: "documents/.trash/alpha-trashed.md", updated: iso(H), outbound_links: [] },
      { title: "ALPHA trashed in folder", path: "documents/notes/.trash/alpha-tf.md", updated: iso(H), outbound_links: [] },
      { title: "ALPHA archived", path: "documents/.archive/alpha-archived.md", updated: iso(H), outbound_links: [] },
      { title: "ALPHA archived in folder", path: "documents/notes/.archive/alpha-af.md", updated: iso(H), outbound_links: [] },
    ];
    try {
      await renderHome();
      expect(rowTitles("docs")).toEqual(["ALPHA newest draft", "ALPHA middle", "ALPHA older note"]);
    } finally { (DB.alice as any).documents = keep; }
  });
  it("Research: the subject's own sessions with their state", async () => {
    await renderHome();
    expect(rowTitles("research")).toEqual(["ALPHA which CPUs fit", "ALPHA finished question"]);
    const [a, b] = within(card("research")).getAllByTestId("row-session");
    expect(a.textContent).toMatch(/2 open branches/);
    expect(a.textContent).toMatch(/running/);
    expect(b.textContent).toMatch(/report ready/);
    expect(b.textContent).toMatch(/finished/);
  });
  it("Podcasts: episodes and requests still in flight (a request that became an episode is listed once)", async () => {
    await renderHome();
    expect(rowTitles("podcasts")).toEqual(["ALPHA digest episode", "ALPHA rendering now"]);
    const t = card("podcasts").textContent!;
    expect(t).toMatch(/rendering/);
    expect(t).toMatch(/yours · 14 min/);
  });
  it("Ideas: the subject's ideas", async () => {
    await renderHome();
    expect(rowTitles("ideas")).toEqual(["ALPHA pantry idea"]);
    expect(card("ideas").textContent).toMatch(/researched/);
  });
  it("the two library cards come from the server's totals: real titles, the exact number over the whole library", async () => {
    await renderHome();
    const n = screen.getByTestId("new-counts").textContent!;
    expect(n).toMatch(/2 new sources, 682 new claims/);
    expect(n).toMatch(/Shared source first/); expect(n).toMatch(/Shared source second/);
    const w = screen.getByTestId("claims-waiting").textContent!;
    expect(w).toMatch(/14292 claims backed by one source only/);
    expect(w).toMatch(/Shared claim one source 1/);
    expect(within(screen.getByTestId("claims-waiting")).queryAllByText(/Shared claim one source \d/)).toHaveLength(3);
    expect(w).not.toMatch(/14292\+/);
  });
  it("the library cards ask the server for the last seven days and a page of five (no client page of everything)", async () => {
    await renderHome();
    const urls = requestLog().map((r) => r.url);
    expect(urls).toContain("/workbench/contract/library/recent?days=7&limit=5");
    expect(urls).toContain("/workbench/contract/library/waiting-claims?limit=5");
    expect(urls.some((u) => u.startsWith("/workbench/contract/timeline") || u.startsWith("/workbench/contract/claims"))).toBe(false);
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
    LIB = { recent: { days: 7, sources_total: 0, claims_total: 0, sources: [] }, waiting: { total: 0, claims: [] } };
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
      LIB = LIB0;
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
      // a built screen (its route has a `screen`) shows itself, never the placeholder; the others their phase
      if ((matchRoute(path) as RouteDef).screen) expect(screen.queryByTestId("placeholder")).toBeNull();
      else expect(screen.getByTestId("coming")).toBeTruthy();
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
  it("a non-owner admin: every session comes back with can_act true and readable text, but Home lists none of them", async () => {
    who = "admin";
    await renderHome();
    expect(document.body.textContent).not.toMatch(/ALPHA|SERVICE/);
    expect(screen.getByTestId("empty-research")).toBeTruthy();
    expect(card("research").textContent).not.toMatch(/[0-9]/);
  });
  it("a card without the owner flag is not shown (no guess)", async () => {
    who = "alice";
    const own = DB.alice.sessions as unknown as any[];
    const saved = own.map((x) => x.mine);
    own.forEach((x) => delete x.mine);
    try { await renderHome(); expect(screen.getByTestId("empty-research")).toBeTruthy(); }
    finally { own.forEach((x, i) => (x.mine = saved[i])); }
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
    failing = ["/library/waiting-claims"];
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

describe("round 3 (tester attempt 1)", () => {
  it("F1: the shell's refresh shows another person: Home drops the previous person's cards and reads again for the new one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderHome();
    expect(document.body.textContent).toMatch(/ALPHA newest draft/);
    who = "bob";
    await vi.advanceTimersByTimeAsync(31000);
    await waitFor(() => expect(screen.getByTestId("avatar").getAttribute("aria-label")).toMatch(/bob/i));
    await waitFor(() => expect(screen.queryAllByText("Loading...").length).toBe(0));
    expect(document.body.textContent).not.toMatch(/ALPHA|alice/i);
    expect(rowTitles("docs")).toEqual(["BRAVO plan"]);
  });
  it("F1: no card is drawn until the subject is known", async () => {
    setFetcher(async (u) => (u.startsWith("/workbench/workspace/whoami") ? new Promise<Response>(() => {}) : new Response("{}", { status: 404 })));
    render(<App />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("card-docs")).toBeNull();
    expect(requestLog().some((r) => r.url.startsWith("/workbench/contract/documents"))).toBe(false);
  });
  it("F2: a document row (its path holds a slash) lands on the document screen, not No such screen", async () => {
    await renderHome();
    fireEvent.click(within(card("docs")).getAllByTestId("row-doc")[0]);
    expect(screen.queryByTestId("not-found")).toBeNull();
    expect(screen.getByTestId("document")).toBeTruthy();
    // and on a reload of that URL
    cleanup(); await renderHome();
    expect(screen.queryByTestId("not-found")).toBeNull();
  });
  it("F2: parseRoute splits first, then decodes each segment; a decode error is not found", () => {
    const r = parseRoute("/documents/documents%2Falpha-new.md");
    expect(r.segments).toEqual(["documents", "documents/alpha-new.md"]);
    expect(matchRoute(r.path)).not.toBeNull();
    expect((matchRoute(r.path) as any).path).toBe("/documents/:id");
    expect(parseRoute("/a%20b/c").segments).toEqual(["a b", "c"]);
    const bad = parseRoute("/documents/%E0%A4%A");
    expect(bad.bad).toBe(true);
  });
  it("F4: a 200 that is not the expected JSON shows Could not load on every card, never an empty state", async () => {
    malformed = ["/contract/documents", "/contract/sessions", "/contract/podcasts", "/contract/ideas", "/library/recent", "/library/waiting-claims"];
    await renderHome();
    for (const id of ["docs", "research", "podcasts", "ideas", "library", "claims"]) {
      expect(screen.getByTestId("failed-" + id), id).toBeTruthy();
      expect(screen.queryByTestId("empty-" + id), id).toBeNull();
    }
  });
  it("F4 (rwr-picker-r2 F1): the ask box shows its failed line for a 200 that is not the expected JSON, never 'nothing matches'", async () => {
    malformed = ["/contract/search"];
    await renderHome();
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "cpu" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(screen.getByTestId("ask-failed")).toBeTruthy());
    expect(screen.queryByTestId("ask-none")).toBeNull();
    expect(screen.queryAllByTestId("hit")).toHaveLength(0);
  });
  it("F6: a read that never answers becomes Could not load with Try again after the timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    hanging = ["/contract/ideas"];
    render(<App />);
    await waitFor(() => expect(rowTitles("docs")).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(21000);
    await waitFor(() => expect(screen.getByTestId("failed-ideas")).toBeTruthy());
    expect(rowTitles("docs")).toHaveLength(3);
    hanging = [];
    fireEvent.click(within(screen.getByTestId("failed-ideas")).getByText("Try again"));
    await waitFor(() => expect(rowTitles("ideas")).toHaveLength(1));
  });
  it("F7: a running session with open branches does not repeat the count", async () => {
    await renderHome();
    const a = within(card("research")).getAllByTestId("row-session")[0].textContent!;
    expect(a).toMatch(/2 open branches/);
    expect(a).not.toMatch(/\d+ branches?/);
  });
  it("F8: an own card whose question is null shows (untitled), not null", async () => {
    (DB.alice.sessions as unknown as any[])[0].query = null as any;
    try { await renderHome(); expect(rowTitles("research")[0]).toBe("(untitled)"); }
    finally { (DB.alice.sessions as unknown as any[])[0].query = "ALPHA which CPUs fit"; }
  });
  it("F9: ready episodes come first; requests older than seven days do not push them off", async () => {
    const old = Array.from({ length: 6 }, (_, i) => ({ id: "o" + i, team_id: "t", title: "OLD request " + i, state: "queued", episode_id: null, error: null, turns: 1, created_at: iso(10 * D), updated_at: iso(10 * D) }));
    const keep = DB.alice.requests;
    (DB.alice as any).requests = [...old, ...keep];
    try {
      await renderHome();
      expect(rowTitles("podcasts")).toEqual(["ALPHA digest episode", "ALPHA rendering now"]);
      expect(card("podcasts").textContent).not.toMatch(/OLD request/);
    } finally { (DB.alice as any).requests = keep; }
  });
  it("F3 (decision): another user's shared episode is listed, labelled shared, with no author", async () => {
    (DB.bob as any).episodes = [{ id: "e9", title: "Shared by someone", seconds: 60, shared: true, mine: false, created_at: iso(H) }];
    try {
      who = "bob"; await renderHome();
      const t = card("podcasts").textContent!;
      expect(t).toMatch(/Shared by someone/); expect(t).toMatch(/shared/); expect(t).not.toMatch(/alice|u-alice/i);
    } finally { (DB.bob as any).episodes = []; }
  });
  it("F5: .meta wraps long unbroken text", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/styles.css", "utf8")).toMatch(/\.meta\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

describe("round 5 (privacy lab attempt 3)", () => {
  it("F2: while whoami is still in flight Home says Checking, never Could not tell, even when other shell reads have answered", async () => {
    setFetcher(async (u) => {
      const p = u.split("?")[0];
      if (p === "/workbench/workspace/whoami") return new Promise<Response>(() => {});
      return new Response(JSON.stringify({ sessions: [], jobs: [], sources: [], total: 0, candidates: [] }), { status: 200 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("count-research")).toBeTruthy());
    expect(screen.getByTestId("home-waiting")).toBeTruthy();
    expect(screen.queryByTestId("home-failed")).toBeNull();
  });
});

describe("round 4 (review)", () => {
  it("1: a new-sources count with no source rows is still not the empty line; claims_total alone is news", async () => {
    LIB = { ...LIB0, recent: { days: 7, sources_total: 0, claims_total: 3, sources: [] } };
    await renderHome();
    expect(screen.queryByTestId("empty-library")).toBeNull();
    expect(screen.getByTestId("new-counts").textContent).toMatch(/0 new sources, 3 new claims/);
  });
  it("1: a server answer without the totals is a failed card, never the empty line", async () => {
    setFetcher(async (u) => {
      const p = u.split("?")[0];
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (p === "/workbench/workspace/whoami") return j({ subject_sub: "u-alice", name: "alice" });
      if (p === "/workbench/contract/library/recent") return j({ sources: [] });
      if (p === "/workbench/contract/library/waiting-claims") return j({ claims: [] });
      return new Response("{}", { status: 404 });
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("failed-library")).toBeTruthy());
    expect(screen.getByTestId("failed-claims")).toBeTruthy();
    expect(screen.queryByTestId("empty-library")).toBeNull();
    expect(screen.queryByTestId("empty-claims")).toBeNull();
  });
  it("2: the rail marks a slot whose id holds a slash as current on its own page", async () => {
    const { setLastDocument } = await import("../src/lib/state");
    setLastDocument({ id: "documents/alpha-new.md", title: "Slot doc" });
    window.history.pushState({}, "", "/documents/documents%2Falpha-new.md");
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("doc-slot").className).toMatch(/\bon\b/));
  });
  it("3: one failed whoami poll keeps Home (cards, ask text); only a different subject resets it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderHome();
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "typed words" } });
    const keep = rowTitles("docs");
    failing = ["/workspace/whoami"];
    const before = requestLog().filter((r) => r.url.includes("whoami")).length;
    await vi.advanceTimersByTimeAsync(31000);
    await waitFor(() => expect(requestLog().filter((r) => r.url.includes("whoami")).length).toBeGreaterThan(before));
    await act(async () => { await Promise.resolve(); });
    expect(rowTitles("docs")).toEqual(keep);
    expect((screen.getByTestId("ask-input") as HTMLInputElement).value).toBe("typed words");
    expect(screen.queryByTestId("home-waiting")).toBeNull();
    failing = []; who = "bob";
    await vi.advanceTimersByTimeAsync(31000);
    await waitFor(() => expect(rowTitles("docs")).toEqual(["BRAVO plan"]));
    expect((screen.getByTestId("ask-input") as HTMLInputElement).value).toBe("");
  });
  it("3: a subject never known: a plain failure with Try again, no card", async () => {
    failing = ["/workspace/whoami"];
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("home-failed")).toBeTruthy());
    expect(screen.getByTestId("home-failed").textContent).toMatch(/Try again/);
    expect(screen.queryByTestId("card-docs")).toBeNull();
  });
  it("4: the Research card asks for 200 sessions like the shell; capped with none of mine is not the empty line", async () => {
    const others = Array.from({ length: 200 }, (_, i) => ({ ...FOREIGN, id: "f" + i }));
    const mine = DB.alice.sessions as unknown as any[];
    const saved = mine.slice();
    mine.length = 0; mine.push(...others);
    try {
      await renderHome();
      expect(requestLog().some((r) => r.url === "/workbench/contract/sessions?state=recent&limit=200")).toBe(true);
      expect(screen.queryByTestId("empty-research")).toBeNull();
      expect(screen.getByTestId("capped-research").textContent).toMatch(/200/);
    } finally { mine.length = 0; mine.push(...saved); }
  });
  it("5: a document path that cannot be encoded makes that card Could not load, not a blank app", async () => {
    (DB.alice.documents as unknown as any[]).push({ title: "bad", path: "documents/\ud800.md", updated: iso(H), outbound_links: [] });
    try {
      await renderHome();
      expect(screen.getByTestId("failed-docs")).toBeTruthy();
      expect(screen.getByTestId("card-research")).toBeTruthy();
    } finally { (DB.alice.documents as unknown as any[]).pop(); }
  });
});
