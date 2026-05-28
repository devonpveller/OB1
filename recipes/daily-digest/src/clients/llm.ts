/**
 * LlmClient — OpenAI-compatible chat + embed via the local llama-cpp
 * services. Two endpoints, one class so call sites don't juggle URLs.
 *
 * Defaults are the local Docker service names. No cloud LLM:
 * see memory entry feedback_no_cloud_services / project_local_llm_swap_pattern.
 */

export interface LlmClientOptions {
  /** Chat completions base URL, e.g. http://llama-cpp:8080/v1 */
  chatBase: string;
  /** Model identifier for chat completions, e.g. qwen36-27b:nothink */
  chatModel: string;
  /** Embeddings base URL, e.g. http://llama-cpp-embed:8080/v1 */
  embedBase: string;
  /** Model identifier for embeddings, e.g. bge-m3 */
  embedModel: string;
  /** Non-secret bearer placeholder — llama-cpp ignores when no API key set. */
  bearer?: string;
  /** Per-request timeout. Defaults to 30s for chat, 15s for embed. */
  timeoutMs?: number;
}

export interface ChatOptions {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Override the constructor's default timeout for this call. */
  timeoutMs?: number;
}

export class LlmClient {
  private readonly bearer: string;
  private readonly defaultTimeout: number;

  constructor(private readonly opts: LlmClientOptions) {
    this.bearer = opts.bearer ?? "no-key";
    this.defaultTimeout = opts.timeoutMs ?? 30_000;
  }

  /**
   * Single-shot chat completion. Returns the assistant's content string,
   * or null on transport failure / non-200. Callers should treat null as
   * "skip this enrichment, render without LLM polish".
   */
  async chat(opts: ChatOptions): Promise<string | null> {
    try {
      const res = await fetch(`${this.opts.chatBase}/chat/completions`, {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({
          model: this.opts.chatModel,
          messages: [{ role: "user", content: opts.prompt }],
          max_tokens: opts.maxTokens ?? 200,
          temperature: opts.temperature ?? 0.3,
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeout),
      });
      if (!res.ok) return null;
      const d = await res.json();
      return (d.choices?.[0]?.message?.content as string | undefined)?.trim() || null;
    } catch (err) {
      console.warn(`LLM chat failed: ${err}`);
      return null;
    }
  }

  /**
   * Returns the embedding vector for a single input. The local bge-m3
   * has a 512-token physical batch; callers should truncate input to
   * ~1500 chars to stay inside the window.
   */
  async embed(text: string): Promise<number[] | null> {
    try {
      const res = await fetch(`${this.opts.embedBase}/embeddings`, {
        method: "POST",
        headers: this.jsonHeaders(),
        body: JSON.stringify({
          model: this.opts.embedModel,
          input: text.slice(0, 1500),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const d = await res.json();
      return d.data?.[0]?.embedding ?? null;
    } catch (err) {
      console.warn(`LLM embed failed: ${err}`);
      return null;
    }
  }

  private jsonHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.bearer}`,
      "Content-Type": "application/json",
    };
  }
}
