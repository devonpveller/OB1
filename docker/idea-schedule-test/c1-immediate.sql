\i helpers.sql
BEGIN;
-- clause 1: a user with no schedule, and a user explicitly on immediate: queued at once
DO $$ DECLARE a uuid; b uuid; BEGIN
  a := pg_temp.mk_idea('u-none', 'idea none');
  PERFORM pg_temp.ok(pg_temp.stamped(a) AND pg_temp.jobs(a) = 1, 'no schedule row: queued at capture');
  b := pg_temp.mk_idea('u-imm', 'idea imm');
  PERFORM pg_temp.ok(pg_temp.stamped(b) AND pg_temp.jobs(b) = 1, 'queued at capture');
  PERFORM pg_temp.edit(b, 'idea imm v2');
  PERFORM pg_temp.ok(pg_temp.jobs(b) = 1 AND pg_temp.stamped(b), 'an edit coalesces into one queued job');
END $$;
-- explicit immediate row (needs the schedule table; absent on the base, where immediate is the only mode)
DO $$ DECLARE b uuid; BEGIN
  PERFORM public.idea_schedule_set('u-imm2', 'u-imm2', 'immediate', NULL, NULL, 'UTC');
  b := pg_temp.mk_idea('u-imm2', 'idea imm2');
  PERFORM pg_temp.ok(pg_temp.stamped(b) AND pg_temp.jobs(b) = 1, 'immediate row: queued at capture');
END $$;
ROLLBACK;
