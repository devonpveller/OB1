/**
 * kp-contract: a job with a contract never cites or uses a source outside it -
 * fetched, KB-recalled or reused - and every drop is recorded
 * (operator D11, PLAN-v2; security audit B11 / repro R5).
 *
 * Every seam is stubbed: no model, no DB, no search, no network
 * (`deno test --deny-net harness-contract.test.ts`). The assertion that matters
 * is on EVERY prompt the run sends: off-contract text must reach none of them
 * (the synthesizer, the coverage judge, the screen, the relevance gate).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runResearch, type Deps, type FetchResult, type QueryClient, type RunOptions, type SearchHit,
} from "./harness.ts";
import { resolveContract, type ResolvedContract } from "./contract.ts";
import { credibilityRows } from "./fixtures/credibility-seeds.ts";

const ON = "https://docs.python.org/3/library/asyncio-task.html";
const OFF = "https://evil.example.org/asyncio-howto";

interface Row { id: string; url: string | null; title: string; content: string }
interface World {
  /** public.sources rows KB recall returns (retrieveRelevantSources). */
  kb?: Row[];
  /** reusable claims and the ONE grounding source getReuseSources returns for each. */
  claims?: Array<{ id: string; text: string; source?: Row }>;
}

function stubClient(w: World, sqlLog: string[] = []): QueryClient {
  return {
    queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> {
      sqlLog.push(sql.replace(/\s+/g, " ").trim().slice(0, 60));
      const rows = (r: unknown[]) => Promise.resolve({ rows: r as T[] });
      // P3a: the run reads the credibility registries; answer with the migrations' seeds.
      const cred = credibilityRows(sql);
      if (cred) return rows(cred);
      if (/INSERT INTO public\.sessions/i.test(sql)) return rows([{ id: "00000000-0000-0000-0000-0000000000s1" }]);
      if (/FROM public\.claims c/i.test(sql)) {
        return rows((w.claims ?? []).map((c) => ({
          id: c.id, text: c.text, confidence: 0.9, contradicted: false, grounded: true, has_strong: true,
          researched_on: new Date().toISOString().slice(0, 10), volatility: "slow", revalidate_days: null,
          distance: "0.1",
        })));
      }
      if (/FROM public\.claim_sources cs\s+JOIN public\.sources s/i.test(sql)) {
        const ids = (args?.[0] as string[]) ?? [];
        return rows((w.claims ?? []).filter((c) => c.source && ids.includes(c.id)).map((c) => ({
          claim_id: c.id, id: c.source!.id, url: c.source!.url, title: c.source!.title,
          content: c.source!.content, domain: null,
        })));
      }
      if (/FROM public\.sources s\s+WHERE s\.embedding IS NOT NULL/i.test(sql)) {
        return rows((w.kb ?? []).map((s) => ({ ...s, domain: null, distance: "0.1" })));
      }
      return rows([]);
    },
  };
}

interface Seen { prompts: string[]; fetched: string[]; searched: string[] }

function stubDeps(o: {
  hits?: SearchHit[];
  page?: (url: string) => FetchResult;
} = {}): { deps: Deps; seen: Seen } {
  const seen: Seen = { prompts: [], fetched: [], searched: [] };
  const deps: Deps = {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys, user) => {
      // P3a: the entailment judge (D10) - these tests are about the contract, so every line holds.
      if (sys.includes("ENTAILMENT JUDGE")) return Promise.resolve(JSON.stringify({ verdict: "supports" }));
      seen.prompts.push(`${sys}\n${user}`);
      if (sys.includes("research planner")) return Promise.resolve(JSON.stringify({ needs: ["How does asyncio.TaskGroup cancel?"] }));
      if (sys.includes("web-search queries")) {
        return Promise.resolve(JSON.stringify({ entity: "asyncio", queries: ["asyncio TaskGroup cancellation"] }));
      }
      if (sys.includes("already covered by KNOWN CLAIMS")) return Promise.resolve(JSON.stringify({ covered: [], gaps: [0] }));
      if (sys.includes("GATHERED SOURCES")) return Promise.resolve(JSON.stringify({ covered: [0], open: [] }));
      if (sys.includes("research strategist")) return Promise.resolve(JSON.stringify({ queries: [] }));
      if (sys.includes("You screen a fetched web page")) return Promise.resolve("RELEVANT");
      if (sys.includes("You screen fetched web content")) return Promise.resolve("CLEAN");
      if (sys.includes("grounded synthesizer")) return Promise.resolve("[SOURCED] asyncio TaskGroup cancels siblings. [Source 1]");
      return Promise.resolve("{}");
    },
    searchWeb: (q: string) => {
      seen.searched.push(q);
      return Promise.resolve(o.hits ?? []);
    },
    fetchPage: (url: string): Promise<FetchResult> => {
      seen.fetched.push(url);
      return Promise.resolve(o.page ? o.page(url) : {
        page: { url, title: `page ${url}`, content: `asyncio TaskGroup content from ${url} `.repeat(40), domain: "x" },
        outcome: "ok",
      });
    },
    delegateToCurator: () => Promise.resolve({ thread_id: null, persist: {}, claims: {} }),
  };
  return { deps, seen };
}

