-- ============================================================
-- A person's own view of their research runs (research-workbench-redesign rwr-research-runs). Slot 640, after
-- rw-owner-private-view's 480 (the workbench's own login role, ob_workbench); it reads slot 420's research_handbacks /
-- research_jobs and changes none of them.
--
-- What it adds:
--   * public.research_run_views (owner_sub, job_id, archived_at): ONE row per person per run they archived - a per-user
--     VIEW STATE. Archiving a run writes here and nowhere else: no source, claim, job, event or hand-back row is touched,
--     and another person's view of the same run does not change (the key includes owner_sub). The row goes with its job
--     (ON DELETE CASCADE). No app role holds any right on the table, and RLS is forced with no policy (only the
--     functions below reach it).
--   * run_view_archive(p_sub, p_job) / run_view_unarchive(p_sub, p_job) -> boolean: set / clear that one row for p_sub. A
--     branch (not a root) is refused, and so is a job whose recorded prompt is another person's (research_prompts).
--   * run_views_of(p_sub) -> (job_id, archived_at): the subject's own rows.
--   * run_handbacks_of(p_sub) -> (job_id, document): the user-start runs this subject started (the private hand-back's
--     owner) and the path of the document one was started from (null otherwise). A derived run has no research_prompts
--     row (slot 420: its question is public), so the hand-back is the ONLY record of whose run it is.
--     Every function is SECURITY DEFINER, search_path public, pg_temp; EXECUTE for ob_workbench alone (the identity seam
--     exists only in the workbench, so an owner-argument function executable by another service would be executable,
--     with any subject, by that service). Slot 450's door: no door role runs them (no map line).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f init-research-run-views.sql
-- Refused (nothing changed) unless 420 (research_handbacks) and 480 (ob_workbench) are applied. Idempotent. One
-- transaction, lock_timeout 10s. Live: psql -f AFTER 420 and 480, BEFORE the new workbench image, a fresh DB backup first.
-- Revert: revert-research-run-views.sql (independent of every other slot; run it once the previous workbench image is back).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = warning;
DO $$
BEGIN
    IF to_regclass('public.research_handbacks') IS NULL OR to_regclass('public.research_jobs') IS NULL THEN
        RAISE EXCEPTION 'research run views: slot 420 (init-request-boundary.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        RAISE EXCEPTION 'research run views: slot 480 (init-owner-private-view.sql, the ob_workbench role) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.research_run_views (
    owner_sub   TEXT        NOT NULL CHECK (btrim(owner_sub) <> ''),
    job_id      UUID        NOT NULL REFERENCES public.research_jobs(id) ON DELETE CASCADE,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_sub, job_id)
);
ALTER TABLE public.research_run_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_run_views FORCE ROW LEVEL SECURITY;
-- no policy: no role but a superuser reads or writes the table; the SECURITY DEFINER functions below do
DO $$
DECLARE r RECORD;
BEGIN
    REVOKE ALL ON public.research_run_views FROM PUBLIC;
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.research_run_views'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner LOOP
        EXECUTE format('REVOKE ALL ON public.research_run_views FROM %I', r.grantee);
    END LOOP;
END $$;
COMMENT ON TABLE public.research_run_views IS
  'rwr-research-runs (slot 640): a person''s archived research runs - a per-user view state, nothing else; the run, its sources and claims are untouched. Read and written by the run_view_* functions only.';

CREATE OR REPLACE FUNCTION public.run_view_archive(p_sub TEXT, p_job UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n INT;
BEGIN
    IF p_sub IS NULL OR btrim(p_sub) = '' OR p_job IS NULL THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.research_jobs j WHERE j.id = p_job AND j.parent_job_id IS NULL) THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM public.research_prompts p WHERE p.job_id = p_job AND p.owner_sub <> p_sub) THEN RETURN false; END IF;
    INSERT INTO public.research_run_views (owner_sub, job_id) VALUES (p_sub, p_job) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.run_view_unarchive(p_sub TEXT, p_job UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n INT;
BEGIN
    IF p_sub IS NULL OR btrim(p_sub) = '' OR p_job IS NULL THEN RETURN false; END IF;
    DELETE FROM public.research_run_views WHERE owner_sub = p_sub AND job_id = p_job;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.run_views_of(p_sub TEXT)
RETURNS TABLE (job_id UUID, archived_at TIMESTAMPTZ)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT v.job_id, v.archived_at FROM public.research_run_views v WHERE p_sub IS NOT NULL AND v.owner_sub = p_sub
$$;

-- the user-start runs p_sub started, and the document path one came from (the inlet id is '<path>#<start id>')
CREATE OR REPLACE FUNCTION public.run_handbacks_of(p_sub TEXT)
RETURNS TABLE (job_id UUID, document TEXT)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT h.job_id,
           CASE WHEN h.inlet_kind = 'document' THEN NULLIF(split_part(h.inlet_id, '#', 1), '') END
      FROM public.research_handbacks h
     WHERE p_sub IS NOT NULL AND btrim(p_sub) <> '' AND h.owner_sub = p_sub AND h.purpose = 'user-start' AND h.job_id IS NOT NULL
$$;

DO $$
DECLARE r RECORD; f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY['run_view_archive(text,uuid)', 'run_view_unarchive(text,uuid)', 'run_views_of(text)', 'run_handbacks_of(text)'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_proc pr, aclexplode(pr.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE pr.oid = ('public.' || f)::regprocedure AND NOT ro.rolsuper AND ro.oid <> pr.proowner AND ro.rolname <> 'ob_workbench' LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', f, r.grantee);
        END LOOP;
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO ob_workbench', f);
    END LOOP;
END $$;
COMMENT ON FUNCTION public.run_view_archive(TEXT, UUID) IS 'rwr-research-runs (slot 640): archive a root run for p_sub (a view state only); false when it is not a root, is another person''s by prompt, or already archived. ob_workbench only.';
COMMENT ON FUNCTION public.run_view_unarchive(TEXT, UUID) IS 'rwr-research-runs (slot 640): clear p_sub''s own archive row; false when there was none. ob_workbench only.';
COMMENT ON FUNCTION public.run_views_of(TEXT) IS 'rwr-research-runs (slot 640): p_sub''s own archived runs. ob_workbench only.';
COMMENT ON FUNCTION public.run_handbacks_of(TEXT) IS 'rwr-research-runs (slot 640): the user-start runs p_sub started (the private hand-back owner) and their source document path. ob_workbench only.';

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'research run views: research_run_views and run_view_archive / run_view_unarchive / run_views_of / run_handbacks_of are in place (ob_workbench alone executes them; no right on the table was granted)'; END $$;
COMMIT;
