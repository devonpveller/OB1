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

// ── Entity matching (research-trust-entity, 2026-09-11) ────────────────────
// The deploy of research-trust proved the first version too literal. Dry run
// b7e701ef asked "100Hz audio VR motion sickness physiological mechanism"; the
// gateway returned the Nagoya paper at rank 1; the detector reported
// `collapsed onto "motion"` because "100Hz audio" is not the string the pages
// write. Dry run 1f2ff740 lost two searches the same way: entity
// "Dell OptiPlex 3050", hits that say "OptiPlex 3050" without the brand.
//
// THE RULE. An entity is matched by its distinctive CORE, not by its literal
// spelling:
//   1. TOKENISE splitting digit/letter runs, so 100Hz, 100 Hz and 100-Hz all
//      become ["100","hz"] and compare equal.
//   2. The CORE is what is left after dropping leading and trailing tokens that
//      carry no distinctiveness of their own — a brand ("Dell"), an article
//      ("the"), a medium or context word ("audio", "VR") — for as long as a
//      distinctive token remains. A token is never dropped from beside a
//      digit-bearing token, because a unit belongs to its number: reducing
//      "100 Hz" to "100" would match The 100, the TV series, which is the
//      fixture this module exists for.
//   3. A hit CARRIES the entity if its title+snippet contains the core as a
//      PHRASE (tokens adjacent, any separators), or — when the core is a single
//      distinctive token — that token.
//
// Worked: "Dell OptiPlex 3050" -> optiplex 3050 · "100Hz audio" -> 100 hz ·
// "VR motion sickness" -> motion sickness · "OOMKilled" -> oomkilled.

/** Tokens, splitting a run at every digit/letter boundary. */
export function entityTokens(s: string | undefined | null): string[] {
  const out: string[] = [];
  for (const run of String(s || "").toLowerCase().match(/[a-z0-9]+/g) || []) {
    for (const part of run.match(/\d+|[a-z]+/g) || []) out.push(part);
  }
  return out;
}

/** Words that qualify a subject without identifying one. Closed list, short by
 *  design: everything else is judged structurally (length, digits). */
const QUALIFIERS = new Set(
  ("the a an of for and or in on at to audio video sound acoustic visual vr ar xr " +
   "software hardware device system app tool platform service online digital " +
   "wireless portable desktop laptop pc computer machine model brand review guide " +
   "study research paper data test new best top full")
    .split(" "),
);

/** A token that can identify a subject on its own. */
function distinctive(t: string): boolean {
  if (/\d/.test(t)) return true;
  return t.length >= 5 && !QUALIFIERS.has(t);
}

/**
 * The distinctive core of an entity. Returns the whole token list when nothing
 * can be dropped — an entity with no distinctive token at all is still the only
 * thing the run knows about its subject.
 */
