-- Revert init-research-sessions.sql (research-workbench P4b, rw-p4b-sessions).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-sessions.sql
--
-- What it does, and what it cannot restore:
--   - drops research_steers.actor_sub: THIS DISCARDS who opened each recorded branch (the steers stay;
--     a re-apply back-fills human steers as service:<caller>, not the person who steered);
--   - drops research_cancels: THIS DISCARDS who cancelled what (an append-only record, removed whole);
--   - un-retires implementation_states.steer;
--   - removes the idea-owner trigger: the rows it wrote (actor system:idea-engagement) go, so those idea
--     jobs read as ownerless again; the rows section 3b MOVED from 290's service:idea-engagement are put
--     back exactly as 290 wrote them (research_prompt_moves), then that table is dropped;
--   - admin_audit KEEPS the session.steer / session.cancel actions in its CHECK: the log is append-only
--     and may already hold such rows, which no revert removes.
-- Redeploy the pre-P4b openbrain-research and openbrain-workbench images with it: the P4b research image
-- writes actor_sub and research_cancels.
\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
    IF to_regclass('public.research_prompt_moves') IS NOT NULL THEN
        UPDATE public.research_prompts p SET owner_sub = m.prev_owner_sub, actor_sub = m.prev_actor_sub
          FROM public.research_prompt_moves m WHERE p.job_id = m.job_id;
        DELETE FROM public.research_prompts p
         WHERE p.actor_sub = 'system:idea-engagement'
           AND NOT EXISTS (SELECT 1 FROM public.research_prompt_moves m WHERE m.job_id = p.job_id);
    ELSE
        DELETE FROM public.research_prompts WHERE actor_sub = 'system:idea-engagement';
    END IF;
END $$;
DROP TABLE IF EXISTS public.research_prompt_moves;
DROP TRIGGER IF EXISTS trg_research_jobs_idea_owner ON public.research_jobs;
DROP FUNCTION IF EXISTS public.trg_research_jobs_idea_owner();

DROP TABLE IF EXISTS public.research_cancels;
DROP FUNCTION IF EXISTS public.research_cancels_append_only();

DROP INDEX IF EXISTS public.idx_research_steers_actor;
ALTER TABLE public.research_steers DROP CONSTRAINT IF EXISTS research_steers_actor_sub_check;
ALTER TABLE public.research_steers DROP COLUMN IF EXISTS actor_sub;

UPDATE public.contract_registry_entries
   SET retired_at = NULL
 WHERE registry = 'implementation_states' AND key = 'steer';

COMMIT;
