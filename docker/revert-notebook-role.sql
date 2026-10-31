-- Revert init-notebook-role.sql (intake-notebook-role).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-notebook-role.sql
--
-- ORDER: first point open_notebook back at its old user (compose OB1_DB_USER, the image) and
-- recreate it, THEN run this; a session still logged in as ob_notebook keeps running after the
-- role is dropped and fails on its next statement. Removes the six ob_notebook policies on
-- threads / thread_sources / source_tombstones, every privilege the role holds, and the role. Nothing else.
-- Idempotent: a second run (role already gone) changes nothing.
\set ON_ERROR_STOP on
BEGIN;
DROP POLICY IF EXISTS ob_notebook_select ON public.threads;
DROP POLICY IF EXISTS ob_notebook_insert ON public.threads;
DROP POLICY IF EXISTS ob_notebook_select ON public.thread_sources;
DROP POLICY IF EXISTS ob_notebook_insert ON public.thread_sources;
DROP POLICY IF EXISTS ob_notebook_update ON public.thread_sources;
DROP POLICY IF EXISTS ob_notebook_select ON public.source_tombstones;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_notebook') THEN
        -- revokes every privilege it holds in this database (it owns nothing)
        EXECUTE 'DROP OWNED BY ob_notebook';
        EXECUTE 'DROP ROLE ob_notebook';
    END IF;
END $$;
COMMIT;
