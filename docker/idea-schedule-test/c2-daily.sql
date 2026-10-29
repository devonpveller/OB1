\i helpers.sql
BEGIN;
-- clause 2 (daily): listed at once, queued only at the next local 09:00; DST edge in New York
DO $$ DECLARE a uuid; b uuid; c uuid; n int; BEGIN
  PERFORM pg_temp.sched('u-ny', 'daily', '09:00', NULL, 'America/New_York', '2026-03-07 00:00Z');
  a := pg_temp.mk_idea('u-ny', 'ny idea');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.ideas WHERE id = a), 'the idea is listed at once');
  PERFORM pg_temp.ok(pg_temp.jobs(a) = 0 AND NOT pg_temp.stamped(a), 'not queued at capture');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-07 13:59:59Z') = 0 AND pg_temp.jobs(a) = 0, 'not queued one second before 09:00 EST (14:00Z)');
  n := public.idea_schedule_drain('2026-03-07 14:00:00Z');
  PERFORM pg_temp.ok(n = 1 AND pg_temp.jobs(a) = 1, 'queued at 09:00 EST');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-07 14:30:00Z') = 0 AND pg_temp.jobs(a) = 1, 'never queued twice for one fire');
  -- spring forward 2026-03-08: 09:00 is now EDT = 13:00Z, not 14:00Z
  b := pg_temp.mk_idea('u-ny', 'ny idea 2');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-08 12:59:59Z') = 0 AND pg_temp.jobs(b) = 0, 'DST: not queued at 12:59:59Z');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-08 13:00:00Z') = 1 AND pg_temp.jobs(b) = 1, 'DST: queued at 13:00Z (09:00 EDT)');
  PERFORM pg_temp.ok(public.idea_schedule_next('u-ny', '2026-03-08 13:00:00Z') = '2026-03-09 13:00:00Z', 'next fire after the DST day');
  -- a wall time inside the spring-forward gap (02:30 does not exist on 2026-03-08) is not skipped
  PERFORM pg_temp.sched('u-gap', 'daily', '02:30', NULL, 'America/New_York', '2026-03-08 00:00Z');
  c := pg_temp.mk_idea('u-gap', 'gap idea');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-08 06:59:00Z') = 0, 'gap: not before the resolved instant');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-08 07:30:00Z') = 1 AND pg_temp.jobs(c) = 1, 'gap: still fires that day');
END $$;
ROLLBACK;
