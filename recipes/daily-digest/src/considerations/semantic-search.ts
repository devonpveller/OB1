/**
 * SemanticSearch — reusable "considerations" lookup.
 *
 * Embed a piece of query text via the local llama-cpp-embed service,
 * then ask the brain (via the match_thoughts RPC) for the top-K most
 * similar thoughts. Any section that wants "related from your brain"
 * context per item can inject this and call findRelated.
 *
 * Why a separate file: this is shared between CalendarSection (and
 * eventually TodoSection). Per Open/Closed, adding a new consumer
 * means importing this; no edits here.
 */

import { BrainClient } from "../clients/postgrest.ts";
import { LlmClient } from "../clients/llm.ts";

export interface ConsiderationResult {
  id: number;
  /** Short content snippet (≤200 chars), already truncated. */
  snippet: string;
  /** metadata.source if present, otherwise null. */
  source: string | null;
  /** Cosine similarity, 0–1. */
  similarity: number;
}

export interface SemanticSearchOptions {
  /** Top-K results to return. */
  k: number;
  /** Minimum cosine similarity to include in results. */
  threshold?: number;
  /** PostgREST JSONB filter expression for match_thoughts. */
  filter?: Record<string, unknown>;
}

export class SemanticSearch {
  constructor(
    private readonly brain: BrainClient,
    private readonly llm: LlmClient,
    private readonly defaults: Pick<SemanticSearchOptions, "k" | "threshold"> = { k: 3, threshold: 0.5 },
  ) {}

  /**
   * Find brain thoughts related to a query string. Returns an empty
   * array on embed failure or RPC failure — callers should render the
   * section without considerations rather than fail.
   */
  async findRelated(query: string, overrides: Partial<SemanticSearchOptions> = {}): Promise<ConsiderationResult[]> {
    const k = overrides.k ?? this.defaults.k ?? 3;
    const threshold = overrides.threshold ?? this.defaults.threshold ?? 0.5;
    const trimmed = query.trim();
    if (!trimmed) return [];

    const embedding = await this.llm.embed(trimmed);
    if (!embedding) return [];

    try {
      const rows = await this.brain.semanticSearch({
        embedding,
        k,
        threshold,
        filter: overrides.filter,
      });
      return rows.map((r) => ({
        id: r.id,
        snippet: trimSnippet(r.content, 200),
        source: (r.metadata?.source as string | undefined) ?? null,
        similarity: r.similarity,
      }));
    } catch (err) {
      console.warn(`SemanticSearch RPC failed: ${err}`);
      return [];
    }
  }
}

function trimSnippet(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}
