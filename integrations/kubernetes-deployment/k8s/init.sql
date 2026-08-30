-- Open Brain schema for self-hosted PostgreSQL + pgvector
-- This replaces the Supabase-managed schema with a standalone version.
-- Compatible with the OB1 MCP server tools (search_thoughts, list_thoughts, etc.)

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
    id BIGSERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    embedding vector(1536),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata ON thoughts USING GIN (metadata);

-- match_thoughts function for vector similarity search
-- This replaces the Supabase RPC function
CREATE OR REPLACE FUNCTION match_thoughts(
    query_embedding vector(1536),
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
      -- U5 exposure plane. THE SECOND DEFINITION OF match_thoughts IN THIS REPO: the
      -- docker deployment's copy is guarded by docker/init-agent-memory-corpus-plane.sql,
      -- and this k8s copy was not - found by the completeness gate once it learned to scan
      -- a build context's .sql, not only its .ts. Same predicate, same meaning: an ABSENT
      -- label is unclaimed general corpus and stays visible; a PRESENT label was minted by
      -- the agent-memory mirror, and only the ops plane's rows are served. No parameter,
      -- deliberately - a caller that may name its own plane is not bounded by one.
      AND (t.metadata->>'exposure' IS NULL OR t.metadata->>'exposure' = ANY(ARRAY['ops']))
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
