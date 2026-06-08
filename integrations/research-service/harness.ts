/**
 * The research harness (Research Engine P4) — pure orchestration over injected
 * seams + a DB client. NO server, NO global side effects: importable by tests.
 * index.ts wires the real seams (llama-cpp / SearXNG / fetch / curator) and the
 * HTTP + job layer around `runResearch`.
 *
 * Governing specs: GROUNDING-MODEL.md + PLAN-research-engine.md §6 + OD-5/OD-6.
 */
import { domainOf, decideReuse, backstopDecision, reuseMetric, buildCitedAndRenumber } from "./lib.ts";
import { retrieveRelevantClaims, createStagingSession, stageSource, existingFreshSource } from "./kb.ts";

// Tunables (env-read; reading env does not start a server).
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const SEARCH_K = parseInt(env("SEARCH_K", "8"), 10);
const CLAIM_SHORTLIST_K = parseInt(env("CLAIM_SHORTLIST_K", "12"), 10);
const CONFIDENCE_FLOOR = parseFloat(env("CONFIDENCE_FLOOR", "0.50"));
const FETCH_CONCURRENCY = parseInt(env("FETCH_CONCURRENCY", "4"), 10);
const MAX_FETCH = parseInt(env("MAX_FETCH", "24"), 10);
const MAX_WALL_MS = parseInt(env("MAX_WALL_MS", "180000"), 10);
const EMBEDDING_MAX_CHARS = parseInt(env("EMBEDDING_MAX_CHARS", "4000"), 10);
// #5 — drop claims farther than this (cosine distance) from the query so an
// unscoped run doesn't reuse irrelevant grounded claims.
const REUSE_MAX_DISTANCE = parseFloat(env("REUSE_MAX_DISTANCE", "0.55"));
// #1 — iterative deepening: up to this many gather rounds, refining queries from
// what was found until the needs are covered or the backstop trips.
const MAX_ROUNDS = parseInt(env("MAX_ROUNDS", "3"), 10);

// ── Seams (injectable for tests) ────────────────────────────────────────────
export interface SearchHit { url: string; title: string; snippet: string; }
export interface Page { url: string; title: string; content: string; domain: string; }
export interface Deps {
  embed(text: string): Promise<number[]>;
  chat(system: string, user: string, opts?: { json?: boolean; nothink?: boolean }): Promise<string>;
  searchWeb(query: string, k: number): Promise<SearchHit[]>;
  fetchPage(url: string): Promise<Page | null>;
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

// ── Public types ─────────────────────────────────────────────────────────────
export interface RunOptions { threadId?: string | null; origin?: string; confidenceFloor?: number; }
export interface RunResult {
  synthesis: string;
  needs: string[];
  gaps: string[];
  reuseClaims: { id: string; text: string }[];
  citedSources: { url: string | null; title: string }[];
  metrics: ReturnType<typeof reuseMetric>;
  curator: Record<string, unknown> | null;
  backstop: string;
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

  // 1. Reuse pass — recall relevant grounded claims (cheap).
  await progress("reuse", "recalling grounded claims from the KB");
  const queryEmb = await deps.embed(query);
  const relevant = await retrieveRelevantClaims(client, queryEmb, threadId, CLAIM_SHORTLIST_K, REUSE_MAX_DISTANCE);
  const reuseClaims = relevant.filter((c) => decideReuse(c, floor, now) === "reuse");

  // 2. Plan → coverage → gaps.
  await progress("plan", "decomposing the question into needs");
  const decomp = await jsonChat(deps, DECOMPOSE_SYS, `QUESTION: ${query}`);
  const needs: string[] = Array.isArray(decomp.needs) && decomp.needs.length
    ? decomp.needs.map(String).slice(0, 7) : [query];

  let gapNeeds: string[] = needs;
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

  // 3. Stage gaps only — ITERATIVE deepening (#1): gather a round, re-check which
  //    needs the gathered sources actually cover, refine queries for the
  //    still-open needs, and gather again — up to MAX_ROUNDS or the backstop.
  const sessionId = await createStagingSession(client, query, threadId, opts.origin || "owui");
  const staged: Page[] = [];
  let fetches = 0;
  let backstop = "complete";

