-- P5 (TASKS 5.3) — long-document chunks + a DEDICATED chunk-search RPC.
--
-- Backs long-doc retrieval AND the P7 podcast source list. The search RPC is
-- named `match_source_chunks` — deliberately NOT an overload of `match_sources`
-- (§14.6), so the row-shape difference is explicit. Tombstone-filters committed
-- retracts (P4 4.5). source_id CASCADEs on a source purge.
--
-- Depends on init-source-retract.sql (s.retraction_committed_at) — mounted
-- earlier (82 < 86). Additive + idempotent (G2/G3).

CREATE TABLE IF NOT EXISTS public.source_chunks (
    source_id  UUID NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
    idx        INT  NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    embedding  VECTOR(1024),                 -- bge-m3
    PRIMARY KEY (source_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_source_chunks_embedding
    ON public.source_chunks USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION match_source_chunks(
    query_embedding VECTOR(1024),
    match_threshold FLOAT DEFAULT 0.0,
    match_count     INT   DEFAULT 10,
    filter          JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    source_id UUID, idx INT, content TEXT, similarity FLOAT
) AS $$
    SELECT c.source_id, c.idx, c.content,
           1 - (c.embedding <=> query_embedding) AS similarity
    FROM source_chunks c
    JOIN sources s ON s.id = c.source_id
    WHERE c.embedding IS NOT NULL
      AND 1 - (c.embedding <=> query_embedding) > match_threshold
      AND s.retraction_committed_at IS NULL          -- tombstone filter (P4 4.5)
      AND (filter = '{}'::jsonb OR s.metadata @> filter)
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
$$ LANGUAGE sql STABLE;
