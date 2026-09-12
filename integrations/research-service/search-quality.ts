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
  /** Fraction of hits whose title+snippet carry >= 2 distinct query terms.
   *  SECONDARY EVIDENCE — reported always, decisive only in the no-entity
   *  fallback. It was the gate through two failed attempts and it is not one:
   *  a set can score 0.9 while not one page mentions the subject. */
  overlap: number;
  /** Fraction of hits carrying the SUBJECT ENTITY's core. The gate, when an
   *  entity is known and usable. `undefined` when it is not — a share is not
   *  computed for an entity that was never applied. */
  entityShare?: number;
  /** Whether the supplied entity was USED as the gate, MISSING (none given) or
   *  REJECTED (the query itself does not carry its core, so KEYWORDIZE named a
   *  subject this query is not about). Both non-`used` cases fall back to the
   *  overlap rule and are counted, because a silent fallback is a gate that
   *  reports health it never measured. */
  entityStatus?: EntityStatus;
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
 * How many hits must carry the SUBJECT ENTITY's core for the set to be an
 * answer. RE-MEASURED 2026-09-11 after the research-trust deploy, over every
 * recorded set — nine captured from the live gateway, one from a throwaway rig,
 * two hand-built controls:
 *
 *   1.00  probe-good-oomkilled            GOOD (control)
 *   1.00  probe-good-iphone               GOOD (control)
 *   0.75  search-good-optiplex            GOOD (rig)
 *   0.65  live-optiplex-health            GOOD (live, dry run 1f2ff740)
 *   0.55  live-100hz-mechanism            GOOD (live, dry run b7e701ef)
 *   0.35  live-100hz-studies              GOOD (live, dry run b7e701ef)
 *   0.30  live-optiplex-thermal           GOOD (live, dry run 1f2ff740)
 *   ----------------------------------------------------------------- 0.175
 *   0.05  live-100hz-ssq                  OFF-NEED (live; the query really is
 *                                         about SSQ scores, not about 100 Hz)
 *   0.00  search-collapsed-dell / -most / -the100
 *   0.00  probe-collapsed-capacitor / -motherboard / -vestibular
 *
 * The first version of this constant was 0.5, chosen from the fixtures alone
 * where the gap ran 0.00 -> 0.75. The live sets put four GOOD sets below that
 * line, and two production dry runs reported working searches as failures.
 *
 * The real gap is 0.05 -> 0.30, and 0.175 is the ONLY region satisfying the
 * anchor's rule that no recorded set sit within 0.1 of the threshold: it is
 * 0.125 from the off-need set below and 0.125 from the thinnest good set above.
 * The margin is thin, and that thinness IS the finding — a threshold picked
 * from curated fixtures looked like it had 0.75 of headroom and had 0.125.
 *
 * A set at 0.20 — four of twenty hits about the subject — is a usable search,
 * not a broken engine: the relevance gate is the next filter and it judges
 * pages one at a time. This constant only answers "did the engine understand
 * the subject at all".
 */
export const ENTITY_SHARE = 0.175;

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

// ── Subject matching: a SET of distinctive tokens ──────────────────────────
// FOUR rules stood here before this one, and each failed the same way: an
// 8-string pattern list, a 7-character token length, the token before the first
// number, the longest token. Every one of them passed every subject anybody had
// written down and failed on the first subject nobody had — because each picked
// a SURFACE PROPERTY to stand in for identity, and then reduced the subject to a
// single phrase that a page had to carry verbatim.
//
// The tester's counter-examples for the fourth (attempt 1, 2026-09-11), all on
// live hit sets that were genuinely on-subject:
//   "50 micrograms semaglutide" -> longest token "micrograms" -> 0.00
//   "Nikon Z 6III autofocus firmware" -> "6iii" -> 0.05
//   "Mullvad WireGuard port forwarding" -> "port forwarding" -> 1.00 on router junk
//   "2026 budget" -> "budget"     "Raspberry Pi 5 NVMe HAT" -> "5 nvme"
//
// THE RULE, and it is not a phrase: a subject is its SET of distinctive tokens —
// those bearing digits (a bare four-digit year excepted), those the planner
// capitalised, and those that are not common English — and a hit carries the
// subject when it contains at least half of them, rounded up. No length test,
// no single core phrase, no qualifier list, nothing that has to appear verbatim.
//
// Spelling is handled by expanding BOTH sides: every alphanumeric run yields
// itself and its digit/letter parts, and adjacent digit+letter runs also yield
// their concatenation. So "Z6III" offers {z6iii, z, 6iii, 6, iii} and "Z 6III"
// offers the same set, and a subject token matches if it is in either.

