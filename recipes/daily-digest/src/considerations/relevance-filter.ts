/**
 * LlmRelevanceFilter — second-stage relevance check for considerations.
 *
 * Embedding similarity finds *surface-similar* thoughts. That's a wide
 * net: an event titled "Coffee with Sarah" will match every brain
 * thought mentioning Sarah, including unrelated emails she sent years
 * ago. The user has zero use for those; they want context that is
 * actually relevant to preparing for / understanding the event.
 *
 * This class takes a candidate list from SemanticSearch and asks the
 * local LLM to keep only the truly-relevant items. Single LLM call per
 * event (batched across all candidates), small completion (<= 30
 * tokens) — cheap enough to run on every digest fire.
 *
 * SOLID note: this is a decorator-style filter that depends only on
 * LlmClient and on the ConsiderationResult shape. The Section using it
 * doesn't need to know whether filtering is on, off, or how it works.
 */

import { LlmClient } from "../clients/llm.ts";
import { ConsiderationResult } from "./semantic-search.ts";

export interface RelevanceContext {
  /** Short description of what the considerations are for (event, todo, etc.) */
  summary: string;
  /** Optional richer description for the LLM to ground on. */
  description?: string;
}

export interface LlmRelevanceFilterOptions {
  /** Cap on candidates per filter call. Avoids blowing past prompt budgets. */
  maxCandidates?: number;
  /** Per-call LLM timeout. Default 25s. */
  timeoutMs?: number;
}

export class LlmRelevanceFilter {
  constructor(
    private readonly llm: LlmClient,
    private readonly opts: LlmRelevanceFilterOptions = {},
  ) {}

  /**
   * Return the subset of candidates the LLM judges relevant for the
   * given context. Order is preserved. On any failure (timeout, malformed
   * response, etc.) returns the input unchanged — degrade to embeddings-
   * only behavior rather than dropping the considerations entirely.
   */
  async filter(context: RelevanceContext, candidates: ConsiderationResult[]): Promise<ConsiderationResult[]> {
    if (candidates.length === 0) return [];
    const max = this.opts.maxCandidates ?? 12;
    const bounded = candidates.slice(0, max);

    const prompt = this.buildPrompt(context, bounded);
    const reply = await this.llm.chat({
      prompt,
      maxTokens: 30,
      temperature: 0,
      timeoutMs: this.opts.timeoutMs ?? 25_000,
    });
    if (!reply) return candidates;

    const keepIndices = this.parseIndices(reply, bounded.length);
    if (keepIndices === null) return candidates;
    if (keepIndices.length === 0) return [];

    return keepIndices.map((i) => bounded[i - 1]);
  }

  private buildPrompt(ctx: RelevanceContext, candidates: ConsiderationResult[]): string {
    const numbered = candidates
      .map((c, i) => `${i + 1}. ${c.snippet}`)
      .join("\n");
    return `Calendar event: ${ctx.summary}${ctx.description ? `\nDescription: ${ctx.description.slice(0, 240)}` : ""}

Items pulled from the user's brain that semantic search picked as potentially related:
${numbered}

Pick items that give USEFUL CONTEXT for this event. Be inclusive — relevance is about thematic connection, not exact match.

Keep an item if it:
- Shares a theme with the event (e.g. travel research for a travel event, work topic for a work meeting)
- References the same person, place, or organization mentioned in the event
- Is about preparation, history, or background for this kind of event
- Is plausibly something the user would want to glance at before the event

Drop an item ONLY if it has no thematic connection at all (e.g. an item about cooking when the event is a flight booking).

Output format: comma-separated 1-based indices, e.g. "1, 3, 5". Up to ${candidates.length}. If truly nothing is relevant, output exactly: none. No other text, no explanation.`;
  }

  /**
   * Parse the LLM reply. Tolerates whitespace, surrounding text, and
   * common variants. Returns null on unparseable response (caller falls
   * back to the unfiltered candidate list).
   */
  private parseIndices(reply: string, max: number): number[] | null {
    const cleaned = reply.toLowerCase().trim();
    if (cleaned === "none" || cleaned.startsWith("none")) return [];
    // Pull every integer the response mentions; clamp to valid range.
    const matches = cleaned.match(/\b([1-9]|1[0-9]|2[0-9])\b/g);
    if (!matches) return null;
    const indices: number[] = [];
    const seen = new Set<number>();
    for (const m of matches) {
      const n = parseInt(m, 10);
      if (n >= 1 && n <= max && !seen.has(n)) {
        seen.add(n);
        indices.push(n);
      }
    }
    return indices;
  }
}
