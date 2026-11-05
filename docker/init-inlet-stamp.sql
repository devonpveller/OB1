-- ============================================================
-- Every personal row is written with its owner (research-workbench rw-inlet-stamp, plan 08 PD2). Slot 470, after
-- rw-inlet-owner's 440 (the existing data made the operator's) and rw-boundary-digest's 460.
-- Operator 2026-11-04: "everything has been me ... but after this is deployed its per user. Can't put that off."
--
--   1. public.inlet_connections - THE INLET OWNER RECORD: one row per inlet connection (an id that names a
--      connection, never a person; today 'gmail' - the one mailbox token, which feeds the pull, the prune, the digest and
--      the podcast - and 'vault', the wiki's note folder) and the subject that owns what it brings in. PD4 adds one row
--      per user's own Google connection; the writers do not change (they name a connection and ask for its owner).
--      Seeded here from -v owner_sub=... or, when absent, from 440's recorded owner (public.inlet_owner); a subject that
--      differs from either record is refused. Nothing to seed it from (a fresh volume) = no row, and every inlet writer
--      refuses until the operator records it (fail closed). Readable by no app role; the owner of a connection is read
--      through inlet_connection_owner(id).
--   2. inlet_subject_ok(text): what an owner may be - a subject's shape (no blank, no space, no quote), never a
--      service: / system: / anonymous: principal, never the literal 'operator'.
--   3. THE DATABASE FAILS CLOSED:
--      * thoughts (every thought is personal, 440's rule, except the wiki compile's dossier): an INSERT with no owner is
--        refused; an owner must pass inlet_subject_ok; a row naming metadata.inlet_connection must carry THAT
--        connection's owner (no row is stamped with the operator's subject unless the operator owns that inlet); a gmail
--        row must name its connection. An UPDATE may give an unowned row an owner (440's re-run) but never clear or
--        change an owner.
--      * sources: a shared source may never be personal - an email body (url mail.google.com), a podcast transcript, or a
--        row carrying a Gmail id / thread / labels (440's predicate; they belong in 440's owner-private stores).
--      * owner columns: podcast_episodes.owner_sub, research_handbacks.owner_sub and 440's private stores' owner columns
--        must pass inlet_subject_ok (CHECK, added NOT VALID then validated).
--      Triggers, not CHECKs, on thoughts and sources: the rule reads the connection record (another table), exempts one
--      shaped writer, and treats INSERT and UPDATE differently; a CHECK on thoughts would also fire on every UPDATE of a
--      legacy row (the entity worker, intake) and break writers instead of refusing new unowned rows. The triggers run
--      for every role - PostgREST's (service_role today, slot 450's door roles), ob_app_memory, and superusers.
--      THE ONE EXCEPTION: a SUPERUSER session that sets inlet_stamp.allow_unowned = 'on' (maintenance: a migration's
--      revert that restores unowned rows - 380, 390, 440 - the Authentik re-key, a lab's legacy-shaped fixture). No app
--      role is a superuser (every container runs as ob_app_memory; PostgREST switches to its anon / door role), and a
--      superuser can disable a trigger anyway, so the setting opens nothing a writer can reach. Never set it on a role
--      or a database of the live stack.
--   4. inlet_connection_mail: the prune's view, per connection (440's inlet_owner_mail stays as it is, so a 440 re-run
--      still runs).
--
--   psql -v ON_ERROR_STOP=1 [-v owner_sub="<the operator's subject>"] -U postgres -d openbrain -f init-inlet-stamp.sql
-- Refused (nothing changed) unless 440 is applied AND 440's own predicate finds nothing left to make private: run 440
-- first. From then on these triggers keep that at 0, so a 440 re-run has nothing to do. Re-runnable (nothing to do the
-- second time). Revert: revert-inlet-stamp.sql, BEFORE 440's (revert order 470, 460, 450, 440, 430, 390, 380).
-- Slot 450 (rw-rest-door-auth): when its door roles exist, the ones that read an owner (gmail_pull, digest, podcast,
-- wiki, import) get EXECUTE on inlet_connection_owner and gmail_prune the view; 450's door map lists the same lines,
-- so a 450 re-run keeps them.
-- ============================================================
\if :{?owner_sub}
\else
\set owner_sub ''
\endif
BEGIN;
SET LOCAL client_min_messages = warning;
SET LOCAL lock_timeout = '10s';
SELECT set_config('inlet_stamp.sub', :'owner_sub', true) AS owner_given \gset
DO $$
BEGIN
    IF to_regclass('public.inlet_owner') IS NULL OR to_regprocedure('public.inlet_private_source(uuid,text)') IS NULL
       OR to_regclass('public.inlet_private_sources') IS NULL THEN
        RAISE EXCEPTION 'inlet stamp: slot 440 (init-inlet-owner.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;
