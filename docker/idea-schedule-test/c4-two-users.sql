\i helpers.sql
BEGIN;
-- clause 4: two users with different settings each get their own behaviour
DO $$ DECLARE a uuid; b uuid; c uuid; BEGIN
  PERFORM public.idea_schedule_set('u-a', 'u-a', 'immediate', NULL, NULL, 'UTC');
  PERFORM pg_temp.sched('u-b', 'daily', '09:00', NULL, 'UTC', '2026-03-07 00:00Z');
  PERFORM pg_temp.sched('u-c', 'daily', '21:00', NULL, 'UTC', '2026-03-07 00:00Z');
  a := pg_temp.mk_idea('u-a', 'a'); b := pg_temp.mk_idea('u-b', 'b'); c := pg_temp.mk_idea('u-c', 'c');
  PERFORM pg_temp.ok(pg_temp.jobs(a) = 1 AND pg_temp.jobs(b) = 0 AND pg_temp.jobs(c) = 0, 'A queued at once; B and C wait');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-07 09:00:00Z') = 1 AND pg_temp.jobs(b) = 1 AND pg_temp.jobs(c) = 0, 'at 09:00 only B runs');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-07 21:00:00Z') = 1 AND pg_temp.jobs(c) = 1 AND pg_temp.jobs(a) = 1, 'at 21:00 only C runs');
  PERFORM public.idea_schedule_set('u-b', 'u-b', 'weekly', '10:00', 2, 'Europe/Berlin');
  PERFORM pg_temp.ok((SELECT mode FROM public.idea_schedule WHERE owner_sub = 'u-a') = 'immediate'
                 AND (SELECT mode || at_time FROM public.idea_schedule WHERE owner_sub = 'u-c') = 'daily21:00:00', 'B change did not touch A or C');
  PERFORM pg_temp.ok(public.idea_schedule_next('u-a', now()) IS NULL, 'A has no next fire');
  PERFORM pg_temp.sched('u-d2', 'daily', '09:00', NULL, 'UTC', '2026-03-07 00:00Z');
  b := pg_temp.mk_idea('u-d2', 'waiting'); c := pg_temp.mk_idea('u-c', 'c waiting');
  PERFORM public.idea_schedule_set('u-d2', 'u-d2', 'immediate', NULL, NULL, 'UTC');
  PERFORM pg_temp.ok(pg_temp.jobs(b) = 1 AND pg_temp.jobs(c) = 0, 'switching to immediate flushes only that user ideas');
END $$;
ROLLBACK;
