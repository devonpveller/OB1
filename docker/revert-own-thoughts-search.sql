-- ============================================================
-- Revert of init-own-thoughts-search.sql (rwr-own-thoughts-search-api, slot 530). Takes away exactly what slot 530
-- added: the function owner_private_thoughts_search(text,text,integer) with its comment and grants. No row was ever changed,
-- so there is nothing to restore; the catalog is byte-identical to the state before slot 530. Re-runnable.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-own-thoughts-search.sql
-- Order: deploy the previous workbench (no own-thoughts route) FIRST, then this file; and BEFORE 480's revert.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION IF EXISTS public.owner_private_thoughts_search(TEXT, TEXT, INT);
SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'own thoughts search revert: owner_private_thoughts_search is gone'; END $$;
COMMIT;
