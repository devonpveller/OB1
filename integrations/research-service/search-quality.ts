/**
 * search-quality.ts — is this result set an ANSWER, or did the engine break?
 *
 * PLAN-research-trust-2026-09-11 Phase 1.1. Pure: no deps, no env, no I/O.
 *
 * The failure this exists for (audit 2026-09-11): SearXNG's only answering
 * general engine collapsed every multi-word query onto its first salient token
 * and returned ten on-topic-for-THAT-token pages with HTTP 200 — "most" gave
 * the MOST 529 college plan, "Dell" gave dell.com, "100 Hz …" gave The 100 (TV
 * series). Nothing downstream could tell that from "this topic has no sources",
 * so two runs concluded absence of evidence and one of those conclusions was
 * stored in the knowledge base as a fact.
 *
 * The measurement is the one used in
 * documentation/notes/search-engine-alternatives-2026-09-11.md, where working
 * engines scored 0.57-1.00 and the broken one scored 0.00 on all 12 audited
 * queries — a cut at 0.3 separated them with no overlap.
 */

export interface SearchHit { url: string; title: string; snippet: string; }

export type SearchVerdict = "ok" | "collapsed" | "empty";
export interface SearchQuality {
  verdict: SearchVerdict;
  /** Fraction of hits whose title+snippet carry >= 2 distinct query terms. */
  overlap: number;
  /** The single query token the hit TITLES piled onto, when collapsed. */
  collapsedOn?: string;
}

/** Below this overlap a result set is not answering the query. */
export const COLLAPSE_OVERLAP = 0.3;
/** …and this share of TITLES must carry one single query token for it to be
 *  the first-token collapse signature rather than merely a weak search. */
export const COLLAPSE_TITLE_SHARE = 0.6;

const STOP = new Set(
  ("a an the and or of for to in on at by with from as is are was were be been being " +
   "what which who whom how why when where does do did can could should would will shall " +
   "this that these those it its their there here about into over under than then so such " +
   "not no have has had specific most more established using used use other others reported " +
   "known associated required steps run interpret check assess indicate prior compare affect")
    .split(" "),
);

/** Query/document tokens: lowercase alphanumerics, >1 char, stopwords dropped. */
export function terms(s: string): string[] {
  return (String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Every token, stopwords INCLUDED — used only to find the token the titles
 * piled onto. The audited collapses landed on "most", "specific", "can",
 * "steps", "should", "does" and "there": on 7 of the 12 baseline queries the
 * collapse token is a stopword, so a stopword-filtered dominance test is blind
 * to the majority of the failure it exists to catch. Measured 2026-09-11
 * against the live gateway; see documentation/notes/research-trust-findings.md.
 */
function allTerms(s: string): string[] {
  return (String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 1);
}

// `terms()` only ever yields [a-z0-9]+, so there is nothing to regex-escape —
// keeping it that way is why this builds no pattern from untrusted text.
function has(text: string, term: string): boolean {
  return new RegExp("(?<![a-z0-9])" + term + "(?![a-z0-9])").test(text);
}

/**
 * Fraction of hits whose title+snippet contain at least `min` distinct query
 * terms. `min` is 2 — EXCEPT for a query that has fewer than 2 scoreable terms
 * at all, where 2 is unreachable and would score every possible result set 0.00
 * and condemn a working engine.
 */
export function overlapRatio(query: string, hits: SearchHit[]): number {
  if (!hits.length) return 0;
  const qt = [...new Set(terms(query))];
  if (!qt.length) return 1;                 // nothing to match on — not the engine's fault
  const min = Math.min(2, qt.length);
  let good = 0;
  for (const h of hits) {
    const text = `${h?.title || ""} ${h?.snippet || ""}`.toLowerCase();
    let present = 0;
    for (const t of qt) if (has(text, t)) present++;
    if (present >= min) good++;
  }
  return good / hits.length;
}

/** The query token that the greatest share of TITLES carries, with that share. */
function dominantTitleTerm(query: string, hits: SearchHit[]): { term: string; share: number } {
  const qt = [...new Set(allTerms(query))];
  let best = { term: "", share: 0 };
  for (const t of qt) {
    let n = 0;
    for (const h of hits) if (has(String(h?.title || "").toLowerCase(), t)) n++;
    const share = n / hits.length;
    if (share > best.share) best = { term: t, share };
  }
  return best;
}

/**
 * Classify one result set. A `collapsed` verdict means the SEARCH failed —
 * the caller must count it as a search failure and must never let it read as
 * evidence that the topic is absent.
 */
export function classifyHits(query: string, hits: SearchHit[]): SearchQuality {
  const list = Array.isArray(hits) ? hits.filter((h) => h && h.url) : [];
  if (!list.length) return { verdict: "empty", overlap: 0 };
  const overlap = overlapRatio(query, list);
  if (overlap >= COLLAPSE_OVERLAP) return { verdict: "ok", overlap };
  const dom = dominantTitleTerm(query, list);
  if (dom.share >= COLLAPSE_TITLE_SHARE) {
    return { verdict: "collapsed", overlap, collapsedOn: dom.term };
  }
  // Low overlap with no single dominant token: a weak search, not a broken
  // engine. Saying "collapsed" here would be a diagnosis we cannot support.
  return { verdict: "ok", overlap };
}

/** Per-run search accounting (RunResult.fetchStats.search). */
export interface SearchStats {
  calls: number; ok: number; collapsed: number; empty: number; errors: number;
}
export function emptySearchStats(): SearchStats {
  return { calls: 0, ok: 0, collapsed: 0, empty: 0, errors: 0 };
}
