-- Revert init-intake-queue.sql (rw-p5a-intake).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-intake-queue.sql
-- Drops the stored file bytes of import / add jobs and the columns the intake panel added to
-- import_jobs (THIS DISCARDS each job's owner, origin and add target, and every add row: an add is
-- deleted, its held source stays in its refinery). The worker queues are not touched: a cancelled
-- extract / entity row goes back to 'pending', a cancelled chunk loses its stamp (re-chunked).
\set ON_ERROR_STOP on
BEGIN;
DROP TABLE IF EXISTS public.import_job_payloads;
-- round 4 (reviewer N3): only while the column is there, so a second revert in a row runs clean
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'import_jobs' AND column_name = 'mode') THEN
        DELETE FROM public.import_jobs WHERE mode = 'add';
    END IF;
END $$;
UPDATE public.import_jobs SET status = 'failed', error = COALESCE(error, 'cancelled')
 WHERE status NOT IN ('queued','extracting','embedding','linking','done','failed');
ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_add_target_check;
ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_origin_check;
ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_mode_check;
ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_status_check
    CHECK (status IN ('queued','extracting','embedding','linking','done','failed'));
DROP INDEX IF EXISTS public.idx_import_jobs_owner;
DROP INDEX IF EXISTS public.idx_import_jobs_source;
ALTER TABLE public.import_jobs
    DROP COLUMN IF EXISTS owner_sub, DROP COLUMN IF EXISTS actor_sub, DROP COLUMN IF EXISTS actor_name, DROP COLUMN IF EXISTS origin,
    DROP COLUMN IF EXISTS mode, DROP COLUMN IF EXISTS url, DROP COLUMN IF EXISTS filename,
    DROP COLUMN IF EXISTS refinery_id, DROP COLUMN IF EXISTS doc_path, DROP COLUMN IF EXISTS content_type,
    DROP COLUMN IF EXISTS held_source_id, DROP COLUMN IF EXISTS attempts;
UPDATE public.source_extraction_queue SET status = 'pending' WHERE status = 'cancelled';
UPDATE public.entity_extraction_queue SET status = 'pending' WHERE status = 'cancelled';
UPDATE public.sources SET metadata = metadata - 'chunked_hash' - 'chunk_cancelled'
 WHERE (metadata ->> 'chunk_cancelled')::boolean IS TRUE;
DELETE FROM public.contract_registry_entries
 WHERE (registry = 'job_kinds' AND key IN ('add','chunk','extract','entity'))
    -- only the job_states this file's init added: pending and held are P2b's (init-documents.sql) and stay
    OR (registry = 'job_states' AND key IN ('processing','fetching','holding'));
COMMIT;
NOTIFY pgrst, 'reload schema';
