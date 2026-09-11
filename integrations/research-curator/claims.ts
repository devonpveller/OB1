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

/** Layer A — the claim talks about the source SET rather than about the world. */
// A REPORTING verb — the verb a sentence uses when its subject is a document
// rather than the world. "no source STATES x" is meta; "the author found no
// Sources sheet" is a fact about a spreadsheet and was dropped by the first
// version of this list, which matched a bare "no sources".
const REPORTS =
  "(mention|state|says?|confirm|document|describe|address|explain|discuss|give|list|name|" +
  "report|indicate|support|cover|contain|provide|specify|specifies|clarif\\w*|enumerat\\w*|" +
  "break|frame|label|explicitly|available|provided|here\\b)";

const SOURCE_REFERENTIAL: RegExp[] = [
  /^the\s+(provided\s+)?sources?\s+(contain|do(es)?\s+not|lack|make|reference|describe|address|establish|say)/i,
  new RegExp("^no\\s+(provided\\s+)?sources?\\b", "i"),
  new RegExp("\\bno\\s+(provided\\s+)?sources?\\s+(\\w+\\s+){0,2}" + REPORTS, "i"),
  /\bnone\s+of\s+(these|the|those)\s+sources?\b/i,
  /\b(the\s+)?sources?\s+(provided|given|available|held)\b/i,
  /\b(the\s+)?sources?\s+(do|does)\s+not\b/i,
  // A claim that cites "Source N" INSIDE its own text is describing the
  // evidence set, not the world. (The [Source N] markers are stripped before
  // this runs; a bare "(Source 3)" in prose is not.)
  /\(\s*sources?\s+\d+\s*\)/i,
];

/**
 * Layer B — the claim's assertion is about the STATE OF CONFIRMATION rather
 * than about a fact: what is not confirmed, not ruled out, not extrapolable,
 * or true of X "and not" the thing actually being researched. These are
 * epistemic statements; they describe the evidence, and "documented for the DGX
 * Spark, NOT the OptiPlex" is the shape that produced four of the eight.
 */
const EVIDENTIAL_HEDGE: RegExp[] = [
  // A BARE "… is not confirmed" was here and matched ordinary world claims that
  // end in an honest caveat ("…though the exact UI pattern is not confirmed"),
  // which the filter would then have deleted. Only the form that names what it
  // is not confirmed FOR survives: that is the "documented for X, not for the
  // thing you asked about" shape the audit found.
  /\bnot\s+confirmed\s+(as|for|in)\b/i,
  /\bdoes\s+not\s+rule\s+out\b/i,
  /\bcannot\s+be\s+(directly\s+)?extrapolated\b/i,
  /\bpertains?\s+to\s+[^,]+,\s*not\s+(the|a|an)\b/i,
  /\bdocumented\s+for\s+[^;.]+;\s*(this\s+)?is\s+not\b/i,
  /\bno\s+source\s+(confirms?|states?|provides?|documents?|describes?|addresses?|explains?|discusses?|gives?)/i,
  /\bbut\s+no\s+source\b/i,
];

export type MetaVerdict = "meta" | "world";

/**
 * Deterministic half of the filter. "world" means ONLY that these patterns did
 * not recognise it — the caller may still ask the judge.
 */
export function classifyMetaClaim(text: string): MetaVerdict {
  const t = String(text || "");
  if (!t.trim()) return "world";
  for (const re of SOURCE_REFERENTIAL) if (re.test(t)) return "meta";
  for (const re of EVIDENTIAL_HEDGE) if (re.test(t)) return "meta";
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