const docsOnly = (): ResolvedContract => resolveContract({ contract: { sources: { allow: ["docs.python.org/3"] } } })!;
// deno-lint-ignore no-explicit-any
const drops = (r: unknown): any => (r as Record<string, unknown>).contractDrops;
const anyPromptHas = (seen: Seen, s: string) => seen.prompts.some((p) => p.includes(s));

// ── KB recall ────────────────────────────────────────────────────────────────
const KB: Row[] = [
  { id: "kb-on", url: ON, title: "asyncio tasks", content: "KB-ON-CONTRACT TaskGroup text ".repeat(20) },
  { id: "kb-off", url: OFF, title: "asyncio howto", content: "KB-OFF-CONTRACT poisoned text ".repeat(20) },
  { id: "kb-nourl", url: null, title: "a row with no url", content: "KB-NO-URL text ".repeat(20) },
];

Deno.test("KB recall (digest path): off-contract sources are dropped and recorded", async () => {
  const { deps, seen } = stubDeps();
  const r = await runResearch(deps, stubClient({ kb: KB }), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true, disableWebSearch: true, contract: docsOnly(),
  });
  assert(anyPromptHas(seen, "KB-ON-CONTRACT"), "the on-contract recall never reached the synthesizer");
  assert(!anyPromptHas(seen, "KB-OFF-CONTRACT"), "an off-contract KB recall reached a prompt");
  // the off-contract row and the url-less row (on no allow-list) are both recorded
  assertEquals(drops(r)?.counts?.kb_recall, 2);
  assertEquals(drops(r)?.items?.filter((d: { stage: string }) => d.stage === "kb_recall")
    .map((d: { url: string }) => d.url), [OFF, ""]);
  assert(r.citedSources.every((s) => s.url !== OFF));
});

Deno.test("KB recall (topic path): off-contract recalls never reach the screen, the gate or the synthesizer", async () => {
  const { deps, seen } = stubDeps();
  const r = await runResearch(deps, stubClient({ kb: KB }), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true, contract: docsOnly(),
  });
  assert(anyPromptHas(seen, "KB-ON-CONTRACT"));
  assert(!anyPromptHas(seen, "KB-OFF-CONTRACT"), "an off-contract KB recall reached a prompt");
  assertEquals(drops(r)?.counts?.kb_recall, 2);
});

// ── reused claims (the PLAN-v2 finding: reuse was never filtered) ────────────
const CLAIMS = [
  { id: "c-on", text: "CLAIM-ON asyncio.TaskGroup cancels the remaining tasks when one fails.",
    source: { id: "s-on", url: ON, title: "asyncio tasks", content: "REUSE-SRC-ON content ".repeat(20) } },
  { id: "c-off", text: "CLAIM-OFF asyncio.TaskGroup never cancels anything, use threads.",
    source: { id: "s-off", url: OFF, title: "howto", content: "REUSE-SRC-OFF content ".repeat(20) } },
  { id: "c-nosrc", text: "CLAIM-NOSRC a claim whose grounding source is gone." },
];

const PATHS: Array<[string, RunOptions]> = [
  ["topic path", {}],
  ["digest path", { disableWebSearch: true }],
  ["article path", { mode: "article", seedSources: [{ url: ON, title: "seed", content: "SEED asyncio ".repeat(20) }] }],
];
for (const [label, extra] of PATHS) {
  Deno.test(`reused claims (${label}): a claim grounded outside the contract and its source are dropped and recorded`, async () => {
    const { deps, seen } = stubDeps();
    const r = await runResearch(deps, stubClient({ claims: CLAIMS }), "How does asyncio.TaskGroup cancel?", {
      origin: "agent", dryRun: true, contract: docsOnly(), ...extra,
    });
    assert(!anyPromptHas(seen, "CLAIM-OFF"), "an off-contract reused claim reached a prompt");
    assert(!anyPromptHas(seen, "REUSE-SRC-OFF"), "an off-contract reuse source reached a prompt");
    assert(!anyPromptHas(seen, "CLAIM-NOSRC"), "a claim with no grounding source passed an allow-list contract");
    assert(anyPromptHas(seen, "CLAIM-ON"), "the on-contract reused claim was lost");
    assertEquals(r.reuseClaims.map((c) => c.id), ["c-on"]);
    assertEquals(drops(r)?.counts?.reuse, 2);
    const items = (drops(r)?.items ?? []).filter((d: { stage: string }) => d.stage === "reuse");
    assertEquals(items.map((d: { claim_id: string }) => d.claim_id).sort(), ["c-nosrc", "c-off"]);
  });
}

