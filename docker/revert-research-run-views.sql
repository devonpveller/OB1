-- ============================================================
-- Revert of init-research-run-views.sql (rwr-research-runs, slot 640): drops the four functions and the table the slot
-- added. The slot changed no existing object, so nothing else is restored. Archive marks are view state only; dropping
-- them loses nothing of any run. Re-runnable.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-run-views.sql
-- Order: deploy the previous workbench image FIRST (it does not call the functions), then this file.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.run_view_archive(TEXT, UUID);
DROP FUNCTION IF EXISTS public.run_view_unarchive(TEXT, UUID);
DROP FUNCTION IF EXISTS public.run_views_of(TEXT);
DROP FUNCTION IF EXISTS public.run_handbacks_of(TEXT);
DROP TABLE IF EXISTS public.research_run_views;
COMMIT;
