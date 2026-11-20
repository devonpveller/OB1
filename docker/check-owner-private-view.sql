-- ============================================================
-- The deploy pre-check's catalog half for slot 480 (research-workbench rw-owner-private-view). READ-ONLY, catalog only:
-- it reads no table row and prints function signatures and role names only. One line per finding, then a summary:
--   check: 440 applied | 440 NOT applied
--   check: ob_workbench exists | ob_workbench MISSING
--   check: ob_workbench member of ob_app_memory | NOT a member
--   drift: <signature> executable by ob_app_memory        (one per drifted function; a 440 re-run after 480)
--   check: owner_private_* function(s) MISSING: <signatures>   (the five reads slot 480 creates)
--   check: ob_workbench cannot EXECUTE: <signatures>            (the five reads, one line per function)
--   check: stray grant: <signature> executable by <role>        (any role but ob_workbench, the function owner and superusers, PUBLIC included; the
--                                                                owner_private_* reads and PD1's two inlet_private_ reads)
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
    UNION ALL
    -- the five owner reads must exist (slot 480 applied), whatever else is true
    SELECT 5, 'check: owner_private_* function MISSING: ' || e.sig, true
      FROM (VALUES ('public.owner_private_claims(text,uuid,text,text,uuid,timestamptz,uuid,integer)'),
                   ('public.owner_private_source_text(text,text,text,integer)'),
                   ('public.owner_private_source_knn(text,vector,text,integer)'),
                   ('public.owner_private_has_sources(text)'),
                   ('public.owner_private_jobs(text,timestamptz,uuid,integer)')) e(sig)
     WHERE to_regprocedure(e.sig) IS NULL
    UNION ALL
    -- ... and ob_workbench must be able to run each one that exists
    SELECT 6, 'check: ob_workbench cannot EXECUTE: ' || e.sig, true
      FROM (VALUES ('public.owner_private_claims(text,uuid,text,text,uuid,timestamptz,uuid,integer)'),
                   ('public.owner_private_source_text(text,text,text,integer)'),
                   ('public.owner_private_source_knn(text,vector,text,integer)'),
                   ('public.owner_private_has_sources(text)'),
                   ('public.owner_private_jobs(text,timestamptz,uuid,integer)')) e(sig)
     WHERE to_regprocedure(e.sig) IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench')
            OR NOT has_function_privilege('ob_workbench', to_regprocedure(e.sig), 'EXECUTE'))
    UNION ALL
    -- no other role may run the owner reads or PD1's two private reads: a stray grant (PUBLIC included) hands one subject's
    -- rows to whoever supplies the subject. Allowed: ob_workbench, the function owner, superusers.
    SELECT 7, 'check: stray grant: ' || f.sig || ' executable by ' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, true
      FROM f
      JOIN pg_proc pr ON pr.oid = f.oid
      CROSS JOIN LATERAL aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
     WHERE (f.sig ~ '^(public\.)?owner_private_' OR f.sig ~ '^(public\.)?inlet_private_(source|job)\(')
       AND x.privilege_type = 'EXECUTE'
       AND (x.grantee = 0
            OR (x.grantee <> pr.proowner
                AND x.grantee::regrole::text <> 'ob_workbench'
                AND NOT (SELECT r.rolsuper FROM pg_roles r WHERE r.oid = x.grantee)))
)
SELECT l FROM (
    SELECT o, l FROM lines
    UNION ALL
    SELECT 9, CASE WHEN count(*) FILTER (WHERE bad) > 0 THEN 'check: FAIL ' || count(*) FILTER (WHERE bad) ELSE 'check: OK' END FROM lines
) x ORDER BY o, l;
COMMIT;
