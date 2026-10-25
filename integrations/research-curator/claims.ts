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

// attempt 4 (rw-p3a-entail, tester finding F2): the tag -> edge rule lives in claim-edges.ts, the ONE
// source the research service's credibility model reads too (its byte-identical copy), so the run's
// line total is the total of the claim filed here. Re-exported for this module's callers and tests.
import {
  claimEdges, edgeWeightOk, type EdgeType, type EpistemicTag, isOmnibusCitation, LINK_EDGE_SQL, OMNIBUS_CITATION_MAX, type ParsedEdge,
} from "./claim-edges.ts";
export { claimEdges, edgeWeightOk, isOmnibusCitation, LINK_EDGE_SQL, OMNIBUS_CITATION_MAX };
export type { EdgeType, EpistemicTag, ParsedEdge };

// attempt 6 (rw-p3a-entail, the structural round): the claim list - the parse, its drop rules and the
// deterministic meta-claim filter - lives in claim-list.ts, the ONE derivation the research service
// scores its report with too (its byte-identical copy). writeClaims files exactly claimList().claims.
import {
  claimList, type ClaimList, classifyMetaClaim, type DroppedSegment, type DropReason, headClause, headClauses, type ListedClaim,
  type MetaVerdict, type ParsedClaim, parseSynthesisClaims, type ParseResult,
} from "./claim-list.ts";
export { claimList, classifyMetaClaim, headClause, headClauses, parseSynthesisClaims };
export type { ClaimList, DroppedSegment, DropReason, ListedClaim, MetaVerdict, ParsedClaim, ParseResult };

/**
 * The LLM judge's prompt, asked only about claims the deterministic patterns did
 * not recognise. It lives here, beside the writer that asks it (`classifyMetaClaim`,
 * the deterministic half, is in claim-list.ts since attempt 6), because a prompt
 * with no test is a rule nobody reads - `index.ts` imports it.
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
  /**
   * research-workbench P3a: merged into each claim's metadata - the claim kind the research run's
   * weight table read (`claim_kind`) and the credibility model version. claim_confidence_d15
   * reads claim_kind; a claim without one is scored under the registry's declared fallback kind.
   */
  claimMetadata?: Record<string, unknown>;
}

/**
 * research-workbench P3a attempt 2 (tester near-miss: "a claim filed after P3a without a kind
 * gets the basis 'filed before P3a'"). D15 item 9: an unknown kind FAILS LOUD. Every research
 * package this curator receives since P3a carries the run's claim kind (the research service's
 * harness stamps `claim_kind` on every package), so a package without one is a defect, not a
 * pre-P3a claim: its claims are NOT filed (the caller logs the loss and returns it in the body,
 * index.ts describeLoss), rather than filed under the fallback kind with a false basis. The
 * database's twin is the P3a cutover marker (credibility_trigger_state.kind_required_from): a
 * kindless claim created after it stops claim_confidence_d15 (OBC01).
 */
export class ClaimKindMissingError extends Error {
  constructor(message: string) { super(message); this.name = "ClaimKindMissingError"; }
}

/** The claim metadata a package's claims are filed with - or a loud refusal. */
export function claimMetadataFor(pkg: { claim_kind?: unknown; credibility_model?: unknown }): Record<string, unknown> {
  if (typeof pkg.claim_kind !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/.test(pkg.claim_kind)) {
    throw new ClaimKindMissingError(
      `research package carries no valid claim_kind (${JSON.stringify(pkg.claim_kind ?? null)}): claims are not filed ` +
        "- D15 item 9, an unknown kind fails loud; only claims filed before P3a take the fallback kind",
    );
  }
  return {
    claim_kind: pkg.claim_kind,
    ...(typeof pkg.credibility_model === "string" && pkg.credibility_model ? { credibility_model: pkg.credibility_model } : {}),
  };
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
  /**
   * rw-p3a-figure-filed: per claim of the shared claim list (claim-list.ts claimList(synthesis).claims,
   * index for index), the claim row it was filed into - null when it was not filed (the LLM meta judge
   * refused it, or none of its sources persisted). A repeated id is the database's own text dedup
   * (find_or_create_claim) merging two listed claims into one row. The research service re-states the
   * report credibility figure from this, so the figure is over the claims this write actually filed.
   */
  filed: Array<string | null>;
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
  // attempt 6: THE claim list (claim-list.ts) - the parse, its drop rules and the meta-claim
  // patterns; the research service scores exactly this list of the package it hands us.
  const { claims, metaSkipped, gaps } = claimList(synthesis);
  const res: WriteClaimsResult = {
    claimsWritten: 0, claimsDeduped: 0, edgesWritten: 0,
    edgesSkipped: 0, ungroundedSkipped: 0, metaSkipped: 0, gaps, claimIds: [], filed: [],
  };
  // Phase 3.1 — a statement ABOUT THE RUN is not a claim about the world and
  // must not enter the knowledge base. Patterns first (free, deterministic, in
  // claimList); the judge only for what they did not recognise, and it fails open.
  for (const skipped of metaSkipped) {
    res.metaSkipped++;
    opts.onMetaSkip?.(skipped.text, "pattern");
  }

  for (const claim of claims) {
    if (opts.metaJudge) {
      let verdict: "META" | "WORLD" = "WORLD";
      try { verdict = await opts.metaJudge(claim.text); } catch { verdict = "WORLD"; }
      if (verdict === "META") {
        res.metaSkipped++;
        res.filed.push(null);
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
    if (resolved.length === 0) { res.ungroundedSkipped++; res.filed.push(null); continue; }

    let emb: string | null = null;
    if (opts.embed) {
      try { emb = toVector(await opts.embed(claim.text)); } catch { emb = null; }
    }

    const fc = await client.queryObject<{ id: string; was_duplicate: boolean }>(
      `SELECT * FROM find_or_create_claim($1, $2, $3, $4, $5, $6, $7::vector, $8::jsonb)`,
      [
        claim.text, opts.threadId, opts.synthesisId, claim.tag,
        opts.volatility ?? null, opts.revalidateDays ?? null, emb,
        JSON.stringify({ ...(opts.claimMetadata ?? {}), source: "deep-research-claim" }),
      ],
    );
    const claimId = fc.rows[0].id;
    res.claimIds.push(claimId);
    res.filed.push(claimId);
    if (fc.rows[0].was_duplicate) res.claimsDeduped++; else res.claimsWritten++;

    for (const e of resolved) {
      // attempt 4 (tester near-miss: NaN / Infinity / 5 edge weights were stored and scored 1.0): an
      // edge weight is 0 or in [1e-9, 1] as the REAL it is stored as - refused here as the table's
      // CHECK (claim_sources_weight_credibility) refuses it
      if (!edgeWeightOk(e.weight)) {
        throw new Error(`claim edge refused: weight ${String(e.weight)} is not 0 or in [1e-9, 1] (claim_sources.weight)`);
      }
      // attempt 5 (N1): the shared statement - the weight bound as a double, cast to REAL by the database
      await client.queryObject(LINK_EDGE_SQL, [claimId, e.sourceId, e.edgeType, e.weight]);
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
