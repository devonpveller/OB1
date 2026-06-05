// Chunking for long-doc retrieval (P5.5). Semantic/sentence-boundary default
// with a fixed+overlap fallback, bge-m3-tuned (~1200 chars ≈ comfortably under
// the model's context, with a small overlap so a fact split across a boundary
// is still retrievable).
const CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 150;

export function chunkText(text: string): string[] {
  const clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  // Prefer paragraph / sentence boundaries; fall back to hard slicing for a
  // single oversized "sentence".
  const units = clean.split(/\n{2,}|(?<=[.!?])\s+/).filter((s) => s.trim());
  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    if (u.length > CHUNK_CHARS) {
      if (cur.trim()) { chunks.push(cur.trim()); cur = ""; }
      for (let i = 0; i < u.length; i += CHUNK_CHARS - OVERLAP_CHARS) {
        chunks.push(u.slice(i, i + CHUNK_CHARS));
      }
      continue;
    }
    if ((cur + " " + u).length > CHUNK_CHARS && cur) {
      chunks.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - OVERLAP_CHARS));
    }
    cur += (cur ? " " : "") + u;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