/**
 * Common English words. This is the NLTK English stopword list (179 words,
 * https://www.nltk.org/nltk_data/ — `corpora/stopwords/english`) plus the
 * closed set of SI and imperial unit names, and nothing else. It is a GENERAL
 * list from a cited source, not a list tuned to the fixtures in this directory:
 * the version it replaces had grown case by case as each item's findings landed
 * ("firmware", "port", "forwarding", "micrograms", "budget"), which is the
 * fourth way this module has tried to encode particular incidents into a rule.
 *
 * A word here is not distinctive ON ITS OWN — a digit or a capital in the
 * planner's own spelling still promotes it.
 */
const COMMON = new Set(
  // NLTK English stopwords, verbatim.
  ("i me my myself we our ours ourselves you you're you've you'll you'd your yours " +
   "yourself yourselves he him his himself she she's her hers herself it it's its " +
   "itself they them their theirs themselves what which who whom this that that'll " +
   "these those am is are was were be been being have has had having do does did " +
   "doing a an the and but if or because as until while of at by for with about " +
   "against between into through during before after above below to from up down in " +
   "out on off over under again further then once here there when where why how all " +
   "any both each few more most other some such no nor not only own same so than too " +
   "very s t can will just don don't should should've now d ll m o re ve y ain aren " +
   "aren't couldn couldn't didn didn't doesn doesn't hadn hadn't hasn hasn't haven " +
   "haven't isn isn't ma mightn mightn't mustn mustn't needn needn't shan shan't " +
   "shouldn shouldn't wasn wasn't weren weren't won won't wouldn wouldn't " +
   // Units of measure: a unit names a quantity, not a subject.
   "mg kg lb lbs oz ml cl dl litre litres liter liters gram grams gramme grammes " +
   "kilogram kilograms microgram micrograms milligram milligrams inch inches foot " +
   "feet metre metres meter meters centimetre centimetres millimetre millimetres " +
   "mile miles second seconds minute minutes hour hours day days week weeks month " +
   "months year years percent")
    .split(" ").filter((w) => w.length > 0),
);

/**
 * Every spelling a run can be matched by: each contiguous stretch of its
 * digit/letter parts. "Z6III" offers z, 6, iii, z6, 6iii and z6iii, so a
 * subject token "6iii" finds it however the planner or the page spelled it.
 */
function runForms(run: string): string[] {
  const low = run.toLowerCase();
  const parts = low.match(/\d+|[a-z]+/g) || [];
  if (parts.length <= 1) return [low];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let acc = "";
    for (let j = i; j < parts.length; j++) {
      acc += parts[j];
      if (!out.includes(acc)) out.push(acc);
    }
  }
  return out;
}

/**
 * The token set of a text: every run's forms, plus the concatenation of any
 * adjacent digit-run and letter-run ("100 Hz" -> "100hz", "Z 6III" -> "z6iii"),
 * so a subject written one way matches a page written the other.
 */
export function tokenSet(text: string): Set<string> {
  const runs = String(text || "").match(/[A-Za-z0-9]+/g) || [];
  const out = new Set<string>();
  for (let i = 0; i < runs.length; i++) {
    for (const f of runForms(runs[i])) out.add(f);
    // Glue two runs when the BOUNDARY between them is a digit/letter
    // transition: "100 Hz" -> 100hz, "Z 6III" -> z6iii. Testing the whole run's
    // class instead missed "Z"+"6III", because "6III" is neither all digits nor
    // all letters - and "Z6III" is how Nikon prints it.
    const a = runs[i].toLowerCase(), b = (runs[i + 1] || "").toLowerCase();
    if (b) {
      const endsDigit = /\d$/.test(a), startsDigit = /^\d/.test(b);
      if (endsDigit !== startsDigit) for (const f of runForms(a + b)) out.add(f);
    }
  }
  return out;
}

function isYear(t: string): boolean {
  if (!/^\d{4}$/.test(t)) return false;
  const n = parseInt(t, 10);
  return n >= 1900 && n <= 2100;
}

