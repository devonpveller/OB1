-- Revert init-settings.sql (rw-settings-store, slot 400).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-settings.sql
-- Drops the settings registry, the user tier and their functions. THIS DISCARDS every user's settings
-- (take a pg_dump of public.user_settings first if any of it matters). The admin tier
-- (public.contract_settings, slot 230) and its rows are NOT touched; nor is idea_schedule (slot 300).
-- After a revert every service reads its env value / code default again (the services treat a missing
-- setting_get() as "no stored value").
-- Idempotent: a second run changes nothing.
\set ON_ERROR_STOP on
BEGIN;
DROP TRIGGER IF EXISTS trg_user_settings_guard ON public.user_settings;
DROP FUNCTION IF EXISTS public.trg_user_settings_guard();
DROP FUNCTION IF EXISTS public.user_setting_set(TEXT, TEXT, JSONB, TEXT, INT);
DROP FUNCTION IF EXISTS public.setting_get(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.setting_problem(TEXT, TEXT, JSONB);
DROP TABLE IF EXISTS public.user_settings;
DROP TABLE IF EXISTS public.settings_keys;
COMMIT;
