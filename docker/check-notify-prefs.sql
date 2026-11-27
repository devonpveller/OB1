-- Read-only check of slot 720 (rwr-notify-prefs): run after init-notify-prefs.sql (or on the live DB after it).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f check-notify-prefs.sql
-- Prints one row per check; ok = t. Changes nothing (no INSERT, UPDATE, DELETE or DDL).
SELECT 'four keys, user tier, section ui, tag only_you, editable' AS check,
       (SELECT count(*) = 4 FROM public.settings_keys
         WHERE key IN ('notify.informational', 'notify.structural', 'notify.transient', 'notify.sign_in_new_device')
           AND tier = 'user' AND section = 'ui' AND tag = 'only_you' AND editable) AS ok
UNION ALL SELECT 'the three class keys are boolean, default true',
       (SELECT count(*) = 3 FROM public.settings_keys
         WHERE key IN ('notify.informational', 'notify.structural', 'notify.transient') AND type = 'boolean' AND default_value = 'true'::jsonb)
UNION ALL SELECT 'the sign-in key is the enum ["on"] with default "on"',
       (SELECT count(*) = 1 FROM public.settings_keys
         WHERE key = 'notify.sign_in_new_device' AND type = 'enum' AND validation = '{"enum":["on"]}'::jsonb AND default_value = '"on"'::jsonb)
UNION ALL SELECT 'setting_problem refuses switching the sign-in key off',
       public.setting_problem('check', 'notify.sign_in_new_device', '"off"'::jsonb) IS NOT NULL
       AND public.setting_problem('check', 'notify.sign_in_new_device', 'false'::jsonb) IS NOT NULL
UNION ALL SELECT 'setting_problem accepts on for the sign-in key and false for a class',
       public.setting_problem('check', 'notify.sign_in_new_device', '"on"'::jsonb) IS NULL
       AND public.setting_problem('check', 'notify.transient', 'false'::jsonb) IS NULL
UNION ALL SELECT 'the sign-in row says Not detected yet and does not claim delivery',
       (SELECT help LIKE 'Not detected yet%' AND help NOT ILIKE '%always shows%' FROM public.settings_keys WHERE key = 'notify.sign_in_new_device')
UNION ALL SELECT 'there is no email key',
       (SELECT count(*) = 0 FROM public.settings_keys WHERE key ~* '^notify\..*(mail|smtp)');