  // One gather pass over a list of search queries. Returns false if the backstop
  // tripped mid-pass (caller stops).
  const gatherQueries = async (queries: string[]): Promise<boolean> => {
    for (const q of queries) {
      const d = backstopDecision({ elapsedMs: Date.now() - t0, maxMs: MAX_WALL_MS, fetches, maxFetches: MAX_FETCH, openGaps: 1 });
      if (d.stop && d.reason !== "complete") { backstop = d.reason; return false; }
      await progress("gather", `searching: ${q}`);
      let hits: SearchHit[] = [];
      try { hits = await deps.searchWeb(q, SEARCH_K); } catch { hits = []; }
      const fresh = hits.filter((h) => !staged.some((s) => s.url === h.url));
      const toFetch = fresh.slice(0, Math.max(0, Math.min(SEARCH_K, MAX_FETCH - fetches)));
      const pages = await mapLimit(toFetch, FETCH_CONCURRENCY, async (h) => {
        const existing = await existingFreshSource(client, h.url).catch(() => null);
        if (existing) return { url: h.url, title: existing.title, content: existing.content, domain: domainOf(h.url) } as Page;
        return await deps.fetchPage(h.url);
      });
      fetches += toFetch.length;
      for (const p of pages) if (p && p.content) staged.push(p);
      await progress("gather", `staged ${staged.length} sources (${fetches} fetched)`, { staged: staged.length, fetches });
    }
    return true;
  };

  let pendingNeeds = [...gapNeeds];
  for (let round = 1; round <= MAX_ROUNDS && pendingNeeds.length; round++) {
    const ok = await gatherQueries(pendingNeeds);
    if (!ok) break;                       // backstop tripped
    if (round >= MAX_ROUNDS) break;       // no point re-planning on the last round
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
    await progress("deepen", `round ${round}: ${stillOpen.length} need(s) still open`, { round, open: stillOpen.length });
  }

  // Persist staged candidates into the session pool (dedup vs OB).
  await mapLimit(staged, FETCH_CONCURRENCY, async (p) => {
    try {
      const emb = await deps.embed(`${p.title}\n\n${p.content}`.slice(0, EMBEDDING_MAX_CHARS));
      await stageSource(client, sessionId, p, emb);
    } catch { /* best-effort staging */ }
  });

  // 4. Synthesize verbatim with claim-level citations (sources 1-indexed).
  await progress("synthesize", "writing the grounded synthesis");
  const sourceList = staged.map((p, i) => `[Source ${i + 1}] ${p.title} (${p.domain})\n${p.content.slice(0, 2000)}`).join("\n\n");
  const claimList = reuseClaims.map((c) => `- ${c.text}`).join("\n") || "(none)";
  const rawSynthesis = (await deps.chat(
    SYNTH_SYS,
    `QUESTION: ${query}\n\nKNOWN CLAIMS (already grounded; reuse as support):\n${claimList}\n\nSOURCES:\n${sourceList || "(none gathered)"}`,
  )).trim();

  // 5. Cited-only sources (GROUNDING-MODEL §6.3) + renumber citations so the
  //    curator's [Source N] → source_ids[N-1] resolution stays aligned with the
  //    compacted cited list. Delegate to curator (verbatim storage + claims, P2).
  const { synthesis, cited } = buildCitedAndRenumber(rawSynthesis, staged);
  const gapMatches = synthesis.match(/\[GAP\]/gi) || [];
  // Reuse signal = needs actually COVERED by existing claims (needs - gaps), not
  // every grounded claim the recall pulled (which overcounts when an unscoped
  // query drags in semantically-near but irrelevant claims). This is the honest
  // compounding-reuse number for the trend (PLAN §6 / P4.5).
  const coveredNeeds = Math.max(0, needs.length - gapNeeds.length);
  const metrics = reuseMetric(coveredNeeds, cited.length, gapMatches.length);

  await progress("persist", "delegating placement + grounding to the curator");
  let curator: Record<string, unknown> | null = null;
  if (cited.length || reuseClaims.length) {
    const pkg = {
      research_key: `rs-${await sha1(query + (threadId || ""))}`,
      query,
      claim: firstParagraph(synthesis).slice(0, 600),
      synthesis,
      kind: "deep_research",
      topic_hint: opts.origin || "research",
      thread_id: threadId || undefined,
      sources: cited.map((p) => ({ url: p.url, title: p.title, content: p.content, domain: p.domain })),
    };
    try { curator = await deps.delegateToCurator(pkg); } catch (e) { curator = { error: String((e as Error).message) }; }
  }

  return {
    synthesis, needs,
    gaps: gapMatches.length ? gapNeeds : [],
    reuseClaims: reuseClaims.map((c) => ({ id: c.id, text: c.text })),
    citedSources: cited.map((p) => ({ url: p.url, title: p.title })),
    metrics, curator, backstop,
  };
}
