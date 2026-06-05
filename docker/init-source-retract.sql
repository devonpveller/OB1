-- P4 (TASKS 4.3) — reversible STAGED retract columns on `sources`.
--
-- Retract is a staged mutation (G11): `retracted_at` set + `retraction_committed_at`
-- NULL = STAGED (reversible; references show a live "redacted — in progress"
-- marker). The compile tick sets `retraction_committed_at` = COMMITTED (now
-- invisible to all generation read-paths — the 4.5 checklist filters
-- `retraction_committed_at IS NOT NULL`). Restore clears `retracted_at`. The row
-- + content are ALWAYS retained (only purge DELETEs).
--
-- Additive + idempotent (G2). G3 — initdb mount (fresh) + promotion runbook (live).

ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS retracted_at            TIMESTAMPTZ;
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS retracted_by            TEXT;
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS retraction_committed_at TIMESTAMPTZ;

-- Supports the live "in progress" marker query (staged = retracted, not committed).
CREATE INDEX IF NOT EXISTS idx_sources_staged_retract ON public.sources(retracted_at)
    WHERE retracted_at IS NOT NULL AND retraction_committed_at IS NULL;

-- Tombstone-filter match_sources (P4 4.5). It's REDEFINED here, not in
-- init-sources.sql, because retraction_committed_at doesn't exist yet at that
-- earlier step. A committed-retracted source no longer surfaces in semantic
-- source search; a staged one (committed_at NULL) still does until the compile
-- tick. Body otherwise identical to init-sources.sql.
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
      AND s.retraction_committed_at IS NULL          -- tombstone filter (P4 4.5)
      AND (filter = '{}'::jsonb OR s.metadata @> filter)
    ORDER BY s.embedding <=> query_embedding
    LIMIT match_count;
$$ LANGUAGE sql STABLE;
