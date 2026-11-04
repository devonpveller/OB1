-- Revert init-request-boundary.sql (rw-boundary-core, slot 420).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-request-boundary.sql
-- Run it only after the research and workbench images that read request_kind are back to their pre-420 builds.
-- ARCHIVE FIRST: before anything is dropped, every research_handbacks row and every research_jobs row whose
-- request_kind / boundary is not the column default is copied whole into research_request_boundary_archive (the
-- superuser's alone: RLS on, no policy, no grant). Then:
--   1. research_job_report_owner() (slot 390) and trg_idea_revisions_inlet() (slot 230) go back exactly as 420 found
--      them (420 saved their definitions first; byte-identical: the drill compares pg_get_functiondef);
--   2. the guards (trg_research_jobs_boundary, trg_research_prompts_boundary) and their functions, the handback_*
--      functions and the research_handbacks table are dropped;
--   3. the columns research_jobs.request_kind and boundary (and their constraint and index) are dropped - every
--      other column of every row is untouched (a DROP COLUMN fires no row trigger), so the touched tables are
--      byte-identical to before 420 (the drill's md5 over to_jsonb of every row).
-- Runs twice cleanly: a second run finds nothing to archive or drop. The archive is KEPT (a later 420 does not read it).
-- After a revert, a derived job is an ordinary job again: if idea_revisions points at it, slot 390's rule makes its
-- report private (fail closed); the archive says which jobs were derived.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.research_request_boundary_archive (
    id          BIGSERIAL PRIMARY KEY,
    batch       UUID NOT NULL,
    tbl         TEXT NOT NULL,
    row_data    JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_request_boundary_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_request_boundary_archive FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.research_request_boundary_archive_id_seq FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid IN ('public.research_request_boundary_archive'::regclass, 'public.research_request_boundary_archive_id_seq'::regclass)
                AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_request_boundary_archive FROM %I', r.grantee);
        EXECUTE format('REVOKE ALL ON SEQUENCE public.research_request_boundary_archive_id_seq FROM %I', r.grantee);
    END LOOP;
END $$;

DO $$
DECLARE
    v_batch UUID := gen_random_uuid();
    v_hb    BIGINT := 0;
    v_jobs  BIGINT := 0;
BEGIN
    IF to_regclass('public.research_handbacks') IS NOT NULL THEN
        INSERT INTO public.research_request_boundary_archive (batch, tbl, row_data)
        SELECT v_batch, 'public.research_handbacks', to_jsonb(h) FROM public.research_handbacks h;
        GET DIAGNOSTICS v_hb = ROW_COUNT;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attname = 'request_kind' AND NOT attisdropped) THEN
        EXECUTE $q$INSERT INTO public.research_request_boundary_archive (batch, tbl, row_data)
                   SELECT $1, 'public.research_jobs', jsonb_build_object('id', j.id, 'request_kind', j.request_kind, 'boundary', j.boundary)
                     FROM public.research_jobs j WHERE j.request_kind <> 'unclassified' OR j.boundary IS NOT NULL$q$ USING v_batch;
        GET DIAGNOSTICS v_jobs = ROW_COUNT;
    END IF;
    RAISE NOTICE 'rw-boundary-core revert: archived % hand-back row(s) and % job kind(s) before dropping', v_hb, v_jobs;
END $$;

-- 1. the replaced definitions come back as 420 saved them (research_request_boundary_saved: slot 390's rule and slot
--    230's idea-revision inlet trigger, byte-identical, comments included); only if a saved copy is missing, the text
--    those slots write (below). Nothing is restored when 420 is not applied (a second revert changes nothing).
DO $rv$
DECLARE
    v_420 BOOLEAN := EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attname = 'request_kind' AND NOT attisdropped);
    v_n   INT := 0;
    r     RECORD;
BEGIN
    IF NOT v_420 THEN
        RAISE NOTICE 'rw-boundary-core revert: slot 420 is not applied - no definition to restore';
        RETURN;
    END IF;
    IF to_regclass('public.research_request_boundary_saved') IS NOT NULL THEN
        FOR r IN EXECUTE 'SELECT fn, def, comment FROM public.research_request_boundary_saved ORDER BY fn' LOOP
            EXECUTE r.def;
            EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.fn, r.comment);
            v_n := v_n + 1;
        END LOOP;
    END IF;
    IF to_regclass('public.research_request_boundary_saved') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.research_request_boundary_saved WHERE fn = 'public.research_job_report_owner(uuid)') THEN
        EXECUTE $f390$CREATE OR REPLACE FUNCTION public.research_job_report_owner(p_job UUID)
