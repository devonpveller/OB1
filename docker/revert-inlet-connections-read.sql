-- ============================================================
-- Revert of init-inlet-connections-read.sql (rwr-imports-server-api, slot 600): drops the one function the slot added.
-- Slot 600 changed no table, row, role or grant on a table, so nothing else is restored. Re-runnable.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-inlet-connections-read.sql
-- Order: deploy the previous workbench image FIRST (it does not call the function), then this file.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.inlet_connections_of(TEXT);
COMMIT;
