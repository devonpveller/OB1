-- ============================================================
-- Revert of init-inlet-stamp.sql (research-workbench rw-inlet-stamp, plan 08 PD2, slot 470).
-- Takes away exactly what slot 470 added: the guards on thoughts and sources, the owner CHECKs, the prune's
-- per-connection view, inlet_connection_owner(), the predicates and the inlet owner record. Slot 470 changed no
-- existing row, so there is nothing to restore. Re-runnable.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-inlet-stamp.sql
-- Order: BEFORE revert-inlet-owner.sql (440). After it, the inlet writers of this item refuse (no record): deploy the
-- previous writer code with it.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TRIGGER IF EXISTS trg_inlet_stamp_thoughts ON public.thoughts;
DROP TRIGGER IF EXISTS trg_inlet_stamp_sources ON public.sources;
DROP TRIGGER IF EXISTS trg_inlet_stamp_chunks ON public.source_chunks;
DROP TRIGGER IF EXISTS trg_inlet_stamp_claims ON public.claims;
DO $$
DECLARE c TEXT;
BEGIN
    FOREACH c IN ARRAY ARRAY['podcast_episodes', 'research_handbacks', 'podcast_teams', 'podcast_presenters',
                             'podcast_voice_links', 'podcast_formats', 'podcast_render_requests', 'inlet_private_sources', 'inlet_private_source_chunks',
                             'inlet_private_claims', 'inlet_private_claim_links', 'inlet_private_jobs', 'inlet_private_job_events'] LOOP
        IF to_regclass('public.' || c) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', c, c || '_inlet_stamp_owner_ok');
        END IF;
    END LOOP;
END $$;
DROP VIEW IF EXISTS public.inlet_connection_mail;
DROP FUNCTION IF EXISTS public.inlet_stamp_thoughts_guard();
DROP FUNCTION IF EXISTS public.inlet_stamp_sources_guard();
DROP FUNCTION IF EXISTS public.inlet_stamp_source_personal(TEXT, TEXT, JSONB, TEXT);
DROP FUNCTION IF EXISTS public.inlet_stamp_source_personal(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.inlet_stamp_chunks_guard();
DROP FUNCTION IF EXISTS public.inlet_stamp_claims_guard();
DROP FUNCTION IF EXISTS public.inlet_stamp_text_personal(TEXT);
DROP FUNCTION IF EXISTS public.inlet_stamp_dossier_clean(JSONB, TEXT);
DROP FUNCTION IF EXISTS public.inlet_stamp_is_dossier(JSONB);
DROP FUNCTION IF EXISTS public.inlet_stamp_door_claims();
DROP FUNCTION IF EXISTS public.inlet_connection_owner(TEXT);
DROP TABLE IF EXISTS public.inlet_connections;
DROP FUNCTION IF EXISTS public.inlet_subject_ok(TEXT);
DROP FUNCTION IF EXISTS public.inlet_owner_column_ok(TEXT);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_inlet_stamp_view') THEN
        DROP ROLE ob_inlet_stamp_view;
    END IF;
END $$;
DO $$ BEGIN RAISE NOTICE 'inlet stamp: reverted (slot 470 objects removed)'; END $$;
COMMIT;
