\i helpers.sql
BEGIN;
-- clause 2 (weekly): Wednesday 18:00 in Asia/Kolkata (UTC+5:30); 2026-03-07 is a Saturday
DO $$ DECLARE a uuid; BEGIN
  PERFORM pg_temp.sched('u-in', 'weekly', '18:00', 3, 'Asia/Kolkata', '2026-03-07 00:00Z');
  a := pg_temp.mk_idea('u-in', 'kolkata idea');
  PERFORM pg_temp.ok(pg_temp.jobs(a) = 0, 'weekly: not queued at capture');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-10 23:59:00Z') = 0 AND pg_temp.jobs(a) = 0, 'weekly: not on Tuesday');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-11 12:29:59Z') = 0 AND pg_temp.jobs(a) = 0, 'weekly: not one second before Wed 18:00 IST');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-11 12:30:00Z') = 1 AND pg_temp.jobs(a) = 1, 'weekly: queued Wed 18:00 IST');
  PERFORM pg_temp.ok(public.idea_schedule_next('u-in', '2026-03-11 12:30:00Z') = '2026-03-18 12:30:00Z', 'weekly: next fire is a week later');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-12 12:30:00Z') = 0, 'weekly: nothing on Thursday');
END $$;
ROLLBACK;
