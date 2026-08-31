-- revert-agent-memory-corpus-failclosed.sql
--
-- THE REVERT PATH for init-agent-memory-corpus-failclosed.sql. NOT MOUNTED in the
-- initdb chain - it is an operator tool, and a revert that ran itself on every fresh
-- volume would undo the migration it ships beside.
--
--   docker cp OB1/docker/revert-agent-memory-corpus-failclosed.sql openbrain-db:/tmp/
--   docker exec openbrain-db psql -U postgres -d openbrain -v ON_ERROR_STOP=1 \
--       -f /tmp/revert-agent-memory-corpus-failclosed.sql
--
-- ORDER IS THE MIRROR OF THE MIGRATION: re-open the predicate FIRST, then unstamp.
-- Doing it the other way round would make 12989 rows invisible to the agent plane for
-- the duration of the transaction.
--
-- WHAT IT RESTORES: exactly the rows this migration stamped. Rows labelled `ops` by the
-- write path carry no `exposure_backfill` key and are left alone - which is why the
-- migration stamps rather than relying on a timestamp or on "everything that is ops".

BEGIN;

-- 1. RE-OPEN THE PREDICATE to its pre-migration text.
CREATE OR REPLACE FUNCTION public.ob_corpus_on_ops_plane(md JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT md->>'exposure' IS NULL OR md->>'exposure' = 'ops'
$$;

-- 2. UNSTAMP exactly what the migration stamped. `-` removes a key from a JSONB object;
--    both keys go, returning the object to its pre-migration shape.
UPDATE thoughts
   SET metadata = (metadata - 'exposure') - 'exposure_backfill'
 WHERE metadata->>'exposure_backfill' = 'dfu-c8-corpus-failclosed';

COMMIT;

-- VERIFY AFTER REVERT (expect: unlabelled 12989, ops 4, backfill-stamped 0):
--   SELECT count(*) FILTER (WHERE metadata->>'exposure' IS NULL)               AS unlabelled,
--          count(*) FILTER (WHERE metadata->>'exposure' = 'ops')               AS ops,
--          count(*) FILTER (WHERE metadata->>'exposure_backfill' IS NOT NULL)  AS stamped
--     FROM thoughts;
