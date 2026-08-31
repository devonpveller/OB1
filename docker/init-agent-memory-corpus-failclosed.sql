-- init-agent-memory-corpus-failclosed.sql
--
-- WHY THIS EXISTS (DFU PLAN.md section C.8 clause 3, operator ruling 2026-08-30).
--
-- The corpus predicate shipped as:
--     SELECT md->>'exposure' IS NULL OR md->>'exposure' = 'ops'
-- so a thought with NO exposure label is VISIBLE to the agent plane. That is the
-- "unlabelled defaults to fine" class from this effort's own class list - a guard
-- deciding by exception, where the unhandled state falls through to a pass. It is
-- the same shape as the andon board's `on_indeterminate: warn` hole, one layer down
-- and in SQL.
--
-- Measured on the live database before this migration (orchestrator, 2026-08-30, and
-- re-measured by the dfudone item 2026-08-31):
--     thoughts total                12993
--     metadata->>'exposure' IS NULL 12989
--     metadata->>'exposure' = 'ops'     4
--     metadata->>'exposure' = 'personal' 0
-- So 12989 rows are visible TODAY only because the predicate is fail-open, not
-- because anybody decided they were ops-plane content.
--
-- WHAT THIS DOES, in the only order that is safe:
--   1. LABEL FIRST. Every unlabelled thought is stamped exposure='ops' - which is
--      what the predicate already treats it as, so this changes NO row's visibility.
--   2. THEN CLOSE. The predicate drops the `IS NULL` arm. After this, an unlabelled
--      row - every row inserted from here on that forgets the label - is INVISIBLE
--      to the agent plane rather than visible.
-- Doing it the other way round would hide 12989 rows between the two statements.
--
-- ADDITIVE AND REVERSIBLE, as PLAN.md class 4 requires:
--   - No table is dropped, no column is dropped, no row is deleted.
--   - The backfill only ADDS two keys to a JSONB object; it never overwrites an
--     exposure label that already exists (the WHERE clause excludes labelled rows).
--   - Every row it touches is STAMPED with `exposure_backfill` = the marker below,
--     so the revert can strip exactly the rows this migration created and no others.
--     A revert that guessed "everything labelled ops" would also strip the 4 rows
--     that were deliberately labelled ops by the write path, which is why the stamp
--     exists rather than a date comparison.
--   - Revert path: revert-agent-memory-corpus-failclosed.sql, beside this file.
--
-- IDEMPOTENT. Re-running is a no-op: the UPDATE's WHERE matches nothing the second
-- time, and the function is CREATE OR REPLACE. The initdb chain may replay it on a
-- fresh volume, and the promotion runbook applies it to a live database; both reach
-- the same state.
--
-- ORDERING IN THE CHAIN: 190, after 180-init-agent-memory-rls.sql, which is where
-- ob_corpus_on_ops_plane and the policies that call it are defined. This file is
-- self-contained even if 180 has not run - CREATE OR REPLACE defines the function
-- either way - but the POLICIES that consume it come from 180, so on a database
-- without 180 this migration is correct and inert rather than wrong.

BEGIN;

-- 1. LABEL FIRST. Additive: `||` merges keys into the existing object and leaves
--    every other key untouched. COALESCE covers the nullable column (thoughts.metadata
--    is NULLABLE with a '{}' default, so a row explicitly set to NULL is possible and
--    `NULL || jsonb` would silently produce NULL - dropping the row's whole metadata).
UPDATE thoughts
   SET metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'exposure', 'ops',
                       'exposure_backfill', 'dfu-c8-corpus-failclosed'
                     )
 WHERE COALESCE(metadata, '{}'::jsonb)->>'exposure' IS NULL;

-- 2. THEN CLOSE THE PREDICATE. The `IS NULL` arm is removed; an unlabelled row is no
--    longer on the ops plane. Signature and volatility are unchanged, so the policies
--    in 180 that call it keep working without being redefined.
CREATE OR REPLACE FUNCTION public.ob_corpus_on_ops_plane(md JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT md->>'exposure' = 'ops'
$$;

-- The grant is re-asserted because CREATE OR REPLACE keeps existing grants but this
-- file must also be correct on a database where 180 never ran.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.ob_corpus_on_ops_plane(JSONB) TO service_role;
  END IF;
END $$;

COMMIT;
