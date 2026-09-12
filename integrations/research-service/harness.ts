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
import { rankHits, partitionRelevant, floorKeepable } from "./filtering.ts";
import { classifyReport, renderSys, templateById, DEFAULT_TEMPLATE_ID } from "./templates.ts";
import { deniedUrl, clampCeiling, type ResolvedContract } from "./contract.ts";
import { SKEPTIC_SYS, parseSkepticResult, applyDowngrades, type SkepticResult } from "./skeptic.ts";
import {
  classifyHits, emptySearchStats, reformulate, type SearchStats, shapeQuery,
} from "./search-quality.ts";
import { applyNumericGrounding, renderGroundingDiff, type RenderGroundingDiff } from "./grounding.ts";
import { checkRenderFidelity, countUnits, supersetCitations, type FidelityRecord } from "./fidelity.ts";
import {
  coverageFooter, emptySearchRecord, failureNotice, gapQuestions, reconcileNeedsStatus,
  shouldClassifyTemplate, type GapPassRecord,
  type NeedState, type NeedStatus, type SearchRecord,
} from "./report.ts";

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
// ── research-trust (2026-09-11) ─────────────────────────────────────────────
// RELEVANT_TARGET — the run's YIELD target. Gathering continues while fewer than
// this many pages have survived the relevance gate and un-searched reformulations
// remain. MAX_ROUNDS stays as the hard ceiling; it is no longer the stop CONDITION
// (stopping at round 3 with zero relevant sources is how two runs reported
// "complete" having retrieved nothing).
const RELEVANT_TARGET = parseInt(env("RELEVANT_TARGET", "8"), 10);
// A run whose searches collapse this many times IN A ROW stops gathering with
// backstop="search_degraded". Three is the plan's number: enough to distinguish
// one bad query from a broken engine, small enough not to burn the budget.
const COLLAPSE_STREAK_MAX = parseInt(env("COLLAPSE_STREAK_MAX", "3"), 10);
// A fetched page with less extracted text than this is not READABLE — it was
// fetched, but there is nothing in it to ground anything with.
const READABLE_MIN_CHARS = parseInt(env("READABLE_MIN_CHARS", "400"), 10);
// Many hits, almost nothing readable, is a FETCH failure, not an empty topic.
const FETCH_DEGRADED_MIN_HITS = parseInt(env("FETCH_DEGRADED_MIN_HITS", "20"), 10);
const FETCH_DEGRADED_RATIO = parseFloat(env("FETCH_DEGRADED_RATIO", "0.2"));
// How much of each freshly-gathered source the synthesizer actually sees. Was a
// hard-coded 2000; a source cut at 2 000 chars is thin evidence by construction.
const SOURCE_SLICE_CHARS = parseInt(env("SOURCE_SLICE_CHARS", "4000"), 10);
// Interactive (owui) topic research may run longer than the shared default: a
// correct answer is worth minutes. Digest/article/notebook paths are unaffected —
// this is applied only on the default topic-research path for origin "owui".
const MAX_WALL_MS_OWUI = parseInt(env("MAX_WALL_MS_OWUI", String(MAX_WALL_MS)), 10);

// ── The gap-closing pass (research-trust-report) ─────────────────────────────
// The operator's complaint was not that the engine stops early - it is that it
// hands back an incomplete answer and leaves the person to notice. So when the
// first synthesis leaves needs open and there is clock left, the run closes what
// it can BEFORE delivering, and says so in the chat while it does.
//
// Exactly one pass, and only from this much of the budget: a second gather plus
// a second synthesis is roughly a third of a run, so the pass may only start
// while most of the clock is unspent. Past that the honest thing is to deliver
// what there is and recommend a targeted run, which is what the report's
// limitations section now does.
const GAP_PASS_MAX_ELAPSED = parseFloat(env("GAP_PASS_MAX_ELAPSED", "0.6"));
/** Needs the pass will chase in one round. */
const GAP_PASS_MAX_QUERIES = parseInt(env("GAP_PASS_MAX_QUERIES", "3"), 10);

// ── Seams (injectable for tests) ────────────────────────────────────────────
export interface SearchHit { url: string; title: string; snippet: string; }
export interface Page { url: string; title: string; content: string; domain: string; }
// A fetch attempt's outcome — distinguishes a retrieved source from a timeout
// (flaky Tor) from any other failure. `page` is non-null only when outcome="ok".
/**
 * Phase 1.5 — "error" used to be one bucket holding a 404, a PDF, an empty
 * extract and a dead socket. 18 of 50 attempts in one audited run and 31 of 72
 * in the other landed in it, and nothing downstream could tell "we could not
 * READ it" from "it is not THERE". The old "error" is still accepted (mocks and
 * older callers emit it) and counted under `network`.
 */
export type FetchOutcome =
  | "ok" | "timeout" | "error"
  | "http" | "non_html" | "empty_extract" | "network";
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
// Phase 1.2 — round 1 searches KEYWORDS, not the decomposed question. The
// SUBJECT ENTITY is asked for explicitly because it is the one token a query
// may never lose: a need rewritten without it is a search about the category.
// The entity is a NAME, and the prompt now says so three ways. Live dry run
// 6975d982 returned "100Hz audio VR motion sickness" for a question about 100 Hz
// audio and VR motion sickness: a faithful summary of the TOPIC, and useless as
// a name — no page carries that phrase, so a healthy search was reported as a
// failure. The prompt is the cheap half of the fix; harness.ts shortens
// deterministically when the model does it anyway, because a prompt is a
// request and not a guarantee.
const KEYWORDIZE_SYS =
  `You turn research needs into web-search queries. First identify the SUBJECT ENTITY of the QUESTION — the single specific NAMED thing being researched, as it is PRINTED ON A PAGE ABOUT IT: a product ("OptiPlex 3050"), a drug ("semaglutide"), a version ("Postgres 17"), an error ("CrashLoopBackOff"), a measurement ("100 Hz").

ENTITY RULES — the entity is a NAME, at most 3 words:
- NEVER the topic or the question. For "how 100Hz audio affects VR motion sickness" the entity is "100 Hz", NOT "100Hz audio VR motion sickness".
- NEVER an intent ("used purchase", "troubleshooting") and never a year on its own.
- If the question is about two named things, pick the ONE the answer is about.

Then, for EACH need, write ONE web query of 3 to 7 terms that CONTAINS the subject entity and the need's distinguishing words. No questions, no punctuation, no filler words.

Return ONLY JSON: {"entity": "...", "queries": ["...", "..."]} — exactly one query per need, in the same order.`;
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

