-- ============================================================
-- Ownership / grant check for slot 520 (rwr-source-reader-api), the sibling of check-owner-private-view.sql. READ-ONLY,
-- catalog only: it reads no table row and prints function signatures and role names only. One line per finding, then a summary:
--   check: 480 applied | 480 NOT applied              (ob_workbench and owner_private_subject_ok exist)
--   check: reader function MISSING: <signature>      (slot 520 not applied)
--   check: ob_workbench cannot EXECUTE: <signature>
--   check: stray grant: <signature> executable by <role>   (any role but ob_workbench, the function owner and superusers, PUBLIC included)
--   check: not SECURITY DEFINER with search_path public, pg_temp: <signature>
--   check: FAIL <n> | check: OK
--   psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d openbrain -f check-source-reader.sql
-- ============================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH e(sig) AS (VALUES ('public.inlet_private_reader_chunks(uuid,text)'), ('public.inlet_private_reader_claims(uuid,text)')),
lines AS (
    SELECT 1 AS o, CASE WHEN to_regprocedure('public.owner_private_subject_ok(text)') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench')
                        THEN 'check: 480 applied' ELSE 'check: 480 NOT applied' END AS l,
           NOT (to_regprocedure('public.owner_private_subject_ok(text)') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench')) AS bad
    UNION ALL
    SELECT 2, 'check: reader function MISSING: ' || e.sig, true FROM e WHERE to_regprocedure(e.sig) IS NULL
    UNION ALL
    SELECT 3, 'check: ob_workbench cannot EXECUTE: ' || e.sig, true FROM e
     WHERE to_regprocedure(e.sig) IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') OR NOT has_function_privilege('ob_workbench', to_regprocedure(e.sig), 'EXECUTE'))
    UNION ALL
    SELECT 4, 'check: stray grant: ' || pr.oid::regprocedure::text || ' executable by ' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, true
      FROM e JOIN pg_proc pr ON pr.oid = to_regprocedure(e.sig)
      CROSS JOIN LATERAL aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
     WHERE x.privilege_type = 'EXECUTE'
       AND (x.grantee = 0
            OR (x.grantee <> pr.proowner AND x.grantee::regrole::text <> 'ob_workbench'
                AND NOT (SELECT r.rolsuper FROM pg_roles r WHERE r.oid = x.grantee)))
    UNION ALL
    SELECT 5, 'check: not SECURITY DEFINER with search_path public, pg_temp: ' || pr.oid::regprocedure::text, true
      FROM e JOIN pg_proc pr ON pr.oid = to_regprocedure(e.sig)
     WHERE NOT pr.prosecdef OR pr.proconfig IS NULL OR NOT ('search_path=public, pg_temp' = ANY (pr.proconfig))
)
SELECT l FROM (
    SELECT o, l FROM lines
    UNION ALL
    SELECT 9, CASE WHEN count(*) FILTER (WHERE bad) > 0 THEN 'check: FAIL ' || count(*) FILTER (WHERE bad) ELSE 'check: OK' END FROM lines
) x ORDER BY o, l;
COMMIT;
