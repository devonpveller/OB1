-- ============================================================
-- Revert of init-source-reader.sql (research-workbench redesign, rwr-source-reader-api, slot 520).
-- Takes away exactly the two owner read functions slot 520 added. Slot 520 changed no table, column, row or grant, so
-- there is nothing to restore. Re-runnable.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-source-reader.sql
-- Order: after the workbench image that calls them is rolled back (a private source then reads as not found, which
-- is the fail-closed answer); no ordering against 440 / 470.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.inlet_private_reader_chunks(UUID, TEXT);
DROP FUNCTION IF EXISTS public.inlet_private_reader_claims(UUID, TEXT);
SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'source reader: the private reader functions are gone'; END $$;
COMMIT;
