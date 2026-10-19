/**
 * Phase 2 — the Skeptic: a defensive investment-gate over a grounded synthesis.
 *
 * Purpose (DEFENSE): keep low-quality sources and ungrounded/fake claims from
 * being invested into Open Brain, autonomously (no human in the loop), while
 * recording an audit trail of what was rejected. Its verdict DOWNGRADES a claim's
 * tag ([SOURCED]→[UNCERTAIN]/[GAP]) — which the curator already turns into lower
 * confidence via its tag→edge weighting, so a refuted claim falls below the reuse
 * floor and is not compounded as fact.
 *
 * SCOPE OF THIS MODULE (pure, no I/O — fully unit-testable):
 *   - SKEPTIC_SYS         the adversarial judge prompt
 *   - parseSkepticResult  tolerant JSON parse (fail-OPEN: a broken verdict = no-op)
 *   - applyDowngrades     index-safe tag rewrite over the synthesis string
 *   - deriveRequeries     corroborating + negated queries (for the re-gather tier)
 *
 * The judge CALL (deps.chat) and the loop live in harness.ts. The re-gather /
 * drop-and-replace tier (which mutates the source pool and RE-synthesizes) needs
 * the live stack to validate citation realignment; it is gated behind
 * SKEPTIC_REGATHER_MAX (default 0) and validated on-site.
 *
 * Governing plan: documentation/implementation-guide/supervised-research-pipeline/
 *   TASKS-phase2-skeptic.md.
 */

/** A claim tag in the grounded synthesis vocabulary. */
export type Tag = "SOURCED" | "INFERRED" | "UNCERTAIN" | "GAP";
/** A skeptic only ever LOWERS a tag — never upgrades. Valid downgrade targets. */
const DOWNGRADE_TARGETS = new Set<Tag>(["UNCERTAIN", "GAP"]);

export interface SkepticChallenge {
  claim: string;   // the assertion under challenge (verbatim from the synthesis)
  type: string;    // source_dependence | currency | severity_inflation | non_sequitur | disconfirming_evidence
  evidence: string;
  confidenceDelta: number; // negative; drives forecast probability later (Track B)
}
export interface Downgrade { claim: string; to: Tag; }
export interface SkepticResult {
  challenges: SkepticChallenge[];
  downgrades: Downgrade[];
  refuted: string[];                                      // claims judged unsupported
  droppedSources: Array<{ url: string; reason: string }>;// source-level rejections (audit)
  regatherRounds: number;                                // drop-and-replace iterations run
}

export function emptySkepticResult(): SkepticResult {
  return { challenges: [], downgrades: [], refuted: [], droppedSources: [], regatherRounds: 0 };
}

export const SKEPTIC_SYS =
  `You are Open Brain's SKEPTIC — an adversarial reviewer whose job is to REFUTE, not to write. You are given a QUESTION, a GROUNDED ANSWER (one tagged claim per line, each ending with its [Source N] citation), and the SOURCES. Your goal is DEFENSE: stop low-quality sources and unsupported claims from being trusted.

Scrutinize:
- SOURCE quality/independence: are the sources trustworthy, current, and INDEPENDENT (not all echoing one press release)? List any that should not be trusted.
- CLAIM grounding: does each [SOURCED]/[INFERRED] claim actually follow from the cited sources? Watch for severity inflation, stale data, and conclusions that do not follow.

Return ONLY JSON:
{
  "challenges": [{"claim":"<verbatim assertion>","type":"source_dependence|currency|severity_inflation|non_sequitur|disconfirming_evidence","evidence":"<why>","confidenceDelta":-0.3}],
  "downgrades": [{"claim":"<verbatim assertion to weaken>","to":"UNCERTAIN"}],
  "refuted": ["<verbatim assertion the sources do NOT support>"],
  "droppedSources": [{"url":"<source url to distrust>","reason":"<why>"}]
}

RULES: quote the "claim" text verbatim from the GROUNDED ANSWER so it can be located. Downgrade to "UNCERTAIN" when support is weak, "GAP" when the sources do not support it at all. Put clearly-unsupported claims in "refuted" AND downgrade them to "GAP". confidenceDelta is negative (0 to -1). If the answer is sound, return empty arrays. Never invent facts; you only judge what is present.`;

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Parse the judge's JSON verdict tolerantly. FAIL-OPEN: any parse/shape error
 * yields an empty result (the skeptic never breaks a run — like screenSources).
 * Malformed individual entries are dropped, not fatal. Only downgrades to a valid
 * LOWER tag are kept (a skeptic never upgrades).
 */