export function entityCore(entity: string | undefined | null): string[] {
  const toks = entityTokens(entity);
  if (!toks.length) return [];
  if (!toks.some(distinctive)) return toks;

  // A MODEL NUMBER anchors the identity. Everything before the token that
  // immediately precedes the first digit-bearing token is a brand or a
  // qualifier, whatever its length: the identity of "Lenovo ThinkCentre M910q"
  // is "ThinkCentre M910q" (pages write it without "Lenovo"), and of
  // "Dell OptiPlex 3050" is "OptiPlex 3050".
  //
  // A LENGTH test cannot do this. The first version dropped a leading token
  // only when it was under five characters, which worked for "Dell" by accident
  // and left "Lenovo", "NVIDIA" and "Microsoft" in the core — the same defect
  // this item exists to fix, one brand name later.
  let core = [...toks];
  const firstDigit = core.findIndex((t) => /\d/.test(t));
  if (firstDigit >= 0) {
    const start = Math.max(0, firstDigit - 1);
    const tail = core.slice(start);
    // A one-character number is not a model code: "MacBook Air M2" would reduce
    // to "m 2", which matches the M.2 SSD form factor on any page. Require the
    // tail to carry a digit AND something with shape to it.
    const strongTail = tail.length >= 2 && tail.some((t) => /\d/.test(t)) &&
      tail.some((t) => (/\d/.test(t) && t.length >= 2) || t.length >= 3);
    if (strongTail) core = tail;
    else {
      let anchor = start;
      while (anchor > 0 && core[anchor].length < 5) anchor--;
      core = core.slice(anchor);
    }
  }

  // Then trim qualifiers off both ends — "OptiPlex 3050 desktop" is written
  // "OptiPlex 3050", and "100 Hz audio" is written "100 Hz".
  const droppable = (i: number): boolean => {
    const t = core[i];
    if (distinctive(t)) return false;
    // A UNIT belongs to its number: never orphan one from the other. Only a
    // short alphabetic token can be a unit — "desktop" beside "3050" is a
    // qualifier, not a unit.
    if (t.length <= 4) {
      const left = i > 0 ? core[i - 1] : "";
      const right = i < core.length - 1 ? core[i + 1] : "";
      if (/\d/.test(left) || /\d/.test(right)) return false;
    }
    return true;
  };
  const beforeTrim = [...core];
  let changed = true;
  while (changed && core.length > 1) {
    changed = false;
    if (droppable(0) && core.slice(1).some(distinctive)) { core.shift(); changed = true; continue; }
    const last = core.length - 1;
    if (droppable(last) && core.slice(0, last).some(distinctive)) { core.pop(); changed = true; }
  }
  // A bare number is not an identity. "Surface Laptop 5" trims to "5", which
  // matches any page with a 5 in it; keep the untrimmed core instead.
  if (core.length === 1 && /^\d+$/.test(core[0])) return beforeTrim;
  return core;
}

/** The core as a phrase regex: tokens adjacent, any separator between them. */
export function entityPhrase(entity: string | undefined | null): RegExp | null {
  const core = entityCore(entity);
  if (!core.length) return null;
  return corePhrase(core);
}

function corePhrase(core: string[]): RegExp {
  // A model number may carry a form-factor suffix in the wild: the OptiPlex
  // 3050 is written "3050m", "3050 SFF", "3050MT". Up to two trailing letters
  // after a NUMERIC final token are the same machine; more digits are not
  // ("3050" must never match inside "30500", and "3060" is a different model).
  const last = core[core.length - 1];
  const tail = /^\d+$/.test(last) ? "[a-z]{0,2}(?![a-z0-9])" : "(?![a-z0-9])";
  return new RegExp("(?<![a-z0-9])" + core.join("[^a-z0-9]{0,2}") + tail, "i");
}

/** Does this hit carry the entity's core? */
export function hitCarriesEntity(hit: SearchHit, core: string[]): boolean {
  if (!core.length) return false;
  return corePhrase(core).test(`${hit?.title || ""} ${hit?.snippet || ""}`);
}

/** Fraction of hits carrying the entity core. Accepts a core or a regex. */
export function entityShare(coreOrRe: string[] | RegExp, hits: SearchHit[]): number {
  if (!hits.length) return 0;
  const re = Array.isArray(coreOrRe) ? corePhrase(coreOrRe) : coreOrRe;
  let n = 0;
  for (const h of hits) if (re.test(`${h?.title || ""} ${h?.snippet || ""}`)) n++;
  return n / hits.length;
}

/**
 * Is this entity usable as the gate for THIS query? KEYWORDIZE is a model, and
 * a model can return a subject the query never mentioned — gating on that would
 * condemn every search for a question it misread. The entity is accepted only
 * when the query itself carries its core.
 */
export type EntityStatus = "used" | "missing" | "rejected";
export function entityStatusFor(query: string, entity: string | undefined | null): EntityStatus {
  const core = entityCore(entity);
  if (!core.length) return "missing";
  return corePhrase(core).test(String(query || "")) ? "used" : "rejected";
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
    const core = entityCore(entity);
    const share = entityShare(core, list);
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
