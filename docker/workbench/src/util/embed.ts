// Local embeddings (bge-m3, 1024-dim) via the OpenAI-compatible endpoint.
//
// The embedding server has a fixed PHYSICAL BATCH (llama-cpp-embed default 512
// tokens): any single input must fit in one ubatch. Token count per char varies
// wildly (English ~0.27 tok/char, code/CJK up to ~1), so a fixed char cap can't
// be both safe and useful. Instead we start from a generous char budget and
// ADAPTIVELY HALVE on a "too large" 500 until it fits — robust to any text
// without over-truncating English. (Operators wanting fuller embeddings can
// raise the embed server's ubatch/batch size; this just stops it from erroring.)
import { config } from "../config.ts";
import { logRefusal } from "../identity/refusal_log.ts";

export function embed(text: string): Promise<number[]> {
  return embedWith(config.embedding.key, text);
}

// rw-owner-private-view: the owner's private search embeds ONLY the query (never a stored row), with the workbench's
// own key (config.embedding.privateKey); null when that key is blank - the caller answers 503 and calls nothing.
export function privateEmbedder(key: string = config.embedding.privateKey): ((text: string) => Promise<number[]>) | null {
  return key ? (text: string) => embedWith(key, text) : null;
}

async function embedWith(key: string, text: string): Promise<number[]> {
  let input = String(text || "").slice(0, config.embedding.maxChars);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${config.embedding.base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: config.embedding.model, input }),
    });
    if (r.ok) {
      const v = (await r.json())?.data?.[0]?.embedding;
      if (!Array.isArray(v)) throw new Error("embedding endpoint returned no vector");
      return v;
    }
    const body = (await r.text()).slice(0, 300);
    // Physical-batch overflow → shrink and retry.
    if (r.status === 500 && /too large|batch size|n_tokens|exceed/i.test(body) && input.length > 200) {
      input = input.slice(0, Math.floor(input.length / 2));
      continue;
    }
    // rw-identity-harden2 round 2: the endpoint's body is logged, never carried in the error
    logRefusal("embed: upstream", `[embed] embedding ${r.status}: ${body}`);
    throw new Error(`embedding ${r.status}`);
  }
  throw new Error("embedding failed: input still too large after shrinking");
}

// pgvector literal for a parameter cast `$n::vector`.
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
