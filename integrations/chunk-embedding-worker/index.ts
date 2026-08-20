/**
 * Chunk-embedding worker — Integrated Knowledge System.
 *
 * Canonical OB1-side passage indexer. Chunks ANY source's content into
 * `source_chunks` using the EXACT workbench contract (1200-char chunks / 150
 * overlap, one bge-m3 embedding per chunk) so cross-frontend retrieval
 * (`match_source_chunks`) works regardless of which writer created the source —
 * Open Notebook, `capture_with_thread` (MCP), `/research/persist`, or the
 * workbench. Chunking is therefore a property of OB1 ingestion, not of any one
 * frontend.
 *
 * Writer-agnostic by design: it SCANS `sources` for rows whose content has
 * changed since they were last chunked (`md5(content)` vs
 * `metadata.chunked_hash`) instead of depending on a specific ingestion path.
 * Drains on POST /chunks and (optionally) on a periodic interval.
 *
 * Idempotent per source: DELETE old chunks + INSERT fresh in one transaction,
 * then stamp `metadata.chunked_hash` — mirrors the workbench import.ts write.
 *
 * Routes:
 *   GET  /health  -> ok
 *   POST /chunks  -> (re)chunk up to `limit` due sources; returns counts
 *
 * Env: DB_HOST/PORT/NAME/USER/PASSWORD, EMBEDDING_API_BASE/KEY/MODEL,
 *      EMBEDDING_MAX_CHARS (4000), CHUNK_BATCH (25),
 *      CHUNK_INTERVAL_MS (0 = off), PORT (8000).
 */
import { Pool } from "postgres";

const DB_HOST = Deno.env.get("DB_HOST") || "127.0.0.1";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "postgres";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") || "";

const EMBEDDING_API_BASE = Deno.env.get("EMBEDDING_API_BASE") || "http://llama-cpp-embed:8080/v1";
const EMBEDDING_API_KEY = Deno.env.get("EMBEDDING_API_KEY") || "not-needed";
const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") || "bge-m3";
const EMBEDDING_MAX_CHARS = parseInt(Deno.env.get("EMBEDDING_MAX_CHARS") || "4000", 10);

const CHUNK_BATCH = parseInt(Deno.env.get("CHUNK_BATCH") || "25", 10);
const CHUNK_INTERVAL_MS = parseInt(Deno.env.get("CHUNK_INTERVAL_MS") || "0", 10);
const PORT = parseInt(Deno.env.get("PORT") || "8000", 10);

const pool = new Pool(
  { hostname: DB_HOST, port: DB_PORT, database: DB_NAME, user: DB_USER, password: DB_PASSWORD },
  8,
);

// ── canonical chunker (verbatim from OB1 workbench src/util/chunk.ts) ─────
const CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 150;
function chunkText(text: string): string[] {
  const clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
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

// ── canonical embed (adaptive-halving, from workbench src/util/embed.ts) ──
async function embed(text: string): Promise<number[]> {
  let input = String(text || "").slice(0, EMBEDDING_MAX_CHARS);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
    });
    if (r.ok) {
      const v = (await r.json())?.data?.[0]?.embedding;
      if (!Array.isArray(v)) throw new Error("embedding endpoint returned no vector");
      return v;
    }
    const body = (await r.text()).slice(0, 300);
    if (r.status === 500 && /too large|batch size|n_tokens|exceed/i.test(body) && input.length > 200) {
      input = input.slice(0, Math.floor(input.length / 2));
      continue;
    }
    throw new Error(`embedding ${r.status}: ${body}`);
  }
  throw new Error("embedding failed: input still too large after shrinking");
}
const toVector = (v: number[]) => `[${v.join(",")}]`;

// Detect non-text/binary content (e.g. raw PDF bytes that slipped past
// extraction). The embedding endpoint rejects invalid UTF-8 with a 500, and a
// source that never embeds would otherwise be re-scanned forever (poison pill).
function looksBinary(s: string): boolean {
  if (!s) return false;
  if (s.startsWith("%PDF-")) return true;
  const sample = s.slice(0, 4000);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true; // NUL → binary
    // Surrogates: JS strings are UTF-16, so EVERY character above U+FFFF
    // (emoji, CJK ext, math alphanumerics) is stored as a surrogate PAIR.
    // Rejecting any surrogate therefore rejects perfectly valid text.
    // 2026-08-20: this mis-flagged 494 of 8,419 sources (5.9%) as
    // "binary_content" -- 488 of them research-ingested web_articles, plus
    // the SenseGlove Unreal 5.4 manual, which was excluded from chunk
    // retrieval because it contains a rocket emoji. Zero were truly binary.
    // Only an UNPAIRED surrogate indicates broken text.
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= sample.length) break; // pair split by the 4000-char slice
      const lo = sample.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { i++; continue; } // valid pair -> text
      return true; // unpaired high surrogate
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true; // unpaired low surrogate
    if (c < 9 || (c > 13 && c < 32)) bad++; // control chars
  }
  return bad / Math.max(1, sample.length) > 0.05;
}

