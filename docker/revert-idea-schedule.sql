-- Revert init-idea-schedule.sql (rw-idea-schedule).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-idea-schedule.sql
-- Restores the P4a capture trigger (queue at once) and drops the schedule table and functions
-- (THIS DISCARDS every user's schedule). Ideas deferred and not yet queued are queued first so none
-- is stranded.
\set ON_ERROR_STOP on
BEGIN;
SELECT public.idea_research_now(i.id) FROM public.ideas i
  JOIN public.idea_revisions r ON r.idea_id = i.id AND r.revision = i.current_revision
 WHERE i.status <> 'archived' AND r.research_job_id IS NULL AND r.metadata->>'deferred' = 'true';
CREATE OR REPLACE FUNCTION public.trg_idea_revisions_engage()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.research_job_id IS NULL THEN
        NEW.research_job_id := public.research_idea_queue(NEW.idea_id, NEW.revision, NEW.summary)::text;
    END IF;
    RETURN NEW;
END;
$$;
DROP FUNCTION IF EXISTS public.idea_schedule_drain(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.idea_schedule_set(TEXT, TEXT, TEXT, TIME, INT, TEXT);
DROP FUNCTION IF EXISTS public.idea_schedule_next(TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.idea_schedule_fire(TEXT, TIME, INT, TEXT, TIMESTAMPTZ, INT);
DROP FUNCTION IF EXISTS public.idea_research_now(UUID);
DROP TABLE IF EXISTS public.idea_schedule;
COMMIT;
