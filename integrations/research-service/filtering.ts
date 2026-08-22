/**
 * filtering.ts — source-quality filtering for the research engine
 * (operator request 2026-08-22).
 *
 * Two mechanisms, both upstream of the synthesis so junk never becomes
 * evidence:
 *
 *   1. rankHits — credibility-ranked search results. Research queries should
 *      pull from credible domains first (.edu/.gov, journals, scholar,
 *      official docs) and fan out to product/vendor pages only as the
 *      credible pool thins. Retail/commerce domains (the "SaaS api tools" →
 *      lowes.com failure) sink to the bottom. Stable sort: within a tier the
 *      engine's own relevance order is preserved.
 *
 *   2. isRelevant / partitionRelevant — a deterministic per-page LLM gate:
 *      does the fetched page actually contain information pertaining to the
 *      research question (the "prompt anchor")? One word, nothink, fail-OPEN
 *      (a model blip must never silently discard a legit source — the
 *      synthesizer's grounding rules remain the backstop).
 */
import type { Deps, Page, SearchHit } from "./harness.ts";

// ── Domain credibility tiers (data-driven; extend the lists, not the code) ──

/** Highest credibility — academic, government, standards, journals. */
const TIER_SCHOLARLY: RegExp[] = [
  /(^|\.)scholar\.google\.[a-z.]+$/, /(^|\.)arxiv\.org$/, /(^|\.)ncbi\.nlm\.nih\.gov$/,
  /(^|\.)pubmed\.gov$/, /(^|\.)nature\.com$/, /(^|\.)science\.org$/,
  /(^|\.)sciencedirect\.com$/, /(^|\.)springer\.com$/, /(^|\.)link\.springer\.com$/,
  /(^|\.)jstor\.org$/, /(^|\.)semanticscholar\.org$/, /(^|\.)ieee\.org$/,
  /(^|\.)ieeexplore\.ieee\.org$/, /(^|\.)acm\.org$/, /(^|\.)dl\.acm\.org$/,
  /(^|\.)researchgate\.net$/, /(^|\.)plos\.org$/, /(^|\.)pnas\.org$/,
  /\.edu$/, /\.gov$/, /\.ac\.[a-z]{2}$/, /\.edu\.[a-z]{2}$/, /\.gov\.[a-z]{2}$/,
];

/** Reference / official-documentation tier. */
const TIER_REFERENCE: RegExp[] = [
  /(^|\.)wikipedia\.org$/, /(^|\.)readthedocs\.io$/, /(^|\.)learn\.microsoft\.com$/,
  /(^|\.)developer\.mozilla\.org$/, /(^|\.)docs\.github\.com$/, /(^|\.)w3\.org$/,
  /(^|\.)ietf\.org$/, /(^|\.)iso\.org$/, /(^|\.)nist\.gov$/,
  /^docs\./, /^developer\./, /^dev\./,
];

/** Useful practitioner tier. */
const TIER_PRACTITIONER: RegExp[] = [
  /(^|\.)github\.com$/, /(^|\.)stackoverflow\.com$/, /(^|\.)stackexchange\.com$/,
];

/** Retail / commerce / low-signal — the classic false-positive pool for
 *  research terms like "tools". */
const TIER_RETAIL: RegExp[] = [
  /(^|\.)amazon\.[a-z.]+$/, /(^|\.)ebay\.[a-z.]+$/, /(^|\.)walmart\.com$/,
  /(^|\.)lowes\.com$/, /(^|\.)homedepot\.com$/, /(^|\.)bestbuy\.com$/,
  /(^|\.)target\.com$/, /(^|\.)etsy\.com$/, /(^|\.)aliexpress\.[a-z.]+$/,
  /(^|\.)alibaba\.com$/, /(^|\.)temu\.com$/, /(^|\.)wayfair\.com$/,
  /(^|\.)pinterest\.[a-z.]+$/, /(^|\.)groupon\.com$/, /(^|\.)wish\.com$/,
  /(^|\.)harborfreight\.com$/, /(^|\.)acehardware\.com$/, /(^|\.)menards\.com$/,
];

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** Credibility score for a URL. Higher = fetched earlier. */
export function scoreDomain(url: string): number {
  const h = hostOf(url);
  if (!h) return 0;
  if (TIER_RETAIL.some((re) => re.test(h))) return -3;
  if (TIER_SCHOLARLY.some((re) => re.test(h))) return 3;
  if (TIER_REFERENCE.some((re) => re.test(h))) return 2;
  if (TIER_PRACTITIONER.some((re) => re.test(h))) return 1;
  if (h.endsWith(".org")) return 1;
  return 0;
}

/** Stable credibility sort: score desc, engine order within a tier. */
export function rankHits(hits: SearchHit[]): SearchHit[] {
  return hits
    .map((h, i) => ({ h, i, s: scoreDomain(h.url) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((x) => x.h);
}

// ── Per-page relevance gate ────────────────────────────────────────────────

const RELEVANCE_SYS =
  `You screen a fetched web page for a research engine. Decide whether the page contains information RELEVANT to the RESEARCH QUESTION — facts, analysis, documentation, comparisons, or context a researcher answering that question could actually use.

IRRELEVANT examples: a retail/product listing that merely shares a keyword with the question ("tools"), an unrelated topic, a navigation/landing shell with no substance, a page purely about a different subject.
RELEVANT examples: any page with substantive content that bears on the question, even partially, even from an unexpected angle.

When genuinely unsure, answer RELEVANT (the synthesis stage judges evidence strength — your job is only to drop clear noise).

Answer with ONLY one word: RELEVANT or IRRELEVANT.`;

/** One deterministic check (nothink). Fails OPEN — a model blip never drops a
 *  source; only a confident IRRELEVANT verdict does. */
export async function isRelevant(deps: Deps, page: Page, anchor: string): Promise<boolean> {
  const content = (page.content || "").slice(0, 3500);
  if (content.trim().length < 20) return true; // nothing to judge; screening/synthesis handle it
  let raw: string;
  try {
    raw = await deps.chat(
      RELEVANCE_SYS,
      `RESEARCH QUESTION: ${anchor}\n\nURL: ${page.url}\nTITLE: ${page.title}\n\nPAGE CONTENT (excerpt):\n${content}`,
      { nothink: true },
    );
  } catch {
    return true; // fail-open
  }
  const v = (raw || "").toUpperCase();
  return !(v.includes("IRRELEVANT") && !v.replace(/IRRELEVANT/g, "").includes("RELEVANT"));
}

export interface RelevanceResult {
  relevant: Page[];
  rejected: Array<{ url: string; title: string }>;
}

/** Partition pages by relevance to the anchor (bounded concurrency). */
export async function partitionRelevant(
  deps: Deps,
  pages: Page[],
  anchor: string,
  concurrency = 4,
): Promise<RelevanceResult> {
  const verdicts = new Array<boolean>(pages.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      while (i < pages.length) {
        const idx = i++;
        verdicts[idx] = await isRelevant(deps, pages[idx], anchor);
      }
    }),
  );
  const relevant: Page[] = [];
  const rejected: Array<{ url: string; title: string }> = [];
  pages.forEach((p, idx) => {
    if (verdicts[idx]) relevant.push(p);
    else rejected.push({ url: p.url, title: p.title });
  });
  return { relevant, rejected };
}