export function parseSkepticResult(raw: string): SkepticResult {
  const out = emptySkepticResult();
  let o: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    o = parsed as Record<string, unknown>;
  } catch {
    return out;
  }

  if (Array.isArray(o.challenges)) {
    for (const c of o.challenges) {
      if (!c || typeof c !== "object") continue;
      const r = c as Record<string, unknown>;
      const claim = asStr(r.claim);
      if (!claim) continue;
      out.challenges.push({
        claim, type: asStr(r.type) || "unspecified",
        evidence: asStr(r.evidence), confidenceDelta: asNum(r.confidenceDelta),
      });
    }
  }
  if (Array.isArray(o.downgrades)) {
    for (const d of o.downgrades) {
      if (!d || typeof d !== "object") continue;
      const r = d as Record<string, unknown>;
      const claim = asStr(r.claim);
      const to = asStr(r.to).toUpperCase() as Tag;
      if (claim && DOWNGRADE_TARGETS.has(to)) out.downgrades.push({ claim, to });
    }
  }
  if (Array.isArray(o.refuted)) {
    for (const x of o.refuted) { const s = asStr(x); if (s) out.refuted.push(s); }
  }
  if (Array.isArray(o.droppedSources)) {
    for (const s of o.droppedSources) {
      if (!s || typeof s !== "object") continue;
      const r = s as Record<string, unknown>;
      const url = asStr(r.url);
      if (url) out.droppedSources.push({ url, reason: asStr(r.reason) });
    }
  }
  return out;
}

const TAG_RE = /^(\s*)\[(SOURCED|INFERRED|UNCERTAIN)\]/i;
const CITE_RE = /\s*\[Sources?[^\]]*\]/gi;

/**
 * Rewrite the tag of each downgraded claim's line IN PLACE (index-safe: line
 * count and [Source N] numbers are preserved, so buildCitedAndRenumber stays
 * aligned). A claim is matched to the first not-yet-used tagged line that
 * contains its text (case-insensitive). Downgrading to GAP also strips the
 * citation (a [GAP] line carries none). Returns the new synthesis + count applied.
 */
export function applyDowngrades(synthesis: string, downgrades: Downgrade[]): { synthesis: string; applied: number } {
  if (!downgrades.length) return { synthesis, applied: 0 };
  const lines = synthesis.split("\n");
  const used = new Set<number>();
  let applied = 0;
  for (const dg of downgrades) {
    const needle = dg.claim.trim().toLowerCase();
    if (!needle) continue;
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const line = lines[i];
      if (!TAG_RE.test(line)) continue;
      if (!line.toLowerCase().includes(needle)) continue;
      let next = line.replace(TAG_RE, `$1[${dg.to}]`);
      if (dg.to === "GAP") next = next.replace(CITE_RE, "").trimEnd();
      lines[i] = next;
      used.add(i);
      applied++;
      break;
    }
  }
  return { synthesis: lines.join("\n"), applied };
}

/**
 * Build re-gather queries for the drop-and-replace tier: for each refuted claim,
 * a corroborating query (the claim itself) and a NEGATED one (all current
 * gathering is confirmatory; nothing searches against the thesis). Capped.
 */
export function deriveRequeries(refuted: string[], cap = 6): string[] {
  const out: string[] = [];
  for (const claim of refuted) {
    const c = claim.trim();
    if (!c) continue;
    out.push(c);
    out.push(`${c} debunked OR false OR contradicted OR "no evidence"`);
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}
