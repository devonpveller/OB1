-- P0 (research-inlet) — give `threads` an embedding for thread resolution.
--
-- The research-package ingestion inlet (openbrain-curator) resolves each new
-- deep-research package onto the best existing thread. Stage 1 of that resolver
-- is a pgvector shortlist: ORDER BY threads.embedding <=> <claim-embedding>.
-- This column is that shortlist key. It is maintained by the curator as
-- embed(name + '\n' + description) on every ingest, so it tracks the thread's
-- evolving scope (see PLAN-research-inlet-service.md §3.5).
--
-- bge-m3 / 1024-dim, matching sources.embedding (so the same query embedding
-- compares cleanly against both source and thread vectors).
--
-- Additive + idempotent (G2). Existing threads start NULL; the backfill script
-- (backfill-thread-embeddings.ts) embeds them once, and the shortlist already
-- filters `embedding IS NOT NULL`, so a partially-backfilled state degrades
-- gracefully (un-embedded threads are simply not shortlist candidates until
-- they next receive an ingest or the backfill runs).
--
-- G3 — TWO places: mounted at /docker-entrypoint-initdb.d (FRESH volume only)
-- AND applied to the live DB via the promotion runbook. A file added only to
-- compose silently no-ops on the running stack (the live volume already exists).

ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS embedding VECTOR(1024);

-- Optional ANN index — only worth it once thread counts climb into the
-- thousands; at tens-of-threads a sequential cosine scan is faster than an
-- index probe. Left commented until the row count justifies it.
-- CREATE INDEX IF NOT EXISTS threads_embedding_idx
--   ON public.threads USING hnsw (embedding vector_cosine_ops);
