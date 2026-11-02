-- ============================================================
-- The intake and queue panel (research-workbench P5a, rw-p5a-intake).
--
-- What this file adds, and only this:
--   1. import_jobs gains its OWNER and the user's ADD:
--        owner_sub / actor_sub  the identity seam's subject_sub / actor_sub of the request that made the
--                               job (07-MULTI-USER: a user's imports and adds are their front-end
--                               history - only that subject lists, retries or cancels them). NULL = a job
--                               made before this file: it belongs to WORKSPACE_DEFAULT_SUB (read time,
--                               documents/ownership.ts ownerlessOwner - the value is never written here).
--        origin                 workspace | owui (the OWUI inlet enters the same add path).
--        mode                   import (the P5 import/grounding route) | add (a user add: fetched through
--                               the research service's proxy-bound fetch, held in an idea refinery).
--        url, filename, refinery_id, doc_path, content_type, held_source_id   what the job adds, where
--                               it lands (refinery_id for the general add, doc_path for the contextual
--                               add), its declared content type, and the held source it made.
--        attempts               how many times the job ran (a retry runs it again).
--      and its status set gains fetching, holding, held, cancelled.
--   2. import_job_payloads     a file add's / file import's bytes, kept until the job ends well, so a
--                               failed one can be retried without the user re-sending the file.
--   3. job_kinds add / chunk / extract / entity and the job_states processing / fetching / holding (pending and
--      held are P2b's, init-documents.sql - not added here, so the revert never removes them) - the registry the intake panel
--      reads (jobs(state): "the queues the intake panel shows"). chunk = sources waiting for the chunk
--      worker (md5(content) vs metadata.chunked_hash), extract = source_extraction_queue, entity =
--      entity_extraction_queue (both drained by the entity worker; it claims status 'pending' only).
-- No worker changes: a cancelled chunk is stamped processed (chunked_hash = md5(content),
-- chunk_cancelled), a cancelled extract / entity row is status 'cancelled' (never claimed); retry undoes it.
-- Idempotent; re-running it changes nothing. Fresh-volume slot 360 (340 is rw-p8a3-room's rooms, 350 rw-p8a2-cleanup's); the live DB gets it by hand
-- (psql -f, BEFORE the new workbench image). Revert: revert-intake-queue.sql.
-- ============================================================

ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS owner_sub      TEXT;
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS actor_sub      TEXT;
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS actor_name     TEXT; -- the display name an add records as added_by (as the P2b add does)
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS origin         TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS mode           TEXT NOT NULL DEFAULT 'import';
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS url            TEXT;
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS filename       TEXT;
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS refinery_id    UUID;
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS doc_path       TEXT;
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS content_type   TEXT;
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS held_source_id UUID;
ALTER TABLE public.import_jobs ADD COLUMN IF NOT EXISTS attempts       INT NOT NULL DEFAULT 1;

ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_status_check
    CHECK (status IN ('queued','fetching','extracting','embedding','linking','holding','done','held','failed','cancelled'));
ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_mode_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_mode_check CHECK (mode IN ('import','add'));
ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_origin_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_origin_check CHECK (origin IN ('workspace','owui'));
-- an add lands in exactly one place: a named refinery (general) or a document's refinery (contextual)
ALTER TABLE public.import_jobs DROP CONSTRAINT IF EXISTS import_jobs_add_target_check;
ALTER TABLE public.import_jobs ADD CONSTRAINT import_jobs_add_target_check
    CHECK (mode <> 'add' OR ((refinery_id IS NOT NULL) <> (doc_path IS NOT NULL)));

CREATE INDEX IF NOT EXISTS idx_import_jobs_owner  ON public.import_jobs(owner_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_jobs_source ON public.import_jobs(source_id);

CREATE TABLE IF NOT EXISTS public.import_job_payloads (
    job_id     UUID PRIMARY KEY REFERENCES public.import_jobs(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    bytes      BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('job_kinds', 'add',     'user add (held in a refinery)', '{"table":"import_jobs","meaning":"a link or file a user added: fetched through the research service, held in an idea refinery"}'),
    ('job_kinds', 'chunk',   'chunking',                      '{"table":"sources","meaning":"a source waiting for the chunk worker (md5(content) vs metadata.chunked_hash)"}'),
    ('job_kinds', 'extract', 'entity extraction (sources)',   '{"table":"source_extraction_queue"}'),
    ('job_kinds', 'entity',  'entity extraction (thoughts)',  '{"table":"entity_extraction_queue"}'),
    ('job_states', 'processing', 'processing', '{}'),
    ('job_states', 'fetching',   'fetching',   '{}'),
    ('job_states', 'holding',    'holding',    '{}')
ON CONFLICT (registry, key) DO NOTHING;

-- ── RLS + grants (the P0 shape) ─────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['import_job_payloads'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role_all', t);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