Deno.test("reused claims: a deny-only contract keeps a claim with no source url, drops a denied one", async () => {
  const { deps, seen } = stubDeps();
  const rc = resolveContract({ contract: { sources: { deny: ["evil.example.org"] } } })!;
  const r = await runResearch(deps, stubClient({ claims: CLAIMS }), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true, disableWebSearch: true, contract: rc,
  });
  assert(!anyPromptHas(seen, "CLAIM-OFF"));
  assert(anyPromptHas(seen, "CLAIM-NOSRC") && anyPromptHas(seen, "CLAIM-ON"));
  assertEquals(drops(r)?.counts?.reuse, 1);
});

// ── search hits, fetches, redirects ─────────────────────────────────────────
const HITS: SearchHit[] = [
  { url: ON, title: "asyncio TaskGroup docs", snippet: "asyncio TaskGroup cancellation" },
  { url: OFF, title: "asyncio TaskGroup howto", snippet: "asyncio TaskGroup cancellation" },
  { url: "https://docs.python.org/3/../2/library/asyncio.html", title: "asyncio TaskGroup trick", snippet: "asyncio TaskGroup" },
];

Deno.test("search hits outside the contract are never fetched and are recorded", async () => {
  const { deps, seen } = stubDeps({ hits: HITS });
  const r = await runResearch(deps, stubClient({}), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true, contract: docsOnly(),
  });
  assert(seen.fetched.length > 0 && seen.fetched.every((u) => u === ON), `fetched ${JSON.stringify(seen.fetched)}`);
  assert(drops(r)?.counts?.search >= 2, JSON.stringify(drops(r)));
});

Deno.test("a redirect is judged on its FINAL url: off-contract landing pages are dropped and recorded", async () => {
  const { deps, seen } = stubDeps({
    hits: [HITS[0]],
    page: (url) => ({
      page: { url, title: "landing", content: "REDIRECTED-CONTENT asyncio TaskGroup ".repeat(40), domain: "x" },
      outcome: "ok", finalUrl: OFF,
    } as FetchResult),
  });
  const r = await runResearch(deps, stubClient({}), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true, contract: docsOnly(),
  });
  assertEquals(seen.fetched, [ON]);
  assert(!anyPromptHas(seen, "REDIRECTED-CONTENT"), "an off-contract redirect target reached a prompt");
  assertEquals(drops(r)?.counts?.redirect, 1);
  assertEquals(drops(r)?.items?.find((d: { stage: string }) => d.stage === "redirect")?.url, OFF);
});

Deno.test("a redirect that stays inside the contract is kept", async () => {
  const { deps, seen } = stubDeps({
    hits: [HITS[0]],
    page: (url) => ({
      page: { url, title: "landing", content: "INSIDE-REDIRECT asyncio TaskGroup ".repeat(40), domain: "x" },
      outcome: "ok", finalUrl: "https://docs.python.org/3/library/asyncio.html",
    } as FetchResult),
  });
  const r = await runResearch(deps, stubClient({}), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true, contract: docsOnly(),
  });
  assert(anyPromptHas(seen, "INSIDE-REDIRECT"));
  assertEquals(drops(r)?.counts?.redirect ?? 0, 0);
});

// ── seeds: deny only (the allow-list does not apply to the caller's own subject) ──
Deno.test("seeds: a path-prefix deny drops the seed and records it; the allow-list does not", async () => {
  const { deps, seen } = stubDeps();
  const rc = resolveContract({ contract: { sources: { allow: ["docs.python.org"], deny: ["docs.python.org/2"] } } })!;
  const r = await runResearch(deps, stubClient({}), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true, sourcesOnly: true, contract: rc,
    seedSources: [
      { url: "https://docs.python.org/2/library/thread.html", title: "py2", content: "SEED-DENIED ".repeat(20) },
      { url: "https://blog.example.net/post", title: "blog", content: "SEED-OFF-ALLOW-KEPT ".repeat(20) },
    ],
  });
  assert(!anyPromptHas(seen, "SEED-DENIED"), "a denied seed reached a prompt");
  assert(anyPromptHas(seen, "SEED-OFF-ALLOW-KEPT"), "a seed was dropped by the allow-list (seeds are exempt)");
  assertEquals(drops(r)?.counts?.seed, 1);
});

// ── no contract / no source rule = today's behaviour ────────────────────────
Deno.test("no contract: nothing is filtered, nothing is recorded, no extra DB read", async () => {
  const a = stubDeps({ hits: HITS });
  const logA: string[] = [];
  const r = await runResearch(a.deps, stubClient({ kb: KB, claims: CLAIMS }, logA), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true,
  });
  assertEquals(drops(r), undefined);
  assert(anyPromptHas(a.seen, "KB-OFF-CONTRACT") && anyPromptHas(a.seen, "CLAIM-OFF"));
  // a budget-only contract has no source rule: the same reads, in the same order
  const b = stubDeps({ hits: HITS });
  const logB: string[] = [];
  await runResearch(b.deps, stubClient({ kb: KB, claims: CLAIMS }, logB), "How does asyncio.TaskGroup cancel?", {
    origin: "agent", dryRun: true, contract: resolveContract({ contract: { budget: { max_fetch: 24 } } })!,
  });
  assertEquals(logB, logA);
  assertEquals(b.seen.fetched, a.seen.fetched);
});
