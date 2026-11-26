-- Revert init-cleanup-dismissals.sql (research-workbench redesign, rwr-cleanup; slot 700).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-cleanup-dismissals.sql
--
-- THIS DISCARDS every dismissal row: take a pg_dump first if any of it matters (a person's dismissed
-- suggestions and reopen candidates show again). Nothing else is touched. Put the previous workbench image
-- back FIRST: the new image reads this table.
\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS public.cleanup_dismissals;

DELETE FROM public.contract_registry_entries WHERE registry = 'dismissal_kinds';
DELETE FROM public.contract_registries WHERE name = 'dismissal_kinds';

COMMIT;
NOTIFY pgrst, 'reload schema';
