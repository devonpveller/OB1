-- OB1 Agent Memory - the memory carries its OWN vector.
--
-- WHY THIS EXISTS (dark-factory-unification PLAN section 2, phase U5).
--
-- `performRecall` used to find memories by joining `thoughts` and ordering on the
-- THOUGHT'S embedding. That made a `thoughts` row mandatory for a memory to be recallable
-- at all, and `thoughts` is the SHARED CORPUS - read by openbrain-mcp's general tools, by
-- extensions-server, by open-brain-rest, by agent-memory-api, by the `match_thoughts` SQL
-- function, and published wholesale over PostgREST. None of those readers applies an
-- exposure predicate, and a REST projection of a table has nowhere to put one.
--
-- So a personal-plane memory's full content was mirrored into a store that six readers
-- could return without an audit row. Proven live: agent_memory_inspect refused the memory
-- and filed access_refused, while list_thoughts and search_thoughts handed over the same
-- content verbatim and filed nothing.
--
-- Giving `agent_memories` its own embedding is what lets the mirror become OPTIONAL:
-- agent-memory-plane.ts writes a `thoughts` row only for exposures in
-- UNIFIED_SEARCH_EXPOSURES, personal-plane memories get `thought_id IS NULL` (which the
-- schema has always allowed - `ON DELETE SET NULL`), and recall still finds them because
-- the vector it orders on lives on the memory row.
--
-- DIMENSION: vector(1024), matching `thoughts.embedding` in init.sql. This fork embeds
-- with bge-m3, not OpenAI text-embedding-3-small - a 1536 here would fail every insert.
--
-- REVERT: `ALTER TABLE public.agent_memories DROP COLUMN embedding;` and restore the JOIN
-- in performWriteback/performRecall. Nothing else depends on the column. Dropping it does
-- NOT delete any memory: content, summary and metadata are unaffected, and every ops-plane
-- memory still has its mirrored thought.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'agent_memories'
  ) THEN
    RAISE EXCEPTION
      'init-agent-memory-embedding requires public.agent_memories (100-init-agent-memory.sql).';
  END IF;
END $$;

ALTER TABLE public.agent_memories
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- BACKFILL FROM THE MIRROR. Every memory written before this migration has a thought row,
-- because the mirror was unconditional; copying its vector is exactly the value recall was
-- already ordering on, so recall behaviour for existing rows is unchanged rather than
-- approximately unchanged. Rows with no thought (none exist yet, but ON DELETE SET NULL
-- can produce them) keep a NULL embedding and are skipped by recall's
-- `am.embedding IS NOT NULL`, which is the honest outcome: a memory with no vector cannot
-- be ranked, and silently ranking it at distance 0 would put it at the top of every recall.
UPDATE public.agent_memories am
   SET embedding = t.embedding
  FROM public.thoughts t
 WHERE t.id = am.thought_id
   AND am.embedding IS NULL
   AND t.embedding IS NOT NULL;

-- Same index kind and operator class as thoughts.embedding (init.sql), so recall's
-- ORDER BY uses an index rather than a sequential scan once the plane has volume.
CREATE INDEX IF NOT EXISTS idx_agent_memories_embedding
    ON public.agent_memories USING hnsw (embedding vector_cosine_ops);

COMMIT;
