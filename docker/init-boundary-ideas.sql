-- ============================================================
-- The idea path through the request boundary (research-workbench rw-boundary-ideas, plan 09 PD0b). Slot 580.
-- Operator 2026-11-04 ("PD0: approved", defaults D1-D12): an idea's research starts only from a de-personalised
-- question. The idea's text never reaches a shared row or the web; its report is shared knowledge; the dossier that
-- ties the report to the idea stays the owner's.
--
--   * research_idea_queue(idea, revision, summary) - REPLACED (slot 260): with the same per-idea advisory lock and the
--     same coalescing it upserts ONE pending private hand-back (research_handbacks, slot 420) instead of a job, and no
--     longer pastes the prior synthesis (the boundary forms the question from the current revision). Coalescing: a
--     change while a hand-back is pending folds into it (latest revision wins); a change while its derived job is still
--     QUEUED withdraws that job (cancelled, "superseded") and the hand-back pends again on the new revision - one queued
--     job per idea; a change while the job RUNS opens the one follow-up. A new revision supersedes the owner's open
--     review (awaiting_owner -> refused). Returns the hand-back's id. Its callers - the capture / update trigger
--     (trg_idea_revisions_engage, slot 300), idea_research_now and idea_research (research now: the workbench, the MCP
--     research_idea tool, the refinery's flag), idea_schedule_drain and idea_schedule_set (the owner's schedule) - are
--     replaced only where they read "already queued": a queued revision is now marked metadata.research_handback (the
--     job id is stamped later, by the drain).
--   * the research service DRAINS pending idea hand-backs through formDerivedRequest (boundary-ideas.ts) with:
--       idea_handback_item(id[, owner])  the idea as a service read (title, the revision's text, domain);
--       idea_handback_settle(...)        pending -> queued (a derived job; stamps ideas.last_job_id and
--                                        idea_revisions.research_job_id) | awaiting_owner (the owner's review data) |
--                                        refused - only while still pending on the SAME revision (an edit wins).
--   * the owner's review (D7): idea_handback_review(owner, idea) - the owner's latest idea hand-back and, waiting, the
--     refused candidate and its failing tokens; idea_handback_decide(owner, id, job, verdict) - an approved question's
--     derived job (formed by the research service, the identity deny list still enforced) or a 'personal' job;
--     idea_handback_run_private(owner, actor, id, question) - "run privately": a request_kind 'personal' job tied to the
--     idea (branch_kind idea + refinery_id, the legacy idea shape), so slot 390's rule keeps its report private to the
--     owner; its prompt row is the owner's (trg_research_jobs_idea_owner).
--   * the refinery's delivery: idea_handback_deliverables() - the finished jobs of queued idea hand-backs, with their
--     result (420's handback_delivered closes each).
--   * 420 reviewer R-F4: an idea hand-back is BOUND to the idea's owner (trg_research_handbacks_idea_owner: inlet idea
--     <=> purpose idea-research, the owner = ideas.owner_sub of that idea, on every insert and update) and KEYED with
--     it (uq_handback_idea_pending: one pending row per owner + idea). 420's uq_handback_open keeps its rule for every
--     other purpose (one open row per inlet); for ideas a queued row may coexist with the pending follow-up.
-- Grants: every function this file CREATES is EXECUTE for ob_app_memory only (the research service, the workbench and
-- the refinery connect as it; not PUBLIC, not service_role = PostgREST's anonymous role); the replaced functions keep
-- their slot-260/300/370 ACLs (CREATE OR REPLACE). ob_app_memory is created out of band: on a volume where it does not
-- exist yet, run this file again after creating it (idempotent; until then the new functions are executable by nobody).
-- Fresh-volume slot 580; live: psql -f AFTER 420 and BEFORE the new research / refinery / workbench images, a fresh
-- backup first. Revert: revert-boundary-ideas.sql (archives the idea hand-backs first; restores the replaced definitions
-- byte-identical from the copies saved here). Revert 580 before 420. One transaction; the lock wait is bounded.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── archive first: the definitions this file replaces, as the database holds them (once; a re-run keeps the copy) ──
CREATE TABLE IF NOT EXISTS public.research_boundary_ideas_saved (
    fn       TEXT PRIMARY KEY,
    def      TEXT NOT NULL,
    comment  TEXT,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_boundary_ideas_saved ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_boundary_ideas_saved FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.research_boundary_ideas_saved'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_boundary_ideas_saved FROM %I', r.grantee);
    END LOOP;
END $$;
INSERT INTO public.research_boundary_ideas_saved (fn, def, comment)
SELECT f, pg_get_functiondef(to_regprocedure(f)), obj_description(to_regprocedure(f), 'pg_proc')
  FROM unnest(ARRAY['public.research_idea_queue(uuid,integer,text)', 'public.trg_idea_revisions_engage()',
                    'public.idea_research_now(uuid)', 'public.idea_schedule_set(text,text,text,time,integer,text)',
                    'public.idea_schedule_drain(timestamptz)', 'public.idea_research(uuid,text,text)']) f
 WHERE to_regprocedure(f) IS NOT NULL
ON CONFLICT (fn) DO NOTHING;
INSERT INTO public.research_boundary_ideas_saved (fn, def)
SELECT 'index:uq_handback_open', pg_get_indexdef('public.uq_handback_open'::regclass)
 WHERE to_regclass('public.uq_handback_open') IS NOT NULL
ON CONFLICT (fn) DO NOTHING;

-- ── R-F4: an idea hand-back is keyed and bound to the idea's owner ───────
CREATE OR REPLACE FUNCTION public.trg_research_handbacks_idea_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.inlet_kind = 'idea' OR NEW.purpose = 'idea-research' THEN
        IF NEW.inlet_kind IS DISTINCT FROM 'idea' OR NEW.purpose IS DISTINCT FROM 'idea-research' THEN
            RAISE EXCEPTION 'research_handbacks: an idea hand-back is inlet idea with purpose idea-research' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.ideas i WHERE i.id::text = lower(NEW.inlet_id) AND i.owner_sub = NEW.owner_sub) THEN
            RAISE EXCEPTION 'research_handbacks: an idea hand-back belongs to its idea''s owner' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_research_handbacks_idea_owner ON public.research_handbacks;
CREATE TRIGGER trg_research_handbacks_idea_owner
    BEFORE INSERT OR UPDATE OF owner_sub, inlet_kind, inlet_id, purpose ON public.research_handbacks
    FOR EACH ROW EXECUTE FUNCTION public.trg_research_handbacks_idea_owner();

DROP INDEX IF EXISTS public.uq_handback_open;
CREATE UNIQUE INDEX uq_handback_open ON public.research_handbacks (inlet_kind, inlet_id, purpose)
    WHERE state IN ('pending', 'queued') AND purpose <> 'idea-research';
CREATE UNIQUE INDEX IF NOT EXISTS uq_handback_idea_pending ON public.research_handbacks (owner_sub, inlet_kind, inlet_id, purpose)
    WHERE state = 'pending' AND purpose = 'idea-research';

-- ── the queue: a pending hand-back, never a job ─────────────────────────
CREATE OR REPLACE FUNCTION public.research_idea_queue(p_idea_id UUID, p_revision INT, p_summary TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner TEXT;
    v_hb    UUID;
    r       RECORD;
BEGIN
    -- the same lock as before (slot 260): one idea's queue, edits and settles are serialised
    PERFORM pg_advisory_xact_lock(hashtext('research_idea:' || p_idea_id::text));
    SELECT owner_sub INTO v_owner FROM public.ideas WHERE id = p_idea_id;
    -- no owner, no research (the boundary refuses a request nobody owns)
    IF coalesce(btrim(v_owner), '') = '' OR v_owner ~* '^(service|system|anonymous):' THEN RETURN NULL; END IF;
    -- slot 470 (rw-inlet-stamp): a hand-back's owner passes inlet_subject_ok (never the literal 'operator') - an idea
    -- whose owner does not is not researched, rather than failing its capture / edit on that CHECK
    -- (nested: the inner call is planned only where 470 is applied)
    IF to_regprocedure('public.inlet_subject_ok(text)') IS NOT NULL THEN
        IF NOT public.inlet_subject_ok(v_owner) THEN RETURN NULL; END IF;
    END IF;
    -- a new revision supersedes the owner's open review of an older one
    UPDATE public.research_handbacks
       SET state = 'refused', owner_view = NULL, updated_at = now(),
           verdict = verdict || jsonb_build_object('superseded_by_revision', p_revision)
     WHERE inlet_kind = 'idea' AND inlet_id = p_idea_id::text AND purpose = 'idea-research' AND state = 'awaiting_owner';
    -- coalescing 1: the pending hand-back takes the new revision
    SELECT h.id INTO v_hb FROM public.research_handbacks h
     WHERE h.inlet_kind = 'idea' AND h.inlet_id = p_idea_id::text AND h.purpose = 'idea-research' AND h.state = 'pending'
       AND h.owner_sub = v_owner
     FOR UPDATE;
    IF v_hb IS NOT NULL THEN
        UPDATE public.research_handbacks SET inlet_revision = p_revision, updated_at = now() WHERE id = v_hb;
        RETURN v_hb;
    END IF;
    -- coalescing 2: a derived job that has not started is withdrawn; its hand-back pends again on the new revision
    FOR r IN SELECT h.id, h.job_id FROM public.research_handbacks h JOIN public.research_jobs j ON j.id = h.job_id
              WHERE h.inlet_kind = 'idea' AND h.inlet_id = p_idea_id::text AND h.purpose = 'idea-research' AND h.state = 'queued'
                AND j.status = 'queued' AND h.owner_sub = v_owner
              ORDER BY h.created_at
              FOR UPDATE OF h, j
    LOOP
        UPDATE public.research_jobs
           SET status = 'cancelled', finished_at = now(), error = 'cancelled: superseded by a newer revision of its request',
               progress = jsonb_build_object('phase', 'cancelled', 'code', 'superseded', 'message', 'superseded by a newer revision of its request')
         WHERE id = r.job_id AND status = 'queued';
        IF NOT FOUND THEN CONTINUE; END IF;
        IF v_hb IS NULL THEN
            UPDATE public.research_handbacks
               SET state = 'pending', job_id = NULL, inlet_revision = p_revision, updated_at = now(),
                   verdict = verdict || jsonb_build_object('refolded_from_revision', inlet_revision)
             WHERE id = r.id;
            v_hb := r.id;
        ELSE
            UPDATE public.research_handbacks SET state = 'failed', updated_at = now() WHERE id = r.id;
        END IF;
    END LOOP;
    IF v_hb IS NULL THEN
        -- nothing open (or the job runs: this is its one follow-up)
        INSERT INTO public.research_handbacks (owner_sub, inlet_kind, inlet_id, inlet_revision, purpose, state, deliver)
        VALUES (v_owner, 'idea', p_idea_id::text, p_revision, 'idea-research', 'pending', '{}'::jsonb)
        RETURNING id INTO v_hb;
    END IF;
    RETURN v_hb;
END;
$$;
COMMENT ON FUNCTION public.research_idea_queue(UUID, INT, TEXT) IS
    'rw-boundary-ideas (slot 580): an idea''s research is a PENDING private hand-back (same lock, same coalescing), formed into a de-personalised derived job by the research service''s drain; returns the hand-back id (p_summary is no longer read)';

-- the capture / update trigger (slot 300's, one change): a queued revision is marked with its hand-back
CREATE OR REPLACE FUNCTION public.trg_idea_revisions_engage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_mode TEXT;
    v_hb   UUID;
BEGIN
    IF NEW.research_job_id IS NULL AND NOT (coalesce(NEW.metadata, '{}'::jsonb) ? 'research_handback') THEN
        SELECT s.mode INTO v_mode FROM public.idea_schedule s
          JOIN public.ideas i ON i.owner_sub = s.owner_sub WHERE i.id = NEW.idea_id;
        IF v_mode IS NOT NULL AND v_mode <> 'immediate' THEN
            NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('deferred', true);
        ELSE
            v_hb := public.research_idea_queue(NEW.idea_id, NEW.revision, NEW.summary);
            IF v_hb IS NOT NULL THEN
                NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('research_handback', v_hb::text);
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- research now (slot 300's, one change): the current revision is marked with its hand-back
CREATE OR REPLACE FUNCTION public.idea_research_now(p_idea_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rev INT; v_sum TEXT; v_hb UUID;
BEGIN
    SELECT current_revision, summary INTO v_rev, v_sum FROM public.ideas
     WHERE id = p_idea_id AND status <> 'archived';
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_hb := public.research_idea_queue(p_idea_id, v_rev, v_sum);
    IF v_hb IS NULL THEN RETURN NULL; END IF;
    UPDATE public.idea_revisions SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('research_handback', v_hb::text)
     WHERE idea_id = p_idea_id AND revision = v_rev AND research_job_id IS NULL;
    UPDATE public.ideas SET metadata = metadata - 'research_now' WHERE id = p_idea_id;
    RETURN v_hb;
END;
$$;

-- the owner's schedule (slot 300's, one change each): "not yet queued" = no job AND no hand-back on the revision
CREATE OR REPLACE FUNCTION public.idea_schedule_set(
    p_owner TEXT, p_actor TEXT, p_mode TEXT, p_at TIME, p_weekday INT, p_tz TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN
        RAISE EXCEPTION 'unknown time zone %', p_tz USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.idea_schedule (owner_sub, actor_sub, mode, at_time, weekday, tz)
    VALUES (p_owner, p_actor, p_mode,
            CASE WHEN p_mode = 'immediate' THEN NULL ELSE p_at END,
            CASE WHEN p_mode = 'weekly' THEN p_weekday ELSE NULL END, p_tz)
    ON CONFLICT (owner_sub) DO UPDATE
       SET actor_sub = EXCLUDED.actor_sub, mode = EXCLUDED.mode, at_time = EXCLUDED.at_time,
           weekday = EXCLUDED.weekday, tz = EXCLUDED.tz, updated_at = now(), last_drained_at = now();
    IF p_mode = 'immediate' THEN
        FOR v_id IN
            SELECT i.id FROM public.ideas i
              JOIN public.idea_revisions r ON r.idea_id = i.id AND r.revision = i.current_revision
             WHERE i.owner_sub = p_owner AND i.status <> 'archived'
               AND r.research_job_id IS NULL AND r.metadata->>'deferred' = 'true'
               AND NOT (coalesce(r.metadata, '{}'::jsonb) ? 'research_handback')
        LOOP
            PERFORM public.idea_research_now(v_id);
        END LOOP;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.idea_schedule_drain(p_now TIMESTAMPTZ DEFAULT now())
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    s RECORD; v_fire TIMESTAMPTZ; v_id UUID; v_n INT := 0;
BEGIN
    FOR s IN SELECT * FROM public.idea_schedule WHERE mode <> 'immediate' FOR UPDATE SKIP LOCKED LOOP
        v_fire := public.idea_schedule_fire(s.mode, s.at_time, s.weekday, s.tz, p_now, -1);
        IF v_fire IS NULL OR v_fire <= s.last_drained_at THEN CONTINUE; END IF;
        FOR v_id IN
            SELECT i.id FROM public.ideas i
              JOIN public.idea_revisions r ON r.idea_id = i.id AND r.revision = i.current_revision
             WHERE i.owner_sub = s.owner_sub AND i.status <> 'archived'
               AND r.research_job_id IS NULL AND r.metadata->>'deferred' = 'true'
               AND NOT (coalesce(r.metadata, '{}'::jsonb) ? 'research_handback')
             ORDER BY i.created_at
        LOOP
            IF public.idea_research_now(v_id) IS NOT NULL THEN v_n := v_n + 1; END IF;
        END LOOP;
        UPDATE public.idea_schedule SET last_drained_at = GREATEST(last_drained_at, p_now) WHERE owner_sub = s.owner_sub;
    END LOOP;
    RETURN v_n;
END;
$$;

-- research now, owner-checked (slot 370's, one change): the answer names the queued REQUEST (the hand-back), not a job
CREATE OR REPLACE FUNCTION public.idea_research(p_idea UUID, p_owner TEXT, p_actor TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status TEXT; v_hb UUID;
BEGIN
    SELECT status INTO v_status FROM public.ideas WHERE id = p_idea AND owner_sub = p_owner AND coalesce(btrim(p_owner), '') <> '';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF v_status = 'archived' THEN RETURN jsonb_build_object('outcome', 'archived'); END IF;
    v_hb := public.idea_research_now(p_idea);
    IF v_hb IS NULL THEN RETURN jsonb_build_object('outcome', 'archived'); END IF;
    RETURN jsonb_build_object('outcome', 'queued', 'request_id', v_hb::text);
END;
$$;

-- ── the drain's reads and writes (the research service, boundary-ideas.ts) ──
-- the idea as the boundary reads it: a PENDING row for the drain (no owner given), or the owner's own row (the owner's
-- approval). `gone` = the idea was deleted or archived (the drain refuses it instead of re-reading it forever).
CREATE OR REPLACE FUNCTION public.idea_handback_item(p_id UUID, p_owner TEXT DEFAULT NULL)
RETURNS TABLE (id UUID, owner_sub TEXT, idea_id UUID, inlet_revision INT, state TEXT, title TEXT, summary TEXT, domain TEXT, gone BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT h.id, h.owner_sub, i.id, h.inlet_revision, h.state, i.title, coalesce(r.summary, i.summary), i.domain,
           (i.id IS NULL OR i.status = 'archived')
      FROM public.research_handbacks h
      LEFT JOIN public.ideas i ON i.id::text = h.inlet_id AND i.owner_sub = h.owner_sub
      LEFT JOIN public.idea_revisions r ON r.idea_id = i.id AND r.revision = h.inlet_revision
     WHERE h.id = p_id AND h.purpose = 'idea-research' AND h.inlet_kind = 'idea'
       AND ((p_owner IS NULL AND h.state = 'pending')
            OR (btrim(coalesce(p_owner, '')) <> '' AND h.owner_sub = p_owner AND i.id IS NOT NULL));
$$;

-- the stamp (internal: called by the functions below only) - the idea's current job and the revision's research
CREATE OR REPLACE FUNCTION public.idea_handback_stamp(p_idea UUID, p_revision INT, p_job UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.ideas SET last_job_id = p_job::text WHERE id = p_idea;
    UPDATE public.idea_revisions SET research_job_id = p_job::text
     WHERE idea_id = p_idea AND revision = p_revision AND research_job_id IS NULL;
END;
$$;

-- the drain's outcome for one pending row: queued (its derived job, stamped on the idea), awaiting_owner (the owner's
-- review data) or refused. Only while the row is still PENDING on the revision the question was formed from (under the
-- idea's lock): false = an edit came first, the caller rolls its job back and forms again.
CREATE OR REPLACE FUNCTION public.idea_handback_settle(
    p_id UUID, p_revision INT, p_job UUID, p_state TEXT, p_verdict JSONB, p_owner_view JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_idea TEXT; v RECORD;
BEGIN
    IF p_state NOT IN ('queued', 'awaiting_owner', 'refused') OR (p_state = 'queued') <> (p_job IS NOT NULL) THEN
        RAISE EXCEPTION 'idea_handback_settle: queued names its derived job; awaiting_owner / refused name none' USING ERRCODE = '22023';
    END IF;
    SELECT h.inlet_id INTO v_idea FROM public.research_handbacks h WHERE h.id = p_id AND h.purpose = 'idea-research';
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('research_idea:' || v_idea));
    SELECT h.* INTO v FROM public.research_handbacks h WHERE h.id = p_id FOR UPDATE;
    IF v.state <> 'pending' OR v.inlet_revision IS DISTINCT FROM p_revision THEN RETURN false; END IF;
    IF p_job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.research_jobs j WHERE j.id = p_job AND j.request_kind = 'derived' AND j.status = 'queued') THEN
        RAISE EXCEPTION 'idea_handback_settle: the drain queues a derived job only' USING ERRCODE = '22023';
    END IF;
    UPDATE public.research_handbacks
       SET state = p_state, job_id = p_job, verdict = coalesce(p_verdict, verdict), updated_at = now(),
           owner_view = CASE WHEN p_state = 'awaiting_owner' THEN p_owner_view END
     WHERE id = p_id;
    IF p_job IS NOT NULL THEN PERFORM public.idea_handback_stamp(v_idea::uuid, v.inlet_revision, p_job); END IF;
    RETURN true;
END;
$$;

-- ── the owner's review (D7) ─────────────────────────────────────────────
-- the owner's latest idea hand-back for one idea: its state and, while it waits for them, the refused candidate and
-- its failing tokens. Another user's idea (or none) answers no row.
CREATE OR REPLACE FUNCTION public.idea_handback_review(p_owner TEXT, p_idea UUID)
RETURNS TABLE (handback_id UUID, revision INT, state TEXT, refusal TEXT, candidate TEXT, failing JSONB, code TEXT,
               job_id UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT h.id, h.inlet_revision, h.state, h.verdict ->> 'refusal', h.owner_view ->> 'candidate',
           coalesce(h.owner_view -> 'failing', '[]'::jsonb), h.owner_view ->> 'code', h.job_id, h.created_at, h.updated_at
      FROM public.research_handbacks h JOIN public.ideas i ON i.id::text = h.inlet_id AND i.owner_sub = h.owner_sub
     WHERE btrim(coalesce(p_owner, '')) <> '' AND h.owner_sub = p_owner AND i.id = p_idea
       AND h.purpose = 'idea-research' AND h.inlet_kind = 'idea'
     ORDER BY h.updated_at DESC, h.created_at DESC LIMIT 1;
$$;

-- the owner's decision on a review that waits for them: its job - a DERIVED job (the research service formed it from
-- the owner's approved question, the identity deny list enforced) or the 'personal' job of idea_handback_run_private.
CREATE OR REPLACE FUNCTION public.idea_handback_decide(p_owner TEXT, p_id UUID, p_job UUID, p_verdict JSONB DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_idea TEXT; v_kind TEXT; v RECORD;
BEGIN
    IF btrim(coalesce(p_owner, '')) = '' OR p_job IS NULL THEN RETURN false; END IF;
    SELECT h.inlet_id INTO v_idea FROM public.research_handbacks h
     WHERE h.id = p_id AND h.purpose = 'idea-research' AND h.owner_sub = p_owner;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('research_idea:' || v_idea));
    SELECT h.* INTO v FROM public.research_handbacks h
      JOIN public.ideas i ON i.id::text = h.inlet_id AND i.owner_sub = h.owner_sub AND i.status <> 'archived'
     WHERE h.id = p_id AND h.owner_sub = p_owner AND h.state = 'awaiting_owner'
     FOR UPDATE OF h;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT j.request_kind INTO v_kind FROM public.research_jobs j
     WHERE j.id = p_job AND j.status = 'queued'
       AND (j.request_kind = 'derived' OR (j.request_kind = 'personal' AND j.refinery_id::text = v_idea));
    IF v_kind IS NULL THEN
        RAISE EXCEPTION 'idea_handback_decide: an owner''s decision names a queued derived job, or the idea''s own personal job' USING ERRCODE = '22023';
    END IF;
    UPDATE public.research_handbacks
       SET state = 'queued', job_id = p_job, owner_view = NULL, updated_at = now(),
           verdict = verdict || coalesce(p_verdict, '{}'::jsonb) || jsonb_build_object('decided_by', 'owner', 'run', CASE WHEN v_kind = 'derived' THEN 'derived' ELSE 'private' END)
     WHERE id = p_id;
    PERFORM public.idea_handback_stamp(v_idea::uuid, v.inlet_revision, p_job);
    RETURN true;
END;
$$;

-- "run privately" (D7): the owner's own question, researched as a request_kind 'personal' job tied to the idea (the
-- legacy idea shape: branch_kind idea, refinery_id, inlet_ref) - slot 390's rule keeps its report private to the owner,
-- trg_research_jobs_idea_owner gives its prompt to the owner. NULL = not the owner's review, or it no longer waits.
CREATE OR REPLACE FUNCTION public.idea_handback_run_private(p_owner TEXT, p_actor TEXT, p_id UUID, p_question TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_q TEXT := btrim(coalesce(p_question, '')); v_idea UUID; v_job UUID;
BEGIN
    IF length(v_q) < 3 OR length(v_q) > 2000 THEN RAISE EXCEPTION 'a question is 3 to 2000 characters' USING ERRCODE = '22023'; END IF;
    SELECT i.id INTO v_idea FROM public.research_handbacks h
      JOIN public.ideas i ON i.id::text = h.inlet_id AND i.owner_sub = h.owner_sub AND i.status <> 'archived'
     WHERE h.id = p_id AND h.purpose = 'idea-research' AND h.state = 'awaiting_owner' AND btrim(coalesce(p_owner, '')) <> '' AND h.owner_sub = p_owner;
    IF v_idea IS NULL THEN RETURN NULL; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('research_idea:' || v_idea::text));
    INSERT INTO public.research_jobs (status, origin, caller, query, anchor, branch_kind, refinery_id, inlet_ref, options, request_kind)
    VALUES ('queued', 'mattermost', 'idea-engagement', v_q, v_q, 'idea', v_idea,
            jsonb_build_object('kind', 'idea', 'id', v_idea::text), jsonb_build_object('lane', 'research-branch'), 'personal')
    RETURNING id INTO v_job;
    IF NOT public.idea_handback_decide(p_owner, p_id, v_job, jsonb_build_object('actor_sub', coalesce(p_actor, p_owner))) THEN
        RAISE EXCEPTION 'idea_handback_run_private: the review no longer waits for its owner' USING ERRCODE = '40001';
    END IF;
    RETURN v_job;
END;
$$;

-- ── the refinery's delivery: the finished jobs of queued idea hand-backs (420's handback_delivered closes each) ──
CREATE OR REPLACE FUNCTION public.idea_handback_deliverables(p_limit INT DEFAULT 50)
RETURNS TABLE (id UUID, idea_id UUID, job_id UUID, job_status TEXT, result JSONB, error TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT h.id, h.inlet_id::uuid, h.job_id, j.status, j.result, j.error
      FROM public.research_handbacks h JOIN public.research_jobs j ON j.id = h.job_id
     WHERE h.purpose = 'idea-research' AND h.inlet_kind = 'idea' AND h.state = 'queued' AND j.status IN ('done', 'error', 'cancelled')
     ORDER BY j.finished_at NULLS LAST, h.created_at LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
$$;

-- ── grants: the functions this file creates are ob_app_memory's alone (420's pattern) ──
DO $$
DECLARE
    f TEXT;
    r RECORD;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.trg_research_handbacks_idea_owner()', 'public.idea_handback_stamp(uuid,integer,uuid)',
        'public.idea_handback_item(uuid,text)', 'public.idea_handback_settle(uuid,integer,uuid,text,jsonb,jsonb)',
        'public.idea_handback_review(text,uuid)', 'public.idea_handback_decide(text,uuid,uuid,jsonb)',
        'public.idea_handback_run_private(text,text,uuid,text)', 'public.idea_handback_deliverables(integer)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        FOR r IN SELECT DISTINCT ro.rolname FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE p.oid = to_regprocedure(f) AND NOT ro.rolsuper AND ro.oid <> p.proowner
        LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.rolname);
        END LOOP;
        IF f NOT IN ('public.trg_research_handbacks_idea_owner()', 'public.idea_handback_stamp(uuid,integer,uuid)')
           AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ob_app_memory', f);
        END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        RAISE NOTICE 'rw-boundary-ideas: ob_app_memory does not exist yet - the idea_handback_* functions are executable by nobody until this file runs again after it is created';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
