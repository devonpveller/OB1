-- Revert init-flags.sql (research-workbench redesign, rwr-flags-api; slot 500).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-flags.sql
--
-- THIS DISCARDS every flag row: take a pg_dump first if any of it matters. Nothing else is touched (a flag
-- never changed a flagged item, so there is nothing to restore there). The pre-flags workbench image must be
-- redeployed with this revert, since the flags image reads this table.
\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS public.user_flags;

DELETE FROM public.contract_registry_entries
 WHERE registry IN ('flag_reasons', 'flag_item_kinds', 'flag_from_kinds', 'flag_states');
DELETE FROM public.contract_registries
 WHERE name IN ('flag_reasons', 'flag_item_kinds', 'flag_from_kinds', 'flag_states');

COMMIT;
NOTIFY pgrst, 'reload schema';
