-- ============================================================
-- Idea research schedule (research-workbench rw-idea-schedule). Slot 300.
-- Each user chooses WHEN research on their ideas starts: immediate (the P4a behaviour, the default
-- for a user with no row), daily at a time, or weekly on a day and time, in their time zone.
--   * idea_schedule: one row per owner (owner_sub = the identity seam subject). Service-role only;
--     the workbench reads and writes it filtered by the caller's subject, never another's.
--   * trg_idea_revisions_engage (replaced): an idea of a user in a scheduled mode is still captured
--     and listed at once, but its revision is stamped metadata.deferred=true and NOT queued.
--   * idea_schedule_drain(now): queues, once per fire time, each scheduled owner's deferred ideas on
--     their CURRENT revision only, so any number of edits during the wait is one run.
--   * idea_research_now(idea): queues at once in every mode (and stamps the revision, so the
--     scheduled drain does not queue it a second time).
-- Additive and idempotent; no table is dropped. Fresh-volume slot 300; live: psql -f. Revert:
-- revert-idea-schedule.sql. Weekday is ISO (1 = Monday .. 7 = Sunday).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.idea_schedule (
    owner_sub       TEXT PRIMARY KEY,
    actor_sub       TEXT NOT NULL DEFAULT 'system:outside-seam',
    mode            TEXT NOT NULL DEFAULT 'immediate' CHECK (mode IN ('immediate', 'daily', 'weekly')),
    at_time         TIME,
    weekday         INT CHECK (weekday BETWEEN 1 AND 7),
    tz              TEXT NOT NULL DEFAULT 'UTC',
    last_drained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT idea_schedule_shape CHECK (
        (mode = 'immediate') OR
        (mode = 'daily'  AND at_time IS NOT NULL AND weekday IS NULL) OR
        (mode = 'weekly' AND at_time IS NOT NULL AND weekday IS NOT NULL))
);
ALTER TABLE public.idea_schedule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idea_schedule_service_role_all ON public.idea_schedule;
CREATE POLICY idea_schedule_service_role_all ON public.idea_schedule
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.idea_schedule TO service_role;

-- The scheduled instant nearest to p_now: p_dir = -1 the latest <= p_now, +1 the earliest > p_now.
-- Local wall-clock arithmetic in the user's zone; a time that does not exist (spring-forward gap)
-- lands on the instant Postgres resolves it to, so the fire is never skipped.
CREATE OR REPLACE FUNCTION public.idea_schedule_fire(
    p_mode TEXT, p_at TIME, p_weekday INT, p_tz TEXT, p_now TIMESTAMPTZ, p_dir INT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_day  DATE := (p_now AT TIME ZONE p_tz)::date;
    v_k    INT;
    v_d    DATE;
    v_inst TIMESTAMPTZ;
BEGIN
    IF p_mode NOT IN ('daily', 'weekly') THEN RETURN NULL; END IF;
    FOR v_k IN 0..9 LOOP
        v_d := v_day + (p_dir * v_k);
        IF p_mode = 'weekly' AND extract(isodow FROM v_d)::int <> p_weekday THEN CONTINUE; END IF;
        v_inst := (v_d + p_at) AT TIME ZONE p_tz;
        IF p_dir < 0 AND v_inst <= p_now THEN RETURN v_inst; END IF;
        IF p_dir > 0 AND v_inst >  p_now THEN RETURN v_inst; END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

-- The owner's next scheduled start after p_now (NULL = immediate / no schedule).
CREATE OR REPLACE FUNCTION public.idea_schedule_next(p_owner TEXT, p_now TIMESTAMPTZ DEFAULT now())
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT public.idea_schedule_fire(s.mode, s.at_time, s.weekday, s.tz, p_now, 1)
      FROM public.idea_schedule s WHERE s.owner_sub = p_owner;
$$;

-- Queue one idea now (coalescing as research_idea_queue) and stamp its CURRENT revision.
CREATE OR REPLACE FUNCTION public.idea_research_now(p_idea_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rev INT; v_sum TEXT; v_job UUID;
BEGIN
    SELECT current_revision, summary INTO v_rev, v_sum FROM public.ideas
     WHERE id = p_idea_id AND status <> 'archived';
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_job := public.research_idea_queue(p_idea_id, v_rev, v_sum);
    UPDATE public.idea_revisions SET research_job_id = v_job::text
     WHERE idea_id = p_idea_id AND revision = v_rev AND research_job_id IS NULL;
    UPDATE public.ideas SET metadata = metadata - 'research_now' WHERE id = p_idea_id;
    RETURN v_job;
END;
$$;

-- Set an owner's schedule. Validates the zone; returning to immediate flushes the deferred ideas.
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
        LOOP
            PERFORM public.idea_research_now(v_id);
        END LOOP;
    END IF;
END;
$$;

-- The scheduler pass (the refinery's poll calls it; p_now is the fake clock in tests). For each
-- scheduled owner whose latest fire time has passed since their last drain, queue each deferred idea
-- once on its current revision. Returns the number of ideas queued.
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
             ORDER BY i.created_at
        LOOP
            IF public.idea_research_now(v_id) IS NOT NULL THEN v_n := v_n + 1; END IF;
        END LOOP;
        UPDATE public.idea_schedule SET last_drained_at = GREATEST(last_drained_at, p_now) WHERE owner_sub = s.owner_sub;
    END LOOP;
    RETURN v_n;
END;
$$;

-- The capture trigger: queue at once unless the idea's owner chose a schedule, then mark the
-- revision deferred (the panel lists the idea either way).
CREATE OR REPLACE FUNCTION public.trg_idea_revisions_engage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_mode TEXT;
BEGIN
    IF NEW.research_job_id IS NULL THEN
        SELECT s.mode INTO v_mode FROM public.idea_schedule s
          JOIN public.ideas i ON i.owner_sub = s.owner_sub WHERE i.id = NEW.idea_id;
        IF v_mode IS NOT NULL AND v_mode <> 'immediate' THEN
            NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('deferred', true);
        ELSE
            NEW.research_job_id := public.research_idea_queue(NEW.idea_id, NEW.revision, NEW.summary)::text;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.idea_schedule_fire(TEXT, TIME, INT, TEXT, TIMESTAMPTZ, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_schedule_next(TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_research_now(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_schedule_set(TEXT, TEXT, TEXT, TIME, INT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_schedule_drain(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.idea_schedule_fire(TEXT, TIME, INT, TEXT, TIMESTAMPTZ, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_schedule_next(TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_research_now(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_schedule_set(TEXT, TEXT, TEXT, TIME, INT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.idea_schedule_drain(TIMESTAMPTZ) TO service_role;
NOTIFY pgrst, 'reload schema';
