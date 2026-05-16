-- Open Brain — external `sources` layer (v2 three-layer architecture).
--
-- Holds external source documents + research synthesis produced by
-- deep_research_tool.py. This is the OpenBrain-owned home for everything
-- that is NOT a user-fact (mnemory) and NOT canonical synthesis (wiki).
--
-- One table, two row kinds, linked by research_key:
--   * content_type='research_synthesis' : the durable claim/answer row
--       (volatility / revalidate / run-kind are REAL columns here —
--        open-brain returns full rows, so the mnemory ⟦EV:research⟧
--        self-describing-header hack is no longer needed).
--   * other content_type values          : one row per gathered source
--       the research run actually used (the wiki's raw inputs).
--
-- Embedding is vector(1024) to match the bge-m3 local model (NOT the
-- upstream OpenAI vector(1536)).
--
-- Idempotent: safe to run live (CREATE ... IF NOT EXISTS) and re-run on
-- a fresh volume via /docker-entrypoint-initdb.d (ordered after init +
-- init-extensions).

CREATE TABLE IF NOT EXISTS sources (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url             TEXT,                       -- nullable: uploads/manual have none
    title           TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',   -- extracted body OR synthesized claim
    content_type    TEXT NOT NULL DEFAULT 'web_article'
        CHECK (content_type IN (
            'web_article','pdf','youtube_transcript','podcast_transcript',
            'paper','manual','research_synthesis')),
    tags            TEXT[] NOT NULL DEFAULT '{}',
    notebook        TEXT,                       -- v2 notebook/project scoping (nullable)
    domain          TEXT,                       -- source host, when applicable

    -- Research linkage (the EV:research concepts, now real columns) -----
    research_key    TEXT,                       -- deterministic query hash; cache/supersede
    research_query  TEXT,                       -- the question this row answers / was gathered for
    run_kind        TEXT,                       -- research | knowledge_research | deep_research
    volatility      TEXT CHECK (volatility IN ('fast','medium','slow')),
    revalidate_days INT,
    researched_on   DATE,                       -- staleness = researched_on + revalidate_days < today

    fetched_at      TIMESTAMPTZ,
    embedding       VECTOR(1024),               -- bge-m3
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sources_research_key ON sources (research_key);
CREATE INDEX IF NOT EXISTS idx_sources_content_type ON sources (content_type);
CREATE INDEX IF NOT EXISTS idx_sources_notebook     ON sources (notebook);
CREATE INDEX IF NOT EXISTS idx_sources_url          ON sources (url);
CREATE INDEX IF NOT EXISTS idx_sources_tags         ON sources USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_sources_embedding
    ON sources USING hnsw (embedding vector_cosine_ops);

-- One CURRENT synthesis row per research question (supersede-in-place).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_synthesis_key
    ON sources (research_key)
    WHERE content_type = 'research_synthesis';

-- auto-update updated_at (reuse the shim pattern from init-extensions.sql)
CREATE OR REPLACE FUNCTION sources_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sources_touch ON sources;
CREATE TRIGGER trg_sources_touch
    BEFORE UPDATE ON sources
    FOR EACH ROW EXECUTE FUNCTION sources_touch_updated_at();

-- match_sources: semantic search over sources (mirrors match_thoughts).
CREATE OR REPLACE FUNCTION match_sources(
    query_embedding VECTOR(1024),
    match_threshold FLOAT DEFAULT 0.0,
    match_count     INT   DEFAULT 10,
    filter          JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    id UUID, url TEXT, title TEXT, content TEXT, content_type TEXT,
    notebook TEXT, research_key TEXT, similarity FLOAT
) AS $$
    SELECT s.id, s.url, s.title, s.content, s.content_type,
           s.notebook, s.research_key,
           1 - (s.embedding <=> query_embedding) AS similarity
    FROM sources s
    WHERE s.embedding IS NOT NULL
      AND 1 - (s.embedding <=> query_embedding) > match_threshold
      AND (filter = '{}'::jsonb OR s.metadata @> filter)
    ORDER BY s.embedding <=> query_embedding
    LIMIT match_count;
$$ LANGUAGE sql STABLE;
