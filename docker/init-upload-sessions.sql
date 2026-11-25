-- ============================================================
-- Upload sessions (research-workbench-redesign rwr-upload-sessions). Slot 610, after rw-owner-private-view's 480 (the
-- workbench's own login role, ob_workbench).
--
-- What this file adds, and only this:
--   upload_sessions        one row per large-file upload a person started from Imports: the file's name, its declared
--                          size and sha256, its state (open -> finishing -> done | failed), the reason a finish was
--                          refused, and the intake add job it became. owner_sub is the identity seam's subject_sub
--                          (whose upload it is) and actor_sub who acted; neither is ever caller-supplied.
--   upload_session_pieces  one row per piece received: its byte offset and length. The BYTES are not here: they are files
--                          on the workbench's own Docker volume (openbrain-uploads), which no other service mounts and no
--                          route serves.
-- Both tables are the workbench's alone: RLS enabled and FORCED, one policy for ob_workbench, every right any other role
-- held (init-grants.sql's default privileges hand every new table to service_role) revoked. A file's name can be
-- private, so no other service (PostgREST's anon role included) can read a row.
-- No foreign key to import_jobs (a foreign key would lock that live table); job_id is a plain uuid the workbench sets.
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f init-upload-sessions.sql
-- Refused (nothing changed) unless 480 is applied (ob_workbench). Idempotent: a second run changes nothing. One
-- transaction, lock_timeout 10s; it creates two NEW tables and locks no existing one. Live: psql -f AFTER 480, BEFORE the
-- new workbench image, a fresh DB backup first. Revert: revert-upload-sessions.sql (the previous workbench image first).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = warning;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        RAISE EXCEPTION 'upload sessions: slot 480 (init-owner-private-view.sql, the ob_workbench role) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.upload_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub   TEXT NOT NULL CHECK (owner_sub <> ''),
    actor_sub   TEXT NOT NULL,
    filename    TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
    size        BIGINT NOT NULL CHECK (size > 0),
    sha256      TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'finishing', 'done', 'failed')),
    reason      TEXT,
    job_id      UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner ON public.upload_sessions (owner_sub, state);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_updated ON public.upload_sessions (updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_sessions_job ON public.upload_sessions (job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.upload_session_pieces (
    session_id    UUID NOT NULL REFERENCES public.upload_sessions (id) ON DELETE CASCADE,
    piece_offset  BIGINT NOT NULL CHECK (piece_offset >= 0),
    piece_length  BIGINT NOT NULL CHECK (piece_length > 0),
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, piece_offset)
);

ALTER TABLE public.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.upload_session_pieces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_session_pieces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS upload_sessions_workbench ON public.upload_sessions;
CREATE POLICY upload_sessions_workbench ON public.upload_sessions FOR ALL TO ob_workbench USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS upload_session_pieces_workbench ON public.upload_session_pieces;
CREATE POLICY upload_session_pieces_workbench ON public.upload_session_pieces FOR ALL TO ob_workbench USING (true) WITH CHECK (true);

DO $$
DECLARE r RECORD;
BEGIN
    REVOKE ALL ON public.upload_sessions, public.upload_session_pieces FROM PUBLIC;
    FOR r IN SELECT DISTINCT c.relname, ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid IN ('public.upload_sessions'::regclass, 'public.upload_session_pieces'::regclass)
                AND NOT ro.rolsuper AND ro.oid <> c.relowner AND ro.rolname <> 'ob_workbench' LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', r.relname, r.grantee);
    END LOOP;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.upload_sessions, public.upload_session_pieces TO ob_workbench;
END $$;
COMMENT ON TABLE public.upload_sessions IS
  'rwr-upload-sessions (slot 610): a person''s large-file upload in pieces (the bytes are files on the workbench''s own volume). ob_workbench only.';
COMMENT ON TABLE public.upload_session_pieces IS
  'rwr-upload-sessions (slot 610): the pieces an upload session received (offset, length). ob_workbench only.';

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'upload sessions: upload_sessions and upload_session_pieces are in place (ob_workbench alone; RLS forced)'; END $$;
COMMIT;
