/**
 * claim-edges.ts - THE line-tag -> grounding-edge rule (rw-p3a-entail attempt 4, tester finding F2).
 *
 * ONE SOURCE. This file is the only place that says which edges a tagged synthesis line is filed
 * with. The research curator files claims with it (claims.ts parseSynthesisClaims) and the research
 * service computes each line's credibility with it (credibility.ts filedLineCredibility), so the
 * run's line total is the total of the claim the curator files from that line. The two services
 * build from separate Docker contexts, so the research service carries a byte-identical copy at
 * integrations/research-service/claim-edges.ts; claim-edges.test.ts in BOTH services fails when
 * the two files differ (and the credibility e2e runner checks it too). Edit this file, then copy it.
 *
 *   [SOURCED]   first cited source `states`, the rest `corroborates`, weight 1.0
 *   [INFERRED]  every cited source `inferred_from`, weight 1.0
 *   [UNCERTAIN] every cited source `inferred_from`, weight 0.5
 *   a line citing more than OMNIBUS_CITATION_MAX sources is [UNCERTAIN] whatever its tag (Phase 3.2:
 *   a line citing the whole pool is a summary, not a finding) - `inferred_from` 0.5 for every source
 *   [GAP] or anything else: no edges (not a claim)
 *
 * What an edge TYPE is worth (states / corroborates / inferred_from) is not here: it is the
 * registry's `credibility_terms.edge_factors` row, read by both credibility twins.
 * Pure, dependency-free.
 */

export type EdgeType = "states" | "inferred_from" | "corroborates" | "contradicts";
export type EpistemicTag = "sourced" | "inferred" | "uncertain";

export interface ParsedEdge {
  /** 1-based [Source N] index as written in the synthesis. */
  sourceIndex: number;
  edgeType: EdgeType;
  weight: number;
}

/**
 * The 0.85 poison claim cited ALL ELEVEN sources from one line. A single assertion that eleven
 * independent sources directly state is not a finding, it is a summary of the pool - so past this
 * many citations a line is at most [UNCERTAIN] and never writes a `states` edge.
 */
export const OMNIBUS_CITATION_MAX = 4;
export function isOmnibusCitation(nums: number[]): boolean {
  return (nums || []).length > OMNIBUS_CITATION_MAX;
}

/** A line tag as written ("SOURCED", "[Inferred]", "uncertain") -> the epistemic tag, or null (GAP, unknown). */
export function epistemicTagOf(tag: string): EpistemicTag | null {
  const t = String(tag || "").replace(/[[\]\s]/g, "").toLowerCase();
  return t === "sourced" || t === "inferred" || t === "uncertain" ? t : null;
}

/** The tag a line is FILED under: its own, or [UNCERTAIN] for an omnibus line. */
export function effectiveTag(tag: EpistemicTag, nums: number[]): EpistemicTag {
  return isOmnibusCitation(nums) ? "uncertain" : tag;
}

/**
 * The smallest non-zero credibility number (attempt 4, tester finding F1): an edge weight is 0 or in
 * [1e-9, 1], judged on the REAL (float4) the database stores it as - claim_sources.weight is REAL, so
 * Math.fround(weight) is the number both credibility twins read. NaN, Infinity, 5 and -1 are refused.
 * The SQL twin's CHECK claim_sources_weight_credibility applies the same rule to the stored value.
 */
export const EDGE_WEIGHT_MIN_NONZERO = 1e-9;
export function edgeWeightOk(weight: unknown): boolean {
  if (typeof weight !== "number" || !Number.isFinite(weight)) return false;
  const w = Math.fround(weight);
  return w === 0 || (w >= EDGE_WEIGHT_MIN_NONZERO && w <= 1);
}

/** The edges a line with this (effective) tag and these citations is filed with. */
export function edgesForTag(tag: EpistemicTag, nums: number[]): ParsedEdge[] {
  if (isOmnibusCitation(nums)) {
    return nums.map((sourceIndex) => ({ sourceIndex, edgeType: "inferred_from" as EdgeType, weight: 0.5 }));
  }
  if (tag === "sourced") {
    // First citation directly states; the rest independently corroborate.
    return nums.map((sourceIndex, i) => ({
      sourceIndex,
      edgeType: (i === 0 ? "states" : "corroborates") as EdgeType,
      weight: 1.0,
    }));
  }
  if (tag === "inferred") {
    return nums.map((sourceIndex) => ({ sourceIndex, edgeType: "inferred_from" as EdgeType, weight: 1.0 }));
  }
  // uncertain - derived but low-trust.
  return nums.map((sourceIndex) => ({ sourceIndex, edgeType: "inferred_from" as EdgeType, weight: 0.5 }));
}

/**
 * The whole rule in one call: a line's tag as written and its citations (in order, de-duplicated)
 * -> the tag it is filed under and its edges; null when the line is not filed as a claim.
 */
export function claimEdges(tag: string, nums: number[]): { tag: EpistemicTag; edges: ParsedEdge[] } | null {
  const t = epistemicTagOf(tag);
  if (!t) return null;
  const eff = effectiveTag(t, nums);
  return { tag: eff, edges: edgesForTag(eff, nums) };
}
