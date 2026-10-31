// research-workbench P3b - the trust panels' pure logic (tested in test/trust-panels.test.tsx): the
// stance bar from a claim's edge types, the needs-a-look ranking, the sort orders, the coverage counts
// line (counts, never a percent) and the source's relevance-for-run axis.

export interface LedgerClaim {
  id: string;
  text: string;
  epistemic_tag: string;
  status: string;
  confidence: number;
  contradicted: boolean;
  grounded: boolean;
  synthesis_id: string | null;
  edges_by_type: Record<string, number>;
  sources: { source_id: string; edge_type: string; lifecycle: string; title: string; url: string | null }[];
  verdict: string | null;
  corroborations: number;
  contradicted_by_newer: boolean;
}

// The stance bar: the claim's grounding edges by type (claims() edges_by_type). states / corroborates
// SUPPORT it, contradicts CONTRADICTS it, inferred_from only MENTIONS (a derived link, not a statement).
export const STANCE: Record<string, "supports" | "contradicts" | "mentions"> = {
  states: "supports", corroborates: "supports", contradicts: "contradicts", inferred_from: "mentions",
};

export function stanceOf(edges: Record<string, number>) {
  const out = { supports: 0, contradicts: 0, mentions: 0 };
  for (const [type, n] of Object.entries(edges ?? {})) out[STANCE[type] ?? "mentions"] += Number(n) || 0;
  const total = out.supports + out.contradicts + out.mentions;
  return { ...out, total };
}

// Needs a look: what should be checked first. Every reason is named, so the order is explained.
export function needsALook(c: LedgerClaim): { score: number; reasons: string[] } {
  const r: [number, string][] = [];
  if (c.contradicted_by_newer) r.push([8, "contradicted by something newer"]);
  if (c.contradicted) r.push([4, "contradicted"]);
  if (c.verdict && c.verdict !== "supports") r.push([3, `entailment ${c.verdict}`]);
  if (!c.grounded) r.push([3, "not grounded"]);
  if (!c.verdict) r.push([1, "not judged by the entailment stage"]);
  if (c.corroborations === 0) r.push([1, "no corroborating source"]);
  if (c.confidence < 0.5) r.push([2, `confidence ${c.confidence.toFixed(2)} below 0.50`]);
  return { score: r.reduce((a, [w]) => a + w, 0), reasons: r.map(([, t]) => t) };
}

export type SortKey = "confidence" | "needs-a-look";

export function sortClaims(claims: LedgerClaim[], by: SortKey, descending = true): LedgerClaim[] {
  const k = (c: LedgerClaim) => (by === "confidence" ? c.confidence : needsALook(c).score);
  const sign = descending ? -1 : 1;
  return [...claims].sort((a, b) =>
    sign * (k(a) - k(b)) ||
    (by === "needs-a-look" ? a.confidence - b.confidence : 0) ||
    a.id.localeCompare(b.id));
}

export const NEED_STATUSES = ["answered", "partial", "open", "search_failed"] as const;
export const STATUS_LABEL: Record<string, string> = {
  answered: "answered", partial: "partial", open: "open", search_failed: "search failed",
};

// "2 answered · 1 partial · 3 open · 0 search failed" - counts, never a percent.
export function statusLine(by: Record<string, number>): string {
  const known = NEED_STATUSES.map((s) => `${by?.[s] ?? 0} ${STATUS_LABEL[s]}`);
  const other = Object.entries(by ?? {}).filter(([s]) => !(NEED_STATUSES as readonly string[]).includes(s)).map(([s, n]) => `${n} ${s}`);
  return [...known, ...other].join(" · ");
}

// The relevance-for-run axis (the panel library's "relevance-for-run axis"): how much of a run's
// claim set this source grounds. With a run in focus, against that run; otherwise per run it served.
export function relevanceOf(sourceClaims: LedgerClaim[], run: { report_id: string; claims: number } | null) {
  if (run) {
    const k = sourceClaims.filter((c) => c.synthesis_id === run.report_id).length;
    return { focused: true, text: `grounds ${k} of the focused run's ${run.claims} claim(s)`, runs: k ? 1 : 0, claims: k };
  }
  const runs = new Set(sourceClaims.map((c) => c.synthesis_id).filter(Boolean));
  return {
    focused: false,
    text: sourceClaims.length
      ? `grounds ${sourceClaims.length} claim(s) across ${runs.size} run(s); focus a session in Coverage to read it against one run`
      : "grounds no claim of any run yet",
    runs: runs.size, claims: sourceClaims.length,
  };
}
