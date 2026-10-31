-- Revert init-research-sessions.sql (research-workbench P4b, rw-p4b-sessions).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-sessions.sql
--
-- What it does: drops research_steers.actor_sub (THIS DISCARDS who opened each recorded branch; the
-- steers themselves stay), un-retires implementation_states.steer, and removes the idea-owner trigger
-- with the research_prompts rows it wrote (actor system:idea-engagement: those idea jobs read as
-- ownerless again, the default subject's, as before P4b). Redeploy the pre-P4b
-- openbrain-research and openbrain-workbench images with it: the P4b research image writes actor_sub.
\set ON_ERROR_STOP on
BEGIN;

-- the idea-owner rows this slot wrote (and its trigger); every other research_prompts row stays
DELETE FROM public.research_prompts WHERE actor_sub = 'system:idea-engagement';
DROP TRIGGER IF EXISTS trg_research_jobs_idea_owner ON public.research_jobs;
DROP FUNCTION IF EXISTS public.trg_research_jobs_idea_owner();

DROP INDEX IF EXISTS public.idx_research_steers_actor;
ALTER TABLE public.research_steers DROP CONSTRAINT IF EXISTS research_steers_actor_sub_check;
ALTER TABLE public.research_steers DROP COLUMN IF EXISTS actor_sub;

UPDATE public.contract_registry_entries
   SET retired_at = NULL
 WHERE registry = 'implementation_states' AND key = 'steer';

COMMIT;
