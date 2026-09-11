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

/**
 * `offtopic` was added 2026-09-11 after the tester showed that ten pages of
 * pure noise ("Best Buy Deals 1..10" for an OptiPlex query) were classified
 * `ok`, because the old rule only recognised junk that piled onto a query
 * TOKEN. An engine that drifts semantically was invisible, and its output spent
 * the fetch and relevance-gate budget while `SearchStats.ok` counted it as
 * engine health. `collapsed` and `offtopic` differ only in whether we can NAME
 * the token; both mean the search did not answer the query.
 */
export type SearchVerdict = "ok" | "collapsed" | "offtopic" | "empty";
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
/**
 * Below this many hits, a low score is not a verdict about the engine. A
 * three-hit answer to an obscure question is thin, not broken, and condemning
 * it would be the same overreach in the other direction.
 */
export const OFFTOPIC_MIN_HITS = 5;
/**
 * A query term this long is DISTINCTIVE enough that a hit containing it alone
 * is on topic ("CrashLoopBackOff", "semaglutide", "vestibular"). Short tokens
 * are not: the audited collapses piled onto "dell", "most" and "100", and if
 * any single token could vouch for a hit the recorded failures would classify
 * `ok` and this whole module would be undone. Seven is above every collapse
 * token measured on 2026-09-11 and below the shortest real anchor seen.
 */
export const ANCHOR_MIN_LEN = 7;

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
  const anchor = anchorTerm(qt);
  let good = 0;
  for (const h of hits) {
    const text = `${h?.title || ""} ${h?.snippet || ""}`.toLowerCase();
    let present = 0;
    for (const t of qt) if (has(text, t)) present++;
    // A hit carrying the DISTINCTIVE anchor term is on topic even if it is the
    // only query word in it: "Debug CrashLoopBackOff" answers "Kubernetes
    // CrashLoopBackOff diagnose". Without this, a query whose subject is one
    // strong token plus generic words scored 0.00 on a perfect result set.
    if (present >= min || (anchor && present >= 1 && has(text, anchor))) good++;
  }
  return good / hits.length;
}

/** The longest query term, when it is long enough to vouch for a hit alone. */
export function anchorTerm(queryTerms: string[]): string {
  let best = "";
  for (const t of queryTerms) if (t.length > best.length) best = t;
  return best.length >= ANCHOR_MIN_LEN ? best : "";
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
  // No dominant token, but a full page of results in which NOTHING mentions the
  // query: the engine answered a different question. We cannot name the token,
  // so we do not claim to — but calling this `ok` told the run its search had
  // worked and spent the whole fetch budget on noise.
  if (overlap === 0 && list.length >= OFFTOPIC_MIN_HITS) {
    return { verdict: "offtopic", overlap };
  }
  // A thin or partially-relevant set: a weak search, not a broken engine.
  // Saying anything stronger here would be a diagnosis we cannot support.
  return { verdict: "ok", overlap };
}

// ── Query shaping (Phase 1.2) ───────────────────────────────────────────────
// Round 1 used to search the DECOMPOSE questions verbatim — long natural
// language, the worst possible input. Note that on the audited engine this was
// NOT the cause of the collapse (a two-token query collapsed identically,
// measured 15/15 in search-engine-alternatives-2026-09-11.md §4); keyword
// queries are right for the engines that DO answer, not a Bing remedy.

const MAX_QUERY_TOKENS = 10;

/** Trim to at most `max` whitespace-separated tokens. */
function clampTokens(s: string, max = MAX_QUERY_TOKENS): string {
  return String(s || "").trim().split(/\s+/).filter(Boolean).slice(0, max).join(" ");
}

function containsEntity(query: string, entity: string): boolean {
  if (!entity) return true;
  return query.toLowerCase().includes(entity.toLowerCase());
}

/**
 * One web query for one need. `raw` is the model's proposal and is used only if
 * it is usable: the SUBJECT ENTITY is enforced here rather than trusted to the
 * prompt, because a query that has dropped the subject is how "failure modes"
 * became a search about failure modes in general.
 */
export function keywordQuery(entity: string, need: string, raw?: unknown): string {
  const ent = String(entity || "").trim();
  let q = typeof raw === "string" ? raw.trim() : "";
  if (!q) {
    // Fall back to the need's own content words — never the raw question.
    q = terms(need).slice(0, 5).join(" ");
  }
  if (ent && !containsEntity(q, ent)) q = `${ent} ${q}`;
  q = clampTokens(q);
  return q || ent || clampTokens(need, 6);
}

/** Suffixes that bias a re-query toward pages that discuss a thing rather than sell it. */
export const REFORMULATION_SUFFIXES = ["problems", "guide", "review", "study", "forum"];

/**
 * The second attempt at a need whose first search came back collapsed: keep the
 * entity plus two content nouns, drop everything else, and add one template
 * suffix. Deterministic in `nth` so a run is reproducible.
 */
export function reformulate(need: string, entity: string, nth: number): string {
  const ent = String(entity || "").trim();
  const entTokens = new Set(terms(ent));
  const nouns = terms(need).filter((t) => !entTokens.has(t) && !/^\d+$/.test(t)).slice(0, 2);
  const suffix = REFORMULATION_SUFFIXES[Math.abs(nth) % REFORMULATION_SUFFIXES.length];
  return clampTokens([ent, ...nouns, suffix].filter(Boolean).join(" "));
}

/** Per-run search accounting (RunResult.fetchStats.search). */
export interface SearchStats {
  calls: number; ok: number; collapsed: number; offtopic: number; empty: number; errors: number;
}
export function emptySearchStats(): SearchStats {
  return { calls: 0, ok: 0, collapsed: 0, offtopic: 0, empty: 0, errors: 0 };
}
