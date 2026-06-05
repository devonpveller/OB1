// Local embeddings (bge-m3, 1024-dim) via the OpenAI-compatible endpoint.
import { config } from "../config.ts";

export async function embed(text: string): Promise<number[]> {
  const r = await fetch(`${config.embedding.base}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.embedding.key}` },
    body: JSON.stringify({ model: config.embedding.model, input: text.slice(0, 8000) }),
  });
  if (!r.ok) throw new Error(`embedding ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const v = j?.data?.[0]?.embedding;
  if (!Array.isArray(v)) throw new Error("embedding endpoint returned no vector");
  return v;
}

// pgvector literal for a parameter cast `$n::vector`.
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
