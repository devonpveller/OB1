-- rw-idea-schedule lab helpers (session-local). Each case file \i's this, runs in one transaction,
-- raises on a failed check and rolls back.
CREATE FUNCTION pg_temp.ok(c boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF c IS NOT TRUE THEN RAISE EXCEPTION 'CHECK FAILED: %', msg; END IF; END; $$;
CREATE FUNCTION pg_temp.mk_idea(o text, ttl text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  INSERT INTO public.ideas (title, summary, owner_sub, actor_sub) VALUES (ttl, ttl, o, 'lab') RETURNING id INTO v;
  INSERT INTO public.idea_revisions (idea_id, revision, summary) VALUES (v, 1, ttl);
  RETURN v;
END; $$;
CREATE FUNCTION pg_temp.edit(v uuid, txt text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r int;
BEGIN
  UPDATE public.ideas SET current_revision = current_revision + 1, summary = txt, status = 'dirty' WHERE id = v RETURNING current_revision INTO r;
  INSERT INTO public.idea_revisions (idea_id, revision, summary) VALUES (v, r, txt);
  RETURN r;
END; $$;
CREATE FUNCTION pg_temp.jobs(v uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.research_jobs WHERE refinery_id = v AND branch_kind = 'idea' $$;
CREATE FUNCTION pg_temp.stamped(v uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT r.research_job_id IS NOT NULL FROM public.idea_revisions r JOIN public.ideas i ON i.id = r.idea_id AND r.revision = i.current_revision WHERE i.id = v $$;
CREATE FUNCTION pg_temp.sched(o text, m text, t time, wd int, tz text, since timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.idea_schedule_set(o, o, m, t, wd, tz);
  UPDATE public.idea_schedule SET last_drained_at = since WHERE owner_sub = o;
END; $$;
