-- ============================================================
-- A person's own inlet connections, readable (research-workbench-redesign rwr-imports-server-api). Slot 600, after
-- rw-inlet-stamp's 470 (the record: public.inlet_connections) and rw-owner-private-view's 480 (the workbench's own login
-- role, ob_workbench).
--
-- Why: inlet_connections is "readable by no app role" (470), so the Imports screen could not list a person's connected
-- inlets. This adds ONE read and changes nothing else:
--   inlet_connections_of(p_sub TEXT) -> (kind, created_at, updated_at)
--     SECURITY DEFINER, STABLE, search_path public, pg_temp. The rows whose owner_sub IS p_sub and nobody else's; nothing
--     at all when p_sub is not a usable subject (470's rule: a subject's shape, never service: / system: / anonymous:,
--     never the literal 'operator'). Exposes NO other column: not the connection's id (it can name a mailbox or a vault),
--     not owner_sub. No count, no total. EXECUTE: ob_workbench alone (the identity seam exists only in the workbench, so an
--     owner-argument function executable by ob_app_memory would be executable, with any subject, by ten other services).
-- It grants nothing on the table: no role gains any right on public.inlet_connections (its RLS stays forced, its grants
-- stay as 470 left them). Slot 450's door: no door role runs it (no map line).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f init-inlet-connections-read.sql
-- Refused (nothing changed) unless 470 and 480 are applied. Idempotent: a second run has nothing to do. One transaction,
-- lock_timeout 10s. Live: psql -f AFTER 470 and 480, BEFORE the new workbench image, a fresh DB backup first.
-- Revert: revert-inlet-connections-read.sql (independent of every other slot but must run before 480's / 470's reverts).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = warning;
DO $$
BEGIN
    IF to_regclass('public.inlet_connections') IS NULL OR to_regprocedure('public.inlet_subject_ok(text)') IS NULL THEN
        RAISE EXCEPTION 'inlet connections read: slot 470 (init-inlet-stamp.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        RAISE EXCEPTION 'inlet connections read: slot 480 (init-owner-private-view.sql, the ob_workbench role) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.inlet_connections_of(p_sub TEXT)
RETURNS TABLE (kind TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.kind, c.created_at, c.updated_at
      FROM public.inlet_connections c
     WHERE public.inlet_subject_ok(p_sub) AND c.owner_sub = p_sub
     ORDER BY c.created_at, c.kind
$$;

DO $$
DECLARE r RECORD;
BEGIN
    REVOKE ALL ON FUNCTION public.inlet_connections_of(TEXT) FROM PUBLIC;
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_proc pr, aclexplode(pr.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE pr.oid = 'public.inlet_connections_of(text)'::regprocedure AND NOT ro.rolsuper AND ro.oid <> pr.proowner AND ro.rolname <> 'ob_workbench' LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.inlet_connections_of(text) FROM %I', r.grantee);
    END LOOP;
    GRANT EXECUTE ON FUNCTION public.inlet_connections_of(TEXT) TO ob_workbench;
END $$;
COMMENT ON FUNCTION public.inlet_connections_of(TEXT) IS
  'rwr-imports-server-api (slot 600): the subject''s own inlet connections (kind and stamps only); nothing for any other subject, nor for an unusable one. ob_workbench only.';

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'inlet connections read: inlet_connections_of(text) is in place (ob_workbench alone executes it; no right on the table was granted)'; END $$;
COMMIT;
