-- Revert init-document-toplace.sql (research-workbench redesign, rwr-doc-toplace-api; slot 630).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-document-toplace.sql
--
-- THIS DISCARDS every queued ("to place") cite: take a pg_dump first if any of it matters. Nothing else is touched: the
-- slot added one table (its indexes, constraints, policy and the foreign key's triggers on the listing table go with it)
-- and no function, registry entry, role or grant on any other object. Put the pre-630 workbench image back FIRST (the new
-- image reads this table). Re-runnable.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TABLE IF EXISTS public.document_pending_refs;
COMMIT;
NOTIFY pgrst, 'reload schema';