const CONTENT_ERROR_RE = /parse_error|surrogate|invalid string|invalid utf|not.?valid|byte sequence/i;

// Stamp a source as processed (chunked_hash) — optionally with an error note —
// so it is NOT re-scanned until its content actually changes (md5 differs).
async function markProcessed(id: string, h: string, error?: string): Promise<void> {
  const tx = await pool.connect();
  try {
    await tx.queryObject(
      `UPDATE public.sources
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('chunked_hash', $2::text)
                         || $3::jsonb
        WHERE id = $1::uuid`,
      [id, h, error ? JSON.stringify({ chunk_error: error }) : "{}"],
    );
  } finally {
    tx.release();
  }
}

// ── drain: (re)chunk sources whose content changed since last chunked ────
async function drainChunks(limit: number): Promise<{ sources: number; chunks: number }> {
  // Fetch the due set, then release the scan connection before the (slow,
  // embedding-bound) per-source loop.
  let due: Array<{ id: string; content: string; h: string }> = [];
  const scan = await pool.connect();
  try {
    const res = await scan.queryObject<{ id: string; content: string; h: string }>(
      `SELECT id::text AS id, content, md5(content) AS h
         FROM public.sources
        WHERE COALESCE(content, '') <> ''
          AND content_type <> 'research_synthesis'
          AND retraction_committed_at IS NULL
          AND NOT COALESCE((metadata->>'deleted')::boolean, false)
          AND md5(content) IS DISTINCT FROM (metadata->>'chunked_hash')
        ORDER BY updated_at DESC
        LIMIT $1`,
      [limit],
    );
    due = res.rows;
  } finally {
    scan.release();
  }

  let nSources = 0, nChunks = 0;
  for (const row of due) {
    // Skip non-text/binary content up front (e.g. raw PDF bytes that escaped
    // extraction) — it can never embed, and marking it processed stops it from
    // being re-scanned every cycle (the poison-pill loop that hammered the
    // embed endpoint).
    if (looksBinary(row.content)) {
      console.error(`skipping binary/non-text content for ${row.id}`);
      await markProcessed(row.id, row.h, "binary_content");
      continue;
    }
    const chunks = chunkText(row.content);
    let embs: string[];
    try {
      embs = [];
      for (const c of chunks) embs.push(toVector(await embed(c)));
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`embed failed for ${row.id}:`, msg);
      // A CONTENT problem (invalid UTF-8 etc.) will never succeed → mark it
      // processed so it doesn't loop. A TRANSIENT failure (endpoint down) is
      // left un-stamped so it retries on the next scan.
      if (CONTENT_ERROR_RE.test(msg)) {
        await markProcessed(row.id, row.h, `embed_failed: ${msg.slice(0, 120)}`);
      }
      continue;
    }
    const tx = await pool.connect();
    try {
      await tx.queryArray("BEGIN");
      await tx.queryObject(`DELETE FROM public.source_chunks WHERE source_id = $1::uuid`, [row.id]);
      for (let i = 0; i < chunks.length; i++) {
        await tx.queryObject(
          `INSERT INTO public.source_chunks (source_id, idx, content, embedding)
           VALUES ($1::uuid, $2, $3, $4::vector)`,
          [row.id, i, chunks[i], embs[i]],
        );
      }
      await tx.queryObject(
        `UPDATE public.sources
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                           || jsonb_build_object('chunked_hash', $2::text)
          WHERE id = $1::uuid`,
        [row.id, row.h],
      );
      await tx.queryArray("COMMIT");
      nSources++; nChunks += chunks.length;
    } catch (e) {
      try { await tx.queryArray("ROLLBACK"); } catch { /* ignore */ }
      console.error(`chunk write failed for ${row.id}:`, (e as Error).message);
    } finally {
      tx.release();
    }
  }
  return { sources: nSources, chunks: nChunks };
}

let draining = false;
async function safeDrain(limit: number) {
  if (draining) return { skipped: true as const };
  draining = true;
  try {
    return await drainChunks(limit);
  } finally {
    draining = false;
  }
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return new Response("ok", { status: 200 });
  }
  if (req.method === "POST" && url.pathname === "/chunks") {
    const limit = parseInt(url.searchParams.get("limit") || `${CHUNK_BATCH}`, 10);
    try {
      const res = await safeDrain(limit);
      console.log(`chunks drain: ${JSON.stringify(res)}`);
      return Response.json({ ok: true, ...res });
    } catch (e) {
      console.error("chunk drain failed:", (e as Error).message);
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }
  return new Response("not found", { status: 404 });
});

if (CHUNK_INTERVAL_MS > 0) {
  setInterval(() => {
    safeDrain(CHUNK_BATCH).catch((e) => console.error("interval drain:", (e as Error)?.message));
  }, CHUNK_INTERVAL_MS);
  console.log(`chunk-embedding-worker periodic scan every ${CHUNK_INTERVAL_MS}ms`);
}
console.log(`chunk-embedding-worker listening on :${PORT} (batch ${CHUNK_BATCH})`);
