/**
 * Shared types for the link-enrichment stage (S3 — Digest Link Processor).
 *
 * Plan: documentation/daily-digests-autonomous-podcasts/PLAN-digest-podcast-services.md (S3)
 * Tasks: …/TASKS-digest-podcast-services.md (P1)
 *
 * The stage follows each label-email's links, fetches + extracts the article,
 * runs the D6 synthesis pass (tagged grounded claims citing the article), and
 * hands a research package to the openbrain-curator (S1) which resolves the
 * thread and writes grounded claims. Output is a day report: one row per
 * candidate link, with its resolved thread + an audible enrichment status.
 */

/**
 * Per-link / per-segment enrichment status — rides on the report so the
 * podcast renderer can SPEAK it (the operator's "say so in the audio" rule).
 */
export type EnrichmentStatus =
  | "enriched" // fetched + extracted + ingested → narrate from full content
  | "email-only" // link failed / paywalled / robots-blocked / skipped → narrate from blurb + caveat
  | "previously-seen"; // dedup hit (already a source) → narrate as "previously seen"

/** A URL pulled from an email, after hygiene + redirect unwrapping. */
export interface LinkCandidate {
  /** The URL as it appeared in the email (possibly a tracker wrapper). */
  rawUrl: string;
  /** The unwrapped destination (=rawUrl when no redirect). */
  url: string;
  /** Registrable-ish host of `url`, for grouping/logging. */
  domain: string;
  /** Anchor text from the raw email HTML — the key POI signal. */
  text?: string;
  /** Why a candidate was dropped before fetch (kept = undefined). */
  dropped?: string;
}

/** Result of fetching + extracting one article. */
export interface ExtractResult {
  ok: boolean;
  status: number; // HTTP status (0 on transport failure)
  title: string;
  text: string; // extracted article text ("" when !ok)
  reason?: string; // human note when !ok (timeout / robots / paywall-stub / …)
}

/** One row of the day report — the required input to S4 (the podcast step). */
export interface DayReportEntry {
  gmailId: string;
  label: string;
  rawUrl: string;
  url: string;
  domain: string;
  status: EnrichmentStatus;
  /** Curator decision, when the package was committed. */
  threadId?: string;
  threadName?: string;
  threadDecision?: "explicit" | "existing" | "new";
  /** Grounded-claim stats from the curator response (committed runs). */
  claimsWritten?: number;
  claimsDeduped?: number;
  ungroundedSkipped?: number;
  /** Populated in dry-run: the package that WOULD be posted. */
  preview?: {
    claim: string;
    synthesisChars: number;
    taggedClaimLines: number;
  };
  /** Why this entry is email-only / skipped. */
  note?: string;
}

/** The full day report handed to S4 and written to /reports. */
export interface DayReport {
  generatedAt: string;
  windowHours: number;
  committed: boolean; // false = dry-run (nothing written to the brain)
  totals: {
    emailsScanned: number;
    emailsWithNoLinks: number; // likely HTML-only → href loss (measures the raw-Gmail gap)
    linksConsidered: number;
    enriched: number;
    emailOnly: number;
    previouslySeen: number;
  };
  entries: DayReportEntry[];
}
