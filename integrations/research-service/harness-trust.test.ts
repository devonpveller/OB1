/**
 * End-to-end replays of the two audited runs, with every seam mocked
 * (PLAN-research-trust Phases 1.2, 1.4, 1.5, 2.1, 2.2, 4.1-4.3).
 *
 * The artefact these replay (audit 2026-09-11, job ce398d06):
 *   search returned junk -> the relevance gate correctly rejected all 32 fetched
 *   pages -> months-old KB-recall pages about the DGX Spark were EXEMPT from the
 *   gate and became the entire cited pool -> the run reported backstop=complete,
 *   "coverage 22%", and handed the curator a synthesis whose first line said the
 *   sources contained nothing about the subject. That line is now a claim in the
 *   knowledge base at confidence 0.85.
 *
 * Everything here runs on mocked chat/search/fetch: no LLM call, no network.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runResearch, type Deps, type FetchResult, type QueryClient, type SearchHit } from "./harness.ts";

// ── A DB that answers every read with nothing, and hands out one session id ──
function stubClient(): QueryClient {
  return {
    // deno-lint-ignore no-explicit-any
    queryObject<T>(sql: string, _args?: unknown[]): Promise<{ rows: T[] }> {
      if (/INSERT INTO public\.sessions/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: "00000000-0000-0000-0000-000000000001" }] as unknown as T[] });
      }
      return Promise.resolve({ rows: [] as T[] });
    },
  };
}

type Fixture = { query: string; hits: Array<{ url: string; title: string; snippet: string }> };
const fx = (n: string): Fixture =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

const OPTIPLEX_QUERY =
  "Dell OptiPlex 3050 used purchase: common failure modes, known defects, red flags, " +
  "thermal issues, capacitor/CPU socket problems, how to verify hardware health";

const OPTIPLEX_NEEDS = [
  "What are the most common hardware failure modes and known defects reported for the Dell OptiPlex 3050?",
  "What specific thermal issues, capacitor failures, or CPU socket problems are associated with this model?",
  "How can a buyer verify the integrity of the BIOS and check for signs of tampering?",
];

/**
 * The three collapsed payloads, keyed by the query they were CAPTURED for. A
 * replay that serves a recorded response against some other query is not a
 * replay: the detector reads the query, so the pairing is the evidence.
 */
const COLLAPSED = ["search-collapsed-dell", "search-collapsed-most", "search-collapsed-the100"]
  .map((n) => fx(n));
const recordedHits = (q: string): SearchHit[] => {
  const f = COLLAPSED.find((c) => c.query === q);
  return (f ? f.hits : []) as SearchHit[];
};

/**
 * The audited run's own subject and the payload the live gateway returned for
 * it on 2026-09-11. Every round-1 query the harness builds carries this entity,
 * so serving THIS payload for them is faithful: the recorded collapse is what
 * the engine does to any query starting "Dell …" (audit, and
 * search-engine-alternatives-2026-09-11.md section 4, 15 variants at 0.00).
 */
const REPLAY_ENTITY = "Dell OptiPlex 3050";
const DELL_HITS = COLLAPSED[0].hits as SearchHit[];

interface MockOpts {
  hitsFor?: (q: string) => SearchHit[];
  /** Round-1 queries the KEYWORDIZE pass returns. */
  queries?: string[];
  /** Subject entity the KEYWORDIZE pass returns. */
  entity?: string;
  relevance?: (title: string) => boolean;
  pageContent?: (url: string) => string;
  synthesis?: string;
}

function mockDeps(o: MockOpts = {}) {
  const calls = { search: [] as string[], curator: 0, relevanceAsked: [] as string[], synth: 0 };
  const deps: Deps = {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys, user) => {
      if (sys.includes("research planner")) {
        return Promise.resolve(JSON.stringify({ needs: OPTIPLEX_NEEDS }));
      }
      if (sys.includes("web-search queries")) {
        // KEYWORDIZE — deliberately returns queries WITHOUT the entity, to prove
        // the harness enforces the entity constraint rather than trusting the model.
        return Promise.resolve(JSON.stringify({
          entity: o.entity ?? "OptiPlex 3050",
          queries: o.queries ??
            ["common hardware failure modes", "thermal capacitor socket", "bios integrity tampering"],
        }));
      }
      if (sys.includes("already covered by KNOWN CLAIMS")) {
        return Promise.resolve(JSON.stringify({ covered: [], gaps: [0, 1, 2] }));
      }
      if (sys.includes("GATHERED SOURCES")) {
        return Promise.resolve(JSON.stringify({ covered: [], open: [0, 1, 2] }));
      }
      if (sys.includes("research strategist")) {
        return Promise.resolve(JSON.stringify({ queries: [] }));
      }
      if (sys.includes("You screen a fetched web page")) {
        const m = user.match(/^TITLE: (.*)$/m);
        const title = m ? m[1] : "";
        calls.relevanceAsked.push(title);
        const ok = o.relevance ? o.relevance(title) : /optiplex/i.test(title);
        return Promise.resolve(ok ? "RELEVANT" : "IRRELEVANT");
      }
      if (sys.includes("grounded synthesizer")) {
        calls.synth++;
        return Promise.resolve(o.synthesis ??
          "[SOURCED] The OptiPlex 3050 uses an LGA 1151 socket. [Source 1]");
      }
      if (sys.includes("You choose the best REPORT TEMPLATE")) return Promise.resolve(JSON.stringify({ template: "general-report" }));
      if (sys.includes("Open Brain’s research writer") || sys.includes("research writer")) return Promise.resolve("# A rendered report\nBody.");
      if (sys.includes("You screen fetched web content")) return Promise.resolve("CLEAN");
      return Promise.resolve("{}");
    },
    searchWeb: (q: string) => {
      calls.search.push(q);
      return Promise.resolve(o.hitsFor ? o.hitsFor(q) : recordedHits(q));
    },
    fetchPage: (url: string): Promise<FetchResult> =>
      Promise.resolve({
        page: {
          url, title: url.replace(/^https?:\/\//, "").slice(0, 60),
          content: o.pageContent ? o.pageContent(url) : "x".repeat(1200),
          domain: "example.com",
        },
        outcome: "ok",
      }),
    delegateToCurator: (pkg) => {
      calls.curator++;
      return Promise.resolve({ thread_id: pkg.thread_id, persist: {}, claims: {} });
    },
  };
  return { deps, calls };
}

