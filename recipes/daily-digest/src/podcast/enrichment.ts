/**
 * Email enrichment artifact — the bridge from the podcast pipeline to the email.
 *
 * Chain reordered (2026-06-08, operator): the email now waits for the podcast
 * and is enriched by its research. The podcast pipeline (link-enrich.ts) writes
 * this artifact after producing the episode; the digest's PodcastBriefSection
 * reads it and renders a richer "researched feeds" block + episode link +
 * follow-ups. If the artifact is missing or stale, the section is omitted and
 * the email still goes out (the email-always-arrives invariant holds).
 *
 * Shared by producer (link-enrich) and consumer (digest section).
 */

export interface EnrichedArticle {
  title: string;
  url: string;
  keyPoints: string[]; // [SOURCED]/[INFERRED] — grounded to the article
  preliminary: string[]; // [UNCERTAIN] — "preliminary research suggests…"
  gaps: string[]; // [GAP] — open questions
  emailOnly: boolean; // couldn't enrich → narrate the caveat
}
export interface EnrichedSegment {
  label: string; // gmail label, e.g. "brain/ai/nate b jones"
  items: EnrichedArticle[];
}
export interface EmailEnrichment {
  generatedAt: string;
  date: string;
  episode: {
    name: string;
    title: string;
    /** Open the episode in Open Notebook's UI (user-facing / Tailnet). */
    viewUrl: string | null;
    /** Direct audio download (user-facing / Tailnet). */
    downloadUrl: string | null;
  } | null;
  segments: EnrichedSegment[];
  followUps: string[]; // aggregated open questions across the day — the "actions"
}

/** Strip tags/citations to email-ready prose. */
function clean(s: string): string {
  return String(s || "")
    .replace(/\[Source[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[-•*\s]+/, "")
    .trim();
}

/** Parse a tagged synthesis into email-ready bullet groups. */
export function parseSynthesisForEmail(
  synthesis: string,
): { keyPoints: string[]; preliminary: string[]; gaps: string[] } {
  const keyPoints: string[] = [], preliminary: string[] = [], gaps: string[] = [];
  for (const raw of String(synthesis || "").split("\n")) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\[(?:SOURCED|INFERRED)\]\s*(.+)$/i))) keyPoints.push(clean(m[1]));
    else if ((m = line.match(/^\[UNCERTAIN\]\s*(.+)$/i))) preliminary.push(clean(m[1]));
    else if ((m = line.match(/^\[GAP\]\s*(.+)$/i))) gaps.push(clean(m[1]));
  }
  return { keyPoints, preliminary, gaps };
}

/**
 * Load the enrichment artifact, accepting it only if recent (the digest runs
 * minutes after the podcast). Returns null on missing/stale/unparseable — the
 * caller then omits the section and the email still sends.
 */
export async function loadEnrichment(
  path: string,
  maxAgeMs = 12 * 3600 * 1000,
): Promise<EmailEnrichment | null> {
  try {
    const data = JSON.parse(await Deno.readTextFile(path)) as EmailEnrichment;
    const age = Date.now() - new Date(data.generatedAt).getTime();
    if (!(age >= 0 && age < maxAgeMs)) return null; // stale → ignore
    return data;
  } catch {
    return null;
  }
}
