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
--      * owner columns: the owner columns of the podcast tables, the hand-back table and 440's private stores
--        must pass inlet_subject_ok (CHECK, added NOT VALID then validated) - the literal 'operator' included.
--      Triggers, not CHECKs, on thoughts and sources: the rule reads the connection record (another table), exempts one
--      shaped writer, and treats INSERT and UPDATE differently; a CHECK on thoughts would also fire on every UPDATE of a
--      legacy row (the entity worker, intake) and break writers instead of refusing new unowned rows. The triggers run
--      for every role - PostgREST's (service_role today, slot 450's door roles), ob_app_memory, and superusers. There
--      is NO escape hatch: no setting, no role exception (coordinator decision 2026-11-05). A migration whose revert
--      writes unowned rows (440, 390, 380) runs after this slot is reverted: the revert order is the reverse of the
--      apply order, 470 first. If one ever has to run with 470 in place, that is a finding, not a reason for a bypass.
--   4. inlet_connection_mail: the prune's view, per connection (440's inlet_owner_mail stays as it is, so a 440 re-run
--      still runs).
--
--   psql -v ON_ERROR_STOP=1 [-v owner_sub="<the operator's subject>"] -U postgres -d openbrain -f init-inlet-stamp.sql
-- Refused (nothing changed) unless 440 is applied AND 440's own predicate finds nothing left to make private: run 440
-- first. From then on these triggers keep that at 0, so a 440 re-run has nothing to do. Re-runnable (nothing to do the
-- second time). Revert: revert-inlet-stamp.sql, BEFORE 440's (revert order 470, 460, 450, 440, 430, 390, 380): 440's
-- revert writes the owners back to NULL, which these guards refuse for every role.
-- Slot 450 (rw-rest-door-auth): this slot grants nothing to its door roles; the lines they need are in 450's door map
-- (inlet_connection_owner for the stamping writers, the view for the prune, the import role).
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
CREATE OR REPLACE FUNCTION public.inlet_subject_ok(p_subject TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT p_subject IS NOT NULL
       AND p_subject ~ '^[A-Za-z0-9][A-Za-z0-9._@|+=:/-]{0,254}$'
       AND p_subject !~* '^(service|system|anonymous):'
       AND lower(p_subject) <> 'operator'
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
-- this slot's own view role (NOLOGIN) reads the record for the prune's view, and nothing else does. Its own, not 440's
-- ob_inlet_owner_view: 440's revert drops that role, and must not be blocked by an object of this slot.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_inlet_stamp_view') THEN
        CREATE ROLE ob_inlet_stamp_view NOLOGIN NOBYPASSRLS;
    END IF;
END $$;
GRANT service_role TO ob_inlet_stamp_view;   -- the ops plane's policy on thoughts, and its table grants
GRANT SELECT ON public.inlet_connections TO ob_inlet_stamp_view;
DROP POLICY IF EXISTS inlet_connections_view_read ON public.inlet_connections;
CREATE POLICY inlet_connections_view_read ON public.inlet_connections AS PERMISSIVE FOR SELECT TO ob_inlet_stamp_view USING (true);

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
-- row before this slot came from that one mailbox). Owned by this slot's view role, the only reader of the record.
CREATE OR REPLACE VIEW public.inlet_connection_mail WITH (security_barrier = true) AS
    SELECT t.id, t.content, t.metadata, t.created_at,
           coalesce(t.metadata ->> 'inlet_connection', 'gmail') AS inlet_connection
      FROM public.thoughts t
     WHERE t.metadata ->> 'source' = 'gmail'
       AND t.user_id = (SELECT c.owner_sub FROM public.inlet_connections c
                         WHERE c.id = coalesce(t.metadata ->> 'inlet_connection', 'gmail'));
ALTER VIEW public.inlet_connection_mail OWNER TO ob_inlet_stamp_view;
REVOKE ALL ON public.inlet_connection_mail FROM PUBLIC;
GRANT SELECT, DELETE ON public.inlet_connection_mail TO service_role;
COMMENT ON VIEW public.inlet_connection_mail IS
  'rw-inlet-stamp (slot 470): a connection''s owner''s gmail thoughts, for prune-short-term.ts (filters inlet_connection, deletes by owner). Owned by ob_inlet_stamp_view.';

-- ── 3. the database fails closed ──────────────────────────────────────────────────────────────────────────────────

