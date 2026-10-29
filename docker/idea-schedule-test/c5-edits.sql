\i helpers.sql
BEGIN;
-- clause 5: edits during a scheduled wait queue exactly one run, on the latest revision
DO $$ DECLARE a uuid; r int; BEGIN
  PERFORM pg_temp.sched('u-e', 'daily', '09:00', NULL, 'UTC', '2026-03-07 00:00Z');
  a := pg_temp.mk_idea('u-e', 'v1');
  PERFORM pg_temp.edit(a, 'v2'); PERFORM pg_temp.edit(a, 'v3'); r := pg_temp.edit(a, 'v4');
  PERFORM pg_temp.ok(pg_temp.jobs(a) = 0, 'no run per edit during the wait');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-07 09:00:00Z') = 1, 'one idea queued at the fire');
  PERFORM pg_temp.ok(pg_temp.jobs(a) = 1, 'exactly one run');
  PERFORM pg_temp.ok((SELECT query FROM public.research_jobs WHERE refinery_id = a AND branch_kind = 'idea') LIKE '%v4%', 'the run is on the latest text');
  PERFORM pg_temp.ok((SELECT (options->>'idea_revision')::int FROM public.research_jobs WHERE refinery_id = a AND branch_kind = 'idea') = r, 'the run targets the latest revision');
  PERFORM pg_temp.ok(public.idea_schedule_drain('2026-03-08 09:00:00Z') = 0 AND pg_temp.jobs(a) = 1, 'the next fire adds nothing');
END $$;
ROLLBACK;
