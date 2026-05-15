-- Open Brain schema for self-hosted PostgreSQL + pgvector (Docker Compose).
-- Adapted from integrations/kubernetes-deployment/k8s/init.sql.
-- Embedding dimension is 1024 to match the local bge-m3 model
-- (the upstream OB1 default of 1536 is for OpenAI text-embedding-3-small).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
    id BIGSERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    embedding vector(1024),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata ON thoughts USING GIN (metadata);
-- HNSW index for fast cosine similarity search (pgvector >= 0.5).
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding
    ON thoughts USING hnsw (embedding vector_cosine_ops);

-- match_thoughts function for vector similarity search.
-- Mirrors the Supabase RPC the upstream OB1 server expects; the
-- self-hosted MCP server issues raw SQL but this is kept for parity
-- and for any tooling that calls the RPC directly.
CREATE OR REPLACE FUNCTION match_thoughts(
    query_embedding vector(1024),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    id BIGINT,
    content TEXT,
    metadata JSONB,
    similarity FLOAT,
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.content,
        t.metadata,
        (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
        t.created_at
    FROM thoughts t
    WHERE 1 - (t.embedding <=> query_embedding) >= match_threshold
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
