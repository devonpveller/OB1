-- ============================================================
-- The deploy check for slot 490 (research-workbench-redesign rwr-ui-state-drift-check). READ-ONLY, catalog and function
-- results only: it reads no user_settings row and prints no setting value. A re-run of slot 400 after 490 silently puts
-- 400's setting_problem() and user_setting_set() back (ref_list refused, no advisory lock, no tombstone check). One line
-- per finding, then a summary:
--   check: setting_problem accepts library.recent (ref_list)  |  drift: setting_problem refuses library.recent (slot 400's text; re-run init-ui-state.sql)
--   check: user_setting_set takes the advisory lock           |  drift: user_setting_set has no pg_advisory_xact_lock (slot 400's text; re-run init-ui-state.sql)
--   check: user_setting_tombstones exists                     |  drift: user_setting_tombstones MISSING (re-run init-ui-state.sql)
--   check: user_setting_clear exists                          |  drift: user_setting_clear MISSING (re-run init-ui-state.sql)
--   OK | DRIFT <n>
--   psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d openbrain -f check-ui-state.sql
-- (workbench/check-ui-state-deploy.ps1 runs it and exits non-zero on DRIFT.)
-- The probe value is the literal '[]' for the key library.recent under a throwaway owner 'x': the function only judges it.
-- ============================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH lines AS (
    SELECT 1 AS o,
           CASE WHEN public.setting_problem('x', 'library.recent', '[]'::jsonb) IS NULL THEN 'check: setting_problem accepts library.recent (ref_list)'
                ELSE 'drift: setting_problem refuses library.recent (slot 400''s text; re-run init-ui-state.sql)' END AS l,
           public.setting_problem('x', 'library.recent', '[]'::jsonb) IS NOT NULL AS bad
    UNION ALL
    SELECT 2,
           CASE WHEN coalesce(position('pg_advisory_xact_lock' IN pg_get_functiondef(to_regprocedure('public.user_setting_set(text,text,jsonb,text,integer)'))), 0) > 0
                THEN 'check: user_setting_set takes the advisory lock'
                ELSE 'drift: user_setting_set has no pg_advisory_xact_lock (slot 400''s text, or missing; re-run init-ui-state.sql)' END,
           coalesce(position('pg_advisory_xact_lock' IN pg_get_functiondef(to_regprocedure('public.user_setting_set(text,text,jsonb,text,integer)'))), 0) = 0
    UNION ALL
    SELECT 3,
           CASE WHEN to_regclass('public.user_setting_tombstones') IS NOT NULL THEN 'check: user_setting_tombstones exists'
                ELSE 'drift: user_setting_tombstones MISSING (re-run init-ui-state.sql)' END,
           to_regclass('public.user_setting_tombstones') IS NULL
    UNION ALL
    SELECT 4,
           CASE WHEN to_regprocedure('public.user_setting_clear(text,text,integer)') IS NOT NULL THEN 'check: user_setting_clear exists'
                ELSE 'drift: user_setting_clear MISSING (re-run init-ui-state.sql)' END,
           to_regprocedure('public.user_setting_clear(text,text,integer)') IS NULL
)
SELECT l FROM (
    SELECT o, l FROM lines
    UNION ALL
    SELECT 9, CASE WHEN count(*) FILTER (WHERE bad) > 0 THEN 'DRIFT ' || count(*) FILTER (WHERE bad) ELSE 'OK' END FROM lines
) x ORDER BY o, l;
COMMIT;
