/**
 * BrainClient — narrow wrapper around the local PostgREST proxy
 * (openbrain-rest) for the queries the digest needs. Knows nothing
 * about sections, rendering, or HTTP servers.
 */

export interface Thought {
  id: number;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface BrainClientOptions {
  /** Base URL of the openbrain-rest Caddy proxy. e.g. http://openbrain-rest */
  baseUrl: string;
}

export class BrainClient {
  private readonly baseUrl: string;

  constructor(opts: BrainClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
  }

  /**
   * Latest N thoughts in a sliding time window, excluding internal types
   * (profile fields) that the AI-news section shouldn't see.
   */
  async fetchRecentThoughts(opts: {
    windowHours: number;
    limit: number;
    excludeTypes?: string[];
  }): Promise<Thought[]> {
    const since = new Date(Date.now() - opts.windowHours * 3600_000).toISOString();
    const params = new URLSearchParams({
      select: "id,content,metadata,created_at",
      created_at: `gte.${since}`,
      order: "created_at.desc",
      limit: String(opts.limit),
    });
    for (const t of opts.excludeTypes ?? []) {
      // PostgREST: metadata->>type=not.eq.profile_field
      params.append("metadata->>type", `not.eq.${t}`);
    }
    return await this.getJson<Thought[]>(`/rest/v1/thoughts?${params}`);
  }

  /**
   * Latest value for a single profile_field/{field_name}. Returns null
   * when the field has never been captured (e.g. user hasn't set
   * profile_field/address yet).
   */
  async fetchProfileField(fieldName: string): Promise<string | null> {
    const params = new URLSearchParams({
      select: "content",
      "metadata->>type": "eq.profile_field",
      "metadata->>field_name": `eq.${fieldName}`,
      order: "created_at.desc",
      limit: "1",
    });
    const rows = await this.getJson<Array<{ content: string }>>(
      `/rest/v1/thoughts?${params}`,
    );
    return rows[0]?.content?.trim() || null;
  }

  /**
   * Filtered fetch by metadata.type — used by sections that consume a
   * specific thought class (calendar_event, todo, etc.). extraFilters
   * is an array of [key, value] pairs so callers can supply multiple
   * conditions on the same column (e.g. range queries like
   *   [["metadata->>event_start", "gte.X"], ["metadata->>event_start", "lte.Y"]]
   * ).
   */
  async fetchThoughtsOfType(opts: {
    type: string;
    limit: number;
    extraFilters?: Array<[string, string]>;
  }): Promise<Thought[]> {
    const params = new URLSearchParams({
      select: "id,content,metadata,created_at",
      "metadata->>type": `eq.${opts.type}`,
      order: "created_at.desc",
      limit: String(opts.limit),
    });
    for (const [k, v] of opts.extraFilters ?? []) {
      params.append(k, v);
    }
    return await this.getJson<Thought[]>(`/rest/v1/thoughts?${params}`);
  }

  /**
   * Vector-similarity search via the local match_thoughts RPC (defined
   * in OB1/docker/init.sql). Returns top-K most similar thoughts to
   * the supplied embedding. Threshold is the minimum cosine similarity
   * (default 0.5; pgvector returns 1 - cosine_distance).
   */
  async semanticSearch(opts: {
    embedding: number[];
    k: number;
    threshold?: number;
    filter?: Record<string, unknown>;
  }): Promise<Array<{ id: number; content: string; metadata: Record<string, unknown> | null; similarity: number }>> {
    const res = await fetch(`${this.baseUrl}/rest/v1/rpc/match_thoughts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query_embedding: opts.embedding,
        match_threshold: opts.threshold ?? 0.5,
        match_count: opts.k,
        filter: opts.filter ?? {},
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`semanticSearch failed: ${res.status} ${msg}`);
    }
    return await res.json();
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`PostgREST GET ${path} failed: ${res.status} ${msg}`);
    }
    return await res.json() as T;
  }
}
