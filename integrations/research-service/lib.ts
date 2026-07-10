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
// `sources` and `timeouts` are tracked SEPARATELY and capped by DIFFERENT
// variables: `maxSources` (MAX_FETCH) is the source-YIELD budget — how many
// pages we actually retrieved — while `maxTimeouts` (MAX_FETCH_TIMEOUTS) bounds
// WASTED attempts that timed out (a flaky Tor circuit). Conflating the two (the
// old single `fetches` counter) meant a run that timed out 40 times reported the
// same "max_fetch" as one that fetched 40 real sources. They are different
// signals and now stop for different, nameable reasons.
export interface BackstopState {
  elapsedMs: number;
  maxMs: number;
  sources: number;       // successfully fetched pages (the yield)
  maxSources: number;    // MAX_FETCH
  timeouts: number;      // fetch attempts that timed out (wasted)
  maxTimeouts: number;   // MAX_FETCH_TIMEOUTS (0 disables this ceiling)
  openGaps: number;
}
export interface BackstopDecision { stop: boolean; reason: "complete" | "wall_time" | "max_fetch" | "max_timeouts" | "continue"; }

export function backstopDecision(s: BackstopState): BackstopDecision {
  if (s.openGaps <= 0) return { stop: true, reason: "complete" };
  if (s.elapsedMs >= s.maxMs) return { stop: true, reason: "wall_time" };
  if (s.sources >= s.maxSources) return { stop: true, reason: "max_fetch" };
  if (s.maxTimeouts > 0 && s.timeouts >= s.maxTimeouts) return { stop: true, reason: "max_timeouts" };
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
// Tolerant of every shape the model emits: [Source 1], [Source 1, 2],
// [Sources 1 and 2], [Source 1, Source 2, Source 4] — extract every number
// inside any [Source...] bracket.
const CITE_BRACKET_RE = /\[Sources?\b[^\]]*\]/gi;
export function citedNumbers(synthesis: string): number[] {
  const nums = new Set<number>();
  for (const bracket of String(synthesis || "").match(CITE_BRACKET_RE) || []) {
    for (const d of bracket.match(/\d+/g) || []) {
      const n = parseInt(d, 10);
      if (n > 0) nums.add(n);
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

/**
 * Build the cited-only source subset AND renumber the synthesis's `[Source N]`
 * citations to match it, so the curator (which resolves `[Source N]` →
 * source_ids[N-1]) stays aligned. Citations indexing the FULL staged list would
 * otherwise point past the end of the compacted cited list and drop edges.
 *
 * Mechanical renumber only — claim TEXT is untouched, so the synthesis is still
 * stored "verbatim" in the sense that matters (no re-synthesis/truncation); the
 * citation indices simply reference the sources that are actually stored.
 * Unresolvable citations (a number with no staged source) are dropped.
 */
export function buildCitedAndRenumber<T>(synthesis: string, sources: T[]): { synthesis: string; cited: T[] } {
  const oldNums = citedNumbers(synthesis).filter((n) => sources[n - 1] != null);
  const map = new Map<number, number>();
  oldNums.forEach((n, i) => map.set(n, i + 1));
  const cited = oldNums.map((n) => sources[n - 1]);
  const renum = String(synthesis || "").replace(CITE_BRACKET_RE, (bracket) => {
    const mapped = (bracket.match(/\d+/g) || [])
      .map((d) => map.get(parseInt(d, 10)))
      .filter((x): x is number => x != null);
    return mapped.length ? `[Source ${mapped.join(", ")}]` : "";
  });
  return { synthesis: renum, cited };
}

// ── Repo source selection (REPO-SOURCES-WIRING §4) ──────────────────────────
/**
 * Deterministic, bounded selection of a repo's KNOWLEDGE files for source
 * ingestion — docs + structural manifests only, never wholesale code. Priority
 * buckets (highest first) keep the most probative files inside `maxFiles`:
 * root README* → .gitmodules → root build manifests (*.sln,
 * Directory.Build.props, *.csproj) → docs/**\/*.md → other root *.md (LICENSE
 * excluded) → depth-1 README* → shallow *.csproj (≤2 deep). Candidates beyond
 * the cap are returned as `skipped` — logged by the caller, never silent.
 */
export interface RepoFileSelection { selected: string[]; skipped: string[] }

export function selectRepoFiles(paths: string[], maxFiles = 40): RepoFileSelection {
  const depth = (p: string) => p.split("/").length - 1;
  const base = (p: string) => p.split("/").pop() || p;
  const lb = (p: string) => base(p).toLowerCase();
  const lp = (p: string) => p.toLowerCase();
  const buckets: Array<(p: string) => boolean> = [
    (p) => depth(p) === 0 && lb(p).startsWith("readme"),
    (p) => depth(p) === 0 && base(p) === ".gitmodules",
    (p) => depth(p) === 0 && (lp(p).endsWith(".sln") || base(p) === "Directory.Build.props"
                              || lp(p).endsWith(".csproj")),
    (p) => lp(p).startsWith("docs/") && lp(p).endsWith(".md"),
    (p) => depth(p) === 0 && lp(p).endsWith(".md")
           && !lb(p).startsWith("license") && !lb(p).startsWith("readme"),
    (p) => depth(p) === 1 && lb(p).startsWith("readme"),
    (p) => depth(p) >= 1 && depth(p) <= 2 && lp(p).endsWith(".csproj"),
  ];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const match of buckets) {
    for (const p of paths) {
      if (!seen.has(p) && match(p)) { seen.add(p); candidates.push(p); }
    }
  }
  return { selected: candidates.slice(0, maxFiles), skipped: candidates.slice(maxFiles) };
}
