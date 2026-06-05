/**
 * Cross-thread suggestion worker — Integrated Knowledge System (Phase 5).
 *
 * Proposes (never auto-creates) cross-thread source links by semantic
 * similarity. For each source confirmed in some thread, it compares the
 * source's embedding against EVERY OTHER active thread's confirmed-source
 * cluster (max cosine via pgvector). When similarity >= SUGGESTION_THRESHOLD
 * and the (thread, source) pair is not already linked in ANY status, it
 * inserts a `thread_sources(link_type='suggested', status='pending')` row
 * with a populated `suggestion_reason`.
 *
 * CRITICAL RULE (concept §4.2): research in one thread is NEVER auto-added to
 * another. This worker only ever writes suggested/pending. Confirmation is a
 * deliberate user act in the Open Notebook triage UI (Phase 6).
 *
 * Modelled on entity-extraction-worker (queue + on-demand HTTP drain,
 * debounced) but talks to Postgres DIRECTLY via deno-postgres (like the MCP
 * server) rather than supabase-js/PostgREST — the sandbox has no PostgREST,
 * and direct pg keeps the pgvector distance operator on the server side.
 *
 * Routes:
 *   GET  /health     -> ok
 *   POST /suggest    -> embed-backfill, then score + insert suggestions
 *                       (the entity worker uses POST / and POST /sources;
 *                        this worker's drain verb is POST /suggest — C4)
 *
 * Env: DB_HOST/PORT/NAME/USER/PASSWORD, EMBEDDING_API_BASE/KEY/MODEL,
 *      SUGGESTION_THRESHOLD (default 0.50), PORT (default 8000).
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

const SUGGESTION_THRESHOLD = parseFloat(Deno.env.get("SUGGESTION_THRESHOLD") || "0.50");
const PORT = parseInt(Deno.env.get("PORT") || "8000", 10);

const pool = new Pool({
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
}, 8);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${EMBEDDING_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 1600) }),
  });
  if (!r.ok) throw new Error(`embedding ${r.status}`);
  return (await r.json()).data[0].embedding;
}

// Backfill embeddings for any confirmed-linked source that lacks one (e.g.
// seed rows, or ON-uploaded sources written without an embedding). A source
// must be embedded before it can be compared.
async function backfillEmbeddings(): Promise<number> {
  const client = await pool.connect();
  let done = 0;
  try {
    const rows = await client.queryObject<{ id: string; title: string; content: string }>(
      `SELECT DISTINCT s.id, s.title, s.content
         FROM sources s
         JOIN thread_sources ts ON ts.source_id = s.id AND ts.status = 'confirmed'
        WHERE s.embedding IS NULL AND COALESCE(s.content,'') <> ''`,
    );
    for (const r of rows.rows) {
      try {
        const emb = await getEmbedding(`${r.title}\n\n${r.content}`);
        await client.queryObject(
          `UPDATE sources SET embedding = $2::vector WHERE id = $1`,
          [r.id, `[${emb.join(",")}]`],
        );
        done++;
      } catch (e) {
        console.error(`embed backfill failed for ${r.id}:`, (e as Error).message);
      }
    }
  } finally {
    client.release();
  }
  return done;
}

// Score every (confirmed source, other active thread) pair by max cosine to
// that thread's confirmed cluster; insert suggested/pending above threshold.
// ON CONFLICT DO NOTHING enforces the dedup rule: a pair already linked in
// ANY status (incl. hidden/rejected) is never re-suggested (§4.3).
async function generateSuggestions(threshold: number): Promise<
  Array<{ thread_id: string; source_id: string; suggestion_reason: string }>
> {
  const client = await pool.connect();
  try {
    const result = await client.queryObject<{
      thread_id: string; source_id: string; suggestion_reason: string;
    }>(
      `WITH src AS (
         SELECT DISTINCT s.id, s.embedding
         FROM sources s
         JOIN thread_sources ts ON ts.source_id = s.id AND ts.status = 'confirmed'
         WHERE s.embedding IS NOT NULL
       ),
       pairs AS (
         SELECT src.id AS source_id, t.id AS thread_id, src.embedding
         FROM src CROSS JOIN threads t
         WHERE t.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM thread_sources x
             WHERE x.thread_id = t.id AND x.source_id = src.id)
       ),
       scored AS (
         SELECT p.source_id, p.thread_id,
                (SELECT 1 - MIN(s2.embedding <=> p.embedding)
                   FROM thread_sources ts2
                   JOIN sources s2 ON s2.id = ts2.source_id
                  WHERE ts2.thread_id = p.thread_id
                    AND ts2.status = 'confirmed'
                    AND s2.embedding IS NOT NULL) AS sim
         FROM pairs p
       )
       INSERT INTO thread_sources (thread_id, source_id, link_type, status, suggestion_reason)
       SELECT thread_id, source_id, 'suggested', 'pending',
              'cross-thread similarity ' || round(sim::numeric, 3)
              || ' to this thread''s source cluster'
       FROM scored
       WHERE sim IS NOT NULL AND sim >= $1
       ON CONFLICT (thread_id, source_id) DO NOTHING
       RETURNING thread_id, source_id, suggestion_reason`,
      [threshold],
    );
    return result.rows;
  } finally {
    client.release();
  }
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return new Response("ok", { status: 200 });
  }
  if (req.method === "POST" && url.pathname === "/suggest") {
    const threshold = parseFloat(url.searchParams.get("threshold") || `${SUGGESTION_THRESHOLD}`);
    try {
      const embedded = await backfillEmbeddings();
      const created = await generateSuggestions(threshold);
      console.log(`suggest: embedded=${embedded} threshold=${threshold} created=${created.length}`);
      return Response.json({
        ok: true,
        threshold,
        embedded,
        suggestions_created: created.length,
        suggestions: created,
      });
    } catch (e) {
      console.error("suggest failed:", (e as Error).message);
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }
  return new Response("not found", { status: 404 });
});

console.log(`suggestion-worker listening on :${PORT} (threshold ${SUGGESTION_THRESHOLD})`);