/**
 * The subject's DISTINCTIVE tokens, in the planner's own spelling order.
 * Digit-bearing (not a bare year), or capitalised by the planner, or not a
 * common English word. An empty result means the subject names nothing — the
 * caller falls back and counts it.
 */
export function subjectTokens(entity: string | undefined | null): string[] {
  // "3.12" is one token: a dot between digits does not separate them. Repeat
  // until stable - a single global pass leaves "17.2.1" as "172.1", because the
  // matches overlap on the digit between the two dots.
  let raw = String(entity || "");
  for (let prev = ""; prev !== raw;) { prev = raw; raw = raw.replace(/(\d)\.(\d)/g, "$1$2"); }
  const runs = raw.match(/[A-Za-z0-9]+/g) || [];
  const out: string[] = [];
  for (const run of runs) {
    const low = run.toLowerCase();
    const hasDigit = /\d/.test(low);
    if (hasDigit && isYear(low)) continue;           // a year dates, it does not name
    const capitalised = /^[A-Z]/.test(run);
    if (hasDigit || capitalised || !COMMON.has(low)) {
      if (!out.includes(low)) out.push(low);
    }
  }
  return out;
}

/**
 * Does this hit carry the subject? BOTH must hold:
 *
 *  (a) it contains at least half of the subject's distinctive tokens, rounded
 *      up — the set rule; and
 *  (b) it contains at least two distinct non-stopword QUERY terms, which is
 *      exactly the per-hit test `overlapRatio` already applies. A distinctive
 *      subject token counts as one of the two.
 *
 * (b) is the EVIDENCE FLOOR, and it is here because (a) alone has none: half of
 * one or two is ONE, and a one-or-two-token subject is exactly what the
 * tightened KEYWORDIZE produces. The tester's live counter-examples, every one
 * a real page about a different subject that shares a single token:
 *   "Signal"       vs digital-signal-processing pages  -> 1.00
 *   "Arc browser"  vs arc-welding pages                -> 0.60
 *   "MacBook M2"   vs M.2 NVMe heatsink pages          -> 1.00
 * The last one also brings back the M.2 collision every previous rule guarded,
 * because the glue expansion turns "M.2" into the token `m2`.
 *
 * The floor uses a signal the run already has and adds no list and no length.
 */
export function hitCarriesSubject(
  hit: SearchHit, subject: string[], query = "",
): boolean {
  if (!subject.length) return false;
  const set = tokenSet(`${hit?.title || ""} ${hit?.snippet || ""}`);
  const matched = subject.filter((t) => set.has(t));
  if (matched.length < Math.ceil(subject.length / 2)) return false;
  // A BARE NUMBER never satisfies the test on its own: the subject "100 Hz" is
  // two tokens and every hit in the recorded `the100` fixture carries "100" —
  // The 100, the TV series, the failure this module was built for.
  const allNumeric = subject.every((t) => /^\d+$/.test(t));
  if (!allNumeric && !matched.some((t) => !/^\d+$/.test(t))) return false;
  // (b) the evidence floor. With no query to score against there is nothing to
  // apply, and the subject match stands alone.
  if (!query) return true;
  const text = `${hit?.title || ""} ${hit?.snippet || ""}`.toLowerCase();
  const qt = [...new Set(terms(query))];
  if (qt.length < 2) return true;              // nothing to ask two of
  let present = 0;
  for (const t of qt) if (has(text, t)) present++;
  if (present >= 2) return true;
  // A distinctive subject token counts toward the two even when the overlap
  // scorer cannot see it — "100Hz" is one token to the scorer and two to the
  // tokeniser, and the subject is what the run is actually about.
  return present + matched.filter((t) => !has(text, t)).length >= 2;
}

/** Fraction of hits carrying the subject. */
export function entityShare(subject: string[], hits: SearchHit[], query = ""): number {
  if (!hits.length || !subject.length) return 0;
  let n = 0;
  for (const h of hits) if (hitCarriesSubject(h, subject, query)) n++;
  return n / hits.length;
}

/**
 * Is this subject usable as the gate for THIS query? It must name something,
 * and the query must carry at least half of what it names — KEYWORDIZE is a
 * model and can return a subject the query is not about.
 */
