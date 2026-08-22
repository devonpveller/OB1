/**
 * The research harness (Research Engine P4) — pure orchestration over injected
 * seams + a DB client. NO server, NO global side effects: importable by tests.
 * index.ts wires the real seams (llama-cpp / SearXNG / fetch / curator) and the
 * HTTP + job layer around `runResearch`.
 *
 * Governing specs: GROUNDING-MODEL.md + PLAN-research-engine.md §6 + OD-5/OD-6.
 */
import { domainOf, decideReuse, backstopDecision, reuseMetric, buildCitedAndRenumber } from "./lib.ts";
import { retrieveRelevantClaims, retrieveRelevantSources, createStagingSession, stageSource, existingFreshSource, getReuseSources } from "./kb.ts";
import { INJECTION_GUARD, screenSources } from "./injection.ts";
import { rankHits, partitionRelevant } from "./filtering.ts";
import { classifyTemplate, renderSys } from "./templates.ts";
import { deniedUrl, clampCeiling, type ResolvedContract } from "./contract.ts";
import { SKEPTIC_SYS, parseSkepticResult, applyDowngrades, type SkepticResult } from "./skeptic.ts";

// Tunables (env-read; reading env does not start a server).
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const SEARCH_K = parseInt(env("SEARCH_K", "8"), 10);
const CLAIM_SHORTLIST_K = parseInt(env("CLAIM_SHORTLIST_K", "12"), 10);
const CONFIDENCE_FLOOR = parseFloat(env("CONFIDENCE_FLOOR", "0.50"));
const FETCH_CONCURRENCY = parseInt(env("FETCH_CONCURRENCY", "4"), 10);
// MAX_FETCH = the source-YIELD budget: how many pages we actually RETRIEVE
// (successful fetches). It is NOT charged for timeouts or cache reuse anymore.
const MAX_FETCH = parseInt(env("MAX_FETCH", "24"), 10);
// MAX_FETCH_TIMEOUTS = a SEPARATE ceiling on wasted attempts that time out (a
// flaky Tor circuit). Stops a run that is burning wall-time on dead fetches
// without yielding sources, and surfaces "max_timeouts" as a distinct stop
// reason so the operator knows it was the network, not the source budget. Set
// 0 to disable the ceiling (only MAX_FETCH / wall-time then bound the run).
const MAX_FETCH_TIMEOUTS = parseInt(env("MAX_FETCH_TIMEOUTS", "20"), 10);
const MAX_WALL_MS = parseInt(env("MAX_WALL_MS", "180000"), 10);
const EMBEDDING_MAX_CHARS = parseInt(env("EMBEDDING_MAX_CHARS", "4000"), 10);
// KB-source recall (REPO-SOURCES-WIRING §6): how many stored sources to fold into the pool
// per run, and how semantically close they must be (cosine distance; 0 = identical). The
// distance default MATCHES the proven claim-reuse bar (REUSE_MAX_DISTANCE) so recall is never
// LOOSER than existing reuse semantics — a shared-service change must not shift relevance for
// the other consumers (OWUI deep_research, digest, podcast, ON). K=0 disables recall entirely.
const KB_SOURCES_K = parseInt(env("KB_SOURCES_K", "6"), 10);
const KB_SOURCES_MAX_DISTANCE = parseFloat(env("KB_SOURCES_MAX_DISTANCE", "0.55"));
// #5 — drop claims farther than this (cosine distance) from the query so an
// unscoped run doesn't reuse irrelevant grounded claims.
const REUSE_MAX_DISTANCE = parseFloat(env("REUSE_MAX_DISTANCE", "0.55"));
// #1 — iterative deepening: up to this many gather rounds, refining queries from
// what was found until the needs are covered or the backstop trips.
const MAX_ROUNDS = parseInt(env("MAX_ROUNDS", "3"), 10);
// Article mode — PRELIMINARY gap research bounds. A gap the article + OB claims
// can't resolve gets a SMALL, clearly-tentative web look (not full research).
const PRELIM_MAX_FETCH = parseInt(env("PRELIM_MAX_FETCH", "6"), 10);
const PRELIM_GAP_LIMIT = parseInt(env("PRELIM_GAP_LIMIT", "3"), 10);
// Article mode — how much of the seed article/body to feed the synthesis. A
// newsletter-body roundup (many news items + tools) exceeds the default
// gather-source slice, so the primary article gets a larger window.
const ARTICLE_SOURCE_CHARS = parseInt(env("ARTICLE_SOURCE_CHARS", "8000"), 10);
// Phase 2 — Skeptic defensive gate. Ships DARK: default off, so the OFF path is
// byte-identical to today. When on, the judge-only tier runs (downgrade weak/
// refuted claims + record the audit). The drop-and-replace re-gather tier (pool
// mutation + re-synthesis) is deferred to on-site validation and NOT in this
// build; SKEPTIC_REGATHER_MAX is reserved for it.
const SKEPTIC_ENABLED = env("SKEPTIC_ENABLED", "0") === "1";

