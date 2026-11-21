-- ============================================================
-- The deploy pre-check's catalog half for slot 530 (rwr-own-thoughts-search-api). READ-ONLY, catalog only: it reads no
-- table row and prints function signatures and role names only. One line per finding, then a summary:
--   check: 480 applied | 480 NOT applied (ob_workbench / owner_private_subject_ok missing: deploy rw-owner-private-view first)
--   check: owner_private_thoughts_search exists | MISSING
--   check: owner_private_thoughts_search is SECURITY DEFINER, STABLE, search_path public, pg_temp | NOT (the shape drifted)
--   check: ob_workbench can EXECUTE it | ob_workbench cannot EXECUTE it
--   check: stray grant: <signature> executable by <role>     (any role but ob_workbench, the function owner and superusers,
--                                                              PUBLIC included - one line per grantee)
--   check: FAIL <n> | check: OK
--   psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d openbrain -f check-own-thoughts-search.sql
-- Covers this one function; check-owner-private-view.sql (slot 480) covers the nine of 480.
-- ============================================================
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH f AS (
    SELECT to_regprocedure('public.owner_private_thoughts_search(text,text,integer)') AS oid
),
lines AS (
    SELECT 1 AS o,
           CASE WHEN to_regprocedure('public.owner_private_subject_ok(text)') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench')
                THEN 'check: 480 applied' ELSE 'check: 480 NOT applied' END AS l,
           NOT (to_regprocedure('public.owner_private_subject_ok(text)') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench')) AS bad
    UNION ALL
    SELECT 2, CASE WHEN f.oid IS NOT NULL THEN 'check: owner_private_thoughts_search exists' ELSE 'check: owner_private_thoughts_search MISSING' END, f.oid IS NULL FROM f
    UNION ALL
    SELECT 3, 'check: owner_private_thoughts_search is NOT SECURITY DEFINER, STABLE, search_path public, pg_temp', true
      FROM f JOIN pg_proc p ON p.oid = f.oid
     WHERE NOT (p.prosecdef AND p.provolatile = 's' AND coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=public, pg_temp']::text[])
    UNION ALL
    SELECT 4, 'check: ob_workbench cannot EXECUTE owner_private_thoughts_search', true
      FROM f
     WHERE f.oid IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench')
            OR NOT has_function_privilege('ob_workbench', f.oid, 'EXECUTE'))
    UNION ALL
    SELECT 5, 'check: stray grant: owner_private_thoughts_search executable by ' || CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END, true
      FROM f
      JOIN pg_proc pr ON pr.oid = f.oid
      CROSS JOIN LATERAL aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) x
     WHERE x.privilege_type = 'EXECUTE'
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
