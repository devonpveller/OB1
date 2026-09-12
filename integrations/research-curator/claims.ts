/**
 * Synthesis → claims parser + writer (Research Engine P1.3 / P1.4).
 *
 * Governing spec: documentation/implementation-guide/research-engine-for-OB/
 *   GROUNDING-MODEL.md §4 ("mapping to what already exists").
 *
 * The deep_research synthesis already tags its assertions in prose:
 *     [SOURCED]  ... [Source 1]
 *     [INFERRED] ... [Source 1, 2]
 *     [UNCERTAIN] ...
 *     [GAP] ...
 * This is the embryonic structured form. We PARSE those citations into
 * claims + typed grounding edges (OD-4: parse-first, no second LLM pass) and
 * enforce rule #1 at the gate: a claim that resolves to ZERO grounding edges
 * terminating in a primary source is NOT admitted — it is dropped (and, for
 * [GAP], recorded as a gap for a future run). Nothing ungrounded is stored.
 *
 *   [SOURCED]  → first cited source `states`; any additional `corroborates`
 *   [INFERRED] → every cited source `inferred_from`
 *   [UNCERTAIN]→ cited sources `inferred_from` at half weight (above the floor
 *                only if it survives the confidence function)
 *   [GAP]      → not a claim; recorded as a gap
 *
 * Pure parser (`parseSynthesisClaims`) is dependency-free and unit-testable.
 * `writeClaims` applies the parse via the server-side SQL helpers
 * (find_or_create_claim / link_claim_to_source) so all grounding logic and
 * the confidence recompute stay in the database (init-claims.sql).
 */

export type EdgeType = "states" | "inferred_from" | "corroborates" | "contradicts";
export type EpistemicTag = "sourced" | "inferred" | "uncertain";

export interface ParsedEdge {
  /** 1-based [Source N] index as written in the synthesis. */
  sourceIndex: number;
  edgeType: EdgeType;
  weight: number;
}

export interface ParsedClaim {
  text: string;
  tag: EpistemicTag;
  edges: ParsedEdge[];
}

export interface ParseResult {
  claims: ParsedClaim[];
  /** [GAP] segments — recorded, never stored as claims (rule #7). */
  gaps: string[];
}

const TAG_RE = /\[(SOURCED|INFERRED|UNCERTAIN|GAP)\]/gi;
// Tolerant of every shape: [Source 1] / [Source 1, 2] / [Sources 1, 2 and 3] /
// [Source 1, Source 2, Source 4] — extract every number inside a [Source...] bracket.
const SRC_RE = /\[Sources?\b[^\]]*\]/gi;

function parseSourceNumbers(segment: string): number[] {
  const nums: number[] = [];
  for (const bracket of segment.match(SRC_RE) || []) {
    for (const d of bracket.match(/\d+/g) || []) {
      const n = parseInt(d, 10);
      if (n > 0 && !nums.includes(n)) nums.push(n);
    }
  }
  return nums;
}

/** Strip citation markers + tidy whitespace to get the bare claim text. */
function cleanClaimText(segment: string): string {
  return segment
    .replace(SRC_RE, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-*•:]+/, "")
    .replace(/[\s\-*•]+$/, "")
    .trim();
}

