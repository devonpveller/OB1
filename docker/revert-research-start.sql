-- Revert init-research-start.sql (rwr-research-start-api, slot 540).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-start.sql
-- Run it only after the research and workbench images are back to their pre-540 builds, and with no derived job
-- queued or running that carries a contract budget (a requeue UPDATE of one would then be refused by the older,
-- stricter allow-list). Run it BEFORE 460's and 420's reverts.
-- ARCHIVE FIRST: every research_handbacks row with purpose 'user-start' is copied whole into research_start_archive
-- (the superuser's alone: RLS on, no policy, no grant) and then deleted, because the restored purpose CHECK refuses
-- it. Then:
--   1. request_boundary_options_ok goes back exactly as 540 found it (540 saved its definition first);
--   2. the purpose CHECK goes back to the four purposes.
-- Runs twice cleanly: a second run finds nothing to archive or restore. The archive is KEPT.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.research_start_archive (
    id          BIGSERIAL PRIMARY KEY,
    batch       UUID NOT NULL,
    tbl         TEXT NOT NULL,
    row_data    JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_start_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_start_archive FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.research_start_archive_id_seq FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid IN ('public.research_start_archive'::regclass, 'public.research_start_archive_id_seq'::regclass)
                AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_start_archive FROM %I', r.grantee);
        EXECUTE format('REVOKE ALL ON SEQUENCE public.research_start_archive_id_seq FROM %I', r.grantee);
    END LOOP;
END $$;

DO $$
DECLARE
    v_batch UUID := gen_random_uuid();
    v_n     BIGINT := 0;
    v_def   TEXT;
    v_cmt   TEXT;
BEGIN
    INSERT INTO public.research_start_archive (batch, tbl, row_data)
    SELECT v_batch, 'public.research_handbacks', to_jsonb(h) FROM public.research_handbacks h WHERE h.purpose = 'user-start';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'rwr-research-start-api revert: archived % user-start hand-back(s) before deleting', v_n;
    DELETE FROM public.research_handbacks WHERE purpose = 'user-start';
    IF to_regclass('public.research_start_saved') IS NOT NULL THEN
        SELECT def, comment INTO v_def, v_cmt FROM public.research_start_saved WHERE fn = 'public.request_boundary_options_ok(jsonb,boolean)';
        IF v_def IS NOT NULL THEN
            EXECUTE v_def;
            EXECUTE format('COMMENT ON FUNCTION public.request_boundary_options_ok(jsonb, boolean) IS %L', v_cmt);
            RAISE NOTICE 'rwr-research-start-api revert: request_boundary_options_ok restored from the saved copy';
        END IF;
    ELSE
        RAISE NOTICE 'rwr-research-start-api revert: slot 540 is not applied - no definition to restore';
    END IF;
END $$;

ALTER TABLE public.research_handbacks DROP CONSTRAINT IF EXISTS research_handbacks_purpose_check;
ALTER TABLE public.research_handbacks ADD CONSTRAINT research_handbacks_purpose_check
    CHECK (purpose IN ('idea-research', 'digest-article', 'digest-gap', 'brainstorm-gap'));
DROP TABLE IF EXISTS public.research_start_saved;

COMMIT;
