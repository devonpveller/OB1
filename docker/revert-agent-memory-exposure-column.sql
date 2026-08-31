-- revert-agent-memory-exposure-column.sql
--
-- THE REVERT PATH for init-agent-memory-exposure-column.sql (DFU C.9 H3). NOT MOUNTED in the
-- initdb chain - it is an operator tool, and a revert that ran itself on every fresh volume
-- would undo the migration it ships beside.
--
--   docker cp OB1/docker/revert-agent-memory-exposure-column.sql openbrain-db:/tmp/
--   docker exec openbrain-db psql -U postgres -d openbrain -v ON_ERROR_STOP=1 \
--       -f /tmp/revert-agent-memory-exposure-column.sql
--
-- ORDER OF REVERTS. If 200-init-graph-plane-rls.sql has been applied since, revert THAT
-- FIRST (revert-graph-plane-rls.sql) - its policies, sweeps and write gate read the column
-- this file takes out of service, and reverting them in the other order leaves the graph
-- gate calling a predicate whose argument no longer means anything.
--
-- WHAT IT RESTORES: the jsonb key as the source of truth, exactly as 180+190 left it. The
-- COLUMN IS NOT DROPPED - dropping a column is not reversible, and PLAN class 4 forbids it.
-- It is de-constrained (NOT NULL and the CHECK are removed) and left in place, inert: no
-- policy reads it, and a writer that keeps supplying it is harmless.
--
-- THE VISIBILITY-PRESERVING ORDER, which is the mirror of the migration's:
--   1. Re-point the POLICIES at the jsonb predicate FIRST. The jsonb mirror is complete at
--      this moment - the migration wrote it for every row it touched and the doors keep it in
--      step - so this step changes no row's visibility. Doing it LAST instead would leave a
--      moment where the constraints are gone (an unlabelled row can be written) while the
--      policies still read the column, which is the one ordering that could admit a row whose
--      plane was never established.
--   2. THEN de-constrain the column, which nothing reads any more.
--   3. THEN restore upsert_thought's pre-H3 body.
--   4. THEN unstamp exactly the rows this migration labelled, and only those.
-- All of it in ONE transaction, so no session observes an intermediate state.

BEGIN;

-- 1. THE POLICIES GO BACK TO THE JSONB PREDICATE. The jsonb-argument functions were never
--    dropped by the migration (see its header), so they are still here.
DO $$
BEGIN
  IF to_regprocedure('public.ob_memory_on_ops_plane(jsonb)') IS NULL
     OR to_regprocedure('public.ob_corpus_on_ops_plane(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'revert-agent-memory-exposure-column: the jsonb exposure predicates are '
                    'missing. Re-apply 180-init-agent-memory-rls.sql and '
                    '190-init-agent-memory-corpus-failclosed.sql before reverting, or this '
                    'revert would leave both tables with no readable policy at all.';
  END IF;
END $$;

-- AND REFUSE IF 200 IS STILL APPLIED, rather than trusting the header's "revert 200 first".
-- The policies this file writes are 180's, WITHOUT the `thought_id` arm 200 added to close
-- the FK existence oracle. Reverting in the wrong order would therefore re-open that oracle
-- as a silent side effect of a migration that says nothing about it. The presence of the arm
-- in the CURRENT policy is the test - a property of the database, not a note in a runbook.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='public' AND tablename='agent_memories'
                AND policyname='agent_memories_ops_plane'
                AND COALESCE(with_check,'') LIKE '%thought_id%') THEN
    RAISE EXCEPTION 'revert-agent-memory-exposure-column: 200-init-graph-plane-rls.sql is still '
                    'applied (agent_memories_ops_plane still carries the thought_id arm). '
                    'Revert it FIRST with revert-graph-plane-rls.sql: this file restores 180''s '
                    'policies, which do NOT carry that arm, so reverting in this order would '
                    're-open the foreign-key existence oracle without saying so.';
  END IF;
END $$;

DROP POLICY IF EXISTS agent_memories_ops_plane ON public.agent_memories;
CREATE POLICY agent_memories_ops_plane ON public.agent_memories
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_memory_on_ops_plane(metadata))
  WITH CHECK (public.ob_memory_on_ops_plane(metadata));

DROP POLICY IF EXISTS thoughts_ops_plane ON public.thoughts;
CREATE POLICY thoughts_ops_plane ON public.thoughts
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_corpus_on_ops_plane(metadata))
  WITH CHECK (public.ob_corpus_on_ops_plane(metadata));

-- 2. DE-CONSTRAIN the column. It stays, holding its values, read by nothing.
ALTER TABLE public.agent_memories DROP CONSTRAINT IF EXISTS agent_memories_exposure_check;
ALTER TABLE public.thoughts       DROP CONSTRAINT IF EXISTS thoughts_exposure_check;
ALTER TABLE public.agent_memories ALTER COLUMN exposure DROP NOT NULL;
ALTER TABLE public.thoughts       ALTER COLUMN exposure DROP NOT NULL;

COMMENT ON COLUMN public.agent_memories.exposure IS
  'REVERTED (H3 rolled back): inert. The authority is metadata->>''exposure'' again.';
COMMENT ON COLUMN public.thoughts.exposure IS
  'REVERTED (H3 rolled back): inert. The authority is metadata->>''exposure'' again.';

-- 3. upsert_thought goes back to init-graph.sql's body, verbatim.
CREATE OR REPLACE FUNCTION public.upsert_thought(
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS public.thoughts
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_fp   TEXT := encode(digest(p_content, 'sha256'), 'hex');
  v_meta JSONB := COALESCE(p_payload->'metadata', '{}'::jsonb);
  v_row  public.thoughts;
BEGIN
  SELECT * INTO v_row FROM public.thoughts
    WHERE content_fingerprint = v_fp LIMIT 1;
  IF FOUND THEN
    UPDATE public.thoughts
       SET metadata = metadata || v_meta, updated_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.thoughts (content, metadata)
      VALUES (p_content, v_meta)
      RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$fn$;

-- 4. UNSTAMP exactly what this migration stamped - rows that had NO label at all and that it
--    labelled 'ops'. Rows labelled by a writer, and rows 190 stamped, carry a different
--    marker or none and are left alone. The column value is cleared for the same rows, so a
--    re-apply re-derives it rather than trusting a value from a reverted run.
UPDATE public.thoughts
   SET metadata = (metadata - 'exposure') - 'exposure_backfill',
       exposure = NULL
 WHERE metadata->>'exposure_backfill' = 'dfu-h3-exposure-column';

UPDATE public.agent_memories
   SET metadata = (metadata - 'exposure') - 'exposure_backfill',
       exposure = NULL
 WHERE metadata->>'exposure_backfill' = 'dfu-h3-exposure-column';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- VERIFY AFTER REVERT (expect: notnull=f/f, checks=0, policies naming metadata=2):
--   SELECT table_name, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema='public' AND column_name='exposure';
--   SELECT count(*) FROM pg_constraint WHERE conname IN
--     ('agent_memories_exposure_check','thoughts_exposure_check');
--   SELECT tablename, policyname, qual FROM pg_policies
--    WHERE schemaname='public' AND tablename IN ('agent_memories','thoughts') ORDER BY 1,2;
--   -- and the corpus still reads: expect the same count as before the revert.
--   SET ROLE service_role; SELECT count(*) FROM thoughts; RESET ROLE;
