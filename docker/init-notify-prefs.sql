-- ============================================================
-- Notification preferences (research-workbench-redesign rwr-notify-prefs). Slot 720.
-- Which kinds of notification show in YOUR bell. Four per-user settings keys in slot 400's store (user tier, section 'ui',
-- tag only_you; one value per owner_sub, versioned writes, read and written only for the identity seam's subject through
-- /workbench/settings/:key; no route change, no new table, no new function):
--   notify.informational   boolean  default true   an event of the class informational (a new idea, a dossier delivered)
--   notify.structural      boolean  default true   an event of the class structural (not the model: needs a fix)
--   notify.transient       boolean  default true   an event of the class transient (the model did not perform)
--   notify.sign_in_new_device  enum ["on"]  default "on"   a sign-in from a new device. It CANNOT be switched off: the
--                          registry's own enum judges every write (setting_problem refuses anything but "on", 400) and the
--                          trigger on user_settings applies the same rule to any writer, so a direct write is refused too.
-- The key of a class is 'notify.' || the class. The bell's read (GET /workbench/contract/notifications) leaves out an event
-- of a class whose BOOLEAN key this person has stored as false, for that person only; a key of any other type (the sign-in
-- key) can never hide anything. There is no email key: the email column is shown disabled ("needs a mail service") and no mail
-- is sent by anything here. No new notification class is created (the sign-in key is the preference, not a producer): nothing
-- in this server detects a new device or can post such an event yet, so the row says "Not detected yet" and is reserved and always on.
-- Rights: nothing new is created, so nothing is granted or revoked; user_settings keeps slot 400's rights (service_role).
-- Slot 720 sits ON slots 400 + 550 (it needs the tag column) and changes neither the section nor the type CHECK, nor any
-- function, so it replaces nothing of 490 or 700. BUT its four rows sit in section 'ui', which slot 490 owns (490's narrowed
-- section CHECK refuses them), so 720 depends on 490 at ROLLBACK: revert 720 BEFORE revert-ui-state.sql. Additive and idempotent: a re-run restores exactly what is written
-- here. Fresh-volume slot 720; live: after 400 + 550 and a fresh DB backup, psql -f BEFORE the new workbench image (without
-- the rows a person has no preference to store and nothing is hidden). Check: check-notify-prefs.sql (read-only).
-- Revert: put the previous workbench image back FIRST, then revert-notify-prefs.sql (discards every person's stored value
-- of these four keys and their tombstones; the catalog is then exactly as before), BEFORE revert-settings-tags.sql and BEFORE revert-ui-state.sql
-- (revert-ui-state.sql fails while these rows exist: rollback order is 730, 720, 710, 700, 550, 490).
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.settings_keys (key, tier, type, section, position, label, help, default_value, env_name, read_by, validation, editable, store, tag) VALUES
    ('notify.informational', 'user', 'boolean', 'ui', 100, 'Events about your work',
        'A new idea of yours, a dossier delivered. Off: these no longer show in your bell. Other people''s bells are not changed.',
        'true', NULL, 'openbrain-workbench, on every read of your bell', '{}', true, 'settings', 'only_you'),
    ('notify.structural', 'user', 'boolean', 'ui', 110, 'Problems that need a fix',
        'Something failed that is not the model (for example a document that could not be updated). Off: these no longer show in your bell.',
        'true', NULL, 'openbrain-workbench, on every read of your bell', '{}', true, 'settings', 'only_you'),
    ('notify.transient', 'user', 'boolean', 'ui', 120, 'The model did not perform',
        'A model call that kept failing. Off: these no longer show in your bell.',
        'true', NULL, 'openbrain-workbench, on every read of your bell', '{}', true, 'settings', 'only_you'),
    ('notify.sign_in_new_device', 'user', 'enum', 'ui', 130, 'Sign-in from a new device',
        'Not detected yet: this server does not track sign-in devices, so no alert is sent today. The row is reserved and always on, and cannot be switched off.',
        '"on"', NULL, 'openbrain-workbench, on every read of your bell', '{"enum":["on"]}', true, 'settings', 'only_you')
ON CONFLICT (key) DO UPDATE SET
    tier = EXCLUDED.tier, type = EXCLUDED.type, section = EXCLUDED.section, position = EXCLUDED.position,
    label = EXCLUDED.label, help = EXCLUDED.help, default_value = EXCLUDED.default_value, env_name = EXCLUDED.env_name,
    read_by = EXCLUDED.read_by, validation = EXCLUDED.validation, editable = EXCLUDED.editable, store = EXCLUDED.store,
    tag = EXCLUDED.tag;

COMMIT;
NOTIFY pgrst, 'reload schema';
