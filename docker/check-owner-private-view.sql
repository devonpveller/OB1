-- ============================================================
-- The deploy pre-check's catalog half for slot 480 (research-workbench rw-owner-private-view). READ-ONLY, catalog only:
-- it reads no table row and prints function signatures and role names only. One line per finding, then a summary:
--   check: 440 applied | 440 NOT applied
--   check: ob_workbench exists | ob_workbench MISSING
--   check: ob_workbench member of ob_app_memory | NOT a member
--   drift: <signature> executable by ob_app_memory        (one per drifted function; a 440 re-run after 480)
--   check: FAIL <n> | check: OK
--   psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d openbrain -f check-owner-private-view.sql
-- (workbench/check-owner-private-view-deploy.ps1 runs it and exits non-zero on FAIL.)
-- ============================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH f AS (
    SELECT p.oid, p.oid::regprocedure::text AS sig FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname LIKE 'inlet\_private\_%' OR p.proname LIKE 'owner\_private\_%')
),
lines AS (
    SELECT 1 AS o, CASE WHEN to_regprocedure('public.inlet_private_source(uuid,text)') IS NOT NULL THEN 'check: 440 applied' ELSE 'check: 440 NOT applied' END AS l,
           to_regprocedure('public.inlet_private_source(uuid,text)') IS NULL AS bad
    UNION ALL
    SELECT 2, CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN 'check: ob_workbench exists' ELSE 'check: ob_workbench MISSING' END,
           NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench')
    UNION ALL
    SELECT 3, CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory')
                    AND pg_has_role('ob_workbench', 'ob_app_memory', 'MEMBER') THEN 'check: ob_workbench member of ob_app_memory'
                   ELSE 'check: ob_workbench NOT a member of ob_app_memory' END,
           NOT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory')
                AND pg_has_role('ob_workbench', 'ob_app_memory', 'MEMBER'))
    UNION ALL
    SELECT 4, 'drift: ' || f.sig || ' executable by ob_app_memory', true
      FROM f
     WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory')
       AND has_function_privilege('ob_app_memory', f.oid, 'EXECUTE')
)
SELECT l FROM (
    SELECT o, l FROM lines
    UNION ALL
    SELECT 9, CASE WHEN count(*) FILTER (WHERE bad) > 0 THEN 'check: FAIL ' || count(*) FILTER (WHERE bad) ELSE 'check: OK' END FROM lines
) x ORDER BY o, l;
COMMIT;
