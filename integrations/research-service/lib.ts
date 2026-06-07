/**
 * Pure helpers for the research service (no DB, no network) — the testable core
 * of the harness: HTML→text extraction, the OD-5 reuse decision, the OD-6
 * backstop, citation parsing, and the reuse metric.
 *
 * Governing spec: documentation/implementation-guide/research-engine-for-OB/
 *   GROUNDING-MODEL.md + PLAN-research-engine.md §6 + decisions OD-5/OD-6.
 */

// ── HTML → text (per-source extraction; single pages, not whole sites) ──────
const _ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => _ENTITIES[m.toLowerCase()] ?? m);
}

/** Strip a fetched HTML document down to readable body text. */
export function extractTextFromHtml(html: string): string {
  let s = String(html || "");
  // Drop non-content elements wholesale.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(nav|header|footer|aside|form|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Block elements → newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");           // remaining tags
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n").trim();
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// ── Freshness (OD-5; windows fast 7 / medium 180 / slow 1095) ───────────────
export function revalidateWindow(volatility?: string | null, revalidateDays?: number | null): number {
  if (revalidateDays != null && Number.isFinite(revalidateDays)) return revalidateDays;
  switch (volatility) {
    case "fast": return 7;
    case "medium": return 180;
    case "slow": return 1095;
    default: return 180;
  }
}

export function isStale(researchedOn: string | Date | null | undefined,
                        volatility: string | null | undefined,
                        revalidateDays: number | null | undefined,
                        now: Date): boolean {
  if (!researchedOn) return true;
  const ro = researchedOn instanceof Date ? researchedOn : new Date(researchedOn);
  if (isNaN(ro.getTime())) return true;
  const due = ro.getTime() + revalidateWindow(volatility, revalidateDays) * 86400000;
  return now.getTime() > due;
}

// ── OD-5 reuse decision ─────────────────────────────────────────────────────
export interface ClaimReuseInput {
  confidence: number;
  contradicted: boolean;
  hasStrongEdge: boolean;   // states OR corroborates present
  grounded: boolean;        // terminates in a primary source
  researchedOn: string | Date | null;
  volatility: string | null;
  revalidateDays: number | null;
}
export type ReuseVerdict = "reuse" | "revalidate" | "research";

/**
 * OD-5 "strict + stale":
 *  - reuse as-is:  grounded, strong edge (states/corroborated), fresh, >= floor
 *  - revalidate:   grounded but inferred-only OR stale (cheap re-confirm)
 *  - research:     ungrounded / contradicted / below floor (full gather)
 */
export function decideReuse(c: ClaimReuseInput, floor: number, now: Date): ReuseVerdict {
  if (!c.grounded || c.contradicted || c.confidence < floor) return "research";
  const stale = isStale(c.researchedOn, c.volatility, c.revalidateDays, now);
  if (c.hasStrongEdge && !stale) return "reuse";
  return "revalidate";
}

// ── OD-6 adaptive backstop (cannot hallucinate; degrades to honest gaps) ─────
export interface BackstopState {
  elapsedMs: number;
  maxMs: number;
  fetches: number;
  maxFetches: number;
  openGaps: number;
}
export interface BackstopDecision { stop: boolean; reason: "complete" | "wall_time" | "max_fetch" | "continue"; }

export function backstopDecision(s: BackstopState): BackstopDecision {
  if (s.openGaps <= 0) return { stop: true, reason: "complete" };
  if (s.elapsedMs >= s.maxMs) return { stop: true, reason: "wall_time" };
  if (s.fetches >= s.maxFetches) return { stop: true, reason: "max_fetch" };
  return { stop: false, reason: "continue" };
}

// ── Reuse metric (P4.5) ─────────────────────────────────────────────────────
export interface ReuseMetric {
  claims_reused: number;
  claims_freshly_gathered: number;
  gap_ratio: number;        // open gaps / total needs (0 = fully covered)
}
export function reuseMetric(reused: number, freshlyGathered: number, openGaps: number): ReuseMetric {
  const total = reused + freshlyGathered + openGaps;
  return {
    claims_reused: reused,
    claims_freshly_gathered: freshlyGathered,
    gap_ratio: total > 0 ? openGaps / total : 0,
  };
}

// ── Citation parsing ([Source N]) — cited-only subset (GROUNDING-MODEL §6.3) ─
const CITE_RE = /\[Sources?\s+([\d,\s&and]+?)\]/gi;
export function citedNumbers(synthesis: string): number[] {
  const nums = new Set<number>();
  let m: RegExpExecArray | null;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(String(synthesis || ""))) !== null) {
    for (const tok of m[1].split(/[,\s&]+|and/i)) {
      const n = parseInt(tok.trim(), 10);
      if (Number.isFinite(n) && n > 0) nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/** Keep only the sources the synthesis actually cited ([Source N] → sources[N-1]). */
export function citedSubset<T>(synthesis: string, sources: T[]): T[] {
  return citedNumbers(synthesis)
    .map((n) => sources[n - 1])
    .filter((x): x is T => x != null);
}
