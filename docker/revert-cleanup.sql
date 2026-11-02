-- Revert init-cleanup.sql (rw-p8a2-cleanup).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-cleanup.sql
-- Drops the cleanup view's action log (THIS DISCARDS every cleanup_actions ROW: which user took which
-- cleanup action). The shared D5 rows (sources, trail events, tombstones) are not touched; their
-- 'cleanup-action:<id>' references then resolve to nothing.
\set ON_ERROR_STOP on
BEGIN;
DROP TABLE IF EXISTS public.cleanup_actions;
COMMIT;
NOTIFY pgrst, 'reload schema';