// ── Seams (injectable for tests) ────────────────────────────────────────────
export interface SearchHit { url: string; title: string; snippet: string; }
export interface Page { url: string; title: string; content: string; domain: string; }
// A fetch attempt's outcome — distinguishes a retrieved source from a timeout
// (flaky Tor) from any other failure. `page` is non-null only when outcome="ok".
export type FetchOutcome = "ok" | "timeout" | "error";
export interface FetchResult { page: Page | null; outcome: FetchOutcome; }
export interface Deps {
  embed(text: string): Promise<number[]>;
  chat(system: string, user: string, opts?: { json?: boolean; nothink?: boolean }): Promise<string>;
  searchWeb(query: string, k: number): Promise<SearchHit[]>;
  fetchPage(url: string): Promise<FetchResult>;
  delegateToCurator(pkg: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface QueryClient { queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>; }

// ── Bounded-parallel map ─────────────────────────────────────────────────────
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

// ── Prompts ──────────────────────────────────────────────────────────────────
const DECOMPOSE_SYS =
  `You are a research planner. Given a QUESTION, list the key sub-questions / facts that must be answered to give a complete, grounded answer. Return ONLY JSON: {"needs": ["...", "..."]}. 3-7 concise needs, each a single factual sub-question.`;
const COVERAGE_SYS =
  `You decide which research NEEDS are already covered by KNOWN CLAIMS. A need is "covered" only if a known claim directly answers it. Return ONLY JSON: {"covered": [need_index,...], "gaps": [need_index,...]}. Indices refer to the NEEDS list (0-based). When unsure, mark it a gap (never assume coverage).`;
const COVERAGE_STAGED_SYS =
  `You judge whether each NEED is now answered by the GATHERED SOURCES (titles + excerpts). A need is "covered" only if a source actually answers it. Return ONLY JSON: {"covered": [need_index,...], "open": [need_index,...]} (0-based indices into the NEEDS list). When unsure, mark it open.`;
const DEEPEN_SYS =
  `You are a research strategist. Some NEEDS are still unanswered after the searches so far. For each still-open need, propose ONE more specific search query that would find the missing information (use specifics/terms surfaced by what was already found). Return ONLY JSON: {"queries": ["...", ...]} — at most one per open need, concise web-search queries.`;

const SYNTH_SYS =
  `You are Open Brain's grounded synthesizer. Write a thorough answer to the QUESTION using ONLY the KNOWN CLAIMS and SOURCES provided.

OUTPUT FORMAT — STRICT. Write the answer as a list, ONE claim per line. Each line MUST begin with its tag and end with its citation, in this exact shape:
  [SOURCED] <a single assertion>. [Source 2]
  [INFERRED] <a single assertion>. [Source 1, 3]
Tags:
  [SOURCED]  — a source directly states it; cite the source(s)
  [INFERRED] — reasoned from one or more sources; cite them
  [UNCERTAIN]— weakly supported; cite what you have
  [GAP]      — a needed fact NO source supports. State the gap on its own line; do NOT fill it from your own knowledge and do NOT cite a source.
Use comma-separated numbers for multiple sources: [Source 1, 2, 4] (NOT "[Source 1, Source 2]"). Put the tag at the START of the line and the citation at the END. One assertion per line.

ABSOLUTE RULES: never invent a fact, number, name, URL, or quote that no source supports — if unsupported, it is a [GAP]. Do not cite a source number that is not in the SOURCES list. A [SOURCED]/[INFERRED]/[UNCERTAIN] line WITHOUT a [Source N] citation is invalid — either cite it or make it a [GAP]. Be specific.`;

// Article-primary synthesis: the episode is ABOUT the seed article. Present the
// article's own substance first; use already-grounded OB claims only as
// supporting context. (Seed-only / disable_web_search flows — the digest podcast.)
const ARTICLE_SYNTH_SYS =
  `You are Open Brain's grounded synthesizer preparing material for a short podcast ABOUT a specific article. The article is provided in SOURCES as [Source 1] (there may be more). The article is the SUBJECT of the episode — present its own substance.

OUTPUT FORMAT — STRICT. ONE claim per line. Each line begins with its tag and ends with its citation:
  [SOURCED] <an assertion the article makes>. [Source 1]
  [INFERRED] <an assertion reasoned from the article, optionally relating it to prior knowledge>. [Source 1]
Tags: [SOURCED] the article states it; [INFERRED] reasoned from the article; [UNCERTAIN] the article only hints at it; [GAP] a fact the article clearly leaves open (state it on its own line, NO citation, do NOT fill from your own knowledge).

WRITE IN THIS ORDER:
1. OVERVIEW — 1-2 [SOURCED] lines stating what the article is about / its central thesis.
2. KEY POINTS — the article's substantive points of interest, each its own [SOURCED]/[INFERRED] line citing the article.
3. CONTEXT — the KNOWN CLAIMS provided below are already-grounded Open Brain knowledge. Where one corroborates or extends a point the article makes, add an [INFERRED] line drawing that connection, citing [Source 1] (the article is what the episode is about). If a known claim notably diverges from the article, you MAY add ONE [UNCERTAIN] "worth noting" line — but keep the focus on the article, not the disagreement.

ABSOLUTE RULES: never invent a fact, number, name, URL, or quote the article does not support — if unsupported it is a [GAP]. The article is PRIMARY; prior knowledge is supporting context only. A [SOURCED]/[INFERRED]/[UNCERTAIN] line WITHOUT a [Source N] citation is invalid. Be specific.`;

// Pass 2 of article mode: PRELIMINARY follow-up on the gaps the article left open.
// Findings here are explicitly tentative and lower-confidence than the article.
const PRELIM_GAP_SYNTH_SYS =
  `You are doing PRELIMINARY follow-up research on open questions a specific article left unanswered, for a podcast segment. You are given the OPEN GAPS and some preliminary web SOURCES numbered from [Source 2] ([Source 1] is the original article, already covered — do NOT cite it here).

For each gap the SOURCES actually address, write ONE line, explicitly tentative:
  [UNCERTAIN] Preliminary research suggests <tentative finding>. [Source 2]
Cite the web source(s) that support it (N >= 2). If the SOURCES do not address a gap, restate it as still open:
  [GAP] <the still-open question>

ABSOLUTE RULES: these are PRELIMINARY, lower-confidence findings from OUTSIDE the article — never present them as settled fact, and always phrase them as "preliminary research suggests…". Never invent: an unsupported tentative claim is a [GAP], not an [UNCERTAIN]. One item per line. Every [UNCERTAIN] line must end with a [Source N] citation (N >= 2).`;

// Readable-prose pass: turns the grounded one-claim-per-line answer into a
// human-readable synthesis WITHOUT losing grounding — every [Source N] citation
// is preserved verbatim so the wiki's source-leaf deep-links still resolve. The
// tagged synthesis stays the machine-truth (it's what the curator decomposes
// into claims); this prose is the human-facing rendering stored alongside it.
const PROSE_SYS =
  `You are Open Brain's research writer. You are given a QUESTION and a GROUNDED ANSWER — a list of verified assertions, each tagged [SOURCED]/[INFERRED]/[UNCERTAIN] and ending with its citation [Source N], plus [GAP] lines for points no source covered.

Rewrite it into a clear, readable Markdown synthesis that answers the QUESTION for a human reader.

RULES:
- Open with a direct answer, then supporting detail. Use ## section headers and short paragraphs or bullet lists where natural.
- PRESERVE every citation: keep each fact's [Source N] marker inline, using the SAME numbers (e.g. "The official repo is github.com/anthropics/skills [Source 1]."). Never renumber or drop a citation.
- Introduce NO fact, number, name, URL, or quote that is not in the grounded answer. If it is not supported there, do not write it.
- Drop the [SOURCED]/[INFERRED]/[UNCERTAIN] tags themselves — convey that nuance in prose ("directly reports…", "this suggests…") but keep the [Source N] citations.
- End with a short "## Gaps" section listing the [GAP] items as open questions (no citations). Omit the section entirely if there are no gaps.
- Be faithful and complete — cover every claim — but readable. Do not add a preamble like "Here is the synthesis"; start with the answer.`;

// ── Public types ─────────────────────────────────────────────────────────────
/** A pre-fetched source the caller supplies to be staged directly (not searched/fetched). */
export interface SeedSource { url: string; title: string; content: string; }
export interface RunOptions {
  threadId?: string | null;
  origin?: string;
  confidenceFloor?: number;
  /** Pre-fetched sources to stage directly (e.g. a newsletter article). */
  seedSources?: SeedSource[];
  /** Skip the web-search gap-gather entirely; corroborate only from reused OB claims. */
  disableWebSearch?: boolean;
  /** STRICTLY the provided seed_sources: skip web search AND the brain-wide claim
   *  reuse pass — answer only from the linked sources. For ON "ask-a-source": if the
   *  sources fall short, the result's [GAP]s let the caller suggest a wider research
   *  query in another round. Implies disableWebSearch. */
  sourcesOnly?: boolean;
  /** "article" → article-primary synthesis prompt (podcast-about-the-article). */
  mode?: "default" | "article";
  /**
   * Article mode only. How to treat gaps the article + OB claims can't resolve:
   *   "none"        — surface them as open POIs, no web research (pure seed-only).
   *   "preliminary" — a BOUNDED, clearly-tentative web look at the open gaps,
   *                   written as low-confidence "preliminary research suggests…".
   * Default "none". Ignored when disableWebSearch is set.
   */
  gapResearch?: "none" | "preliminary";
  /** Run the harness (recall + synthesis) but write NOTHING canonical — no
   *  staging, no curator delegate. Returns the synthesis for preview. */
  dryRun?: boolean;
  /** Phase 1 — resolved per-job contract (narrowing-only). When present, clamps
   *  the gather budget and drops denied seed sources; source allow/deny + red-line
   *  query enforcement is applied by index.ts at the deps boundary. */
  contract?: ResolvedContract;
}
export interface RunResult {
  synthesis: string;
  /** Human-facing report rendering of `synthesis` (same [Source N] citations),
   *  structured by the classified report template (templates.ts). */
  prose: string;
  /** Which report template rendered `prose` (templates.ts id; "" if skipped). */
  reportType: string;
  needs: string[];
  /** Refined/deepened queries generated across gather rounds (breadcrumbs). */
  followupQueries: string[];
  gaps: string[];
  reuseClaims: { id: string; text: string }[];
  citedSources: { url: string | null; title: string }[];
  metrics: ReturnType<typeof reuseMetric>;
  curator: Record<string, unknown> | null;
  backstop: string;
  /** Separated fetch accounting — yield (sources) vs waste (timeouts/errors) vs
   *  free OB cache reuse. `attempts` = sources + timeouts + errors. */
  fetchStats: { sources: number; timeouts: number; errors: number; reused: number; attempts: number };
  /** Phase 2 — the Skeptic's verdict + per-run audit (undefined when SKEPTIC_ENABLED off). */
  skeptic?: SkepticResult;
}
export type Progress = (phase: string, message: string, counters?: Record<string, number>) => Promise<void>;

async function jsonChat(deps: Deps, sys: string, user: string): Promise<Record<string, unknown>> {
  const raw = await deps.chat(sys, user, { json: true, nothink: true });
  try { return JSON.parse(raw); } catch { return {}; }
}

function firstParagraph(s: string): string {
  const stripped = s.replace(/^#+\s.*$/gm, "").trim();
  return (stripped.split(/\n\s*\n/)[0] || stripped).replace(/\s+/g, " ").trim();
}
async function sha1(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * Run one research effort. Reuse → gap analysis → gap-only staging →
 * verbatim grounded synthesis → cited-only → delegate to curator. Honest gaps
 * on backstop, never fabrication (OD-6 / GROUNDING-MODEL rule #7).
 */
export async function runResearch(
  deps: Deps,
  client: QueryClient,
  query: string,
  opts: RunOptions = {},
  progress: Progress = async () => {},
): Promise<RunResult> {
  const t0 = Date.now();
  const floor = opts.confidenceFloor ?? CONFIDENCE_FLOOR;
  const threadId = opts.threadId ?? null;
  const now = new Date();

  const seeds = opts.seedSources ?? [];
  const articleMode = opts.mode === "article";
  const sourcesOnly = opts.sourcesOnly === true;
  const skipSearch = opts.disableWebSearch === true || sourcesOnly; // sources-only ⇒ no web
  const gapResearch = opts.gapResearch ?? "none";
  const dryRun = opts.dryRun === true;

  // Phase 1 — a per-job contract can only NARROW the service ceilings, never
  // raise them. Absent contract ⇒ Math.min(X, Infinity) = X (today's behavior).
  const rcBudget = opts.contract?.budget;
  const effMaxFetch = clampCeiling(MAX_FETCH, rcBudget?.maxFetch);
  const effMaxMs = clampCeiling(MAX_WALL_MS, rcBudget?.wallMs);
  const effRounds = clampCeiling(MAX_ROUNDS, rcBudget?.rounds);

  // 1. Reuse pass — recall relevant grounded claims (cheap). In article mode the
  //    recall is against the ARTICLE itself (its points are what we want to
  //    corroborate from existing OB knowledge), not a short query string.
  await progress("reuse", sourcesOnly ? "sources-only: skipping KB claim reuse" : "recalling grounded claims from the KB");
  const recallText = articleMode && seeds.length
    ? `${seeds[0].title}\n\n${seeds[0].content}`
    : query;
  const queryEmb = await deps.embed(recallText);
  // sources-only ⇒ no brain-wide reuse; ground strictly from the seed_sources.
  const relevant = sourcesOnly
    ? []
    : await retrieveRelevantClaims(client, queryEmb, threadId, CLAIM_SHORTLIST_K, REUSE_MAX_DISTANCE);
  const reuseClaims = relevant.filter((c) => decideReuse(c, floor, now) === "reuse");

  // Seed sources (e.g. a newsletter article the caller already fetched through
  // Tor) are staged directly — never re-fetched. In article mode they are THE
  // subject of the episode.
  const sessionId = dryRun ? null : await createStagingSession(client, query, threadId, opts.origin || "owui");
  // Seeds are exempt from the contract's allow-list (in article mode the seed IS
  // the subject) but are still dropped if they hit a deny domain / red-line host.
  // Pages staged before web gathering (seeds + KB recalls) are exempt from the
  // relevance gate below; everything after this index came from the open web.
  let protectedCount = 0;
  const staged: Page[] = seeds
    .filter((s) => !opts.contract || !deniedUrl(opts.contract, s.url))
    .map((s) => ({
      url: s.url, title: s.title, content: s.content, domain: domainOf(s.url),
    }));
  // Separate fetch accounting (was a single conflated `fetches`):
  //   sourcesFetched — pages successfully RETRIEVED over the network (the yield)
  //   fetchTimeouts  — attempts that timed out (flaky Tor) — wasted, not yield
  //   fetchErrors    — non-OK / non-HTML / empty / network errors
  //   reuseHits      — OB cache hits (free; not a network fetch, not budget-charged)
  let sourcesFetched = 0;
  let fetchTimeouts = 0;
  let fetchErrors = 0;
  let reuseHits = 0;
  let backstop = "complete";
  let needs: string[] = [query];
  let gapNeeds: string[] = [];
  const followupQueries: string[] = []; // refined/deepen queries across rounds (breadcrumbs)

  // KB-SOURCE recall (REPO-SOURCES-WIRING §6): durable primary sources already in OB — e.g.
  // repo docs synced via /sources/repo-sync — can answer repo-specific questions web search
  // can never surface. Fold them into the staged pool BEFORE any web gathering so coverage
  // sees them; they were injection-screened at sync time and are re-screened with the pool
  // below anyway (defense in depth). Never in sources-only/article mode (those ground
  // strictly from the caller's seeds/article).
  if (!sourcesOnly && !articleMode) {
    try {
      const kbSources = await retrieveRelevantSources(
        client, queryEmb, KB_SOURCES_K, KB_SOURCES_MAX_DISTANCE);
      for (const s of kbSources) {
        if (s.url && !staged.some((p) => p.url === s.url)) {
          staged.push({ url: s.url, title: s.title, content: s.content,
                        domain: s.domain || domainOf(s.url) });
          reuseHits++;
        }
      }
      if (kbSources.length) {
        await progress("reuse", `recalled ${kbSources.length} KB source(s) into the pool`,
          { kb_sources: kbSources.length });
      }
    } catch { /* best-effort — store recall must never break research */ }
  }

  // 2/3. Plan → coverage → gap-gather (the DEFAULT topic-research path). Article
  //      mode never runs this — it grounds the seed article first and only then
  //      does bounded preliminary gap research (handled at synthesis). Also
  //      skipped when the caller disables web search.
  if (!articleMode && !skipSearch) {
    await progress("plan", "decomposing the question into needs");
    const decomp = await jsonChat(deps, DECOMPOSE_SYS, `QUESTION: ${query}`);
    needs = Array.isArray(decomp.needs) && decomp.needs.length
      ? decomp.needs.map(String).slice(0, 7) : [query];

    gapNeeds = needs;
    if (reuseClaims.length && needs.length) {
      const cov = await jsonChat(
        deps, COVERAGE_SYS,
        `NEEDS:\n${needs.map((n, i) => `${i}. ${n}`).join("\n")}\n\nKNOWN CLAIMS:\n${reuseClaims.map((c) => `- ${c.text}`).join("\n")}`,
      );
      const gapIdx = new Set<number>(Array.isArray(cov.gaps) ? cov.gaps.map(Number) : needs.map((_, i) => i));
      gapNeeds = needs.filter((_, i) => gapIdx.has(i));
    }
    await progress("plan", `needs=${needs.length} reused=${reuseClaims.length} gaps=${gapNeeds.length}`,
      { needs: needs.length, reused: reuseClaims.length, gaps: gapNeeds.length });
    protectedCount = staged.length; // seeds + KB recalls staged so far are exempt from the relevance gate

    // ITERATIVE deepening (#1): gather a round, re-check which needs the gathered
    // sources actually cover, refine queries for the still-open needs, gather
    // again — up to MAX_ROUNDS or the backstop.
    const gatherQueries = async (queries: string[]): Promise<boolean> => {
      for (const q of queries) {
        const d = backstopDecision({
          elapsedMs: Date.now() - t0, maxMs: effMaxMs,
          sources: sourcesFetched, maxSources: effMaxFetch,
          timeouts: fetchTimeouts, maxTimeouts: MAX_FETCH_TIMEOUTS, openGaps: 1,
        });
        if (d.stop && d.reason !== "complete") { backstop = d.reason; return false; }
        await progress("gather", `searching: ${q}`);
        let hits: SearchHit[] = [];
        try { hits = await deps.searchWeb(q, SEARCH_K); } catch { hits = []; }
        // Credibility-ranked: scholarly/reference domains first, retail last
        // (filtering.ts). The engine's own order breaks ties within a tier.
        hits = rankHits(hits);
        const fresh = hits.filter((h) => !staged.some((s) => s.url === h.url));
        // Headroom = remaining SOURCE budget plus remaining TIMEOUT budget, so we
        // keep trying URLs while either bound has room (a timeout shouldn't burn
        // the source budget). Cache hits below are free and never charged.
        const sourceRoom = Math.max(0, effMaxFetch - sourcesFetched);
        const timeoutRoom = MAX_FETCH_TIMEOUTS > 0 ? Math.max(0, MAX_FETCH_TIMEOUTS - fetchTimeouts) : SEARCH_K;
        const toFetch = fresh.slice(0, Math.max(0, Math.min(SEARCH_K, sourceRoom + timeoutRoom)));
        const results = await mapLimit(toFetch, FETCH_CONCURRENCY, async (h) => {
          const existing = await existingFreshSource(client, h.url).catch(() => null);
          if (existing) {
            return { outcome: "reuse" as const, page: { url: h.url, title: existing.title, content: existing.content, domain: domainOf(h.url) } as Page };
          }
          const fr = await deps.fetchPage(h.url);
          return { outcome: fr.outcome, page: fr.page };
        });
        for (const r of results) {
          if (r.outcome === "reuse") { reuseHits++; if (r.page) staged.push(r.page); }
          else if (r.outcome === "ok") { sourcesFetched++; if (r.page && r.page.content) staged.push(r.page); }
          else if (r.outcome === "timeout") { fetchTimeouts++; }
          else { fetchErrors++; }
        }
        await progress(
          "gather",
          `staged ${staged.length} (ok ${sourcesFetched} · timeout ${fetchTimeouts} · err ${fetchErrors} · reused ${reuseHits})`,
          { staged: staged.length, sources: sourcesFetched, timeouts: fetchTimeouts, errors: fetchErrors, reused: reuseHits },
        );
      }
      return true;
    };

    let pendingNeeds = [...gapNeeds];
    for (let round = 1; round <= effRounds && pendingNeeds.length; round++) {
      const ok = await gatherQueries(pendingNeeds);
      if (!ok) break;                       // backstop tripped
      if (round >= effRounds) break;        // no point re-planning on the last round
      // Which needs are now actually answered by the gathered sources?
      const cov = await jsonChat(
        deps, COVERAGE_STAGED_SYS,
        `NEEDS:\n${pendingNeeds.map((n, i) => `${i}. ${n}`).join("\n")}\n\nGATHERED SOURCES:\n${staged.map((s) => `- ${s.title}: ${s.content.slice(0, 200)}`).join("\n")}`,
      );
      const openIdx = new Set<number>(Array.isArray(cov.open) ? cov.open.map(Number) : []);
      const stillOpen = pendingNeeds.filter((_, i) => openIdx.has(i));
      if (!stillOpen.length) break;          // everything covered → stop deepening
      // Refine into more specific queries for the next round.
      const deep = await jsonChat(
        deps, DEEPEN_SYS,
        `STILL-OPEN NEEDS:\n${stillOpen.map((n, i) => `${i}. ${n}`).join("\n")}\n\nWHAT WAS FOUND:\n${staged.map((s) => `- ${s.title}`).join("\n")}`,
      );
      pendingNeeds = Array.isArray(deep.queries) && deep.queries.length
        ? deep.queries.map(String).slice(0, stillOpen.length) : stillOpen;
      followupQueries.push(...pendingNeeds); // record the refined queries as breadcrumbs
      await progress("deepen", `round ${round}: ${stillOpen.length} need(s) still open`, { round, open: stillOpen.length });
    }
  } else {
    await progress("seed", `staged ${staged.length} seed source(s); web search disabled`,
      { staged: staged.length });
  }

  // Prompt-injection screen — quarantine any fetched/seed source trying to hijack
  // the reader (defense-in-depth with INJECTION_GUARD on the synth prompts below).
  // A page attacking the reader isn't a trustworthy source; drop it before it can
  // poison the synthesis or get persisted.
  if (staged.length) {
    const { clean, quarantined } = await screenSources(deps, staged);
    if (quarantined.length) {
      await progress("screen", `quarantined ${quarantined.length} source(s) for prompt injection`,
        { quarantined: quarantined.length });
      staged.splice(0, staged.length, ...clean);
    }
  }

  // Relevance gate (filtering.ts, 2026-08-22): drop WEB-GATHERED pages that do
  // not actually pertain to the question (the "SaaS api tools" → hardware-store
  // results failure). Seeds and KB recalls are protected — the caller / vector
  // relevance already vouched for them. Fail-open per page; a rejection here is
  // a confident IRRELEVANT verdict, logged so the run's record shows what was
  // discarded and why coverage may differ from raw fetch counts.
  if (staged.length > protectedCount) {
    const protectedPages = staged.slice(0, protectedCount);
    const webPages = staged.slice(protectedCount);
    const { relevant: relevantPages, rejected } = await partitionRelevant(deps, webPages, query);
    // FAIL-SAFE FLOOR (operator concern 2026-08-22): the gate must never turn
    // a run into a no-sources failure. If it would empty the web pool (and
    // nothing protected remains to ground from), keep everything and say so -
    // the synthesizer's grounding rules + the Sources-cited-only report are
    // the backstop against weak pages, and a thin report beats a dead run.
    if (relevantPages.length === 0 && protectedPages.length === 0 && webPages.length > 0) {
      await progress("screen",
        `relevance gate would empty the source pool - keeping all ${webPages.length} page(s) (fail-safe floor)`,
        { irrelevant_overridden: webPages.length });
    } else if (rejected.length) {
      await progress("screen",
        `rejected ${rejected.length} irrelevant source(s): ${rejected.map((r) => r.url).slice(0, 4).join(", ")}${rejected.length > 4 ? ", …" : ""}`,
        { irrelevant: rejected.length });
      staged.splice(0, staged.length, ...protectedPages, ...relevantPages);
    }
  }

  // Persist staged candidates into the session pool (dedup vs OB). Skipped on
  // dry-run (no canonical write).
  if (!dryRun && sessionId) {
    await mapLimit(staged, FETCH_CONCURRENCY, async (p) => {
      try {
        const emb = await deps.embed(`${p.title}\n\n${p.content}`.slice(0, EMBEDDING_MAX_CHARS));
        await stageSource(client, sessionId, p, emb);
      } catch { /* best-effort staging */ }
    });
  }

  // 4. Synthesize verbatim with claim-level citations (sources 1-indexed).
  await progress("synthesize", "writing the grounded synthesis");
  let claimList = reuseClaims.map((c) => `- ${c.text}`).join("\n") || "(none)";
  const sourceLine = (p: Page, i: number, max = 2000) => `[Source ${i + 1}] ${p.title} (${p.domain})\n${p.content.slice(0, max)}`;

  // The source pool the synthesizer can cite, and the buildCitedAndRenumber input.
  // Defaults to `staged`; the default path extends it with reused-claim sources.
  let pool: Page[] = staged;
  let reuseUrls = new Set<string>();

  let rawSynthesis: string;
  if (articleMode) {
    // Pass 1 — ground the article itself (the article is the only staged source
    // here; OB known claims resolve gaps where they can).
    const articleSynth = (await deps.chat(
      `${INJECTION_GUARD}\n\n${ARTICLE_SYNTH_SYS}`,
      `QUESTION: ${query}\n\nKNOWN CLAIMS (already-grounded Open Brain knowledge — supporting context; use to RESOLVE gaps where possible):\n${claimList}\n\nARTICLE:\n${staged.map((p, i) => sourceLine(p, i, ARTICLE_SOURCE_CHARS)).join("\n\n")}`,
    )).trim();

    // Pass 2 — bounded PRELIMINARY research on the gaps the article + OB left open.
    let prelimSynth = "";
    if (gapResearch === "preliminary" && !skipSearch) {
      const gapLines = (articleSynth.match(/^\[GAP\]\s*.+$/gim) || [])
        .map((l) => l.replace(/^\[GAP\]\s*/i, "").trim()).filter(Boolean)
        .slice(0, PRELIM_GAP_LIMIT);
      if (gapLines.length) {
        await progress("gather", `preliminary research on ${gapLines.length} open gap(s)`, { gaps: gapLines.length });
        const base = staged.length; // the article occupies [Source 1..base]
        for (const gap of gapLines) {
          if (sourcesFetched >= PRELIM_MAX_FETCH) { backstop = "max_fetch"; break; }
          let hits: SearchHit[] = [];
          try { hits = await deps.searchWeb(gap, SEARCH_K); } catch { hits = []; }
          hits = rankHits(hits);
          const fresh = hits.filter((h) => !staged.some((s) => s.url === h.url))
            .slice(0, Math.max(0, Math.min(2, PRELIM_MAX_FETCH - sourcesFetched)));
          const results = await mapLimit(fresh, FETCH_CONCURRENCY, (h) => deps.fetchPage(h.url));
          const prelimPages: Page[] = [];
          for (const fr of results) {
            if (fr.outcome === "ok" && fr.page && fr.page.content) { sourcesFetched++; prelimPages.push(fr.page); }
            else if (fr.outcome === "timeout") { fetchTimeouts++; }
            else { fetchErrors++; }
          }
          const gatePrelim = await partitionRelevant(deps, prelimPages, `${query} — ${gap}`);
          // Same fail-safe floor as the main pool: never let the gate zero
          // out a preliminary batch that fetched real pages.
          const keptPrelim = (gatePrelim.relevant.length === 0 && prelimPages.length > 0)
            ? prelimPages
            : gatePrelim.relevant;
          if (keptPrelim === prelimPages && gatePrelim.rejected.length) {
            await progress("screen", `relevance gate would empty the preliminary batch - keeping all ${prelimPages.length} (fail-safe floor)`,
              { irrelevant_overridden: prelimPages.length });
          } else if (gatePrelim.rejected.length) {
            await progress("screen", `rejected ${gatePrelim.rejected.length} irrelevant preliminary source(s)`,
              { irrelevant: gatePrelim.rejected.length });
          }
          const { clean: cleanPrelim, quarantined: qPrelim } = await screenSources(deps, keptPrelim);
          if (qPrelim.length) {
            await progress("screen", `quarantined ${qPrelim.length} preliminary source(s) for prompt injection`,
              { quarantined: qPrelim.length });
          }
          for (const p of cleanPrelim) staged.push(p);
        }
        if (staged.length > base) {
          const gapSources = staged.slice(base).map((p, i) => sourceLine(p, base + i)).join("\n\n");
          prelimSynth = (await deps.chat(
            `${INJECTION_GUARD}\n\n${PRELIM_GAP_SYNTH_SYS}`,
            `OPEN GAPS (from the article):\n${gapLines.map((g, i) => `${i + 1}. ${g}`).join("\n")}\n\nPRELIMINARY SOURCES (the article is [Source 1], already covered):\n${gapSources}`,
          )).trim();
          if (!dryRun && sessionId) {
            await mapLimit(staged.slice(base), FETCH_CONCURRENCY, async (p) => {
              try { const emb = await deps.embed(`${p.title}\n\n${p.content}`.slice(0, EMBEDDING_MAX_CHARS)); await stageSource(client, sessionId, p, emb); } catch { /* best-effort */ }
            });
          }
        }
      }
    }
    rawSynthesis = prelimSynth ? `${articleSynth}\n${prelimSynth}` : articleSynth;
  } else {
    // Fold the REUSED claims' grounding sources into the citable pool (after the
    // freshly-staged ones, deduped by url). This lets the synthesizer cite reused
    // facts [Source N] instead of emitting uncited [SOURCED] lines — and, since
    // those sources flow to the curator, re-grounds the synthesis + re-links it
    // to the reused claims (provenance). Closes the reuse-only gap; a reuse-only
    // run (no fresh gather) now still produces a cited, grounded synthesis.
    const reuse = reuseClaims.length
      ? await getReuseSources(client, reuseClaims.map((c) => c.id))
      : { sources: [], claimToSource: {} };
    const stagedUrls = new Set(staged.map((s) => s.url).filter(Boolean));
    const reuseEntries = reuse.sources.filter((s) => !(s.url && stagedUrls.has(s.url)));
    const reusePages: Page[] = reuseEntries.map((s) => ({
      url: s.url || "", title: s.title, content: s.content, domain: s.domain || "",
    }));
    reuseUrls = new Set(reusePages.map((p) => p.url).filter(Boolean));
    pool = [...staged, ...reusePages];

    // source id → its 0-based index in the pool (reuse sources occupy [staged.length..])
    const idToPoolIdx = new Map<string, number>();
    reuseEntries.forEach((s, i) => idToPoolIdx.set(s.id, staged.length + i));
    // Annotate each reused claim with the [Source N] that grounds it, so the
    // synthesizer cites that number when it uses the fact.
    claimList = reuseClaims.map((c) => {
      const sid = reuse.claimToSource[c.id];
      const idx = sid != null ? idToPoolIdx.get(sid) : undefined;
      return idx != null ? `- ${c.text} [Source ${idx + 1}]` : `- ${c.text}`;
    }).join("\n") || "(none)";

    // Fresh sources get full content; reuse sources get a shorter slice (the claim
    // text already carries the substance — the source is for citation attribution).
    const sourceList = pool
      .map((p, i) => sourceLine(p, i, i < staged.length ? 2000 : 900))
      .join("\n\n");
    rawSynthesis = (await deps.chat(
      `${INJECTION_GUARD}\n\n${SYNTH_SYS}`,
      `QUESTION: ${query}\n\nKNOWN CLAIMS (already grounded — when you assert one, cite the [Source N] shown next to it):\n${claimList}\n\nSOURCES:\n${sourceList || "(none gathered)"}`,
    )).trim();
  }

  // 4b. Skeptic defensive gate (Phase 2, judge-only tier; SKEPTIC_ENABLED, off by
  //     default). Adversarially reviews the synthesis and DOWNGRADES weak/refuted
  //     claims in place ([SOURCED]→[UNCERTAIN]/[GAP]) so they land below the reuse
  //     floor instead of compounding as fact — index-safe (line count + [Source N]
  //     numbers preserved), so buildCitedAndRenumber below stays aligned. Records a
  //     per-run audit (result.skeptic). FAIL-OPEN: the skeptic never breaks a run.
  //     The drop-and-replace re-gather tier (pool mutation + re-synthesis) is
  //     deferred to on-site validation.
  let skeptic: SkepticResult | undefined;
  if (SKEPTIC_ENABLED && rawSynthesis.trim() && (Date.now() - t0) < effMaxMs) {
    try {
      await progress("skeptic", "adversarially reviewing the synthesis");
      const judgeSources = pool
        .map((p, i) => sourceLine(p, i, i < staged.length ? 1200 : 700))
        .join("\n\n");
      const raw = await deps.chat(
        `${INJECTION_GUARD}\n\n${SKEPTIC_SYS}`,
        `QUESTION: ${query}\n\nGROUNDED ANSWER:\n${rawSynthesis}\n\nSOURCES:\n${judgeSources || "(none)"}`,
        { json: true, nothink: true },
      );
      const verdict = parseSkepticResult(raw);
      const { synthesis: downgraded, applied } = applyDowngrades(rawSynthesis, verdict.downgrades);
      rawSynthesis = downgraded;
      skeptic = verdict;
      await progress(
        "skeptic",
        `challenges=${verdict.challenges.length} downgrades=${applied} refuted=${verdict.refuted.length} dropped_sources=${verdict.droppedSources.length}`,
        { challenges: verdict.challenges.length, downgrades: applied, refuted: verdict.refuted.length, dropped_sources: verdict.droppedSources.length },
      );
    } catch (e) {
      await progress("skeptic", `skeptic review skipped: ${(e as Error).message}`); // fail-open
    }
  }

  // 5. Cited-only sources (GROUNDING-MODEL §6.3) + renumber citations so the
  //    curator's [Source N] → source_ids[N-1] resolution stays aligned with the
  //    compacted cited list. Delegate to curator (verbatim storage + claims, P2).
  const { synthesis, cited } = buildCitedAndRenumber(rawSynthesis, pool);

  // Templated report rendering (templates.ts, 2026-08-22) — the human-facing
  // answer is now a PROFESSIONAL REPORT: the run is classified into a report
  // type (scientific paper, technical proposal, product comparison, …) and the
  // grounded synthesis is rendered into that template. The tagged `synthesis`
  // is preserved as the machine-truth the curator decomposes into claims; the
  // report keeps the SAME [Source N] numbers, so wiki source-leaf deep-links
  // still resolve. Best-effort: a render failure leaves prose empty and the
  // renderers fall back to the tagged synthesis.
  let prose = "";
  let reportType = "";
  if (synthesis.trim()) {
    try {
      const tpl = await classifyTemplate(deps, query, synthesis);
      reportType = tpl.id;
      await progress("synthesize", `report template: ${tpl.name}`);
      prose = (await deps.chat(renderSys(tpl), `QUESTION: ${query}\n\nGROUNDED ANSWER:\n${synthesis}`)).trim();
    } catch (e) {
      await progress("synthesize", `report rendering skipped: ${(e as Error).message}`);
    }
  }

  const gapMatches = synthesis.match(/\[GAP\]/gi) || [];
  // Reuse signal = needs actually COVERED by existing claims (needs - gaps), not
  // every grounded claim the recall pulled (which overcounts when an unscoped
  // query drags in semantically-near but irrelevant claims). claims_freshly_
  // gathered counts only NEWLY-gathered cited sources (reuse sources excluded).
  const coveredNeeds = Math.max(0, needs.length - gapNeeds.length);
  const freshCited = cited.filter((p) => !(p.url && reuseUrls.has(p.url)));
  const metrics = reuseMetric(coveredNeeds, freshCited.length, gapMatches.length);

  await progress("persist", dryRun ? "dry-run: skipping curator write" : "delegating placement + grounding to the curator");
  let curator: Record<string, unknown> | null = null;
  if (!dryRun && (cited.length || reuseClaims.length)) {
    const pkg = {
      research_key: `rs-${await sha1(query + (threadId || ""))}`,
      query,
      claim: firstParagraph(synthesis).slice(0, 600),
      synthesis,
      prose,                              // human-readable rendering (curator → sources.metadata)
      needs,                             // the decomposed sub-questions (breadcrumbs)
      followup_queries: followupQueries, // refined/deepen queries across rounds (breadcrumbs)
      kind: "deep_research",
      topic_hint: opts.origin || "research",
      thread_id: threadId || undefined,
      sources: cited.map((p) => ({ url: p.url, title: p.title, content: p.content, domain: p.domain })),
    };
    try { curator = await deps.delegateToCurator(pkg); } catch (e) { curator = { error: String((e as Error).message) }; }
  }

  return {
    synthesis, prose, reportType, needs, followupQueries,
    gaps: gapMatches.length ? gapNeeds : [],
    reuseClaims: reuseClaims.map((c) => ({ id: c.id, text: c.text })),
    citedSources: cited.map((p) => ({ url: p.url, title: p.title })),
    metrics, curator, backstop,
    // Separated fetch accounting (yield vs waste) — informs the operator/user
    // why a run stopped: sources retrieved vs timeouts vs errors vs cache reuse.
    fetchStats: {
      sources: sourcesFetched,
      timeouts: fetchTimeouts,
      errors: fetchErrors,
      reused: reuseHits,
      attempts: sourcesFetched + fetchTimeouts + fetchErrors,
    },
    skeptic,
  };
}