// ── Phase 1.2 ───────────────────────────────────────────────────────────────
Deno.test("round-1 queries are keywords carrying the subject entity, never the raw need", async () => {
  const { deps, calls } = mockDeps();
  await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui", dryRun: true });
  assert(calls.search.length > 0, "no search was run");
  const round1 = calls.search.slice(0, 3);
  for (const q of round1) {
    assertStringIncludes(q.toLowerCase(), "optiplex 3050");
    assert(q.split(/\s+/).length <= 10, `too long: ${q}`);
    assert(!OPTIPLEX_NEEDS.includes(q), `round-1 used the raw need verbatim: ${q}`);
  }
});

// ── Phase 1.1 wiring + 1.4 ──────────────────────────────────────────────────
Deno.test("a collapsed result set is counted as a SEARCH failure and yields no pages", async () => {
  const { deps } = mockDeps({ entity: REPLAY_ENTITY, hitsFor: () => DELL_HITS });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui", dryRun: true });
  assert(r.fetchStats.search.collapsed > 0, "collapse was not counted");
  assertEquals(r.fetchStats.search.ok, 0);
  assertEquals(r.fetchStats.sources, 0, "a collapsed set must not be fetched");
});

Deno.test("a search that returns junk forever ends search_degraded, not complete", async () => {
  const { deps, calls } = mockDeps({ entity: REPLAY_ENTITY, hitsFor: () => DELL_HITS });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui", dryRun: true });
  assertEquals(r.backstop, "search_degraded");
  assert(calls.search.length <= 6,
    `wasted ${calls.search.length} calls after the streak began`);
});

Deno.test("a search that returns GOOD pages stops at the yield target, not at round 3", async () => {
  const good = fx("search-good-optiplex").hits;
  const { deps, calls } = mockDeps({
    hitsFor: () => good as SearchHit[],
    relevance: () => true,
  });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui", dryRun: true });
  assert(r.backstop !== "search_degraded", `backstop=${r.backstop}`);
  assert(r.fetchStats.search.ok > 0, "a good set must be counted ok");
  assert(calls.search.length <= 6, `kept searching: ${calls.search.length}`);
});

// ── Phase 1.5 ───────────────────────────────────────────────────────────────
Deno.test("many hits, almost nothing readable -> fetch_degraded", async () => {
  const many: SearchHit[] = Array.from({ length: 25 }, (_, i) => ({
    url: `https://optiplex-parts.example.org/p/${i}`,
    title: `Dell OptiPlex 3050 part ${i}`,
    snippet: "optiplex 3050 capacitor failure socket",
  }));
  const { deps } = mockDeps({
    hitsFor: () => many,
    relevance: () => true,
    // 3 of 25 have a readable extract; the rest are near-empty shells.
    pageContent: (url) => (/\/p\/[012]$/.test(url) ? "y".repeat(1500) : "tiny"),
  });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui", dryRun: true });
  assertEquals(r.backstop, "fetch_degraded");
  assert(r.fetchStats.readable <= 3, `readable=${r.fetchStats.readable}`);
});

// ── Phase 2.1 + 2.2 — the OptiPlex replay ───────────────────────────────────
Deno.test("REPLAY ce398d06: recall pages are gated too, so the pool is empty", async () => {
  // The KB recall is what made the audited run look like it had sources. The
  // stub client returns none, so this asserts the weaker, load-bearing half:
  // nothing survives a collapsed search, and no off-topic page is exempt.
  const { deps, calls } = mockDeps({ entity: REPLAY_ENTITY, hitsFor: () => DELL_HITS, relevance: (t) => /optiplex/i.test(t) });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui" });
  assertEquals(r.citedSources.length, 0);
  assertEquals(calls.curator, 0, "the curator must not be called with nothing");
});

