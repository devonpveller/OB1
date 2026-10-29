-- Revert init-research-filed.sql (rw-curator-filed).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-filed.sql
-- Removes the 'filed' events (THIS DISCARDS the record that a job was filed; the syntheses stay) and
-- restores the pre-change type check. Redeploy the pre-change curator / kubernetes-deployment /
-- research-service images first: the new persist writes 'filed' events and fails without the type.
\set ON_ERROR_STOP on
BEGIN;
DROP INDEX IF EXISTS public.uq_research_job_events_filed;
ALTER TABLE public.research_job_events DROP CONSTRAINT IF EXISTS research_job_events_filed;
DELETE FROM public.research_job_events WHERE type = 'filed';
ALTER TABLE public.research_job_events DROP CONSTRAINT IF EXISTS research_job_events_type_check;
ALTER TABLE public.research_job_events ADD CONSTRAINT research_job_events_type_check
    CHECK (type IN ('stage', 'source', 'human_steer', 'gap', 'interhub_gap', 'branch_open', 'branch_close', 'topic'));
COMMIT;
