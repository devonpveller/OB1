-- Read-only check of slot 700 (rwr-appearance): run after init-appearance.sql (or on the live DB after it).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f check-appearance.sql
-- Prints one row per check; ok = t. Changes nothing (no INSERT, UPDATE, DELETE or DDL).
SELECT 'five keys, user tier, section ui, tag only_you' AS check,
       (SELECT count(*) = 5 FROM public.settings_keys
         WHERE key IN ('ui.theme', 'ui.accent', 'ui.density', 'ui.text_size', 'ui.saved_themes')
           AND tier = 'user' AND section = 'ui' AND tag = 'only_you' AND editable) AS ok
UNION ALL SELECT 'type CHECK holds theme_list',
       (SELECT pg_get_constraintdef(oid) LIKE '%theme_list%' FROM pg_constraint WHERE conname = 'settings_keys_type_check')
UNION ALL SELECT 'the cap is 10',
       (SELECT (validation->>'max_items')::int = 10 FROM public.settings_keys WHERE key = 'ui.saved_themes')
UNION ALL SELECT 'setting_problem has the theme_list branch',
       (SELECT prosrc LIKE '%WHEN ''theme_list''%' FROM pg_proc WHERE proname = 'setting_problem' AND pronamespace = 'public'::regnamespace)
UNION ALL SELECT 'setting_problem refuses an 11th theme',
       public.setting_problem('check', 'ui.saved_themes', (SELECT jsonb_agg(jsonb_build_object('name', 'n' || i, 'theme', 'dark', 'accent', 'teal', 'density', 'compact', 'text_size', '14')) FROM generate_series(1, 11) i)) IS NOT NULL
UNION ALL SELECT 'setting_problem accepts 10 themes',
       public.setting_problem('check', 'ui.saved_themes', (SELECT jsonb_agg(jsonb_build_object('name', 'n' || i, 'theme', 'dark', 'accent', 'teal', 'density', 'compact', 'text_size', '14')) FROM generate_series(1, 10) i)) IS NULL;
