\i helpers.sql
BEGIN;
-- clause 3: research now queues at once in every mode and is not queued a second time by the schedule
DO $$ DECLARE a uuid; b uuid; c uuid; d uuid; BEGIN
  PERFORM pg_temp.sched('u-d', 'daily', '09:00', NULL, 'UTC', '2026-03-07 00:00Z');
  PERFORM pg_temp.sched('u-w', 'weekly', '09:00', 1, 'UTC', '2026-03-07 00:00Z');
  a := pg_temp.mk_idea('u-d', 'daily idea'); b := pg_temp.mk_idea('u-w', 'weekly idea');
  c := pg_temp.mk_idea('u-i', 'immediate idea');
  PERFORM pg_temp.ok(pg_temp.jobs(a) = 0 AND pg_temp.jobs(b) = 0, 'deferred before research now');
  PERFORM pg_temp.ok(public.idea_research_now(a) IS NOT NULL AND pg_temp.jobs(a) = 1 AND pg_temp.stamped(a), 'daily: research now queues at once');
  PERFORM pg_temp.ok(public.idea_research_now(b) IS NOT NULL AND pg_temp.jobs(b) = 1, 'weekly: research now queues at once');
  PERFORM pg_temp.ok(public.idea_research_now(c) IS NOT NULL AND pg_temp.jobs(c) = 1, 'immediate: research now works');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-09 09:00:00Z') = 0 AND pg_temp.jobs(a) = 1 AND pg_temp.jobs(b) = 1, 'the schedule does not queue it again');
  PERFORM pg_temp.edit(a, 'daily idea v2');
  PERFORM pg_temp.ok(NOT pg_temp.stamped(a), 'an edit after research now is deferred again');
  d := pg_temp.mk_idea('u-d', 'flagged');
  UPDATE public.ideas SET metadata = metadata || '{"research_now": true}' WHERE id = d;
  PERFORM pg_temp.ok(public.idea_research_now(d) IS NOT NULL, 'flagged idea queued');
  PERFORM pg_temp.ok(NOT (SELECT metadata ? 'research_now' FROM public.ideas WHERE id = d), 'flag cleared by research now');
END $$;
ROLLBACK;
