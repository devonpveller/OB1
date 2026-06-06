-- P4.7 (source editing redesign) — working-head authorship.
-- Edits to a source now update sources.content/title IN PLACE (the working head)
-- and stamp who/when; a revision is committed once per compile (commit-pending),
-- snapshotting the dirty head into source_revisions. Additive only (G2).
--
-- Two-place migration (G3): mounted on a fresh volume here AND applied to the
-- live DB via the promotion runbook.
ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS last_edited_by  TEXT,
  ADD COLUMN IF NOT EXISTS last_edited_at  TIMESTAMPTZ;

-- Find dirty sources fast at commit time (last_edited_at set since boot).
CREATE INDEX IF NOT EXISTS idx_sources_last_edited_at
  ON public.sources (last_edited_at)
  WHERE last_edited_at IS NOT NULL;
