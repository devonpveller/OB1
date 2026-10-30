-- ============================================================
-- Research workbench - users, impersonation and the admin audit log (rw-identity).
--
-- Governing plan (private plan store): implementation-guide/research-workbench/07-MULTI-USER.md
-- (operator 2026-10-28: one Authentik user id everywhere; an admin may impersonate a user after
-- giving a reason; every admin action in an append-only, retrievable log).
--
-- What this file adds, and only this:
--   1. workspace_users          users the workbench has seen signed in with Authentik (subject, name,
--                               admin flag as of their last token)
--   2. workspace_impersonation  rw-identity2: one row per admin who is impersonating - whom, the
--                               reason, since, until (short-lived; keyed by the admin's subject). There
--                               is no session table: Authentik forward-auth keeps the sign-in and every
--                               request carries its signed token (amended in place before any deploy:
--                               290 was never applied live - checked 2026-10-30 - so the earlier
--                               workspace_login_pending / workspace_sessions tables are gone from it)
--   3. admin_audit              APPEND-ONLY: impersonate.start/end/refused, every request made
--                               while impersonating, users.read, audit.read. A trigger refuses
--                               UPDATE and DELETE (and TRUNCATE) for every role; the workbench's
--                               role is granted SELECT + INSERT only.
--   4. research_prompts gains nothing: an Open WebUI job started on behalf of a user writes that
--      user's row (the research service, origin `owui`); agent-started research is recorded under
--      the service identity `service:<caller>` (never private: a service is not a user).
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE); re-running it changes nothing. Revert:
-- revert-identity.sql. Mounted as /docker-entrypoint-initdb.d/290-init-identity.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.workspace_users (
    sub         TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    is_admin    BOOLEAN NOT NULL DEFAULT false,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (sub !~* '^(service|system|anonymous):')
);

CREATE TABLE IF NOT EXISTS public.workspace_impersonation (
    admin_sub   TEXT PRIMARY KEY REFERENCES public.workspace_users(sub),
    target_sub  TEXT NOT NULL REFERENCES public.workspace_users(sub),
    reason      TEXT NOT NULL CHECK (length(btrim(reason)) >= 4),
    ref         TEXT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    CHECK (admin_sub <> target_sub),
    CHECK (expires_at > started_at)
);

CREATE TABLE IF NOT EXISTS public.admin_audit (
    id           BIGSERIAL PRIMARY KEY,
    at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    actor_sub    TEXT NOT NULL,
    subject_sub  TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('impersonate.start', 'impersonate.end', 'impersonate.refused',
                                                 'request', 'users.read', 'audit.read')),
    reason       TEXT,
    method       TEXT,
    route        TEXT,
    session_ref  TEXT,
    CHECK (action <> 'impersonate.start' OR length(btrim(coalesce(reason, ''))) >= 4)
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON public.admin_audit (actor_sub, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_subject ON public.admin_audit (subject_sub, id DESC);

-- append-only, for every role (a superuser must drop the trigger on purpose to change history)
CREATE OR REPLACE FUNCTION public.admin_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'admin_audit is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS trg_admin_audit_append_only ON public.admin_audit;
CREATE TRIGGER trg_admin_audit_append_only BEFORE UPDATE OR DELETE ON public.admin_audit
    FOR EACH ROW EXECUTE FUNCTION public.admin_audit_append_only();
DROP TRIGGER IF EXISTS trg_admin_audit_no_truncate ON public.admin_audit;
CREATE TRIGGER trg_admin_audit_no_truncate BEFORE TRUNCATE ON public.admin_audit
    FOR EACH STATEMENT EXECUTE FUNCTION public.admin_audit_append_only();

-- ── RLS + grants (the P0 shape; the audit log: read and append only) ──────────
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['workspace_users', 'workspace_impersonation'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role_all', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    END LOOP;
END $$;
ALTER TABLE public.admin_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_audit_service_role_read ON public.admin_audit;
CREATE POLICY admin_audit_service_role_read ON public.admin_audit FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS admin_audit_service_role_append ON public.admin_audit;
CREATE POLICY admin_audit_service_role_append ON public.admin_audit FOR INSERT TO service_role WITH CHECK (true);
REVOKE ALL ON public.admin_audit FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.admin_audit FROM service_role;
GRANT SELECT, INSERT ON public.admin_audit TO service_role;
GRANT USAGE ON SEQUENCE public.admin_audit_id_seq TO service_role;

-- ── 6. owners of research jobs that predate rw-identity (operator 2026-10-28: all existing private
-- content is the one operator's = WORKSPACE_DEFAULT_SUB). Run with the deploy's value as the session
-- setting, as init-documents.sql's back-fill is:  PGOPTIONS='-c workspace.default_sub=<WORKSPACE_DEFAULT_SUB>'
-- A root job with no research_prompts row becomes that subject's - or, when an agent started it
-- (origin mattermost / notebook), its service's (service:<caller>: shared, not private). Unset = no
-- back-fill (a NOTICE): the readers then treat an ownerless job as WORKSPACE_DEFAULT_SUB's at run time.
DO $$
DECLARE d TEXT := nullif(btrim(coalesce(current_setting('workspace.default_sub', true), '')), '');
        n INT;
BEGIN
    IF d IS NULL THEN
        RAISE NOTICE 'init-identity: workspace.default_sub is not set - research jobs with no owner stay ownerless (read as WORKSPACE_DEFAULT_SUB''s); re-run with PGOPTIONS=''-c workspace.default_sub=<value>'' to record them';
        RETURN;
    END IF;
    INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt)
    SELECT j.id,
           CASE WHEN j.origin IN ('mattermost', 'notebook') AND coalesce(j.caller, '') <> '' THEN 'service:' || j.caller ELSE d END,
           'system:backfill', coalesce(j.query, '')
      FROM public.research_jobs j
     WHERE j.root_job_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.research_prompts p WHERE p.job_id = j.id);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'init-identity: % ownerless research job(s) given an owner', n;
END $$;

NOTIFY pgrst, 'reload schema';
