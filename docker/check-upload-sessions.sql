-- ============================================================
-- Check of slot 610 (rwr-upload-sessions): read-only, answers one line per fact and a final verdict. Run after
-- init-upload-sessions.sql (on the lab, or on live after the deploy):
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -A -t -f check-upload-sessions.sql
-- Every line must read "ok"; the last line is "upload sessions check: PASS" or "... FAIL".
-- ============================================================
WITH t AS (
    SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner
      FROM pg_class c WHERE c.oid IN (to_regclass('public.upload_sessions'), to_regclass('public.upload_session_pieces'))
), grants AS (
    SELECT t.relname, ro.rolname, a.privilege_type
      FROM t, aclexplode(coalesce((SELECT relacl FROM pg_class WHERE oid = t.oid), '{}')) a JOIN pg_roles ro ON ro.oid = a.grantee
     WHERE ro.oid <> t.relowner
), facts AS (
    SELECT 'both tables exist' AS fact, (SELECT count(*) FROM t) = 2 AS ok
    UNION ALL SELECT 'RLS enabled and forced on both', (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM t) IS TRUE
    UNION ALL SELECT 'no role but ob_workbench holds a right', NOT EXISTS (SELECT 1 FROM grants WHERE rolname <> 'ob_workbench')
    UNION ALL SELECT 'ob_workbench holds exactly SELECT, INSERT, UPDATE, DELETE on both',
        (SELECT count(*) FROM grants WHERE rolname = 'ob_workbench' AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) = 8
        AND NOT EXISTS (SELECT 1 FROM grants WHERE rolname = 'ob_workbench' AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
    UNION ALL SELECT 'the only policies are the ob_workbench ones',
        (SELECT count(*) FROM pg_policy p JOIN t ON t.oid = p.polrelid) = 2
        AND NOT EXISTS (SELECT 1 FROM pg_policy p JOIN t ON t.oid = p.polrelid, unnest(p.polroles) r WHERE r <> 'ob_workbench'::regrole)
    UNION ALL SELECT 'no foreign key points at import_jobs from these tables',
        NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN t ON t.oid = k.conrelid WHERE k.contype = 'f' AND k.confrelid = to_regclass('public.import_jobs'))
)
SELECT (CASE WHEN ok THEN 'ok   ' ELSE 'FAIL ' END) || fact FROM facts
UNION ALL
SELECT 'upload sessions check: ' || CASE WHEN bool_and(ok) THEN 'PASS' ELSE 'FAIL' END FROM facts;
