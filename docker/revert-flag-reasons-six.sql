-- Revert init-flag-reasons-six.sql (research-workbench redesign, rwr-flag-reasons-six; slot 680).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-flag-reasons-six.sql
--
-- Removes the two registry rows and nothing else. A flag already saved with 'outdated' or 'broken_link' would be left
-- holding a reason the registry no longer lists, so this REFUSES while one exists (decide those flags first, or take a
-- pg_dump and delete them on purpose); with none, the schema and data are back to what slot 500 left.
\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.user_flags') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.user_flags WHERE reason IN ('outdated', 'broken_link')) THEN
    RAISE EXCEPTION 'revert-flag-reasons-six: flags with reason outdated / broken_link exist; not reverting';
  END IF;
END $$;

DELETE FROM public.contract_registry_entries
 WHERE registry = 'flag_reasons' AND key IN ('outdated', 'broken_link');

COMMIT;
NOTIFY pgrst, 'reload schema';
