-- Revert init-boundary-ideas.sql (rw-boundary-ideas, slot 580).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-boundary-ideas.sql
-- Run it only after the research, refinery and workbench images are back to their pre-580 builds, and BEFORE any revert
-- of slot 420 (580's functions read 420's table).
-- ARCHIVE FIRST: every idea hand-back (purpose idea-research) is copied whole into research_boundary_ideas_archive (the
-- superuser's alone: RLS on, no policy, no grant) before anything changes. Then:
--   1. every OPEN idea hand-back (pending, queued, awaiting_owner) is closed as 'failed' (verdict.reverted = '580'): the
--      restored slot-420 index allows one open row per inlet again, and nothing drains them any more. A queued row's
--      derived job is left as it is (it runs, its report is filed shared); ideas.last_job_id already names it, so the
--      pre-580 refinery delivers it the old way;
--   2. the binding trigger and the functions this file created are dropped; 420's uq_handback_open goes back exactly as
--      it was (the definition 580 saved) and uq_handback_idea_pending is dropped;
--   3. research_idea_queue, trg_idea_revisions_engage, idea_research_now, idea_schedule_set, idea_schedule_drain and
--      idea_research go back exactly as 580 found them (580 saved pg_get_functiondef + the comment first).
-- Revisions queued under 580 whose hand-back never formed a job keep metadata.research_handback and no research_job_id:
-- the restored pre-580 queue does not re-queue them on its own (counted in the NOTICE; `research now` re-queues one).
-- Runs twice cleanly: a second run archives nothing new and changes nothing. The archive is KEPT.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.research_boundary_ideas_archive (
    id          UUID PRIMARY KEY,
    row_data    JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_boundary_ideas_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_boundary_ideas_archive FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.research_boundary_ideas_archive'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_boundary_ideas_archive FROM %I', r.grantee);
    END LOOP;
END $$;

DO $$
DECLARE
    v_arch   BIGINT := 0;
    v_closed BIGINT := 0;
    v_marked BIGINT := 0;
    r        RECORD;
BEGIN
    IF to_regclass('public.research_handbacks') IS NOT NULL THEN
        -- a row changed since an earlier archive is archived again (its latest form); an unchanged one is not
        INSERT INTO public.research_boundary_ideas_archive (id, row_data)
        SELECT h.id, to_jsonb(h) FROM public.research_handbacks h WHERE h.purpose = 'idea-research'
        ON CONFLICT (id) DO UPDATE SET row_data = EXCLUDED.row_data, archived_at = now()
         WHERE research_boundary_ideas_archive.row_data IS DISTINCT FROM EXCLUDED.row_data;
        GET DIAGNOSTICS v_arch = ROW_COUNT;
        UPDATE public.research_handbacks
           SET state = 'failed', owner_view = NULL, updated_at = now(), verdict = verdict || '{"reverted": "580"}'::jsonb
         WHERE purpose = 'idea-research' AND state IN ('pending', 'queued', 'awaiting_owner');
        GET DIAGNOSTICS v_closed = ROW_COUNT;
        -- the closed rows' copies, as they are now
        INSERT INTO public.research_boundary_ideas_archive (id, row_data)
        SELECT h.id, to_jsonb(h) FROM public.research_handbacks h WHERE h.purpose = 'idea-research'
        ON CONFLICT (id) DO UPDATE SET row_data = EXCLUDED.row_data, archived_at = now()
         WHERE research_boundary_ideas_archive.row_data IS DISTINCT FROM EXCLUDED.row_data;
    END IF;
    SELECT count(*) INTO v_marked FROM public.idea_revisions
     WHERE research_job_id IS NULL AND coalesce(metadata, '{}'::jsonb) ? 'research_handback';
    RAISE NOTICE 'rw-boundary-ideas revert: archived % idea hand-back row(s), closed % open one(s); % revision(s) were queued under 580 and never formed a job', v_arch, v_closed, v_marked;

    -- the binding trigger and 580's own functions
    IF to_regclass('public.research_handbacks') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_research_handbacks_idea_owner ON public.research_handbacks;
    END IF;
    DROP FUNCTION IF EXISTS public.trg_research_handbacks_idea_owner();
    DROP FUNCTION IF EXISTS public.idea_handback_item(uuid, text);
    DROP FUNCTION IF EXISTS public.idea_handback_settle(uuid, integer, uuid, text, jsonb, jsonb);
    DROP FUNCTION IF EXISTS public.idea_handback_review(text, uuid);
    DROP FUNCTION IF EXISTS public.idea_handback_run_private(text, text, uuid, text);
    DROP FUNCTION IF EXISTS public.idea_handback_decide(text, uuid, uuid, jsonb);
    DROP FUNCTION IF EXISTS public.idea_handback_deliverables(integer);
    DROP FUNCTION IF EXISTS public.idea_handback_stamp(uuid, integer, uuid);

    IF to_regclass('public.research_boundary_ideas_saved') IS NOT NULL THEN
        -- 420's index, exactly as 580 found it
        IF to_regclass('public.research_handbacks') IS NOT NULL THEN
            DROP INDEX IF EXISTS public.uq_handback_idea_pending;
            FOR r IN SELECT def FROM public.research_boundary_ideas_saved WHERE fn = 'index:uq_handback_open' LOOP
                DROP INDEX IF EXISTS public.uq_handback_open;
                EXECUTE r.def;
            END LOOP;
        END IF;
        -- the replaced functions, byte-identical, with their comments
        FOR r IN SELECT fn, def, comment FROM public.research_boundary_ideas_saved WHERE fn NOT LIKE 'index:%' ORDER BY fn LOOP
            EXECUTE r.def;
            EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.fn, r.comment);
        END LOOP;
        DROP TABLE public.research_boundary_ideas_saved;
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
