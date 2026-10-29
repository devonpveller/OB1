-- ============================================================
-- Research workbench - sign-in, sessions and the admin audit log (rw-identity).
--
-- Governing plan (private plan store): implementation-guide/research-workbench/07-MULTI-USER.md
-- (operator 2026-10-28: one Authentik user id everywhere; an admin may impersonate a user after
-- giving a reason; every admin action in an append-only, retrievable log).
--
-- What this file adds, and only this:
--   1. workspace_users          users who have signed in with Authentik (subject, name, admin flag)
--   2. workspace_login_pending  sign-ins in flight: state (hashed), browser binding (hashed), nonce,
--                               PKCE verifier, where to land; single use, expire after 10 minutes
--   3. workspace_sessions       signed-in browsers: the SHA-256 of the cookie's token (the token is
--                               never stored), the user, the admin flag, an impersonation
--                               (imp_sub + imp_reason + imp_started_at)
--   4. admin_audit              APPEND-ONLY: impersonate.start/end/refused, every request made
--                               while impersonating, users.read, audit.read. A trigger refuses
--                               UPDATE and DELETE (and TRUNCATE) for every role; the workbench's
--                               role is granted SELECT + INSERT only.
--   5. research_prompts gains nothing: an Open WebUI job started on behalf of a user writes that
--      user's row (the research service, origin `owui`); agent-started research is recorded under
--      the service identity `service:<caller>` (never private: a service is not a user).
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE); re-running it changes nothing. Revert:
-- revert-identity.sql. Mounted as /docker-entrypoint-initdb.d/280-init-identity.sql.
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

CREATE TABLE IF NOT EXISTS public.workspace_login_pending (
    state_hash    TEXT PRIMARY KEY,
    binding_hash  TEXT NOT NULL,
    nonce         TEXT NOT NULL,
    verifier      TEXT NOT NULL,
    return_to     TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_login_pending_expiry ON public.workspace_login_pending (expires_at);

CREATE TABLE IF NOT EXISTS public.workspace_sessions (
    id_hash         TEXT PRIMARY KEY,
    sub             TEXT NOT NULL REFERENCES public.workspace_users(sub),
    name            TEXT NOT NULL DEFAULT '',
    is_admin        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    imp_sub         TEXT REFERENCES public.workspace_users(sub),
    imp_reason      TEXT,
    imp_started_at  TIMESTAMPTZ,
    CHECK ((imp_sub IS NULL) = (imp_reason IS NULL)),
    CHECK (imp_sub IS NULL OR (is_admin AND length(btrim(imp_reason)) >= 4))
);
CREATE INDEX IF NOT EXISTS idx_workspace_sessions_sub ON public.workspace_sessions (sub, created_at DESC);

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
    FOREACH t IN ARRAY ARRAY['workspace_users', 'workspace_login_pending', 'workspace_sessions'] LOOP
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

NOTIFY pgrst, 'reload schema';
