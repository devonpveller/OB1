\i helpers.sql
BEGIN;
-- clause 6: the setting is owner-scoped: no role but the service reads it; a bad zone is refused
DO $$ BEGIN
  PERFORM public.idea_schedule_set('u-x', 'u-x', 'daily', '08:00', NULL, 'UTC');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.idea_schedule) >= 1, 'service sees the row');
END $$;
SAVEPOINT s1;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM count(*) FROM public.idea_schedule;
    RAISE EXCEPTION 'CHECK FAILED: authenticated could read idea_schedule';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.idea_schedule_next('u-x', now());
    RAISE EXCEPTION 'CHECK FAILED: authenticated could call idea_schedule_next';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK TO s1;
DO $$ BEGIN
  BEGIN
    PERFORM public.idea_schedule_set('u-y', 'u-y', 'daily', '08:00', NULL, 'Mars/Olympus');
    RAISE EXCEPTION 'CHECK FAILED: an unknown time zone was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.idea_schedule_set('u-y', 'u-y', 'weekly', '08:00', NULL, 'UTC');
    RAISE EXCEPTION 'CHECK FAILED: weekly without a day was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
