-- Revert init-research-trees.sql (research-workbench P4a, rw-p4a-trees).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-trees.sql
--
-- What it does: removes the on-demand idea engagement trigger and function, drops the steer records
-- and the event stream (THIS DISCARDS every recorded steer and stage/source/gap event), and drops the
-- tree columns from research_jobs (THIS DISCARDS parent/child links, rooted step ids, anchors, topic
-- estimates and stored tree reports; branch jobs stay as ordinary rows). Redeploy the pre-P4a
-- research-service image and restore the refinery's 03:00 crontab line with it: the P4a image writes
-- these tables and columns, and the pre-P4a refinery engages ideas only through its nightly drain.
\set ON_ERROR_STOP on
BEGIN;

DROP TRIGGER IF EXISTS trg_idea_revisions_engage ON public.idea_revisions;
DROP FUNCTION IF EXISTS public.trg_idea_revisions_engage();
DROP FUNCTION IF EXISTS public.research_idea_queue(UUID, INT, TEXT);

DROP TABLE IF EXISTS public.research_job_events;
DROP TABLE IF EXISTS public.research_steers;

DROP INDEX IF EXISTS public.idx_research_jobs_idea_open;
DROP INDEX IF EXISTS public.uq_research_jobs_tree_gap;
DROP INDEX IF EXISTS public.idx_research_jobs_root;
DROP INDEX IF EXISTS public.idx_research_jobs_parent;
ALTER TABLE public.research_jobs DROP CONSTRAINT IF EXISTS research_jobs_branch_shape_check;
ALTER TABLE public.research_jobs DROP CONSTRAINT IF EXISTS research_jobs_branch_kind_check;
ALTER TABLE public.research_jobs
    DROP COLUMN IF EXISTS gap_ref,
    DROP COLUMN IF EXISTS tree_report,
    DROP COLUMN IF EXISTS topic_estimate,
    DROP COLUMN IF EXISTS anchor,
    DROP COLUMN IF EXISTS branch_kind,
    DROP COLUMN IF EXISTS rooted_step_id,
    DROP COLUMN IF EXISTS root_job_id,
    DROP COLUMN IF EXISTS parent_job_id;

COMMIT;
NOTIFY pgrst, 'reload schema';