// (The pre-template PROSE_SYS readable-prose prompt lived here until
// 2026-08-23 — dead code since the a627f31 template rework; templates.ts
// renderSys() is the single prose renderer now.)

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
  /** The gap-closing pass, when one ran: what it added and what it closed.
   *  null when nothing was open, the clock was spent, or the path has no
   *  gather loop to run it (article / sources-only / disable_web_search). */
  gapPass: GapPassRecord | null;
  /**
   * What this run IS, as opposed to why it stopped. "no_relevant_sources" means
   * nothing about the subject was retrieved — it is a RETRIEVAL result and must
   * never be read, rendered or stored as a finding about the world.
   */
  outcome: "complete" | "no_relevant_sources";
  /** Per-need verdict, the honest basis for "needs answered X of N". */
  needsStatus: NeedState[];
  /** Queries tried with their verdicts, plus the hit/fetch/readable/relevant funnel. */
  searchRecord: SearchRecord;
  /** Figures a cited line asserted that no cited source holds (Phase 2.3). */
  ungroundedNumbers: string[];
  /** What the RENDERED report says that the grounded answer does not
   *  (research-trust-report). null when no report was rendered. */
  proseUngrounded: RenderGroundingDiff | null;
  /** The per-sentence fidelity check of the rendered report: how much was
   *  checked, how much overstated its sources, and how it was corrected.
   *  `error` set means the check did not run and the document is untouched. */
  renderFidelity: FidelityRecord | null;
  /** Separated fetch accounting — yield (sources) vs waste (timeouts/errors) vs
   *  free OB cache reuse. `attempts` = sources + timeouts + errors.
   *  `readable` = fetched pages with an extract worth grounding from;
   *  `errorKinds` splits the old single `errors` bucket, which could not tell an
   *  unreadable page from an unreachable one. */
  fetchStats: {
    sources: number; timeouts: number; errors: number; reused: number; attempts: number;
    readable: number;
    errorKinds: { http: number; non_html: number; empty_extract: number; network: number };
    search: SearchStats;
  };
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
  // The interactive topic path may run longer (MAX_WALL_MS_OWUI); every other
  // path — digest, article, notebook, sources-only — keeps the shared bound.
  const topicPath = !articleMode && !skipSearch;
  const baseMaxMs = topicPath && (opts.origin || "owui") === "owui" ? MAX_WALL_MS_OWUI : MAX_WALL_MS;
  const effMaxMs = clampCeiling(baseMaxMs, rcBudget?.wallMs);
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
  // research-trust — the run's own record of how retrieval went. `errorKinds`
  // replaces the single fetchErrors bucket; `searchStats` and `searchRecord`
  // are what make "the search broke" sayable at all.
  const errorKinds = { http: 0, non_html: 0, empty_extract: 0, network: 0 };
  const searchStats: SearchStats = emptySearchStats();
  const searchRecord: SearchRecord = emptySearchRecord();
  let readableCount = 0;
  let ungroundedNumbers: string[] = [];
  let proseUngrounded: RenderGroundingDiff | null = null;
  let renderFidelity: FidelityRecord | null = null;
  let needsStatus: NeedState[] = [];
  // Assigned by the topic gather block below, and called once after the first
  // synthesis. Null on every other path - article, sources-only and
  // disable_web_search have no gather loop to run a second round of, and the
  // anchor leaves them untouched.
  let gapRound: ((targets: Array<{ need: string; query: string }>) => Promise<Page[]>) | null = null;
  let gapPass: GapPassRecord | null = null;
  /** The subject the KEYWORDIZE pass named — the one token a query may not lose. */
  let subjectEntity = "";
  const setNeedStatus = (need: string, status: NeedStatus) => {
    const row = needsStatus.find((n) => n.need === need);
    if (row) row.status = status;
  };
  /** Copy the live counters onto the RECORD the footer reads. Called after the
   *  gather loop and again after the gap-closing pass - a pass whose searches
   *  are not in the record is a pass the reader cannot audit. */
  const syncRecordCounts = () => {
    searchRecord.ok = searchStats.ok;
    searchRecord.collapsed = searchStats.collapsed;
    searchRecord.offtopic = searchStats.offtopic;
    searchRecord.empty = searchStats.empty;
    searchRecord.errors = searchStats.errors;
    searchRecord.entity_missing = searchStats.entity_missing;
    searchRecord.entity_rejected = searchStats.entity_rejected;
    searchRecord.unfloored = searchStats.unfloored;
    searchRecord.query_padded = searchStats.query_padded;
  };
  const countFetch = (outcome: FetchOutcome, page: Page | null) => {
    if (outcome === "ok") {
      sourcesFetched++;
      if ((page?.content || "").length >= READABLE_MIN_CHARS) readableCount++;
      return;
    }
    if (outcome === "timeout") { fetchTimeouts++; return; }
    fetchErrors++;
    if (outcome === "http") errorKinds.http++;
    else if (outcome === "non_html") errorKinds.non_html++;
    else if (outcome === "empty_extract") errorKinds.empty_extract++;
    else errorKinds.network++;   // "network" and the legacy "error"
  };

  // KB-SOURCE recall (REPO-SOURCES-WIRING §6): durable primary sources already in OB — e.g.
  // repo docs synced via /sources/repo-sync — can answer repo-specific questions web search
  // can never surface. Fold them into the staged pool BEFORE any web gathering so coverage
  // sees them; they were injection-screened at sync time and are re-screened with the pool
  // below anyway (defense in depth). Never in sources-only/article mode (those ground
  // strictly from the caller's seeds/article).
  //
  // Phase 2.1 (research-trust 2026-09-11): on the DEFAULT topic-research path
  // these recalls are now CANDIDATES, not protected pages. Their exemption from
  // the relevance gate is what turned job ce398d06 into a report: every web page
  // was correctly rejected, and six months-old pages about a different computer
  // (DGX Spark, Compaq d220, an ASUS BIOS FAQ) were exempt, so the pool was never
  // empty, the fail-safe floor never fired, and the run read as complete. Vector
  // proximity is a retrieval signal, not a relevance verdict.
  // The digest (disable_web_search), article and sources-only paths are UNCHANGED:
  // there the recall is often the only pool, and the plan's own rule is to leave
  // those bounds alone.
  const kbRecalled: Page[] = [];
  if (!sourcesOnly && !articleMode) {
    try {
      const kbSources = await retrieveRelevantSources(
        client, queryEmb, KB_SOURCES_K, KB_SOURCES_MAX_DISTANCE);
      for (const s of kbSources) {
        if (s.url && !staged.some((p) => p.url === s.url) && !kbRecalled.some((p) => p.url === s.url)) {
          const page: Page = { url: s.url, title: s.title, content: s.content,
                               domain: s.domain || domainOf(s.url) };
          if (topicPath) kbRecalled.push(page);
          else { staged.push(page); }
          reuseHits++;
        }
      }
      if (kbSources.length) {
        await progress("reuse",
          `recalled ${kbSources.length} KB source(s) ${topicPath ? "as gate candidates" : "into the pool"}`,
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

    // ── Phase 1.2 — round 1 searches KEYWORDS carrying the subject entity ────
    const round1 = new Map<string, string>();
    if (gapNeeds.length) {
      const kw = await jsonChat(
        deps, KEYWORDIZE_SYS,
        `QUESTION: ${query}\n\nNEEDS:\n${gapNeeds.map((n, i) => `${i}. ${n}`).join("\n")}`,
      );
      const rawEntity = typeof kw.entity === "string" ? kw.entity.trim() : "";
      // The subject is used WHOLE, as a set of distinctive tokens. There is
      // nothing to shorten and nothing to count: `shortenEntity` and
      // `entity_shortened` went with the core-phrase rule they served
      // (findings H.4). KEYWORDIZE is still told to return a NAME, and a
      // subject the query is not about is still rejected and counted.
      subjectEntity = rawEntity;
      const raw = Array.isArray(kw.queries) ? kw.queries : [];
      gapNeeds.forEach((need, i) => {
        // `shapeQuery` GUARANTEES two content words. It did not before, and a
        // need whose every word is a stopword ("What is it?") produced the
        // bare subject as the whole query — which the evidence floor then had
        // nothing to measure against. Padding is counted, not silent.
        const shaped = shapeQuery(subjectEntity, need, raw[i]);
        if (shaped.padded) searchStats.query_padded++;
        round1.set(need, shaped.query);
      });
      await progress("plan", `subject="${subjectEntity || "(none)"}"; ${round1.size} keyword quer(ies)`,
        { keyword_queries: round1.size });
    }

    // ── Gather, one attempt per need per round ───────────────────────────────
    // A search whose result set COLLAPSES (search-quality.ts) yields no pages and
    // is recorded as a search failure; the need gets ONE reformulated retry, and a
    // second collapse marks it search_failed rather than leaving it "open", which
    // reads as "nobody has written about this".
    interface Pending { need: string; query: string; attempts: number; }
    let pending: Pending[] = gapNeeds.map((need) => ({
      need, query: round1.get(need) || need, attempts: 0,
    }));
    needsStatus = needs.map((need) => ({
      need,
      status: (gapNeeds.includes(need) ? "open" : "answered") as NeedStatus,
    }));

    let collapseStreak = 0;
    let stopGathering = false;
    // Pages gathered this round, awaiting the injection screen + relevance gate.
    let fresh: Page[] = [];
    // Everything that has SURVIVED the gate (KB recalls included — Phase 2.1).
    const kept: Page[] = [];

    const gateAndKeep = async (
      candidates: Page[],
      label: string,
      floorMayApply = true,
    ): Promise<void> => {
      if (!candidates.length) return;
      const { clean, quarantined } = await screenSources(deps, candidates);
      if (quarantined.length) {
        await progress("screen", `quarantined ${quarantined.length} ${label} source(s) for prompt injection`,
          { quarantined: quarantined.length });
      }
      const { relevant: rel, rejected } = await partitionRelevant(deps, clean, query);
      // FAIL-SAFE FLOOR (operator concern 2026-08-22), NARROWED TWICE.
      //  (1) It must not second-guess a MEASUREMENT: when the searches that
      //      produced these pages collapsed or came back off-topic, the pages
      //      are junk by observation.
      //  (2) It must never re-admit KB RECALLS (`floorMayApply` false). Their
      //      only credential is vector proximity, and re-admitting them when the
      //      gate empties the pool reproduces the audited failure exactly — a
      //      DGX Spark maintenance guide, a Compaq d220 manual and an ASUS BIOS
      //      FAQ becoming the entire cited pool for an OptiPlex question. The
      //      floor exists to second-guess a possibly-wrong model verdict about a
      //      page the run went out and FETCHED for this question.
      let keepNow = rel;
      const junkSearches = searchStats.collapsed + searchStats.offtopic;
      if (floorMayApply && rel.length === 0 && junkSearches === 0 && clean.length > 0) {
        const floorPool = floorKeepable(clean);
        if (floorPool.length > 0) {
          keepNow = floorPool;
          await progress("screen",
            `relevance gate would empty the ${label} pool - keeping ${floorPool.length} of ${clean.length} (fail-safe floor; shells stay dropped)`,
            { irrelevant_overridden: floorPool.length });
        }
      }
      if (rejected.length) {
        await progress("screen",
          `rejected ${rejected.length} ${label} source(s): ${rejected.map((r) => r.url).slice(0, 4).join(", ")}${rejected.length > 4 ? ", …" : ""}`,
          { irrelevant: rejected.filter((r) => r.reason === "irrelevant").length,
            shells_dropped: rejected.filter((r) => r.reason === "no_content").length });
      }
      for (const p of keepNow) if (!kept.some((k) => k.url === p.url)) kept.push(p);
      searchRecord.relevant = kept.length;
    };

    // KB recalls face the same gate as anything else, before round 1 - and the
    // fail-safe floor may NOT re-admit them (see gateAndKeep).
    await gateAndKeep(kbRecalled, "recalled", false);

    // Deepened queries go through the SAME guarantee as round 1: a DEEPEN
    // proposal can be one word just as easily as a KEYWORDIZE one.
    const shapeDeepQuery = (ent: string, need: string, raw: unknown): string => {
      const shaped = shapeQuery(ent, need, raw);
      if (shaped.padded) searchStats.query_padded++;
      return shaped.query;
    };

    const runSearch = async (q: string): Promise<SearchHit[]> => {
      searchStats.calls++;
      await progress("gather", `searching: ${q}`);
      let hits: SearchHit[] = [];
      try {
        hits = await deps.searchWeb(q, SEARCH_K);
      } catch {
        searchStats.errors++;
        searchRecord.queries.push({ query: q, verdict: "error", hits: 0, overlap: 0 });
        return [];
      }
      searchRecord.hits += hits.length;
      // The SUBJECT ENTITY is what makes this a judgement rather than a guess:
      // KEYWORDIZE extracted it, `keywordQuery` enforced it into this very
      // query, and `classifyHits` now asks whether the results actually contain
      // it. Empty (no KEYWORDIZE pass, e.g. a single-need run) falls back to the
      // weaker overlap rule, which search-quality.ts documents.
      const v = classifyHits(q, hits, subjectEntity);
      // Count what the gate could NOT do. A fallback that is never counted is a
      // gate reporting health it did not measure: the footer would say the
      // search was fine without saying it was judged by the weaker rule.
      if (v.entityStatus === "missing") searchStats.entity_missing++;
      else if (v.entityStatus === "unfloored") {
        // Unreachable in a shipped run — `shapeQuery` guarantees two content
        // words — and counted anyway, because the way the last one of these
        // was found was a tester driving runResearch, not a silent stat.
        searchStats.unfloored++;
        await progress("gather",
          `the query "${q}" has under two content words - it cannot be checked against the subject, so these results are refused`,
          { unfloored: searchStats.unfloored });
      } else if (v.entityStatus === "rejected") {
        searchStats.entity_rejected++;
        await progress("gather",
          `the subject entity "${subjectEntity}" is not in this query - judging by overlap alone`,
          { entity_rejected: searchStats.entity_rejected });
      }
      searchRecord.queries.push({
        query: q, verdict: v.verdict, hits: hits.length,
        overlap: Math.round(v.overlap * 100) / 100,
        entityShare: v.entityShare, entityStatus: v.entityStatus,
        collapsedOn: v.collapsedOn,
      });
      if (v.verdict === "collapsed") {
        searchStats.collapsed++;
        collapseStreak++;
        await progress("gather",
          `search COLLAPSED onto "${v.collapsedOn}" (overlap ${v.overlap.toFixed(2)}) - no usable results`,
          { collapsed: searchStats.collapsed });
        return [];
      }
      // `offtopic` = a full page of hits, not one of which mentions the query.
      // It yields nothing and feeds the degraded streak exactly like a collapse:
      // an engine that drifts semantically fails the run just as completely as
      // one that collapses onto a token, and counting it `ok` spent the fetch
      // budget on noise while reporting the search as healthy.
      if (v.verdict === "offtopic") {
        searchStats.offtopic++;
        collapseStreak++;
        await progress("gather",
          `search returned ${hits.length} hits, NONE mentioning the query (overlap 0.00) - no usable results`,
          { offtopic: searchStats.offtopic });
        return [];
      }
      if (v.verdict === "empty") { searchStats.empty++; return []; }
      searchStats.ok++;
      collapseStreak = 0;
      return hits;
    };

    /**
     * One query, from search to pages waiting for the gate. EXTRACTED so the
     * gap-closing pass runs the identical path - same classifier, same dedupe,
     * same budget headroom, same accounting. The anchor asks for the pass's
     * sources to be "gated and screened like round 1"; sharing the code is the
     * only way to make that true rather than asserted.
     *
     * Returns the number of pages added to `fresh`, or -1 when the SEARCH
     * itself failed (no usable hits) - which is a different thing from a search
     * that worked and whose pages all failed to fetch.
     */
    const searchAndFetch = async (q: string): Promise<number> => {
      const hits = rankHits(await runSearch(q));
      if (!hits.length) return -1;
      const seen = (u: string) => staged.some((s) => s.url === u) || fresh.some((s) => s.url === u) ||
                                  kept.some((s) => s.url === u);
      const candidates = hits.filter((h) => !seen(h.url));
      // Headroom = remaining SOURCE budget plus remaining TIMEOUT budget, so we
      // keep trying URLs while either bound has room (a timeout shouldn't burn
      // the source budget). Cache hits below are free and never charged.
      const sourceRoom = Math.max(0, effMaxFetch - sourcesFetched);
      const timeoutRoom = MAX_FETCH_TIMEOUTS > 0 ? Math.max(0, MAX_FETCH_TIMEOUTS - fetchTimeouts) : SEARCH_K;
      const toFetch = candidates.slice(0, Math.max(0, Math.min(SEARCH_K, sourceRoom + timeoutRoom)));
      const results = await mapLimit(toFetch, FETCH_CONCURRENCY, async (h) => {
        const existing = await existingFreshSource(client, h.url).catch(() => null);
        if (existing) {
          return { outcome: "reuse" as const, page: { url: h.url, title: existing.title, content: existing.content, domain: domainOf(h.url) } as Page };
        }
        const fr = await deps.fetchPage(h.url);
        return { outcome: fr.outcome, page: fr.page };
      });
      let added = 0;
      for (const r of results) {
        if (r.outcome === "reuse") {
          reuseHits++;
          searchRecord.fetched++;
          if (r.page) {
            if ((r.page.content || "").length >= READABLE_MIN_CHARS) readableCount++;
            fresh.push(r.page);
            added++;
          }
          continue;
        }
        countFetch(r.outcome as FetchOutcome, r.page);
        if (r.outcome === "ok") {
          searchRecord.fetched++;
          if (r.page && r.page.content) { fresh.push(r.page); added++; }
        }
      }
      await progress(
        "gather",
        `fetched ${searchRecord.fetched} (ok ${sourcesFetched} · readable ${readableCount} · timeout ${fetchTimeouts} · err ${fetchErrors} · reused ${reuseHits})`,
        { fetched: searchRecord.fetched, sources: sourcesFetched, readable: readableCount,
          timeouts: fetchTimeouts, errors: fetchErrors, reused: reuseHits },
      );
      return added;
    };

    for (let round = 1; round <= effRounds && pending.length && !stopGathering; round++) {
      const nextPending: Pending[] = [];
      for (const p of pending) {
        const d = backstopDecision({
          elapsedMs: Date.now() - t0, maxMs: effMaxMs,
          sources: sourcesFetched, maxSources: effMaxFetch,
          timeouts: fetchTimeouts, maxTimeouts: MAX_FETCH_TIMEOUTS, openGaps: 1,
        });
        if (d.stop && d.reason !== "complete") { backstop = d.reason; stopGathering = true; break; }
        if (collapseStreak >= COLLAPSE_STREAK_MAX) {
          backstop = "search_degraded";
          stopGathering = true;
          await progress("gather",
            `${collapseStreak} searches in a row returned nothing that mentions the query - the search plane is degraded`,
            { collapsed: searchStats.collapsed, offtopic: searchStats.offtopic });
          break;
        }
        const got = await searchAndFetch(p.query);
        if (got < 0) {
          if (p.attempts === 0) {
            const retry = reformulate(p.need, subjectEntity, nextPending.length);
            nextPending.push({ need: p.need, query: retry, attempts: 1 });
            followupQueries.push(retry);
          } else {
            setNeedStatus(p.need, "search_failed");
          }
          continue;
        }
        // A need whose search worked is no longer a search failure; whether it is
        // ANSWERED is the coverage judge's call below.
        nextPending.push({ need: p.need, query: p.query, attempts: p.attempts + 1 });
      }

      // Gate this round's haul before deciding whether to keep going: the YIELD
      // target is relevant pages, not fetches (Phase 1.4).
      await gateAndKeep(fresh, "web");
      fresh = [];
      searchRecord.readable = readableCount;

      if (stopGathering) break;
      if (kept.length >= RELEVANT_TARGET) {
        await progress("gather", `reached the yield target: ${kept.length} relevant source(s)`,
          { relevant: kept.length });
        break;
      }
      if (!nextPending.length) break;
      if (round >= effRounds) { pending = nextPending; break; }

      // Which needs are now actually answered by what was KEPT?
      const openNeeds = nextPending.map((p) => p.need);
      const cov = await jsonChat(
        deps, COVERAGE_STAGED_SYS,
        `NEEDS:\n${openNeeds.map((n, i) => `${i}. ${n}`).join("\n")}\n\nGATHERED SOURCES:\n${kept.map((s) => `- ${s.title}: ${s.content.slice(0, 200)}`).join("\n")}`,
      );
      const openIdx = new Set<number>(Array.isArray(cov.open) ? cov.open.map(Number) : []);
      openNeeds.forEach((need, i) => { if (!openIdx.has(i)) setNeedStatus(need, "answered"); });
      const stillOpen = nextPending.filter((_, i) => openIdx.has(i));
      if (!stillOpen.length) break;          // everything covered → stop deepening
      // Refine into more specific queries for the next round (entity enforced).
      const deep = await jsonChat(
        deps, DEEPEN_SYS,
        `STILL-OPEN NEEDS:\n${stillOpen.map((p, i) => `${i}. ${p.need}`).join("\n")}\n\nWHAT WAS FOUND:\n${kept.map((s) => `- ${s.title}`).join("\n")}`,
      );
      const deepQ = Array.isArray(deep.queries) ? deep.queries : [];
      pending = stillOpen.map((p, i) => ({
        need: p.need,
        query: shapeDeepQuery(subjectEntity, p.need, deepQ[i]),
        attempts: p.attempts,
      }));
      followupQueries.push(...pending.map((p) => p.query));
      await progress("deepen", `round ${round}: ${stillOpen.length} need(s) still open`, { round, open: stillOpen.length });
    }

    // Anything still "open" after gathering, whose searches all collapsed, was a
    // SEARCH failure, not an unanswered question.
    if (searchStats.ok === 0 &&
        (searchStats.collapsed > 0 || searchStats.offtopic > 0 || searchStats.empty > 0)) {
      for (const n of needsStatus) if (n.status === "open") n.status = "search_failed";
    }

    // Phase 1.5 — many hits, almost nothing readable, is a FETCH failure.
    // It also overrides "max_fetch": exhausting the fetch budget on pages that
    // could not be read is the degradation, and "max_fetch" describes it as a
    // budget decision, which tells the reader nothing about why there is no
    // answer. A time-based or timeout-based stop keeps its own, more specific,
    // reason.
    if ((backstop === "complete" || backstop === "max_fetch") &&
        searchRecord.hits >= FETCH_DEGRADED_MIN_HITS &&
        readableCount / Math.max(1, searchRecord.hits) < FETCH_DEGRADED_RATIO) {
      backstop = "fetch_degraded";
      await progress("gather",
        `${searchRecord.hits} hits but only ${readableCount} readable page(s) - the fetch path is degraded`,
        { hits: searchRecord.hits, readable: readableCount });
    }

    // The gate has already run on everything; `staged` is the citable pool.
    staged.splice(protectedCount, staged.length - protectedCount, ...kept);
    searchRecord.relevant = kept.length;
    // Carry the per-verdict counts into the RECORD. They were declared on
    // SearchRecord and read by searchHealthLabel()/coverageFooter() from the
    // first version of this branch, and never written — so the footer could
    // not have said DEGRADED on any real run, only on a hand-built fixture in
    // report.test.ts. A field that is read and never written is a check that
    // passes while checking nothing.
    syncRecordCounts();

    // The gap-closing pass, wired but not yet run: it needs the first synthesis
    // to know what is still open. One more round of the SAME search-fetch-gate
    // path, aimed at the needs the synthesis left open.
    gapRound = async (targets) => {
      const before = kept.length;
      for (const t of targets) {
        const d = backstopDecision({
          elapsedMs: Date.now() - t0, maxMs: effMaxMs,
          sources: sourcesFetched, maxSources: effMaxFetch,
          timeouts: fetchTimeouts, maxTimeouts: MAX_FETCH_TIMEOUTS, openGaps: 1,
        });
        // The pass STOPS on a budget; it never RELABELS the run. The first pass
        // has already decided what this run is - `fetch_degraded` on a run whose
        // pages would not read is a diagnosis, and letting a bonus round
        // overwrite it with "max_fetch" would replace why there is no answer
        // with a budget note. Caught by the fetch_degraded case in
        // harness-trust.test.ts, which went max_fetch the moment the pass
        // existed.
        if (d.stop && d.reason !== "complete") {
          await progress("gap_pass", `gap-closing pass stopped early (${d.reason}) - the run's own verdict stands`,
            { stopped: 1 });
          break;
        }
        followupQueries.push(t.query);
        await searchAndFetch(t.query);
      }
      // Same gate, same screen, same fail-safe floor as every other round.
      await gateAndKeep(fresh, "gap-closing");
      fresh = [];
      searchRecord.readable = readableCount;
      staged.splice(protectedCount, staged.length - protectedCount, ...kept);
      searchRecord.relevant = kept.length;
      syncRecordCounts();
      return kept.slice(before);
    };
  } else {
    await progress("seed", `staged ${staged.length} seed source(s); web search disabled`,
      { staged: staged.length });
  }

  // Prompt-injection screen — quarantine any fetched/seed source trying to hijack
  // the reader (defense-in-depth with INJECTION_GUARD on the synth prompts below).
  // A page attacking the reader isn't a trustworthy source; drop it before it can
  // poison the synthesis or get persisted.
  //
  // The topic path screens + gates INSIDE the gather loop (it has to: the yield
  // target counts gate SURVIVORS, so the gate cannot wait until the end). These
  // two blocks therefore serve the article / seed-only / disable_web_search
  // paths, whose behaviour is unchanged.
  if (!topicPath && staged.length) {
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
  if (!topicPath && staged.length > protectedCount) {
    const protectedPages = staged.slice(0, protectedCount);
    const webPages = staged.slice(protectedCount);
    const { relevant: relevantPages, rejected } = await partitionRelevant(deps, webPages, query);
    // FAIL-SAFE FLOOR (operator concern 2026-08-22): the gate must never turn
    // a run into a no-sources failure. If it would empty the web pool (and
    // nothing protected remains to ground from), keep the KEEPABLE pages and
    // say so - the synthesizer's grounding rules + the Sources-cited-only
    // report are the backstop against weak pages, and a thin report beats a
    // dead run. Keepable excludes sub-MIN_JUDGEABLE_CHARS shells (2026-09-05):
    // the floor exists to second-guess a possibly-wrong model verdict, and
    // emptiness is not a verdict - a pool of contentless shells stays empty
    // and the run degrades to honest gaps instead.
    if (relevantPages.length === 0 && protectedPages.length === 0 && webPages.length > 0) {
      const floorPool = floorKeepable(webPages);
      if (floorPool.length > 0) {
        await progress("screen",
          `relevance gate would empty the source pool - keeping ${floorPool.length} of ${webPages.length} page(s) (fail-safe floor; shells stay dropped)`,
          { irrelevant_overridden: floorPool.length, shells_dropped: webPages.length - floorPool.length });
        staged.splice(0, staged.length, ...floorPool);
      } else {
        await progress("screen",
          `all ${webPages.length} web page(s) were contentless shells - proceeding with no web sources`,
          { shells_dropped: webPages.length });
        staged.splice(0, staged.length);
      }
    } else if (rejected.length) {
      await progress("screen",
        `rejected ${rejected.length} source(s): ${rejected.map((r) => r.url).slice(0, 4).join(", ")}${rejected.length > 4 ? ", …" : ""}`,
        { irrelevant: rejected.filter((r) => r.reason === "irrelevant").length,
          shells_dropped: rejected.filter((r) => r.reason === "no_content").length });
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

  // Reuse-claim grounding sources are part of the citable pool on every
  // non-article path, so they must be resolved BEFORE deciding whether there is
  // anything to ground from. (This used to happen after the decision, inside
  // the synthesis branch, which is why the emptiness test could only be made on
  // the topic path.) Article mode cites its seed article and nothing else.
  const reuse = (!articleMode && reuseClaims.length)
    ? await getReuseSources(client, reuseClaims.map((c) => c.id))
    : { sources: [] as Awaited<ReturnType<typeof getReuseSources>>["sources"], claimToSource: {} as Record<string, string> };

  // ── Phase 2.2 — "no relevant sources" is a FIRST-CLASS OUTCOME ─────────────
  // Reached when there is nothing citable: the gate left no page AND no reused
  // claim brings a grounding source with it. The run then does NOT synthesize
  // (there is nothing to synthesize from, and asking the model anyway is how
  // "the provided sources contain no information specific to the Dell OptiPlex
  // 3050" became a stored fact at 0.85), does NOT call the curator, and renders
  // the search record instead of a report.
  //
  // EVERY PATH, not just the topic path (tester, 2026-09-11). This was gated on
  // `topicPath`, so an empty pool in article / sources-only / disable_web_search
  // mode still reached the synthesizer, and with one recalled claim still
  // reached the curator with `sources: []` and the poison sentence as its
  // headline claim. The anchor states criterion 1 unconditionally, and an empty
  // pool means the same thing however the run was configured. A NON-empty pool
  // is untouched on all four paths — this only fires when there is nothing.
  const stagedWithContent = staged.filter((p) => (p.content || "").trim().length > 0);
  const citablePool = stagedWithContent.length + reuse.sources.length;
  const coveredByClaims = Math.max(0, needs.length - gapNeeds.length);
  if (citablePool === 0 && !(topicPath && coveredByClaims > 0)) {
    if (backstop === "complete") backstop = "no_relevant_sources";
    const subj = subjectEntity || query.split(/[:,;]/)[0].trim().slice(0, 80);
    const notice = failureNotice(query, subj, needsStatus, searchRecord, backstop);
    await progress("synthesize",
      `no relevant source was retrieved - reporting a search failure (${backstop})`,
      { relevant: 0, collapsed: searchStats.collapsed, offtopic: searchStats.offtopic });
    await progress("persist", "curator SKIPPED: nothing was grounded");
    return {
      synthesis: "",
      prose: notice,
      reportType: "",
      needs,
      followupQueries,
      gaps: needsStatus.filter((n) => n.status !== "answered").map((n) => n.need),
      reuseClaims: reuseClaims.map((c) => ({ id: c.id, text: c.text })),
      citedSources: [],
      metrics: reuseMetric(0, 0, needsStatus.length),
      // The curator is not called; this is the CuratorOutcome path that keeps
      // research_jobs truthful about it (lib.ts classifyCuratorOutcome).
      curator: { state: "skipped", reason: backstop },
      backstop,
      // A run with nothing citable never reaches the gap-closing pass: there is
      // no synthesis to read open needs out of, and a second round of the same
      // failed searching is not a closing pass.
      gapPass: null,
      // The failure notice is built by report.ts from the run's own record, not
      // written by a model, so there is nothing to diff and nothing to judge.
      proseUngrounded: null,
      renderFidelity: null,
      outcome: "no_relevant_sources",
      needsStatus,
      searchRecord,
      ungroundedNumbers: [],
      fetchStats: {
        sources: sourcesFetched, timeouts: fetchTimeouts, errors: fetchErrors,
        reused: reuseHits, attempts: sourcesFetched + fetchTimeouts + fetchErrors,
        readable: readableCount, errorKinds, search: searchStats,
      },
    };
  }

  // 4. Synthesize verbatim with claim-level citations (sources 1-indexed).
  await progress("synthesize", "writing the grounded synthesis");
  let claimList = reuseClaims.map((c) => `- ${c.text}`).join("\n") || "(none)";
  const sourceLine = (p: Page, i: number, max = SOURCE_SLICE_CHARS) => `[Source ${i + 1}] ${p.title} (${p.domain})\n${p.content.slice(0, max)}`;

  // The source pool the synthesizer can cite, and the buildCitedAndRenumber input.
  // Defaults to `staged`; the default path extends it with reused-claim sources.
  let pool: Page[] = staged;
  let reuseUrls = new Set<string>();

  /**
   * The topic-path synthesis, as a closure because the gap-closing pass runs it
   * a SECOND time over the merged pool. Everything it reads - `staged`, the
   * reuse sources, the claim list - is recomputed from the current state, so
   * the second call sees the pages the pass added and nothing else changes.
   */
  const synthesizeTopic = async (): Promise<string> => {
    // Fold the REUSED claims' grounding sources into the citable pool (after the
    // freshly-staged ones, deduped by url). This lets the synthesizer cite reused
    // facts [Source N] instead of emitting uncited [SOURCED] lines - and, since
    // those sources flow to the curator, re-grounds the synthesis + re-links it
    // to the reused claims (provenance). Closes the reuse-only gap; a reuse-only
    // run (no fresh gather) now still produces a cited, grounded synthesis.
    const stagedUrls = new Set(staged.map((s) => s.url).filter(Boolean));
    const reuseEntries = reuse.sources.filter((s) => !(s.url && stagedUrls.has(s.url)));
    const reusePages: Page[] = reuseEntries.map((s) => ({
      url: s.url || "", title: s.title, content: s.content, domain: s.domain || "",
    }));
    reuseUrls = new Set(reusePages.map((p) => p.url).filter(Boolean));
    pool = [...staged, ...reusePages];

    // source id -> its 0-based index in the pool (reuse sources occupy [staged.length..])
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
    // text already carries the substance - the source is for citation attribution).
    const sourceList = pool
      .map((p, i) => sourceLine(p, i, i < staged.length ? SOURCE_SLICE_CHARS : 900))
      .join("\n\n");
    return (await deps.chat(
      `${INJECTION_GUARD}\n\n${SYNTH_SYS}`,
      `QUESTION: ${query}\n\nKNOWN CLAIMS (already grounded - when you assert one, cite the [Source N] shown next to it):\n${claimList}\n\nSOURCES:\n${sourceList || "(none gathered)"}`,
    )).trim();
  };

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
          // Article mode runs no KEYWORDIZE pass, so there is no subject entity
          // to gate on here: `classifyHits` falls back to the overlap rule (see
          // search-quality.ts). A wrong verdict on a PRELIMINARY gap costs one
          // tentative paragraph, and these findings are already rendered as
          // "preliminary research suggests…" — it is not the audited path.
          const gv = classifyHits(gap, hits);
          if (gv.verdict !== "ok") {
            await progress("gather",
              `preliminary gap search returned no usable results (${gv.verdict})`,
              { prelim_rejected: 1 });
            continue;
          }
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
          // out a preliminary batch that fetched real pages — but shells are
          // not real pages, so they stay dropped even under the floor.
          const prelimPool = floorKeepable(prelimPages);
          const keptPrelim = (gatePrelim.relevant.length === 0 && prelimPool.length > 0)
            ? prelimPool
            : gatePrelim.relevant;
          if (keptPrelim === prelimPool && gatePrelim.rejected.length) {
            await progress("screen", `relevance gate would empty the preliminary batch - keeping ${prelimPool.length} of ${prelimPages.length} (fail-safe floor; shells stay dropped)`,
              { irrelevant_overridden: prelimPool.length, shells_dropped: prelimPages.length - prelimPool.length });
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
    // `reuse` is resolved once, above the empty-pool decision - the decision
    // needs to know whether a reused claim brings a citable source with it.
    rawSynthesis = await synthesizeTopic();
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

  // 4c. Phase 2.3 — numeric grounding. Every figure in a cited line must be in
  //     one of the sources THAT LINE cites. A miss downgrades the line to
  //     [UNCERTAIN] and annotates it; the line is never deleted, because the
  //     sentence around the figure may still be right. Runs BEFORE
  //     buildCitedAndRenumber and is index-safe (line count and every [Source N]
  //     preserved), so the curator's [Source N] → source_ids[N-1] stays aligned.
  //
  // 5. Cited-only sources (GROUNDING-MODEL §6.3) + renumber citations so the
  //    curator's [Source N] → source_ids[N-1] resolution stays aligned with the
  //    compacted cited list.
  //
  // Both are one closure because the gap-closing pass produces a SECOND raw
  // synthesis, and a second synthesis that skipped the numeric gate would be a
  // hole straight through the run's grounding - the pass exists to add sources,
  // which is exactly when a new figure can arrive uncited.
  const harden = async (raw: string): Promise<{ synthesis: string; cited: Page[] }> => {
    const g = applyNumericGrounding(raw, pool.map((p) => p.content));
    ungroundedNumbers = g.ungrounded;
    let out = raw;
    if (g.ungrounded.length) {
      out = g.synthesis;
      await progress("synthesize",
        `${g.ungrounded.length} line(s) asserted a figure no cited source holds - downgraded to [UNCERTAIN]`,
        { ungrounded_numbers: g.ungrounded.length });
    }
    return buildCitedAndRenumber(out, pool);
  };
  let { synthesis, cited } = await harden(rawSynthesis);

  // Templated report rendering (templates.ts, 2026-08-22) — the human-facing
  // answer is now a PROFESSIONAL REPORT: the run is classified into a report
  // type (scientific paper, technical proposal, product comparison, …) and the
  // grounded synthesis is rendered into that template. The tagged `synthesis`
  // is preserved as the machine-truth the curator decomposes into claims; the
  // report keeps the SAME [Source N] numbers, so wiki source-leaf deep-links
  // still resolve. Best-effort: a render failure leaves prose empty and the
  // renderers fall back to the tagged synthesis.
  //
  // Phase 4.2 — the topic template is consulted only once the evidence can fill
  // it. A run that answered fewer than TEMPLATE_MIN_ANSWERED needs gets the
  // general report: the scientific-paper template's Abstract/Discussion headings
  // are assertions in themselves, and over an empty pool they produced
  // "Absence of Evidence for 100 Hz Auditory Tones…", which reads as a finding.
  if (!needsStatus.length) {
    needsStatus = needs.map((need) => ({
      need,
      status: (gapNeeds.includes(need) ? "open" : "answered") as NeedStatus,
    }));
  }
  // Reconcile the judge's per-need verdicts with what the synthesis actually
  // grounded (research-trust-entity). Live dry run 1f2ff740 cited 11 sources,
  // grounded 25 lines, and printed "needs answered 0 of 6" because
  // COVERAGE_STAGED marked every need open — a footer contradicting its own
  // report. A need the synthesis grounds becomes `partial`; `answered` is never
  // manufactured here, and `search_failed` is never reopened.
  needsStatus = reconcileNeedsStatus(needsStatus, synthesis);

  // ── The gap-closing pass (research-trust-report) ────────────────────────────
  // The operator: "when the answer isn't complete enough there should be a
  // recommendation to perform an additional run - or better yet, perform the
  // additional run before sending an incomplete result back to the end user."
  // So the run closes what it can before delivering, and the interim progress
  // event below is what tells the person it is doing so.
  //
  // Bounded by construction: ONE pass (`gapRound` is nulled after it runs),
  // at most GAP_PASS_MAX_QUERIES searches, only while most of the wall clock is
  // unspent, only on the topic path (nothing else assigns `gapRound`), and only
  // when something is actually open. The curator has not been called yet - it is
  // delegated to once, below, with whatever this pass leaves behind.
  {
    const stillOpen = needsStatus.filter((n) => n.status === "open" || n.status === "partial");
    const elapsedRatio = (Date.now() - t0) / Math.max(1, effMaxMs);
    // `backstop === "complete"` is a precondition, not politeness: a run that
    // already tripped a backstop has said why it stopped, and a second round of
    // the same exhausted budget cannot close anything. Those runs get the
    // recommendation in the report's limitations section instead, which is the
    // other half of what the operator asked for.
    // `contract.budget.rounds: 1` bounds the PASS as well as the gather loop
    // (tester, X3). A caller who caps a job at one round is capping the work it
    // may do, and a second round of searching plus a second synthesis is
    // exactly that work - the pass's own bounds (one-shot, three queries, the
    // clock) are not the contract's, and the contract is the one the caller
    // wrote. The pass needs a round to spend, so it runs only when the job was
    // allowed more than one.
    const roundsAllowed = effRounds > 1;
    if (gapRound && stillOpen.length && synthesis.trim() && roundsAllowed &&
        backstop === "complete" && elapsedRatio < GAP_PASS_MAX_ELAPSED) {
      const answeredBefore = needsStatus.filter((n) => n.status === "answered").length;
      // The queries come from what the SYNTHESIS said it could not answer, not
      // from the needs as asked - and through `shapeQuery`, so the pass cannot
      // emit the one-word query the entity floor exists to refuse.
      const targets = gapQuestions(stillOpen.map((n) => n.need), synthesis)
        .slice(0, GAP_PASS_MAX_QUERIES)
        .map(({ need, question }) => {
          const shaped = shapeQuery(subjectEntity, question);
          if (shaped.padded) searchStats.query_padded++;
          return { need, query: shaped.query };
        });
      if (targets.length) {
        // The INTERIM message. index.ts turns this one event into a chat write,
        // so the reader is told a second pass is running instead of waiting on
        // a message that says nothing for another two minutes.
        await progress("gap_pass",
          `First pass complete: ${answeredBefore} of ${needsStatus.length} needs answered - running a gap-closing pass to close the rest`,
          { interim: 1, answered: answeredBefore, total: needsStatus.length, queries: targets.length });
        const run = gapRound;
        gapRound = null;                       // never twice, whatever happens below
        const added = await run(targets);
        if (added.length) {
          rawSynthesis = await synthesizeTopic();
          ({ synthesis, cited } = await harden(rawSynthesis));
          needsStatus = reconcileNeedsStatus(needsStatus, synthesis);
        }
        const answeredAfter = needsStatus.filter((n) => n.status === "answered").length;
        gapPass = { added: added.length, answeredBefore, answeredAfter, total: needsStatus.length };
        await progress("gap_pass",
          `gap-closing pass: +${added.length} source(s), needs answered ${answeredBefore} -> ${answeredAfter} of ${needsStatus.length}`,
          { added: added.length, answered: answeredAfter, total: needsStatus.length });
      }
    }
  }

  const answeredNeeds = needsStatus.filter((n) => n.status === "answered").length;
  const partialNeeds = needsStatus.filter((n) => n.status === "partial").length;
  let prose = "";
  let reportType = "";
  if (synthesis.trim()) {
    try {
      // PARTLY-answered needs count toward the threshold now (report.ts). The
      // live run 33250e9b had seven needs with 26 cited lines between them, all
      // marked `partial`, and fell to the general report because `answered` was
      // 0 - a buyer's question delivered as a bare fact list.
      const classify = shouldClassifyTemplate(answeredNeeds, partialNeeds);
      const choice = classify
        ? await classifyReport(deps, query, synthesis)
        : { template: templateById(DEFAULT_TEMPLATE_ID), purpose: "" as const };
      reportType = choice.template.id;
      await progress("synthesize",
        `report template: ${choice.template.name}${choice.purpose ? ` (purpose: ${choice.purpose})` : ""}` +
        `${classify ? "" : " (evidence too thin to classify)"}`);
      prose = (await deps.chat(renderSys(choice.template), `QUESTION: ${query}\n\nGROUNDED ANSWER:\n${synthesis}`)).trim();
    } catch (e) {
      await progress("synthesize", `report rendering skipped: ${(e as Error).message}`);
    }
  }
  // Phase 4.1 — the footer states how much of the QUESTION was answered. It is
  // appended here (not only in renderResult) so the curator's stored `prose` and
  // the chat rendering carry the same, honest, number.
  // The last place a fact can enter this run ungrounded is the template render,
  // which is a model writing prose. Measured, recorded, never hidden - the same
  // treatment the figures already get (applyNumericGrounding). It does not
  // block: a report is not thrown away over an acronym, and an operator who can
  // see the leak can judge it. Run on the BODY, before the footer and without
  // the Sources list, which legitimately carries URLs the prose does not.
  // Every rendered sentence that cites something is checked against what it
  // cites, and anything claiming MORE is rewritten once and then, if it still
  // does, replaced by the cited line verbatim (fidelity.ts). This runs on the
  // report that SHIPS - after the gap-closing pass, which is the only render
  // this path performs - and before the grounding diff, so what the diff
  // records is what the reader gets. Fail-open: a broken judge leaves the
  // document alone and says so in the footer.
  if (prose) {
    const fid = await checkRenderFidelity(deps, prose, synthesis, query);
    prose = fid.rendered;
    renderFidelity = fid.record;
    const corrected = fid.record.rewritten + fid.record.replaced;
    if (fid.record.error) {
      await progress("synthesize", `the render fidelity check did not run: ${fid.record.error}`,
        { fidelity_checked: 0 });
    } else {
      // The record's N and M were both counted on the DELIVERED document by
      // the check itself (fidelity.ts `countAgainst`); this only asserts it,
      // because a denominator the reader cannot reproduce from the artifact in
      // front of them is the tester's X4 and the reviewer's K.10 in one number.
      if (fid.record.units !== countUnits(prose)) {
        await progress("synthesize",
          `render check accounting mismatch: recorded ${fid.record.units} unit(s), the document has ${countUnits(prose)}`,
          { fidelity_units: fid.record.units });
      }
      if (fid.record.polarity_skipped) {
        await progress("synthesize",
          `polarity: ${fid.record.polarity_skipped} unit(s) left as written (` +
          `${fid.record.polarity_default} by the conservative default), ` +
          `${fid.record.duplicate_skipped} left as a duplicate`,
          { polarity_skipped: fid.record.polarity_skipped,
            polarity_default: fid.record.polarity_default });
      }
      if (fid.record.names_blocked.length) {
        await progress("synthesize",
          `names blocked: ${fid.record.names_blocked.join(", ")} - the grounded answer never uses them`,
          { names_blocked: fid.record.names_blocked.length });
      }
      await progress("synthesize",
        `render checked: ${fid.record.checked} of ${fid.record.units} unit(s), ` +
        `${fid.record.stronger} stronger, ${fid.record.unsupported} unsupported, ` +
        `${fid.record.rewritten} rewritten, ${fid.record.replaced} replaced verbatim, ` +
        `${fid.record.unchecked} unchecked`,
        { fidelity_checked: fid.record.checked, fidelity_units: fid.record.units,
          fidelity_corrected: corrected, fidelity_unchecked: fid.record.unchecked });
    }
  }
  if (prose) {
    proseUngrounded = renderGroundingDiff(prose, synthesis, query);
    // A citation a sentence does not use is a provenance defect a reader can
    // follow to a source that does not support the row (tester X3). Reported
    // beside the other leaks, never corrected: deleting a citation would be the
    // engine editing a claim's evidence on a word count.
    proseUngrounded.citations = supersetCitations(prose, synthesis);
    const leaks = proseUngrounded.numbers.length + proseUngrounded.urls.length +
                  proseUngrounded.names.length;
    if (leaks) {
      await progress("synthesize",
        `the rendered report carries ${leaks} item(s) the grounded answer does not: ` +
        [...proseUngrounded.numbers, ...proseUngrounded.urls, ...proseUngrounded.names].slice(0, 8).join(", "),
        { prose_ungrounded: leaks });
    }
  }
  if (prose && topicPath) {
    prose = `${prose}\n\n_— ${coverageFooter(needsStatus, searchRecord, backstop, gapPass, renderFidelity)}_`;
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
      report_type: reportType || undefined, // template id (curator → sources.metadata → wiki)
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
    gapPass, proseUngrounded, renderFidelity,
    outcome: "complete",
    needsStatus,
    searchRecord,
    ungroundedNumbers,
    // Separated fetch accounting (yield vs waste) — informs the operator/user
    // why a run stopped: sources retrieved vs timeouts vs errors vs cache reuse.
    fetchStats: {
      sources: sourcesFetched,
      timeouts: fetchTimeouts,
      errors: fetchErrors,
      reused: reuseHits,
      attempts: sourcesFetched + fetchTimeouts + fetchErrors,
      readable: readableCount,
      errorKinds,
      search: searchStats,
    },
    skeptic,
  };
}
