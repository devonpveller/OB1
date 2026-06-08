/**
 * Per-link grounded-claim synthesis (S3 / P1.4 — the D6 step).
 *
 * The curator parses grounded claims ONLY from tag-cited synthesis
 * (`[SOURCED] … [Source N]`); raw article text yields zero claims. So each
 * link is a one-source mini-research run: we run an LLM extraction pass over
 * the fetched article that emits one tagged claim per line, every claim cited
 * to `[Source 1]` (the article itself). That tagged text becomes the package's
 * `synthesis`; the curator's claims.ts parser turns it into grounded
 * claim→source edges anchored to the article.
 *
 * The format below MUST match what claims.ts expects (tag at line start,
 * `[Source 1]` at line end). It is the single-source adaptation of
 * OB1/integrations/research-service/harness.ts SYNTH_SYS.
 */

/** Tagged-claims extraction prompt for a SINGLE source (the article = Source 1). */
export const SINGLE_SOURCE_SYNTH_SYS =
  `You are Open Brain's grounded synthesizer. Extract the substantive factual claims from the ARTICLE below. There is exactly ONE source — the article itself — referred to as [Source 1].

OUTPUT FORMAT — STRICT. Write ONE claim per line. Each line MUST begin with its tag and end with its citation, in this exact shape:
  [SOURCED] <a single assertion the article states>. [Source 1]
  [INFERRED] <a single assertion reasoned from the article>. [Source 1]
Tags:
  [SOURCED]  — the article directly states it; cite [Source 1]
  [INFERRED] — reasoned from the article; cite [Source 1]
  [UNCERTAIN]— the article hints at it but is not definitive; cite [Source 1]
  [GAP]      — a fact the article clearly leaves open. State the gap on its own line; do NOT fill it from your own knowledge and do NOT add a citation.

ABSOLUTE RULES: every [SOURCED]/[INFERRED]/[UNCERTAIN] line MUST end with [Source 1] — a line without it is invalid. Never invent a fact, number, name, URL, or quote the article does not support; if unsupported, it is a [GAP] (no citation). One assertion per line. Put the tag at the START and [Source 1] at the END. Extract the 8–20 claims that carry the article's real substance; skip boilerplate, navigation, and promotional filler.`;

/** Injected chat function: (system, user) → assistant text. Null on failure. */
export type ChatFn = (system: string, user: string) => Promise<string | null>;

export interface SynthChatConfig {
  chatApiBase: string; // e.g. http://llama-cpp:8080/v1
  chatModel: string; // e.g. qwen36-27b
  nothinkSuffix?: string; // e.g. :nothink
  apiKey?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

/** Default chat impl against the local llama-cpp (system+user, nothink). */
export function makeSynthChat(cfg: SynthChatConfig): ChatFn {
  const model = `${cfg.chatModel}${cfg.nothinkSuffix ?? ""}`;
  return async (system, user) => {
    try {
      const res = await fetch(`${cfg.chatApiBase}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey ?? "not-needed"}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: cfg.maxTokens ?? 1500,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 90_000),
      });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      const d = await res.json();
      return (d.choices?.[0]?.message?.content as string | undefined)?.trim() || null;
    } catch (err) {
      console.warn(`synth chat failed: ${err}`);
      return null;
    }
  };
}

/** Count lines that look like a tagged, [Source 1]-cited claim (sanity metric). */
export function countTaggedClaimLines(synthesis: string): number {
  let n = 0;
  for (const line of String(synthesis || "").split("\n")) {
    const t = line.trim();
    if (/^\[(SOURCED|INFERRED|UNCERTAIN)\]/i.test(t) && /\[Source\s*1\b/i.test(t)) n++;
  }
  return n;
}

/**
 * Run the extraction pass over one article. Returns the tagged synthesis text
 * (to be the package's `synthesis`), or null if the LLM call failed. The
 * caller treats null as "couldn't synthesize → email-only".
 */
export async function synthesizeArticle(
  chat: ChatFn,
  article: { title: string; url: string; text: string },
  opts: { maxArticleChars?: number } = {},
): Promise<string | null> {
  const maxChars = opts.maxArticleChars ?? 16_000;
  const user =
    `ARTICLE TITLE: ${article.title || "(untitled)"}\n` +
    `ARTICLE URL: ${article.url}\n\n` +
    `ARTICLE TEXT ([Source 1]):\n${article.text.slice(0, maxChars)}`;
  return await chat(SINGLE_SOURCE_SYNTH_SYS, user);
}