export type EntityStatus = "used" | "missing" | "rejected";
export function entityStatusFor(query: string, entity: string | undefined | null): EntityStatus {
  const subject = subjectTokens(entity);
  if (!subject.length) return String(entity || "").trim() ? "rejected" : "missing";
  const qs = tokenSet(query);
  let n = 0;
  for (const t of subject) if (qs.has(t)) n++;
  return n >= Math.ceil(subject.length / 2) ? "used" : "rejected";
}

/**
 * The query token that the greatest share of TITLES carries, with that share.
 * Entity tokens are NOT excluded: an engine can collapse onto PART of the
 * entity, which is exactly what `100 Hz sound motion sickness...` does — every
 * hit carries "100" (The 100, the TV series) and none carries "hz", so the
 * phrase is absent while one of its tokens dominates. Naming "100" is the
 * useful diagnosis; an earlier version skipped entity tokens and could only
 * report the weaker "offtopic".
 */
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
export function classifyHits(
  query: string, hits: SearchHit[], entity?: string | null,
): SearchQuality {
  const list = Array.isArray(hits) ? hits.filter((h) => h && h.url) : [];
  if (!list.length) return { verdict: "empty", overlap: 0 };
  const overlap = overlapRatio(query, list);

  // ── The ENTITY gate ──────────────────────────────────────────────────────
  // The question this asks is the one that matters and the one two previous
  // versions could not ask: are these pages about the thing that was asked
  // about? Overlap could not answer it — `capacitor bulging OptiPlex 3050
  // repair` scored 0.90 on ten pages about capacitors in general, because nine
  // of them carry "capacitor" and "repair". The entity is a structural fact the
  // run already holds, not a constant chosen to fit an incident.
  const status = entityStatusFor(query, entity);
  if (status === "used") {
    const subject = subjectTokens(entity);
    const share = entityShare(subject, list, query);
    if (share >= ENTITY_SHARE) {
      // The subject IS in the results. They may still be weak for the specific
      // NEED — `semaglutide gastroparesis incidence` returned ten real
      // semaglutide pages that never mention gastroparesis — but that is what
      // the relevance gate is for. Calling a search broken because the engine
      // understood the subject and not the question would be the same overreach
      // as calling junk `ok`, pointed the other way.
      return { verdict: "ok", overlap, entityShare: share, entityStatus: status };
    }
    const domE = dominantTitleTerm(query, list);
    if (domE.share >= COLLAPSE_TITLE_SHARE) {
      return { verdict: "collapsed", overlap, entityShare: share, entityStatus: status, collapsedOn: domE.term };
    }
    return { verdict: "offtopic", overlap, entityShare: share, entityStatus: status };
  }

  // ── Fallback: no entity was supplied ─────────────────────────────────────
  // Article-mode preliminary gap searches and any legacy caller land here. This
  // is the ORIGINAL two-term overlap rule and it is WEAKER: without knowing the
  // subject it cannot tell "ten pages about capacitors" from "ten pages about
  // this capacitor". It is kept because a wrong `collapsed` on a preliminary
  // gap costs one tentative paragraph, while the topic path — where the audited
  // failure lives — always has an entity.
  if (overlap >= COLLAPSE_OVERLAP) return { verdict: "ok", overlap, entityStatus: status };
  const dom = dominantTitleTerm(query, list);
  if (dom.share >= COLLAPSE_TITLE_SHARE) {
    return { verdict: "collapsed", overlap, entityStatus: status, collapsedOn: dom.term };
  }
  // No dominant token, but a full page of results in which NOTHING mentions the
  // query: the engine answered a different question. We cannot name the token,
  // so we do not claim to — but calling this `ok` told the run its search had
  // worked and spent the whole fetch budget on noise.
  if (overlap === 0 && list.length >= OFFTOPIC_MIN_HITS) {
    return { verdict: "offtopic", overlap, entityStatus: status };
  }
  // A thin or partially-relevant set: a weak search, not a broken engine.
  // Saying anything stronger here would be a diagnosis we cannot support.
  return { verdict: "ok", overlap, entityStatus: status };
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
  /** Searches classified with NO entity to gate on. */
  entity_missing: number;
  /** Searches whose supplied entity was not carried by the query itself. */
  entity_rejected: number;
}
export function emptySearchStats(): SearchStats {
  return {
    calls: 0, ok: 0, collapsed: 0, offtopic: 0, empty: 0, errors: 0,
    entity_missing: 0, entity_rejected: 0,
  };
}