// ── Meta-claim filter (research-trust 2026-09-11, PLAN Phase 3.1) ───────────
// A claim is a statement about the WORLD. A statement about the SOURCES or
// about this RUN is not a claim, and eight of them are in the claims table
// because nothing here distinguished the two. The worst is stored at 0.85:
//   "The provided sources contain no information specific to the Dell OptiPlex
//    3050 model; all sources reference other platforms…"
// It carries the query's own vocabulary, so the NEXT OptiPlex query recalls it
// as known knowledge and the engine argues with itself.
//
// Two layers, in this order: these patterns, then (for what they do not
// recognise) an LLM judge that FAILS OPEN. Patterns reject; only a confident
// judge verdict rejects beyond them.
//
// ── THE HEAD-CLAUSE RULE (2026-09-11, after the tester's T7 failure) ────────
// The first version judged the WHOLE claim line, so a real fact carrying an
// honest caveat was deleted along with the caveat. Five live claims were being
// eaten — Companies House SR01 form fields, the six-month wait after
// dissolution, registered-office ordering, Conventional Commits keywords, the
// WSO2 licence — each of the shape
//     <a fact about the world>, but/though/; <the sources do not confirm it>.
// Every honest claim is entitled to that tail; it is the engine doing what it
// is supposed to do. So the source-referential and absence-of-evidence families
// are now tested against the HEAD CLAUSE only — the text before the first `;`
// or `, but` / `, though` / `, although` / `, however`. What survives whole-text
// testing is the family that cannot be a caveat: a claim whose whole point is
// that the evidence is about something OTHER than the subject.
//
// A filter that eats knowledge is a worse outcome than the poison it removes.

/**
 * The clause a claim actually asserts. A caveat introduced by `;`, `, but`,
 * `, though`, `, although` or `, however` comments on the assertion; it is not
 * the assertion. Returns the whole text when there is no such break.
 */
export function headClause(text: string): string {
  const t = String(text || "");
  const m = t.match(/;|,\s+(but|though|although|however|whereas|yet)\b/i);
  return (m && m.index !== undefined ? t.slice(0, m.index) : t).trim();
}

/**
 * The head sentence's clauses, each stripped of its subordinator so a
 * `^`-anchored subject pattern can see the subject.
 *
 * The `^` anchor is deliberate — it is what makes these patterns test the
 * SUBJECT rather than fire on any mention of "the sources" — but a LEADING
 * subordinate clause defeated it: "While the provided sources do not address
 * the Dell OptiPlex 3050, they describe the NVIDIA DGX Spark…" is a restatement
 * of the 0.85 poison that attempt 1 caught and attempt 2 did not (tester, X1).
 * So the head is split at `While|Although|Though|Whereas|If|When|Because|Since`
 * and at the comma that ends such a clause, and EVERY resulting clause is
 * judged. A claim is meta if ANY clause's subject is the evidence set.
 */
export function headClauses(text: string): string[] {
  const head = headClause(text);
  // Only a LEADING contrast subordinator restructures the sentence into
  // "<subordinate>, <main>" — and only then does the subject of the second
  // clause need judging separately. A subordinator later in the sentence
  // introduces a REASON ("…, since the sources describe these as independent
  // properties"), which is a justification for a world claim and belongs with
  // the caveat tail. Judging it as a subject cost one live false positive
  // (`083b830e`, an EFS architecture claim) the first time this was written.
  const lead = head.match(/^\s*(while|although|though|whereas|even\s+though)\b\s*/i);
  if (!lead) return [head];
  const rest = head.slice(lead[0].length);
  const comma = rest.search(/,(?![^(]*\))/);
  if (comma < 0) return [rest.trim()];
  return [rest.slice(0, comma).trim(), rest.slice(comma + 1).trim()].filter(Boolean);
}

/**
 * Family 1 — HEAD-ONLY. The thing the sentence is ABOUT is the evidence set:
 * its grammatical subject is "the sources", "no source", "the retrieved pages",
 * "this report". Judged on the head clause, so "…, but the sources do not state
 * its licence type" keeps its claim.
 */
