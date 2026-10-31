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
--   3. an idea's research job gets its idea owner's research_prompts row (see section 3 below), and
--      (round 2) idea jobs 290 back-filled to service:idea-engagement move to their idea's owner.
--   4. research_cancels: every cancel with its actor (append-only).
--   5. admin_audit accepts session.steer / session.cancel (an admin acting on a service's job).
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

-- 3b (round 2, tester T-M3): idea jobs that 290's back-fill already gave to `service:idea-engagement`
--    (origin mattermost, caller idea-engagement: init-identity.sql's agent rule) move to their idea's
--    owner too. What each moved row was is kept in research_prompt_moves, so the revert can put back
--    exactly what 290 wrote (a re-apply moves it again; a row is recorded once).
CREATE TABLE IF NOT EXISTS public.research_prompt_moves (
    job_id         UUID PRIMARY KEY REFERENCES public.research_jobs(id) ON DELETE CASCADE,
    prev_owner_sub TEXT NOT NULL,
    prev_actor_sub TEXT NOT NULL,
    moved_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.research_prompt_moves (job_id, prev_owner_sub, prev_actor_sub)
SELECT p.job_id, p.owner_sub, p.actor_sub
  FROM public.research_prompts p JOIN public.research_jobs j ON j.id = p.job_id JOIN public.ideas i ON i.id = j.refinery_id
 WHERE j.branch_kind = 'idea' AND j.parent_job_id IS NULL AND p.owner_sub = 'service:idea-engagement'
   AND i.owner_sub IS NOT NULL AND btrim(i.owner_sub) <> '' AND i.owner_sub <> p.owner_sub
ON CONFLICT (job_id) DO NOTHING;
UPDATE public.research_prompts p
   SET owner_sub = i.owner_sub, actor_sub = 'system:idea-engagement'
  FROM public.research_jobs j JOIN public.ideas i ON i.id = j.refinery_id
 WHERE p.job_id = j.id AND j.branch_kind = 'idea' AND j.parent_job_id IS NULL AND p.owner_sub = 'service:idea-engagement'
   AND i.owner_sub IS NOT NULL AND btrim(i.owner_sub) <> '' AND i.owner_sub <> p.owner_sub;

-- 4 (round 2, tester F-cancel-actor-recorded): every cancel is recorded with its actor, as a steer is
--    (research_cancels: APPEND-ONLY - a trigger refuses UPDATE, DELETE and TRUNCATE for every role).
CREATE TABLE IF NOT EXISTS public.research_cancels (
    id         BIGSERIAL PRIMARY KEY,
    job_id     UUID NOT NULL REFERENCES public.research_jobs(id),
    actor_sub  TEXT NOT NULL CHECK (btrim(actor_sub) <> ''),
    caller     TEXT,
    reason     TEXT,
    outcome    TEXT NOT NULL CHECK (outcome IN ('cancelled', 'cancelling', 'already_terminal', 'refused_filing')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_research_cancels_job   ON public.research_cancels (job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_research_cancels_actor ON public.research_cancels (actor_sub, created_at);
CREATE OR REPLACE FUNCTION public.research_cancels_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'research_cancels is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS trg_research_cancels_append_only ON public.research_cancels;
CREATE TRIGGER trg_research_cancels_append_only BEFORE UPDATE OR DELETE ON public.research_cancels
    FOR EACH ROW EXECUTE FUNCTION public.research_cancels_append_only();
DROP TRIGGER IF EXISTS trg_research_cancels_no_truncate ON public.research_cancels;
CREATE TRIGGER trg_research_cancels_no_truncate BEFORE TRUNCATE ON public.research_cancels
    FOR EACH STATEMENT EXECUTE FUNCTION public.research_cancels_append_only();
ALTER TABLE public.research_cancels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_cancels_service_role_all ON public.research_cancels;
CREATE POLICY research_cancels_service_role_all ON public.research_cancels FOR ALL TO service_role USING (true) WITH CHECK (true);
-- round 3 (tester t-p4b-sessions2): as admin_audit - the grants close the writes too, not only the trigger
-- (default privileges may hand service_role UPDATE / DELETE / TRUNCATE on a new table)
REVOKE ALL ON public.research_cancels FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.research_cancels FROM service_role;
GRANT SELECT, INSERT ON public.research_cancels TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.research_cancels_id_seq TO service_role;
ALTER TABLE public.research_prompt_moves ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_prompt_moves_service_role_all ON public.research_prompt_moves;
CREATE POLICY research_prompt_moves_service_role_all ON public.research_prompt_moves FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.research_prompt_moves FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.research_prompt_moves FROM service_role;
GRANT SELECT ON public.research_prompt_moves TO service_role;

-- 5 (round 2, 07-MULTI-USER "every admin action goes to an append-only audit log"): an admin's steer or
--    cancel of a service's job is an admin_audit row (the workbench writes it before it acts).
ALTER TABLE public.admin_audit DROP CONSTRAINT IF EXISTS admin_audit_action_check;
ALTER TABLE public.admin_audit ADD CONSTRAINT admin_audit_action_check CHECK (action IN (
    'impersonate.start', 'impersonate.end', 'impersonate.refused', 'request', 'users.read', 'audit.read',
    'session.steer', 'session.cancel'));

COMMIT;