LOCK TABLE public.thoughts, public.sources IN SHARE ROW EXCLUSIVE MODE;

-- ── 2. what an owner may be ───────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.inlet_subject_ok(p_sub TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT p_sub IS NOT NULL
       AND p_sub ~ '^[A-Za-z0-9][A-Za-z0-9._@|+=:/-]{0,254}$'
       AND p_sub !~* '^(service|system|anonymous):'
       AND lower(p_sub) <> 'operator'
$$;
-- a pure predicate; the owner CHECKs below call it as the writing role, so the writers' roles may execute it
REVOKE ALL ON FUNCTION public.inlet_subject_ok(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inlet_subject_ok(TEXT) TO service_role;
COMMENT ON FUNCTION public.inlet_subject_ok(TEXT) IS
  'rw-inlet-stamp (slot 470): a subject that may own a personal row - a subject''s shape, never a service:/system:/anonymous: principal, never the literal operator.';

-- ── 1. the inlet owner record ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inlet_connections (
    id         TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
    kind       TEXT NOT NULL CHECK (kind IN ('gmail', 'vault')),
    owner_sub  TEXT NOT NULL CHECK (public.inlet_subject_ok(owner_sub)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.inlet_connections IS
  'rw-inlet-stamp (slot 470): the inlet owner record - one row per inlet connection and the subject that owns what it brings in. PD4 adds a row per user''s own connection. Readable by no app role: inlet_connection_owner(id).';
DO $$
DECLARE r RECORD;
BEGIN
    ALTER TABLE public.inlet_connections ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.inlet_connections FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON public.inlet_connections FROM PUBLIC;
    -- the schema's default privileges hand new tables to the app roles: take every grant back
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE cl.oid = 'public.inlet_connections'::regclass AND NOT ro.rolsuper AND ro.oid <> cl.relowner LOOP
        EXECUTE format('REVOKE ALL ON public.inlet_connections FROM %I', r.grantee);
    END LOOP;
END $$;
-- 440's view role (NOLOGIN) reads the record for the prune's view, and nothing else does
GRANT SELECT ON public.inlet_connections TO ob_inlet_owner_view;
DROP POLICY IF EXISTS inlet_connections_view_read ON public.inlet_connections;
CREATE POLICY inlet_connections_view_read ON public.inlet_connections AS PERMISSIVE FOR SELECT TO ob_inlet_owner_view USING (true);

-- the seed
SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    v_given TEXT := coalesce(NULLIF(btrim(current_setting('inlet_stamp.sub', true)), ''),
                             NULLIF(btrim(current_setting('workspace.default_sub', true)), ''));
    v_rec   TEXT;
    v_owner TEXT;
    v_n     INT;
    c       TEXT[];
BEGIN
    SELECT o.owner_sub INTO v_rec FROM public.inlet_owner o WHERE o.singleton;
    IF v_given IS NOT NULL AND v_rec IS NOT NULL AND v_given <> v_rec THEN
        RAISE EXCEPTION 'inlet stamp: refused, nothing changed - this database''s personal data belongs to the subject slot 440 recorded; a run may not name a different one'
            USING ERRCODE = '55000';
    END IF;
    v_owner := coalesce(v_rec, v_given);
    IF v_owner IS NOT NULL AND NOT public.inlet_subject_ok(v_owner) THEN
        RAISE EXCEPTION 'inlet stamp: refused, nothing changed - the owner subject is not a valid subject (blank, a service principal, or the literal operator)'
            USING ERRCODE = '22023';
    END IF;
    IF v_owner IS NOT NULL AND EXISTS (SELECT 1 FROM public.inlet_connections WHERE id IN ('gmail', 'vault') AND owner_sub <> v_owner) THEN
        RAISE EXCEPTION 'inlet stamp: refused, nothing changed - a connection is already recorded for a different subject'
            USING ERRCODE = '55000';
    END IF;
    IF v_owner IS NULL THEN
        RAISE NOTICE 'inlet stamp: no owner subject (none given, none recorded by slot 440) - no connection recorded; every inlet writer refuses until one is (re-run with -v owner_sub=<the operator''s subject>)';
    ELSE
        FOREACH c SLICE 1 IN ARRAY ARRAY[ARRAY['gmail', 'gmail'], ARRAY['vault', 'vault']] LOOP
            INSERT INTO public.inlet_connections (id, kind, owner_sub) VALUES (c[1], c[2], v_owner) ON CONFLICT (id) DO NOTHING;
        END LOOP;
        SELECT count(*) INTO v_n FROM public.inlet_connections;
        RAISE NOTICE 'inlet stamp: % inlet connection(s) recorded', v_n;
    END IF;
END $$;
SET LOCAL client_min_messages = warning;

-- the owner of a connection, for the writer that stamps it (SECURITY DEFINER: no app role reads the table)
CREATE OR REPLACE FUNCTION public.inlet_connection_owner(p_id TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v TEXT;
BEGIN
    SELECT c.owner_sub INTO v FROM public.inlet_connections c WHERE c.id = p_id;
    IF v IS NULL OR NOT public.inlet_subject_ok(v) THEN
        RAISE EXCEPTION 'inlet stamp: no owner is recorded for this inlet connection' USING ERRCODE = 'P0002';
    END IF;
    RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.inlet_connection_owner(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inlet_connection_owner(TEXT) TO service_role;
COMMENT ON FUNCTION public.inlet_connection_owner(TEXT) IS
  'rw-inlet-stamp (slot 470): the subject that owns an inlet connection''s rows; raises when none is recorded. EXECUTE: service_role (ob_app_memory; before slot 450 also PostgREST''s anon) and slot 450''s door roles that stamp an owner.';

-- ── 4. the prune's view, per connection ───────────────────────────────────────────────────────────────────────────
-- the gmail thoughts of a connection's owner; a row that names no connection is the 'gmail' connection's (every mail
-- row before this slot came from that one mailbox). Owned by 440's view role, the only reader of the record.
CREATE OR REPLACE VIEW public.inlet_connection_mail WITH (security_barrier = true) AS
    SELECT t.id, t.content, t.metadata, t.created_at,
           coalesce(t.metadata ->> 'inlet_connection', 'gmail') AS inlet_connection
      FROM public.thoughts t
     WHERE t.metadata ->> 'source' = 'gmail'
       AND t.user_id = (SELECT c.owner_sub FROM public.inlet_connections c
                         WHERE c.id = coalesce(t.metadata ->> 'inlet_connection', 'gmail'));
ALTER VIEW public.inlet_connection_mail OWNER TO ob_inlet_owner_view;
REVOKE ALL ON public.inlet_connection_mail FROM PUBLIC;
GRANT SELECT, DELETE ON public.inlet_connection_mail TO service_role;
COMMENT ON VIEW public.inlet_connection_mail IS
  'rw-inlet-stamp (slot 470): a connection''s owner''s gmail thoughts, for prune-short-term.ts (filters inlet_connection, deletes by owner). Owned by ob_inlet_owner_view.';

-- ── 3. the database fails closed ──────────────────────────────────────────────────────────────────────────────────
-- maintenance (see the header): the session asked for it AND its EFFECTIVE role is a superuser. The guards are SECURITY
-- DEFINER (current_user is the definer there), so the effective role is read from the `role` setting a SET ROLE leaves
-- (PostgREST switches every request to its anon / door role: service_role is no superuser, though its login is), else
-- the session's own login role.
CREATE OR REPLACE FUNCTION public.inlet_stamp_maintenance() RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
    SELECT coalesce(current_setting('inlet_stamp.allow_unowned', true), '') = 'on'
       AND coalesce((SELECT r.rolsuper FROM pg_roles r
                      WHERE r.rolname = coalesce(NULLIF(current_setting('role', true), 'none'), session_user::text)), false)
$$;
REVOKE ALL ON FUNCTION public.inlet_stamp_maintenance() FROM PUBLIC;

-- the one shared thought: the wiki compile's dossier (shared output, compiled from shared thoughts only - 440)
CREATE OR REPLACE FUNCTION public.inlet_stamp_is_dossier(p_meta JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT lower(coalesce(p_meta ->> 'type', '')) = 'dossier'
       AND coalesce(p_meta ->> 'generated_by', '') = 'recipes/entity-wiki/generate-wiki.mjs'
$$;

-- SECURITY DEFINER: the record is readable by no app role, and the helpers it calls need no grant to the writer
CREATE OR REPLACE FUNCTION public.inlet_stamp_thoughts_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_conn  TEXT := NEW.metadata ->> 'inlet_connection';
    v_owner TEXT;
BEGIN
    IF public.inlet_stamp_maintenance() THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
            RAISE EXCEPTION 'inlet stamp: a thought''s owner may not be cleared or changed' USING ERRCODE = '23514';
        END IF;
        IF NEW.user_id IS NULL THEN
            RETURN NEW;               -- a legacy unowned row (slot 440's re-run gives it its owner)
        END IF;
        IF NEW.user_id IS DISTINCT FROM OLD.user_id AND NOT public.inlet_subject_ok(NEW.user_id) THEN
            RAISE EXCEPTION 'inlet stamp: a thought''s owner must be a valid subject' USING ERRCODE = '23514';
        END IF;
        IF v_conn IS NULL OR v_conn IS NOT DISTINCT FROM (OLD.metadata ->> 'inlet_connection') THEN
            RETURN NEW;
        END IF;
    ELSE
        IF NEW.user_id IS NULL THEN
            IF public.inlet_stamp_is_dossier(NEW.metadata) AND v_conn IS NULL THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'inlet stamp: a personal row needs its owner (thoughts.user_id); nothing was written' USING ERRCODE = '23514';
        END IF;
        IF NOT public.inlet_subject_ok(NEW.user_id) THEN
            RAISE EXCEPTION 'inlet stamp: a thought''s owner must be a valid subject (never blank, a service principal or the literal operator)' USING ERRCODE = '23514';
        END IF;
        IF v_conn IS NULL THEN
            IF NEW.metadata ->> 'source' = 'gmail' THEN
                RAISE EXCEPTION 'inlet stamp: a gmail row must name its inlet connection (metadata.inlet_connection)' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END IF;
    END IF;
    SELECT c.owner_sub INTO v_owner FROM public.inlet_connections c WHERE c.id = v_conn;
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'inlet stamp: the row names an inlet connection with no recorded owner' USING ERRCODE = '23514';
    END IF;
    IF v_owner IS DISTINCT FROM NEW.user_id THEN
        RAISE EXCEPTION 'inlet stamp: a row of an inlet connection must carry that connection''s owner' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.inlet_stamp_thoughts_guard() FROM PUBLIC;
CREATE OR REPLACE TRIGGER trg_inlet_stamp_thoughts
    BEFORE INSERT OR UPDATE OF user_id, metadata ON public.thoughts
    FOR EACH ROW EXECUTE FUNCTION public.inlet_stamp_thoughts_guard();

-- a source that is personal (440's predicate: the email body, the podcast transcript, a Gmail id on a shared row)
CREATE OR REPLACE FUNCTION public.inlet_stamp_source_personal(p_url TEXT, p_content_type TEXT, p_meta JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT coalesce(p_url, '') ILIKE '%mail.google.com%'
        OR coalesce(p_content_type, '') = 'podcast_transcript'
        OR coalesce(p_meta ->> 'source', '') = 'daily-digest-podcast'
        OR coalesce(p_meta ?| ARRAY['gmail_id', 'gmail_thread_id', 'gmail_labels'], false)
$$;
CREATE OR REPLACE FUNCTION public.inlet_stamp_sources_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.inlet_stamp_maintenance() THEN
        RETURN NEW;
    END IF;
    IF public.inlet_stamp_source_personal(NEW.url, NEW.content_type, NEW.metadata) THEN
        RAISE EXCEPTION 'inlet stamp: a shared source may not be personal (an email body, a podcast transcript or a Gmail id); nothing was written'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.inlet_stamp_sources_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inlet_stamp_is_dossier(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inlet_stamp_source_personal(TEXT, TEXT, JSONB) FROM PUBLIC;

-- the preconditions: nothing left for 440 to make private (run 440 first), checked under the locks
DO $$
DECLARE v_first TIMESTAMPTZ; n_t BIGINT; n_s BIGINT;
BEGIN
    SELECT o.first_run_at INTO v_first FROM public.inlet_owner o WHERE o.singleton;
    SELECT count(*) INTO n_t FROM public.thoughts t
     WHERE t.user_id IS NULL
       AND NOT (lower(coalesce(t.metadata ->> 'type', '')) = 'dossier' AND t.created_at > coalesce(v_first, '-infinity'::timestamptz));
    SELECT count(*) INTO n_s FROM public.sources s WHERE public.inlet_stamp_source_personal(s.url, s.content_type, s.metadata);
    IF n_t > 0 OR n_s > 0 THEN
        RAISE EXCEPTION 'inlet stamp: refused, nothing changed - % unowned thought(s) and % personal shared source(s) are still there: run slot 440 (init-inlet-owner.sql) first', n_t, n_s
            USING ERRCODE = '55000';
    END IF;
END $$;
CREATE OR REPLACE TRIGGER trg_inlet_stamp_sources
    BEFORE INSERT OR UPDATE OF url, content_type, metadata ON public.sources
    FOR EACH ROW EXECUTE FUNCTION public.inlet_stamp_sources_guard();

-- the owner columns
DO $$
DECLARE c TEXT[];
BEGIN
    FOREACH c SLICE 1 IN ARRAY ARRAY[
        ARRAY['podcast_episodes', 'owner_sub'], ARRAY['research_handbacks', 'owner_sub'],
        ARRAY['inlet_private_sources', 'inlet_owner_sub'], ARRAY['inlet_private_source_chunks', 'inlet_owner_sub'],
        ARRAY['inlet_private_claims', 'inlet_owner_sub'], ARRAY['inlet_private_claim_links', 'owner_sub'],
        ARRAY['inlet_private_jobs', 'owner_sub'], ARRAY['inlet_private_job_events', 'owner_sub']] LOOP
        IF to_regclass('public.' || c[1]) IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = ('public.' || c[1])::regclass AND conname = c[1] || '_inlet_stamp_owner_ok') THEN
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (public.inlet_subject_ok(%I)) NOT VALID', c[1], c[1] || '_inlet_stamp_owner_ok', c[2]);
            EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', c[1], c[1] || '_inlet_stamp_owner_ok');
        END IF;
    END LOOP;
END $$;

-- ── slot 450's door roles (when they exist) ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['ob_rest_gmail_pull', 'ob_rest_digest', 'ob_rest_podcast', 'ob_rest_wiki', 'ob_rest_import'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.inlet_connection_owner(TEXT) TO %I', r);
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.inlet_subject_ok(TEXT) TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_rest_gmail_prune') THEN
        GRANT SELECT, DELETE ON public.inlet_connection_mail TO ob_rest_gmail_prune;
    END IF;
END $$;

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'inlet stamp: the owner record, the thoughts and sources guards and the owner checks are in place'; END $$;
COMMIT;