const SOURCE_SUBJECT: RegExp[] = [
  // "The (provided) sources <report-verb> …" as the subject of the head clause.
  /^\W*the\s+(provided\s+|given\s+|available\s+|retrieved\s+|gathered\s+|held\s+)?sources?\b/i,
  // "No source / no provided sources <report-verb> …"
  /^\W*no\s+(provided\s+|available\s+|retrieved\s+)?sources?\b/i,
  /\bno\s+(provided\s+|available\s+|retrieved\s+)?sources?\s+(\w+\s+){0,2}(mention|state|says?|confirm|document|describe|address|explain|discuss|give|list|name|report|indicate|support|cover|contain|provide|specif\w*|clarif\w*|enumerat\w*|frame|label|explicitly)/i,
  /\bnone\s+of\s+(these|the|those)\s+sources?\b/i,
  /^\W*(the\s+)?(retrieved|gathered|fetched|provided|available)\s+(pages?|material|documents?|results?|excerpts?)\b/i,
  /^\W*(this|the)\s+(report|run|search|analysis)\s+(could\s+not|did\s+not|does\s+not|failed\s+to)\b/i,
  /^\W*nothing\s+in\s+the\s+(reviewed|provided|retrieved|available|gathered|cited)\b/i,
  /^\W*in\s+the\s+sources\s+provided\b/i,
];

/**
 * Family 2 — HEAD-ONLY. Absence OF EVIDENCE, said without the word "source"
 * (the tester's B4): "No evidence exists that…", "The literature is silent
 * on…", "No study has tested…". These are claims about the state of the
 * record, and they poison a knowledge base exactly as the audited ones do.
 *
 * Absence in the WORLD is a different thing and must survive: "no evidence OF
 * tampering on the chassis" asserts a fact about a chassis. The separator is
 * the complement — an evidence-absence sentence takes a CLAUSE ("that…",
 * "linking…", "on whether…"), a world-absence sentence takes "of <noun>".
 */
const EVIDENCE_ABSENCE: RegExp[] = [
  /\bno\s+(published\s+|peer-reviewed\s+|available\s+|reviewed\s+|existing\s+)?(evidence|research|literature|documentation|publications?|studies|data)\s+(exists?|was\s+found|were\s+found|has\s+been\s+found|have\s+been\s+found|that\b|linking\b|links\b|addresses\b|addressing\b|supports?\b|indicates?\b|suggests?\b|shows?\b|describ\w+\b|tests?\b|tested\b|examin\w+\b|on\s+whether\b)/i,
  /\bno\s+(study|studies|paper|papers|publication|article|source|document|report)\s+(has|have)\s+(yet\s+)?(tested|examined|measured|reported|addressed|investigated|established|shown|found|confirmed)\b/i,
  /\b(the\s+)?(reviewed\s+|available\s+|retrieved\s+|published\s+)?literature\s+(is|remains)\s+silent\b/i,
  /^\W*no\s+information\s+(specific\s+)?.{0,90}?\b(was|were|is|are)\s+(found|available|retrieved|present)\b/i,
  // A bare "there is no evidence/research …" pattern lived here and fired on
  // "There is no research BUDGET allocated to the programme", where the
  // evidence noun heads a compound and the sentence is about money. Every B4
  // case is already caught by a sibling above, so the bare form is not needed
  // and the false positive is not worth it.
];

/**
 * Family 3 — WHOLE TEXT. The TRANSFER DISCLAIMER: the sentence's purpose is to
 * say that the evidence is about something OTHER than the subject researched.
 * "documented for the DGX Spark … NOT confirmed for the OptiPlex 3050",
 * "pertain to the DGX Spark, not the Dell OptiPlex 3050". This is never a
 * caveat on a claim — it IS the claim, and it is a claim about applicability of
 * evidence. Four of the eight audited poison texts have this shape, and their
 * head clause is an ordinary world sentence, which is why this family cannot be
 * head-restricted.
 */
