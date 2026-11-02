-- rw-p5a-intake round 2 (tester T-F1): what revert-intake-queue.sql may remove, checked on a database that has run the
-- whole initdb chain (slot 360 included). Run AFTER the revert:
--   psql -v ON_ERROR_STOP=1 -f revert-intake-queue-check.sql      (exit 3 = a check failed)
-- 1. every registry row the chain BEFORE slot 360 owns survives - the P2b job_states pending / held
--    (init-documents.sql) and job_kinds compile / held, the P0 job_kinds import / research;
-- 2. what init-intake-queue.sql added is gone: job_kinds add / chunk / extract / entity, job_states processing /
--    fetching / holding, import_jobs.owner_sub, import_job_payloads.
\set ON_ERROR_STOP on
DO $$
DECLARE missing TEXT; leftover TEXT;
BEGIN
  SELECT string_agg(r || '/' || k, ', ') INTO missing FROM (VALUES
      ('job_states', 'pending'), ('job_states', 'held'), ('job_states', 'queued'), ('job_states', 'done'),
      ('job_kinds', 'import'), ('job_kinds', 'research'), ('job_kinds', 'compile'), ('job_kinds', 'held')) v(r, k)
   WHERE NOT EXISTS (SELECT 1 FROM public.contract_registry_entries e WHERE e.registry = v.r AND e.key = v.k);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'REVERT-CHECK FAIL: the revert removed rows it did not add: %', missing; END IF;
  SELECT string_agg(registry || '/' || key, ', ') INTO leftover FROM public.contract_registry_entries
   WHERE (registry = 'job_kinds' AND key IN ('add', 'chunk', 'extract', 'entity'))
      OR (registry = 'job_states' AND key IN ('processing', 'fetching', 'holding'));
  IF leftover IS NOT NULL THEN RAISE EXCEPTION 'REVERT-CHECK FAIL: the revert left rows it added: %', leftover; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'import_jobs' AND column_name = 'owner_sub')
     OR to_regclass('public.import_job_payloads') IS NOT NULL THEN
    RAISE EXCEPTION 'REVERT-CHECK FAIL: import_jobs.owner_sub or import_job_payloads is still there';
  END IF;
  RAISE NOTICE 'REVERT-CHECK OK: the P0/P2b registry rows survive; the intake queue''s own rows, column and table are gone';
END $$;
