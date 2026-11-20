-- ============================================================
-- Revert of init-owner-private-view.sql (research-workbench rw-owner-private-view, slot 480).
-- Takes away exactly what slot 480 added: the owner-scoped reads; PD1's two reads go back to ob_app_memory (440's
-- grant); the ob_workbench role is dropped when no session uses it (else it is kept, NOLOGIN, and said - recreate the
-- workbench as ob_app_memory and run this again). Slot 480 changed no row, so there is nothing to restore. Re-runnable.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-owner-private-view.sql
-- Order: deploy the previous workbench (DB_USER ob_app_memory) FIRST, then this file; and BEFORE 440's revert.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.owner_private_claims(TEXT, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, UUID, INT);
DROP FUNCTION IF EXISTS public.owner_private_source_text(TEXT, TEXT, TEXT, INT);
DO $$
BEGIN
    IF to_regtype('vector') IS NOT NULL THEN
        EXECUTE 'DROP FUNCTION IF EXISTS public.owner_private_source_knn(TEXT, vector, TEXT, INT)';
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.owner_private_has_sources(TEXT);
DROP FUNCTION IF EXISTS public.owner_private_jobs(TEXT, TIMESTAMPTZ, UUID, INT);
DROP FUNCTION IF EXISTS public.owner_private_source_kind(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.owner_private_subject_ok(TEXT);
DO $$
DECLARE n INT;
BEGIN
    -- PD1's two reads: back to 440's grant
    IF to_regprocedure('public.inlet_private_source(uuid,text)') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        GRANT EXECUTE ON FUNCTION public.inlet_private_source(UUID, TEXT) TO ob_app_memory;
        GRANT EXECUTE ON FUNCTION public.inlet_private_job(UUID, TEXT) TO ob_app_memory;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN RETURN; END IF;
    IF to_regprocedure('public.inlet_private_source(uuid,text)') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION public.inlet_private_source(UUID, TEXT) FROM ob_workbench;
        REVOKE ALL ON FUNCTION public.inlet_private_job(UUID, TEXT) FROM ob_workbench;
    END IF;
    SELECT count(*) INTO n FROM pg_stat_activity WHERE usename = 'ob_workbench';
    IF n > 0 THEN
        ALTER ROLE ob_workbench NOLOGIN;
        RAISE NOTICE 'owner private view revert: ob_workbench has % session(s): kept, NOLOGIN - recreate the workbench as ob_app_memory and run this file again', n;
    ELSE
        DROP OWNED BY ob_workbench;
        DROP ROLE ob_workbench;
    END IF;
END $$;
SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'owner private view revert: the owner-scoped reads are gone, PD1''s reads are back on ob_app_memory'; END $$;
COMMIT;
