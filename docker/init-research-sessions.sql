-- ============================================================
-- Running sessions (research-workbench P4b, rw-p4b-sessions). Slot 320.
--   1. research_steers.actor_sub: WHO opened each branch (07-MULTI-USER: a steer is recorded with
--      actor_sub). A human steer records the actor the request named - the workspace's signed-in
--      user (or the admin, while impersonating), the OWUI user, or the calling service
--      (service:<caller>); a system-opened gap / inter-hub branch records system:research. NOT NULL:
--      an unrecorded actor is refused by the database, not only by the service.
--      Back-fill for steers made before this slot: a human steer its caller's service identity
--      (service:<caller>, or system:unrecorded when no caller was stored), a gap / inter-hub steer
--      system:research.
--   2. implementation_states.steer: retired - steer(sessionId, ...) has its backing (P4b wires the
--      workbench's contract call to the P4a door), so it no longer answers not_implemented.
--   3. an idea's research job gets its idea owner's research_prompts row (see section 3 below).
-- Additive and idempotent; no table is dropped, no row deleted. Fresh-volume slot 320; live: psql -f
-- WITH the new openbrain-research image (it writes actor_sub; the pre-P4b image would be refused by
-- the NOT NULL). Revert: revert-research-sessions.sql.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE public.research_steers ADD COLUMN IF NOT EXISTS actor_sub TEXT;
UPDATE public.research_steers
   SET actor_sub = CASE WHEN steer_kind = 'human' THEN coalesce('service:' || nullif(btrim(caller), ''), 'system:unrecorded')
                        ELSE 'system:research' END
 WHERE actor_sub IS NULL;
ALTER TABLE public.research_steers ALTER COLUMN actor_sub SET NOT NULL;
ALTER TABLE public.research_steers DROP CONSTRAINT IF EXISTS research_steers_actor_sub_check;
ALTER TABLE public.research_steers ADD CONSTRAINT research_steers_actor_sub_check CHECK (btrim(actor_sub) <> '');
CREATE INDEX IF NOT EXISTS idx_research_steers_actor ON public.research_steers (actor_sub, created_at);

UPDATE public.contract_registry_entries
   SET retired_at = coalesce(retired_at, now())
 WHERE registry = 'implementation_states' AND key = 'steer';

-- 3. An idea's session is its idea's owner's (07-MULTI-USER: ideas are private, and the text an idea
--    engages research with is the user's). research_idea_queue() (P4a, slot 260) inserts the idea's
--    job without a research_prompts row, so the job read as ownerless - the default subject's - and the
--    idea's own owner saw neither its inlet reference nor its link, and could not steer it. The job
--    now gets the idea owner's row as it is created (owner = ideas.owner_sub, actor
--    system:idea-engagement, prompt = the query it was queued with). An idea with no owner (before
--    P2b) is left as it was. Back-fill: open or finished idea jobs that still have no row.
CREATE OR REPLACE FUNCTION public.trg_research_jobs_idea_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_owner TEXT;
BEGIN
    IF NEW.branch_kind = 'idea' AND NEW.refinery_id IS NOT NULL AND NEW.parent_job_id IS NULL THEN
        SELECT owner_sub INTO v_owner FROM public.ideas WHERE id = NEW.refinery_id;
        IF v_owner IS NOT NULL AND btrim(v_owner) <> '' THEN
            INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt)
            VALUES (NEW.id, v_owner, 'system:idea-engagement', NEW.query)
            ON CONFLICT (job_id) DO NOTHING;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_research_jobs_idea_owner ON public.research_jobs;
CREATE TRIGGER trg_research_jobs_idea_owner AFTER INSERT ON public.research_jobs
    FOR EACH ROW EXECUTE FUNCTION public.trg_research_jobs_idea_owner();

INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt)
SELECT j.id, i.owner_sub, 'system:idea-engagement', j.query
  FROM public.research_jobs j JOIN public.ideas i ON i.id = j.refinery_id
 WHERE j.branch_kind = 'idea' AND j.parent_job_id IS NULL AND i.owner_sub IS NOT NULL AND btrim(i.owner_sub) <> ''
   AND NOT EXISTS (SELECT 1 FROM public.research_prompts p WHERE p.job_id = j.id)
ON CONFLICT (job_id) DO NOTHING;

COMMIT;
