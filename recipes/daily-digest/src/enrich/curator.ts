/**
 * openbrain-curator client (S1 / P1.4).
 *
 * POSTs a research package to the curator's single front door
 * (`/ingest/research-package`). The curator resolves the best existing thread
 * (or creates a new one), delegates the source write to openbrain-mcp's
 * /research/persist, and parses the tagged `synthesis` into grounded claims.
 * We do NOT pass an explicit thread_id — thread resolution is the whole point.
 *
 * Contract verified against OB1/integrations/research-curator/index.ts:
 *   required: `claim`; auth header `x-brain-key`; loopback :8816 → :8000.
 */

export interface ResearchSource {
  url?: string;
  title?: string;
  content?: string;
  summary?: string;
  domain?: string;
}

export interface ResearchPackage {
  /** Short standalone summary — REQUIRED; drives the resolver embedding. */
  claim: string;
  /** Tagged grounded claims (`[SOURCED] … [Source 1]`) — parsed into claims. */
  synthesis?: string;
  query?: string;
  kind?: string;
  volatility?: string; // 'fast' | 'medium' | 'slow'
  revalidate_days?: number;
  /** Hint to the resolver only (e.g. the gmail label). Not a hard mapping. */
  topic_hint?: string;
  sources?: ResearchSource[];
}

/** Curator response — the fields we use from the documented shape. */
export interface CuratorResponse {
  thread_id: string;
  thread_decision: "explicit" | "existing" | "new";
  thread_confidence: number;
  thread_name: string;
  shortlist?: Array<{ thread_id: string; name: string; distance: number }>;
  persist?: {
    synthesis_id?: string;
    sources_written?: number;
    source_ids?: Array<string | null>;
    threaded?: boolean;
  };
  claims?: {
    claimsWritten?: number;
    claimsDeduped?: number;
    edgesWritten?: number;
    edgesSkipped?: number;
    ungroundedSkipped?: number;
    gaps?: string[];
  } | null;
}

export interface CuratorClientOptions {
  /** Base URL, e.g. http://openbrain-curator:8000 or http://127.0.0.1:8816 */
  baseUrl: string;
  /** MCP_ACCESS_KEY value, sent as `x-brain-key`. */
  brainKey: string;
  timeoutMs?: number;
}

export class CuratorClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: CuratorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
  }

  async ingest(pkg: ResearchPackage): Promise<CuratorResponse> {
    const res = await fetch(`${this.baseUrl}/ingest/research-package`, {
      method: "POST",
      headers: {
        "x-brain-key": this.opts.brainKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pkg),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`curator ingest failed: ${res.status} ${msg}`);
    }
    return await res.json() as CuratorResponse;
  }
}
