/**
 * PodcastBriefSection — the email's researched "deep dive" + episode link.
 *
 * Chain reordered: the podcast pipeline runs BEFORE the email and writes a
 * concise enrichment artifact (podcast-brief-latest.json) to the shared
 * /reports volume. This section reads it. If it's missing or stale (podcast
 * failed, or this is an off-cycle digest run), `produce` returns null and the
 * section is simply omitted — the email still goes out (section-omit invariant).
 *
 * No network, no LLM — purely reads the artifact the pipeline already produced.
 */

import { Section, SectionData } from "./section.ts";
import { EmailEnrichment, loadEnrichment } from "../podcast/enrichment.ts";

export type PodcastBriefPayload = EmailEnrichment;

export interface PodcastBriefOptions {
  /** Path to the enrichment artifact (shared /reports volume). */
  path: string;
  /** Reject artifacts older than this (the podcast runs minutes before). */
  maxAgeMs?: number;
}

export class PodcastBriefSection implements Section {
  readonly name = "podcast_brief";

  constructor(private readonly opts: PodcastBriefOptions) {}

  async produce(): Promise<SectionData<PodcastBriefPayload> | null> {
    const data = await loadEnrichment(this.opts.path, this.opts.maxAgeMs);
    if (!data) return null;
    const hasContent = !!data.episode ||
      data.segments.some((s) => s.items.length > 0) ||
      data.followUps.length > 0;
    if (!hasContent) return null;
    return { kind: "podcast_brief", payload: data };
  }
}
