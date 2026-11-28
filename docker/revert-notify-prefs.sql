-- Revert init-notify-prefs.sql (rwr-notify-prefs, slot 720).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-notify-prefs.sql
-- Removes the four keys (notify.informational, notify.structural, notify.transient, notify.sign_in_new_device) and every
-- person's stored value of them and every tombstone (a person's bell then shows every class again). Nothing else changes: the
-- slot adds no table, column, function or right, so the catalog is exactly as it was before slot 720.
-- ORDER: put the PREVIOUS workbench image back FIRST, then this file, BEFORE revert-settings-tags.sql and BEFORE revert-ui-state.sql (this slot's rows are in
-- section 'ui', which slot 490 owns: revert-ui-state.sql fails while they exist; rollback order 730, 720, 710, 700, 550, 490). Take a pg_dump of
-- public.user_settings first if any of it matters. Idempotent: a second run changes nothing.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM public.user_settings WHERE key IN ('notify.informational', 'notify.structural', 'notify.transient', 'notify.sign_in_new_device');
DO $$ BEGIN
    IF to_regclass('public.user_setting_tombstones') IS NOT NULL THEN
        DELETE FROM public.user_setting_tombstones WHERE key IN ('notify.informational', 'notify.structural', 'notify.transient', 'notify.sign_in_new_device');
    END IF;
END $$;
DELETE FROM public.settings_keys WHERE key IN ('notify.informational', 'notify.structural', 'notify.transient', 'notify.sign_in_new_device');
COMMIT;
NOTIFY pgrst, 'reload schema';
