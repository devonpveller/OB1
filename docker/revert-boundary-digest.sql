-- Revert init-boundary-digest.sql (rw-boundary-digest, slot 460).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-boundary-digest.sql
-- Run it only after the digest code (the OB1 gitlink: openbrain-podcast bind-mounts the recipe) and the research
-- image are back to their pre-460 builds, and with no derived job queued or running (a requeue UPDATE of a derived
-- job that carries a run knob would then be refused by 420's stricter allow-list). Run it BEFORE 420's revert.
-- ARCHIVE FIRST: every podcast_episodes row with a transcript is copied (id, owner_sub, transcript) into
-- research_boundary_digest_archive (the superuser's alone: RLS on, no policy, no grant). Then:
--   1. request_boundary_options_ok goes back exactly as 460 found it (460 saved its definition first);
--   2. handback_deliver is dropped (the hand-backs it marked keep their state and their deliver record);
--   3. podcast_episodes.transcript is dropped - every other column of every row is untouched.
-- Runs twice cleanly: a second run finds nothing to archive, restore or drop. The archive is KEPT.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.research_boundary_digest_archive (
    id          BIGSERIAL PRIMARY KEY,
    batch       UUID NOT NULL,
    tbl         TEXT NOT NULL,
    row_data    JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_boundary_digest_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_boundary_digest_archive FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.research_boundary_digest_archive_id_seq FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid IN ('public.research_boundary_digest_archive'::regclass, 'public.research_boundary_digest_archive_id_seq'::regclass)
                AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_boundary_digest_archive FROM %I', r.grantee);
        EXECUTE format('REVOKE ALL ON SEQUENCE public.research_boundary_digest_archive_id_seq FROM %I', r.grantee);
    END LOOP;
END $$;

DO $$
DECLARE
    v_batch UUID := gen_random_uuid();
    v_n     BIGINT := 0;
    v_def   TEXT;
    v_cmt   TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.podcast_episodes'::regclass AND attname = 'transcript' AND NOT attisdropped) THEN
        EXECUTE $q$INSERT INTO public.research_boundary_digest_archive (batch, tbl, row_data)
                   SELECT $1, 'public.podcast_episodes', jsonb_build_object('id', e.id, 'owner_sub', e.owner_sub, 'transcript', e.transcript)
                     FROM public.podcast_episodes e WHERE e.transcript IS NOT NULL$q$ USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT;
    END IF;
    RAISE NOTICE 'rw-boundary-digest revert: archived % transcript(s) before dropping', v_n;
    IF to_regclass('public.research_boundary_digest_saved') IS NOT NULL THEN
        SELECT def, comment INTO v_def, v_cmt FROM public.research_boundary_digest_saved WHERE fn = 'public.request_boundary_options_ok(jsonb,boolean)';
        IF v_def IS NOT NULL THEN
            EXECUTE v_def;
            EXECUTE format('COMMENT ON FUNCTION public.request_boundary_options_ok(jsonb, boolean) IS %L', v_cmt);
            RAISE NOTICE 'rw-boundary-digest revert: request_boundary_options_ok restored from the saved copy';
        END IF;
    ELSE
        RAISE NOTICE 'rw-boundary-digest revert: slot 460 is not applied - no definition to restore';
    END IF;
END $$;

DROP FUNCTION IF EXISTS public.handback_deliver(uuid, text, boolean, jsonb);
ALTER TABLE public.podcast_episodes DROP COLUMN IF EXISTS transcript;
DROP TABLE IF EXISTS public.research_boundary_digest_saved;

COMMIT;