const CONTRAST = /\b(not|n't|no\s+source|however|but|while|whereas|rather\s+than)\b/i;
// Present-tense forms matter: poison `1306bb5a` says "the sources DESCRIBE this
// for ASUS and Compaq boards", and a past-participle-only list missed it.
//
// Only "<verb> (this) FOR <Named thing>" counts. An "in" branch and an optional
// "that" were here and produced three false positives on the live table, every
// one of them an ordinary attribution: "The article notes that in August 2026,
// several AI browsers were demonstrated vulnerable…", "…(as noted in CNN's
// coverage)…", "OpenAI stated that for Astra specifically, it invested in…".
// Reporting what a named party said is not a transfer disclaimer; the poison
// shape is always "the evidence covers X, and X is not what you asked about".
const TRANSFER_SUBJECT =
  /\b(documented|documents|document|described|describes|describe|stated|states|state|reported|reports|report|noted|notes|observed|observes|shown|shows|demonstrated|demonstrates|established|establishes|confirmed|confirms)\s+(this\s+|these\s+|it\s+)?for\s+(the\s+|a\s+|an\s+)?[A-Z0-9]/;

const TRANSFER_DISCLAIMER: RegExp[] = [
  /\bpertains?\s+to\s+[^,;]+,\s*not\s+(the|a|an)\b/i,
  /\bnot\s+confirmed\s+(as|for|in)\b/i,
  /\bcannot\s+be\s+(directly\s+)?extrapolated\b/i,
  /\bdoes\s+not\s+rule\s+out\b/i,
  // A claim that cites "Source N" INSIDE its own text is describing the
  // evidence set, not the world. (The [Source N] markers are stripped before
  // this runs; a bare "(Source 3)" in prose is not.)
  /\(\s*sources?\s+\d+\s*\)/i,
];

/**
 * The LLM judge's prompt, asked only about claims the deterministic patterns did
 * not recognise. It lives here, beside `classifyMetaClaim`, because it is the
 * OTHER half of the same decision and because a prompt with no test is a rule
 * nobody reads - `index.ts` imports it.
 *
 * TWO SHAPES ADDED (research-trust-template). Four real world facts were refused
 * as META across the two live OWUI runs, all of them attribution or hedging:
 *
 *   "The same used-purchase analysis RECOMMENDS the Dell OptiPlex 3060 ... as a
 *    better secondhand option for Windows 11 compatibility"          (33250e9b)
 *   "The OptiPlex 3050 SFF's proprietary PSU connector MAY also limit the
 *    ability to replace the PSU ... IF the original 180 W unit is failing"
 *   "The user in that thread SPECULATED that the CPU may have been damaged
 *    during the thermal-paste service"                               (64ac38cf)
 *
 * Each names a source or hedges a claim, and the judge read "a sentence whose
 * subject IS the source set" as covering them. It does not: the subject of
 * "<source> recommends <thing>" is the thing, and a hedge is a claim about the
 * world with its confidence stated. The examples are now in the prompt, on both
 * sides, so the distinction is drawn rather than left to be inferred.
 */
export const META_JUDGE_SYS =
  `You decide whether a sentence is a claim about the WORLD or a statement about a research run and its sources.

WORLD = it asserts something that is true or false independently of who looked it up.
  - "the OptiPlex 3050 uses an LGA 1151 socket"
  - "a study of 14 subjects found X"
  - ATTRIBUTED: "<source or user> reports / notes / recommends / speculates / argues <content>" - the subject is the CONTENT, and who said it is provenance, not the topic. "The analysis recommends the 3060 as a better option for Windows 11" is WORLD.
  - HEDGED: "<thing> may <effect> if <condition>", "<thing> is likely to <effect>", "one user reported <event>" - a claim about the world with its confidence stated. A hedge is not a statement about the search.

META = its subject IS the evidence set, the search, or the state of confirmation.
  - "the provided sources contain no information about X"
  - "this is not confirmed for Y"
  - "no source documents Z"
  - "these findings pertain to A, not B"
  - "whether the thread's Solved tag indicates a fix is unclear from the sources"

A sentence that merely CITES or NAMES a study is WORLD. A sentence that says what the sources DO NOT contain, or how confident the SEARCH is, is META.

Where they meet, read the MAIN CLAUSE. When a sentence states a fact and then qualifies it with a caveat about the evidence ("X may do Y, though no source confirms Z"), judge the FACT - the caveat is how an honest claim is written. When the main clause itself is about the evidence ("the errors reported alongside thermal issues pertain to the DGX Spark, not the OptiPlex"), it is META however many world-sounding words it contains: an attribution verb or a hedge somewhere in the sentence does not make it a claim about the world.

Return ONLY JSON: {"verdict":"WORLD"} or {"verdict":"META"}.`;

export type MetaVerdict = "meta" | "world";

/**
 * Deterministic half of the filter. "world" means ONLY that these patterns did
 * not recognise it — the caller may still ask the judge.
 */
export function classifyMetaClaim(text: string): MetaVerdict {
  const t = String(text || "");
  if (!t.trim()) return "world";
  for (const clause of headClauses(t)) {
    for (const re of SOURCE_SUBJECT) if (re.test(clause)) return "meta";
    for (const re of EVIDENCE_ABSENCE) if (re.test(clause)) return "meta";
  }
  for (const re of TRANSFER_DISCLAIMER) if (re.test(t)) return "meta";
  // The transfer disclaimer spelled out rather than idiomatic: the evidence is
  // attributed to a NAMED other thing AND the sentence contrasts that with the
  // subject. Both halves are required — "documented for Python 3.12" alone is
  // an ordinary fact.
  if (TRANSFER_SUBJECT.test(t) && CONTRAST.test(t)) return "meta";
  return "world";
}

// ── Omnibus citations (PLAN Phase 3.2) ──────────────────────────────────────
/**
 * The 0.85 poison claim cited ALL ELEVEN sources from one line. A single
 * assertion that eleven independent sources directly state is not a finding,
 * it is a summary of the pool — so past this many citations a line is at most
 * [UNCERTAIN] and never writes a `states` edge.
 */
export const OMNIBUS_CITATION_MAX = 4;
export function isOmnibusCitation(nums: number[]): boolean {
  return (nums || []).length > OMNIBUS_CITATION_MAX;
}

function edgesForTag(tag: EpistemicTag, nums: number[]): ParsedEdge[] {
  if (isOmnibusCitation(nums)) {
    // Downgraded in edgesForTag AND in the tag itself (see parseSynthesisClaims).
    return nums.map((sourceIndex) => ({ sourceIndex, edgeType: "inferred_from" as EdgeType, weight: 0.5 }));
  }
  if (tag === "sourced") {
    // First citation directly states; the rest independently corroborate.
    return nums.map((sourceIndex, i) => ({
      sourceIndex,
      edgeType: i === 0 ? "states" : "corroborates",
      weight: 1.0,
    }));
  }
  if (tag === "inferred") {
    return nums.map((sourceIndex) => ({ sourceIndex, edgeType: "inferred_from", weight: 1.0 }));
  }
  // uncertain — derived but low-trust.
  return nums.map((sourceIndex) => ({ sourceIndex, edgeType: "inferred_from", weight: 0.5 }));
}

const TAG_MAP: Record<string, EpistemicTag | "gap"> = {
  SOURCED: "sourced",
  INFERRED: "inferred",
  UNCERTAIN: "uncertain",
  GAP: "gap",
};

/**
 * Parse a tagged synthesis into claims + gaps. Pure; no DB, no network.
 * A tagged segment runs from its tag marker to the next tag (or end of text).
 */
export function parseSynthesisClaims(synthesis: string): ParseResult {
  const text = String(synthesis || "");
  const claims: ParsedClaim[] = [];
  const gaps: string[] = [];
  const seen = new Set<string>();

  // Collect all tag positions in order.
  const marks: Array<{ tag: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    marks.push({ tag: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < marks.length; i++) {
    const here = marks[i];
    const next = marks[i + 1];
    const segment = text.slice(here.end, next ? next.start : text.length);
    const kind = TAG_MAP[here.tag];
    if (!kind) continue;

    if (kind === "gap") {
      const g = cleanClaimText(segment);
      if (g) gaps.push(g);
      continue;
    }

    const claimText = cleanClaimText(segment);
    if (!claimText) continue;
    const nums = parseSourceNumbers(segment);
    // Phase 3.2 — a line citing more than OMNIBUS_CITATION_MAX sources is
    // summarising the pool, not asserting a fact eleven sources each state.
    const effectiveTag: EpistemicTag = isOmnibusCitation(nums) ? "uncertain" : kind;
    const edges = edgesForTag(effectiveTag, nums);
    // Rule #1 gate: a claim with no grounding edge is not admitted. (It is
    // neither stored nor counted as a gap — it was an untethered assertion.)
    if (edges.length === 0) continue;

    const dedupKey = claimText.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    claims.push({ text: claimText, tag: effectiveTag, edges });
  }

  return { claims, gaps };
}

// ── Writer ─────────────────────────────────────────────────────────────────
// Applies a parse to the DB inside the caller's transaction. `client` is a
// deno-postgres PoolClient already inside BEGIN/COMMIT; `sourceIds` is the
// ordered list of persisted source ids where sourceIds[N-1] is [Source N].

// deno-postgres PoolClient — kept loose to avoid importing the type here.
interface QueryClient {
  queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
}

export interface WriteClaimsOpts {
  threadId: string | null;
  synthesisId: string | null;
  sourceIds: Array<string | null>;
  volatility?: string | null;
  revalidateDays?: number | null;
  /** optional bge-m3 embedder; when present each claim row gets an embedding. */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Second layer of the meta-claim filter (Phase 3.1): asked ONLY about claims
   * the deterministic patterns did not recognise. FAILS OPEN — a judge error or
   * a non-answer keeps the claim, because a filter that silently eats knowledge
   * when the model hiccups is worse than the poison it is removing.
   */
  metaJudge?: (text: string) => Promise<"META" | "WORLD">;
  /** Called for every rejected claim so the refusal is visible, never silent. */
  onMetaSkip?: (text: string, by: "pattern" | "judge") => void;
}

export interface WriteClaimsResult {
  claimsWritten: number;
  claimsDeduped: number;
  edgesWritten: number;
  edgesSkipped: number;   // citation pointed at a source not in sourceIds
  ungroundedSkipped: number; // claim whose every edge was unresolvable
  /** Claims refused as statements about the run rather than about the world. */
  metaSkipped: number;
  gaps: string[];
  claimIds: string[];     // ids of the claims written/deduped (for conflict detection)
}

const toVector = (v: number[]): string => `[${v.join(",")}]`;

/**
 * Parse + persist grounded claims for one synthesis. Enforces rule #1: a claim
 * whose citations all fail to resolve to a real persisted source is skipped,
 * never stored ungrounded.
 */
export async function writeClaims(
  client: QueryClient,
  synthesis: string,
  opts: WriteClaimsOpts,
): Promise<WriteClaimsResult> {
  const { claims, gaps } = parseSynthesisClaims(synthesis);
  const res: WriteClaimsResult = {
    claimsWritten: 0, claimsDeduped: 0, edgesWritten: 0,
    edgesSkipped: 0, ungroundedSkipped: 0, metaSkipped: 0, gaps, claimIds: [],
  };

  for (const claim of claims) {
    // Phase 3.1 — a statement ABOUT THE RUN is not a claim about the world and
    // must not enter the knowledge base. Patterns first (free, deterministic);
    // the judge only for what they did not recognise, and it fails open.
    if (classifyMetaClaim(claim.text) === "meta") {
      res.metaSkipped++;
      opts.onMetaSkip?.(claim.text, "pattern");
      continue;
    }
    if (opts.metaJudge) {
      let verdict: "META" | "WORLD" = "WORLD";
      try { verdict = await opts.metaJudge(claim.text); } catch { verdict = "WORLD"; }
      if (verdict === "META") {
        res.metaSkipped++;
        opts.onMetaSkip?.(claim.text, "judge");
        continue;
      }
    }
    // Resolve citation indices → real source ids first; if none resolve, the
    // claim is ungrounded → do not store it (rule #1).
    const resolved = claim.edges
      .map((e) => ({ ...e, sourceId: opts.sourceIds[e.sourceIndex - 1] ?? null }))
      .filter((e) => {
        if (!e.sourceId) { res.edgesSkipped++; return false; }
        return true;
      });
    if (resolved.length === 0) { res.ungroundedSkipped++; continue; }

    let emb: string | null = null;
    if (opts.embed) {
      try { emb = toVector(await opts.embed(claim.text)); } catch { emb = null; }
    }

    const fc = await client.queryObject<{ id: string; was_duplicate: boolean }>(
      `SELECT * FROM find_or_create_claim($1, $2, $3, $4, $5, $6, $7::vector, $8::jsonb)`,
      [
        claim.text, opts.threadId, opts.synthesisId, claim.tag,
        opts.volatility ?? null, opts.revalidateDays ?? null, emb,
        JSON.stringify({ source: "deep-research-claim" }),
      ],
    );
    const claimId = fc.rows[0].id;
    res.claimIds.push(claimId);
    if (fc.rows[0].was_duplicate) res.claimsDeduped++; else res.claimsWritten++;

    for (const e of resolved) {
      await client.queryObject(
        `SELECT link_claim_to_source($1, $2, $3, $4)`,
        [claimId, e.sourceId, e.edgeType, e.weight],
      );
      res.edgesWritten++;
    }
  }
  return res;
}

// ── Conflict auto-detection (#2 / GROUNDING-MODEL §6.5) ──────────────────────
// "Conflict surfaces — new evidence that contradicts a stored claim raises a
// revision event; never silently prefers the cached claim." For each freshly
// written claim, find the nearest EXISTING claim in the same thread (different
// synthesis) and, if it's close enough to be about the same thing, ask the judge
// whether they CONTRADICT. On contradiction we write reciprocal `contradicts`
// edges — the confidence function caps BOTH claims at 0.30 and flags them
// `contradicted` (neither is silently trusted) until a human/next run resolves it.

export type ConflictVerdict = "contradict" | "agree" | "unrelated";
export interface ConflictJudge { (a: string, b: string): Promise<ConflictVerdict>; }

export interface DetectConflictsResult { compared: number; conflicts: number; }

export async function detectConflicts(
  client: QueryClient,
  claimIds: string[],
  threadId: string | null,
  judge: ConflictJudge,
  maxDistance = 0.25,
): Promise<DetectConflictsResult> {
  const res: DetectConflictsResult = { compared: 0, conflicts: 0 };
  if (!threadId || !claimIds.length) return res;

  for (const id of claimIds) {
    // Nearest other active claim in the same thread, from a DIFFERENT synthesis
    // (don't flag a run against itself), by embedding distance.
    const r = await client.queryObject<{ id: string; text: string; mytext: string; distance: string }>(
      `SELECT n.id, n.text,
              c.text AS mytext,
              (n.embedding <=> c.embedding) AS distance
         FROM public.claims c
         JOIN public.claims n
           ON n.thread_id = c.thread_id AND n.id <> c.id AND n.status = 'active'
          AND n.synthesis_id IS DISTINCT FROM c.synthesis_id
          AND n.embedding IS NOT NULL
        WHERE c.id = $1 AND c.embedding IS NOT NULL
        ORDER BY n.embedding <=> c.embedding
        LIMIT 1`,
      [id],
    );
    const cand = r.rows[0];
    if (!cand || Number(cand.distance) > maxDistance) continue;
    res.compared++;
    let verdict: ConflictVerdict;
    try { verdict = await judge(cand.mytext, cand.text); } catch { continue; }
    if (verdict !== "contradict") continue;
    // Reciprocal contradicts edges — surface on both, prefer neither.
    await client.queryObject(`SELECT link_claim_to_claim($1, $2, 'contradicts', 1.0)`, [id, cand.id]);
    await client.queryObject(`SELECT link_claim_to_claim($1, $2, 'contradicts', 1.0)`, [cand.id, id]);
    res.conflicts++;
  }
  return res;
}