RETURNS TABLE (idea_id UUID, owner_sub TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_jobs   UUID[];
    v_hit    BOOLEAN;
    v_idea   UUID;
BEGIN
    IF p_job IS NULL THEN RETURN; END IF;
    -- the job and the root of its tree (a steer / gap branch of an idea's research is the idea's research)
    SELECT array_agg(x) INTO v_jobs FROM (
        SELECT j.id AS x FROM public.research_jobs j WHERE j.id = p_job
        UNION SELECT j.root_job_id FROM public.research_jobs j WHERE j.id = p_job AND j.root_job_id IS NOT NULL) s;
    IF v_jobs IS NULL THEN RETURN; END IF;
    SELECT bool_or(j.branch_kind = 'idea' OR j.refinery_id IS NOT NULL),
           (array_agg(j.refinery_id ORDER BY (j.id = p_job) DESC) FILTER (WHERE j.refinery_id IS NOT NULL))[1]
      INTO v_hit, v_idea
      FROM public.research_jobs j WHERE j.id = ANY(v_jobs);
    IF v_idea IS NULL THEN
        SELECT r.idea_id INTO v_idea FROM public.idea_revisions r
         WHERE lower(r.research_job_id) = ANY(SELECT x::text FROM unnest(v_jobs) x)
         ORDER BY r.created_at DESC LIMIT 1;
        v_hit := coalesce(v_hit, false) OR FOUND;
    END IF;
    IF NOT coalesce(v_hit, false) THEN RETURN; END IF;
    idea_id := v_idea;
    owner_sub := (SELECT NULLIF(i.owner_sub, '') FROM public.ideas i WHERE i.id = v_idea);
    RETURN NEXT;
END;
$$;$f390$;
        EXECUTE $c390$COMMENT ON FUNCTION public.research_job_report_owner(UUID) IS 'rw-report-isolation: no row = not an idea job (its report is shared); a row = an idea job, its report private to owner_sub (NULL: to nobody)'$c390$;
        RAISE NOTICE 'rw-boundary-core revert: no saved copy of research_job_report_owner - slot 390''s text restored';
    END IF;
    IF to_regclass('public.research_request_boundary_saved') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.research_request_boundary_saved WHERE fn = 'public.trg_idea_revisions_inlet()') THEN
        EXECUTE $f230$CREATE OR REPLACE FUNCTION public.trg_idea_revisions_inlet()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.research_job_id IS NOT NULL
       AND NEW.research_job_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND (TG_OP = 'INSERT' OR NEW.research_job_id IS DISTINCT FROM OLD.research_job_id) THEN
        UPDATE public.research_jobs j
           SET inlet_ref = COALESCE(NULLIF(j.inlet_ref, 'null'::jsonb), jsonb_build_object('kind', 'idea', 'id', NEW.idea_id::text)),
               refinery_id = COALESCE(j.refinery_id, NEW.idea_id)
         WHERE j.id = NEW.research_job_id::uuid;
    END IF;
    RETURN NEW;
END;
$$;$f230$;
        RAISE NOTICE 'rw-boundary-core revert: no saved copy of trg_idea_revisions_inlet - slot 230''s text restored';
    END IF;
    RAISE NOTICE 'rw-boundary-core revert: % saved definition(s) restored', v_n;
END $rv$;
DROP TABLE IF EXISTS public.research_request_boundary_saved;

-- 2. the guards, the functions, the table
DROP TRIGGER IF EXISTS trg_research_jobs_boundary ON public.research_jobs;
DROP FUNCTION IF EXISTS public.trg_research_jobs_boundary();
DO $$
BEGIN
    IF to_regclass('public.research_prompts') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_research_prompts_boundary ON public.research_prompts;
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.trg_research_prompts_boundary();
DROP FUNCTION IF EXISTS public.handback_open(TEXT, TEXT, TEXT, INT, TEXT, UUID, TEXT, JSONB, JSONB, JSONB);
DROP FUNCTION IF EXISTS public.handback_pending(TEXT, INT);
DROP FUNCTION IF EXISTS public.handback_claim(UUID, UUID, TEXT, JSONB, JSONB);
DROP FUNCTION IF EXISTS public.handback_deliverables(TEXT, INT);
DROP FUNCTION IF EXISTS public.handback_delivered(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.handback_owned(TEXT, INT);
DROP TABLE IF EXISTS public.research_handbacks;

-- 3. the columns
DROP INDEX IF EXISTS public.idx_research_jobs_request_kind;
ALTER TABLE public.research_jobs DROP CONSTRAINT IF EXISTS research_jobs_request_kind_check;
ALTER TABLE public.research_jobs DROP COLUMN IF EXISTS boundary;
ALTER TABLE public.research_jobs DROP COLUMN IF EXISTS request_kind;

NOTIFY pgrst, 'reload schema';
COMMIT;
