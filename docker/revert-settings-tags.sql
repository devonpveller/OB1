-- Revert init-settings-tags.sql (rwr-settings-shell, slot 550).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-settings-tags.sql
-- Drops settings_keys.tag and its CHECK; the catalog is then exactly as after slots 400 and 490. ORDER: put the
-- PREVIOUS workbench image back FIRST (the new image selects the column on every settings request), then run this file,
-- then, if ever, revert-ui-state.sql and revert-settings.sql. Idempotent: a second run changes nothing.
\set ON_ERROR_STOP on
BEGIN;
ALTER TABLE public.settings_keys DROP CONSTRAINT IF EXISTS settings_keys_tag_check;
ALTER TABLE public.settings_keys DROP COLUMN IF EXISTS tag;
COMMIT;
NOTIFY pgrst, 'reload schema';