Deno.test("REPLAY ce398d06: outcome is no_relevant_sources and the curator is SKIPPED", async () => {
  const { deps, calls } = mockDeps({ entity: REPLAY_ENTITY, hitsFor: () => DELL_HITS });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui" });
  assertEquals(r.outcome, "no_relevant_sources");
  assertEquals(calls.curator, 0);
  assertEquals(calls.synth, 0, "nothing to synthesize from — do not ask the model");
  assertStringIncludes(r.prose, "search failure, not evidence of absence");
});

Deno.test("REPLAY ce398d06: a 'complete' run citing 0 relevant sources is impossible", async () => {
  const { deps } = mockDeps({ entity: REPLAY_ENTITY, hitsFor: () => DELL_HITS });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui" });
  assert(!(r.backstop === "complete" && r.citedSources.length === 0),
    `backstop=${r.backstop} cited=${r.citedSources.length}`);
});

Deno.test("REPLAY ce398d06: the report never prints 'coverage 22%' or an absence headline", async () => {
  const { deps } = mockDeps({ entity: REPLAY_ENTITY, hitsFor: () => DELL_HITS });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui" });
  assert(!/coverage \d+%/.test(r.prose), r.prose.slice(0, 200));
  assert(!/absence of evidence/i.test(r.prose), r.prose.slice(0, 200));
  assert(!/what the sources actually cover/i.test(r.prose), r.prose.slice(0, 200));
  assertStringIncludes(r.prose, "needs answered 0 of");
  assertEquals(r.reportType, "", "a zero-finding run must not be given a topic template");
});

// ── Phase 4.1 ───────────────────────────────────────────────────────────────
Deno.test("every need carries a status; a need whose searches all collapsed is search_failed", async () => {
  const { deps } = mockDeps({ entity: REPLAY_ENTITY, hitsFor: () => DELL_HITS });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui", dryRun: true });
  assertEquals(r.needsStatus.length, OPTIPLEX_NEEDS.length);
  assert(r.needsStatus.every((n) => n.status === "search_failed"),
    JSON.stringify(r.needsStatus));
  assertEquals(r.searchRecord.relevant, 0);
  assert(r.searchRecord.queries.length > 0);
  assert(r.searchRecord.queries.every((q) => q.verdict === "collapsed"));
});

// ── Phase 2.3 wiring ────────────────────────────────────────────────────────
Deno.test("a synthesized figure no cited source holds is downgraded in the run's own output", async () => {
  const good = fx("search-good-optiplex").hits;
  const { deps } = mockDeps({
    hitsFor: () => good as SearchHit[],
    relevance: () => true,
    pageContent: () => "The OptiPlex 3050 uses an LGA 1151 socket and a 240 W power supply.",
    synthesis: "[SOURCED] The board throttles at 95 °C. [Source 1]\n" +
               "[SOURCED] It uses an LGA 1151 socket. [Source 1]",
  });
  const r = await runResearch(deps, stubClient(), OPTIPLEX_QUERY, { origin: "owui", dryRun: true });
  const lines = r.synthesis.split("\n");
  const hot = lines.find((l) => l.includes("95")) || "";
  assert(hot.startsWith("[UNCERTAIN]"), `not downgraded: ${hot}`);
  assertStringIncludes(hot, "unverified figure");
  assert((r.ungroundedNumbers || []).length > 0);
  const socket = lines.find((l) => l.includes("1151")) || "";
  assert(socket.startsWith("[SOURCED]"), `wrongly downgraded: ${socket}`);
});

// ── Regression: the paths this must NOT change ──────────────────────────────
Deno.test("sources-only mode still grounds strictly from the caller's seeds", async () => {
  const { deps, calls } = mockDeps({
    synthesis: "[SOURCED] The article says the launch slipped to March. [Source 1]",
  });
  const r = await runResearch(deps, stubClient(), "what does this article say?", {
    origin: "open_notebook",
    sourcesOnly: true,
    dryRun: true,
    seedSources: [{ url: "https://example.org/a", title: "The article", content: "The launch slipped to March." }],
  });
  assertEquals(calls.search.length, 0, "sources-only must not search");
  assertEquals(r.citedSources.length, 1);
  assert(r.outcome !== "no_relevant_sources");
});

Deno.test("article mode still stages the seed article and is never gated away", async () => {
  const { deps, calls } = mockDeps({
    synthesis: "[SOURCED] The piece argues the model is smaller than claimed. [Source 1]",
  });
  const r = await runResearch(deps, stubClient(), "episode about this article", {
    origin: "owui",
    mode: "article",
    dryRun: true,
    seedSources: [{ url: "https://news.example.org/x", title: "A newsletter item", content: "The model is smaller than claimed." }],
  });
  assertEquals(calls.search.length, 0);
  assertEquals(r.citedSources.length, 1);
  assertEquals(r.outcome, "complete");
});