-- the one shared thought: the wiki compile's dossier (shared output, compiled from shared thoughts only - 440)
CREATE OR REPLACE FUNCTION public.inlet_stamp_is_dossier(p_meta JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT lower(coalesce(p_meta ->> 'type', '')) = 'dossier'
       AND coalesce(p_meta ->> 'generated_by', '') = 'recipes/entity-wiki/generate-wiki.mjs'
$$;

-- the verified token of a door request (slot 450): PostgREST sets request.jwt.claims from the JWT it checked; a client
-- cannot set it. NULL outside a door request (direct PG, PostgREST's anonymous role). This is the caller's IDENTITY, read
-- to refuse more - it switches nothing off.
CREATE OR REPLACE FUNCTION public.inlet_stamp_door_claims() RETURNS JSONB
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog
AS $$
DECLARE v TEXT := NULLIF(btrim(coalesce(current_setting('request.jwt.claims', true), '')), '');
BEGIN
    IF v IS NULL OR left(v, 1) <> '{' THEN
        RETURN NULL;
    END IF;
    RETURN v::jsonb;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.inlet_stamp_door_claims() FROM PUBLIC;

-- SECURITY DEFINER: the record is readable by no app role, and the helpers it calls need no grant to the writer
CREATE OR REPLACE FUNCTION public.inlet_stamp_thoughts_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Round 2 (tester attempt 1, F1): the NEW row is judged IN FULL on every INSERT and UPDATE, whatever the statement
-- changed - an UPDATE is a write like any other. The rules, in order:
--   1. an owner is never cleared or changed (UPDATE);
--   2. no owner: only the wiki compile's dossier, naming no connection, and an UPDATE may not MAKE a dossier (the
--      exemption is not reachable from any other shape). After this slot applies there is no other unowned thought
--      (its precondition), so every other unowned row is refused, INSERT and UPDATE alike;
--   3. an owner must be a valid subject;
--   4. a door request (slot 450's verified token): the import role names no connection; a row that names no
--      connection is owned by the token's own subject;
--   5. a row that names a connection carries that connection's recorded owner; a gmail row names one - an UPDATE may
--      not drop it (a legacy gmail row that never named one keeps that shape).
DECLARE
    v_conn   TEXT := NEW.metadata ->> 'inlet_connection';
    v_owner  TEXT;
    v_claims JSONB;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'inlet stamp: a thought''s owner may not be cleared or changed' USING ERRCODE = '23514';
    END IF;
    IF NEW.user_id IS NULL THEN
        IF public.inlet_stamp_is_dossier(NEW.metadata) AND v_conn IS NULL
           AND (TG_OP = 'INSERT' OR public.inlet_stamp_is_dossier(OLD.metadata)) THEN
            RETURN NEW;               -- the compile's dossier (written, or rewritten, as a dossier)
        END IF;
        RAISE EXCEPTION 'inlet stamp: a personal row needs its owner (thoughts.user_id); nothing was written' USING ERRCODE = '23514';
    END IF;
    IF NOT public.inlet_subject_ok(NEW.user_id) THEN
        RAISE EXCEPTION 'inlet stamp: a thought''s owner must be a valid subject (never blank, a service principal or the literal operator)' USING ERRCODE = '23514';
    END IF;
    -- a door request (slot 450: PostgREST verified the caller's token): the owner is the inlet connection's record
    -- (rule 5) or, for a row that names no connection, the token's own verified subject - never a user_id the caller
    -- chose for someone else. The import role names no connection at all (imports are not inlets).
    v_claims := public.inlet_stamp_door_claims();
    IF coalesce(v_claims ->> 'role', '') LIKE 'ob\_rest\_%' THEN
        IF v_claims ->> 'role' = 'ob_rest_import' AND v_conn IS NOT NULL THEN
            RAISE EXCEPTION 'inlet stamp: an import names no inlet connection' USING ERRCODE = '23514';
        END IF;
        IF v_conn IS NULL AND NEW.user_id IS DISTINCT FROM (v_claims ->> 'sub') THEN
            RAISE EXCEPTION 'inlet stamp: a door caller may write only rows owned by its verified subject or by its inlet connection''s recorded owner' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF v_conn IS NULL THEN
        IF NEW.metadata ->> 'source' = 'gmail'
           AND (TG_OP = 'INSERT' OR (OLD.metadata ->> 'inlet_connection') IS NOT NULL) THEN
            RAISE EXCEPTION 'inlet stamp: a gmail row must name its inlet connection (metadata.inlet_connection)' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
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
    BEFORE INSERT OR UPDATE ON public.thoughts
    FOR EACH ROW EXECUTE FUNCTION public.inlet_stamp_thoughts_guard();
-- ALWAYS: the guard fires under session_replication_role = replica too (440's init and revert run parts of themselves
-- that way, and any superuser session can set it) - it is not a switch that turns the guard off
ALTER TABLE public.thoughts ENABLE ALWAYS TRIGGER trg_inlet_stamp_thoughts;

-- a source that is personal (440's predicate: the email body, the podcast transcript, a Gmail id on a shared row)
-- Round 2 (tester attempt 1, F2): ONE predicate for "a personal source", the union of what slot 440 moves out of
-- `sources` (init-inlet-owner.sql: url mail.google.com, metadata.source daily-digest-podcast, content_type
-- podcast_transcript) and what it strips from a shared row (its step 5 and its fail-closed check: a Gmail id key, a Gmail
-- URL anywhere in the metadata or the content). Wider than 440 where 440 would miss: a Gmail id key at ANY depth and in
-- ANY case. The lab checks that every row 440's own predicates select, this one selects too (no drift).
CREATE OR REPLACE FUNCTION public.inlet_stamp_source_personal(p_url TEXT, p_content_type TEXT, p_meta JSONB, p_content TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT coalesce(p_url, '') ~* 'mail\.google\.com'
        OR coalesce(p_content_type, '') = 'podcast_transcript'
        OR coalesce(p_meta ->> 'source', '') = 'daily-digest-podcast'
        OR coalesce(p_meta::text, '') ~* '"gmail_(id|thread_id|labels)"\s*:'
        OR coalesce(p_meta::text, '') ~* 'mail\.google\.com'
        OR coalesce(p_content, '') ~* 'mail\.google\.com'
$$;
CREATE OR REPLACE FUNCTION public.inlet_stamp_sources_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.inlet_stamp_source_personal(NEW.url, NEW.content_type, NEW.metadata, NEW.content) THEN
        RAISE EXCEPTION 'inlet stamp: a shared source may not be personal (an email body, a podcast transcript or a Gmail id); nothing was written'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.inlet_stamp_sources_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.inlet_stamp_is_dossier(JSONB) FROM PUBLIC;
DROP FUNCTION IF EXISTS public.inlet_stamp_source_personal(TEXT, TEXT, JSONB);   -- round 1's narrower predicate
REVOKE ALL ON FUNCTION public.inlet_stamp_source_personal(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;

-- the preconditions: nothing left for 440 to make private (run 440 first), checked under the locks
DO $$
DECLARE v_first TIMESTAMPTZ; n_t BIGINT; n_s BIGINT;
BEGIN
    SELECT o.first_run_at INTO v_first FROM public.inlet_owner o WHERE o.singleton;
    SELECT count(*) INTO n_t FROM public.thoughts t
     WHERE t.user_id IS NULL
       AND NOT (lower(coalesce(t.metadata ->> 'type', '')) = 'dossier' AND t.created_at > coalesce(v_first, '-infinity'::timestamptz));
    SELECT count(*) INTO n_s FROM public.sources s WHERE public.inlet_stamp_source_personal(s.url, s.content_type, s.metadata, s.content);
    IF n_t > 0 OR n_s > 0 THEN
        RAISE EXCEPTION 'inlet stamp: refused, nothing changed - % unowned thought(s) and % personal shared source(s) are still there: run slot 440 (init-inlet-owner.sql) first', n_t, n_s
            USING ERRCODE = '55000';
    END IF;
END $$;
CREATE OR REPLACE TRIGGER trg_inlet_stamp_sources
    BEFORE INSERT OR UPDATE ON public.sources
    FOR EACH ROW EXECUTE FUNCTION public.inlet_stamp_sources_guard();
ALTER TABLE public.sources ENABLE ALWAYS TRIGGER trg_inlet_stamp_sources;

-- the owner columns: the same rule as every owner (inlet_subject_ok) - never blank, never a service principal, never
-- the literal 'operator' (coordinator 2026-11-05: not even for a lab convenience; the labs use a real-shaped subject)
DO $$
DECLARE c TEXT[];
BEGIN
    FOREACH c SLICE 1 IN ARRAY ARRAY[
        ARRAY['podcast_episodes', 'owner_sub'], ARRAY['research_handbacks', 'owner_sub'],
        -- round 2 (F3, coordinator: podcasts are per user): the presenter model and the render requests too
        ARRAY['podcast_teams', 'owner_sub'], ARRAY['podcast_presenters', 'owner_sub'], ARRAY['podcast_voice_links', 'owner_sub'],
        ARRAY['podcast_formats', 'owner_sub'], ARRAY['podcast_render_requests', 'requester_sub'],
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

-- ── slot 450's door roles: NOT granted here. A 450 re-run takes every grant from its door roles and grants again from
-- its door map, so the door lines this slot needs live in 450's map (findings, "Door grants for 450's map").

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'inlet stamp: the owner record, the thoughts and sources guards and the owner checks are in place'; END $$;
COMMIT;
