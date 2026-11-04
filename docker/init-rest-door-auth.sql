-- ============================================================
-- The REST door asks who is calling (research-workbench rw-rest-door-auth). Slot 450.
--
-- Before this file, openbrain-rest (Caddy) stripped every credential and PostgREST ran every request as
-- its anonymous role, service_role: any process on the stack host or the open-brain network read every
-- table and ran every function, owner arguments included (idea_capture(p_owner ...), setting_get(p_owner
-- ...), user_setting_set(p_owner ...)). This file is the database half of the fix:
--   * the door's callers get one role each (ob_rest_<caller>, NOLOGIN NOINHERIT, never a member of
--     service_role), holding only what that caller's code does through the door (the inventory in
--     findings/rw-rest-door-auth.md); a new table or function is on no door role until someone grants it;
--   * PostgREST logs in as ob_rest_authenticator (LOGIN NOINHERIT), a member of the door roles ONLY, so a
--     validly signed token naming service_role, postgres, ob_app_memory or anon cannot switch to it
--     (compose drops PGRST_DB_ANON_ROLE, so a request without a token reaches no role at all);
--   * no door role can run a function that takes an owner argument; the two door callers that read a
--     setting call rest_setting_get(p_key), which takes the owner from the token's verified `sub`;
--   * EXECUTE is revoked from PUBLIC on every function in schema public (extension functions included),
--     and postgres's default privileges stop granting it to PUBLIC. Every non-door role that could run a
--     function before keeps it: the grants it got through PUBLIC are re-granted to it directly, GENERATED
--     from the catalog (pg_proc ACLs and role membership), so the file is correct whichever of slot 440
--     (inlet_*) and this one lands first.
-- service_role keeps every privilege it has (ob_app_memory and ob_plane_personal reach it over direct
-- Postgres: the workbench, research, refinery, curator, workers, MCP). Nothing here reads or moves a row.
--
-- The authenticator's password is not in this file: it is set out of band from OB_REST_AUTHENTICATOR_PASSWORD
-- (OB1/docker/rest-door/mint-rest-tokens.ps1 -SetAuthenticatorPassword; the ob_pantry / ob_app_memory way).
-- Idempotent: a re-run recomputes the door grants and re-grants nothing new. Fresh volume: slot 450. Live:
-- psql -f (seconds; lock_timeout 10s below), then the password, then the callers' code, then the door switch
-- (test plan, Live deploy). Revert: revert-rest-door-auth.sql (puts every function ACL back from the archive).
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL search_path = pg_catalog, public;

-- ------------------------------------------------------------
-- 0. The archive (not in PostgREST's schemas): every public function's ACL before the first run of this file,
--    and every grant this file made in place of PUBLIC's - the revert's input.
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS rest_door;
REVOKE ALL ON SCHEMA rest_door FROM PUBLIC;

CREATE TABLE IF NOT EXISTS rest_door.fn_acl_before (
    signature  TEXT PRIMARY KEY,            -- oid::regprocedure::text
    public_had BOOLEAN NOT NULL,            -- PUBLIC could EXECUTE it (an explicit =X or the NULL default)
    proacl     TEXT,                        -- the ACL as it was (NULL = the default)
    taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rest_door.regrants (
    signature TEXT NOT NULL,
    role_name TEXT NOT NULL,
    PRIMARY KEY (signature, role_name)
);
REVOKE ALL ON ALL TABLES IN SCHEMA rest_door FROM PUBLIC;

-- first run only: the before-state. A function created later (slot 440 landing second) is not in it; its
-- PUBLIC grant (if its file made one) is handled the same way below and recorded as it is revoked.
INSERT INTO rest_door.fn_acl_before (signature, public_had, proacl)
SELECT p.oid::regprocedure::text,
       EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
       p.proacl::text
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
ON CONFLICT (signature) DO NOTHING;

-- ------------------------------------------------------------
-- 1. Roles. Cluster-wide; NOLOGIN NOINHERIT for the callers, LOGIN NOINHERIT for PostgREST's login.
-- ------------------------------------------------------------
DO $$
DECLARE
  r TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_rest_authenticator') THEN
    CREATE ROLE ob_rest_authenticator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
  ALTER ROLE ob_rest_authenticator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  FOREACH r IN ARRAY ARRAY['ob_rest_wiki', 'ob_rest_viewer', 'ob_rest_entity', 'ob_rest_digest', 'ob_rest_podcast',
                           'ob_rest_gmail_pull', 'ob_rest_gmail_prune'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION', r);
    END IF;
    EXECUTE format('ALTER ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION', r);
  END LOOP;
END $$;

-- The authenticator is a member of the door roles and of nothing else: whatever membership it was given
-- (by hand, by a past run) is taken away first, so a token can only ever name a door role.
DO $$
DECLARE
  m RECORD;
BEGIN
  FOR m IN SELECT r.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid
            WHERE a.member = 'ob_rest_authenticator'::regrole::oid AND r.rolname !~ '^ob_rest_(wiki|viewer|entity|digest|podcast|gmail_pull|gmail_prune)$' LOOP
    EXECUTE format('REVOKE %I FROM ob_rest_authenticator', m.rolname);
  END LOOP;
END $$;
GRANT ob_rest_wiki, ob_rest_viewer, ob_rest_entity, ob_rest_digest, ob_rest_podcast, ob_rest_gmail_pull, ob_rest_gmail_prune
   TO ob_rest_authenticator;

-- ------------------------------------------------------------
-- 2. rest_setting_get(p_key): a setting read for the owner the TOKEN names. PostgREST puts the verified claims
--    in request.jwt.claims; a door role has no way to set that GUC itself (no SQL, no function that sets one).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rest_setting_get(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_sub TEXT;
BEGIN
  BEGIN
    v_sub := NULLIF(btrim(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')), '');
  EXCEPTION WHEN others THEN
    v_sub := NULL;
  END;
  IF v_sub IS NULL OR v_sub LIKE 'service:%' THEN
    RAISE EXCEPTION 'rest_setting_get: the token names no owner' USING ERRCODE = '42501';
  END IF;
  RETURN public.setting_get(v_sub, p_key);
END
$fn$;
COMMENT ON FUNCTION public.rest_setting_get(TEXT) IS
  'rw-rest-door-auth: setting_get for the owner in the verified token''s sub (the REST door''s only settings read).';
-- only the door roles that read a setting (section 4) run it; a direct-Postgres service calls setting_get itself
REVOKE ALL ON FUNCTION public.rest_setting_get(TEXT) FROM PUBLIC, service_role;

-- ------------------------------------------------------------
-- 3. EXECUTE leaves PUBLIC. Generated: for every public function PUBLIC can run, every non-door role that can
--    run it ONLY through PUBLIC (no direct grant to it or to a role it inherits from) gets a direct grant
--    first, recorded for the revert. Superusers, pg_* roles, anon/authenticated (PostgREST's old roles, now
--    reachable by nobody) and the door roles are not re-granted anything.
-- ------------------------------------------------------------
CREATE TEMP TABLE _rda_regrant ON COMMIT DROP AS
SELECT p.oid AS fn, p.oid::regprocedure::text AS signature, r.rolname AS role_name
  FROM pg_proc p
  CROSS JOIN pg_roles r
 WHERE p.pronamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
   AND NOT r.rolsuper
   AND r.rolname !~ '^pg_'
   AND r.rolname NOT IN ('anon', 'authenticated', 'ob_rest_authenticator')
   AND r.rolname !~ '^ob_rest_'
   AND NOT EXISTS (
         SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee <> 0 AND a.privilege_type = 'EXECUTE'
            AND pg_has_role(r.oid, a.grantee, 'USAGE'));

DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN SELECT * FROM _rda_regrant LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', g.fn::regprocedure, g.role_name);
  END LOOP;
END $$;
INSERT INTO rest_door.regrants (signature, role_name) SELECT signature, role_name FROM _rda_regrant
ON CONFLICT DO NOTHING;
-- a function created after the first run (440 landing second) that PUBLIC could run: archive its before-state too
INSERT INTO rest_door.fn_acl_before (signature, public_had, proacl)
SELECT p.oid::regprocedure::text, true, p.proacl::text
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
ON CONFLICT (signature) DO UPDATE SET public_had = true;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
-- the built-in default (EXECUTE to PUBLIC on every new function) is a GLOBAL default: it can only be taken
-- away without IN SCHEMA. service_role's own default grant (init-grants.sql) stays.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ------------------------------------------------------------
-- 4. The door roles: exactly what each caller's code does through the door (findings, section 2). Re-runnable:
--    everything a door role held is taken away first, then granted again from this map.
-- ------------------------------------------------------------
DO $$
DECLARE
  r TEXT;
  p RECORD;
BEGIN
  FOREACH r IN ARRAY ARRAY['ob_rest_wiki', 'ob_rest_viewer', 'ob_rest_entity', 'ob_rest_digest', 'ob_rest_podcast',
                           'ob_rest_gmail_pull', 'ob_rest_gmail_prune'] LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  END LOOP;
  FOR p IN SELECT pol.polname, c.relname FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
            WHERE c.relnamespace = 'public'::regnamespace AND pol.polname LIKE 'rest\_door\_%' LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.polname, p.relname);
  END LOOP;
END $$;

CREATE TEMP TABLE _rda_map (role_name TEXT, rel TEXT, privs TEXT) ON COMMIT DROP;
INSERT INTO _rda_map VALUES
  -- openbrain-wiki: wiki-service.mjs, the shared wiki-pages / reconcile / compile-notify modules, and the two
  -- children it spawns (entity-wiki/generate-wiki.mjs, wiki-synthesis/scripts/synthesize-notebooks.mjs)
  ('ob_rest_wiki', 'entities',          'SELECT, UPDATE'),
  ('ob_rest_wiki', 'thought_entities',  'SELECT'),
  ('ob_rest_wiki', 'source_entities',   'SELECT'),
  ('ob_rest_wiki', 'edges',             'SELECT'),
  ('ob_rest_wiki', 'threads',           'SELECT, INSERT, UPDATE'),
  ('ob_rest_wiki', 'thread_sources',    'SELECT, INSERT'),
  ('ob_rest_wiki', 'sources',           'SELECT'),
  ('ob_rest_wiki', 'thoughts',          'SELECT, INSERT, UPDATE, DELETE'),   -- the note-file mirror (ops plane by policy)
  ('ob_rest_wiki', 'wiki_pages',        'SELECT, INSERT, UPDATE, DELETE'),
  -- post_research_notification (SECURITY INVOKER): checks the class in the registry view, upserts the notification
  ('ob_rest_wiki', 'contract_registry_view', 'SELECT'),
  ('ob_rest_wiki', 'research_notifications', 'SELECT, INSERT, UPDATE'),
  -- openbrain-wiki-viewer: reads, and the reconcile's repair upsert
  ('ob_rest_viewer', 'wiki_pages',      'SELECT, INSERT, UPDATE'),
  -- openbrain-entity-worker (supabase-js)
  ('ob_rest_entity', 'entities',                'SELECT, INSERT, UPDATE'),
  ('ob_rest_entity', 'thought_entities',        'SELECT, INSERT, UPDATE, DELETE'),
  ('ob_rest_entity', 'edges',                   'SELECT, INSERT, UPDATE'),
  ('ob_rest_entity', 'entity_extraction_queue', 'SELECT, UPDATE'),
  ('ob_rest_entity', 'source_extraction_queue', 'SELECT, UPDATE'),
  ('ob_rest_entity', 'thoughts',                'SELECT'),
  ('ob_rest_entity', 'sources',                 'SELECT'),
  ('ob_rest_entity', 'source_entities',         'SELECT, INSERT, UPDATE, DELETE'),
  -- openbrain-digest
  ('ob_rest_digest', 'thoughts',        'SELECT'),
  -- openbrain-podcast (the render service and the link-enrich run it spawns)
  ('ob_rest_podcast', 'podcast_render_requests', 'SELECT, UPDATE'),
  ('ob_rest_podcast', 'podcast_teams',           'SELECT'),
  ('ob_rest_podcast', 'podcast_team_members',    'SELECT'),
  ('ob_rest_podcast', 'podcast_presenters',      'SELECT'),
  ('ob_rest_podcast', 'podcast_voice_links',     'SELECT'),
  ('ob_rest_podcast', 'podcast_episodes',        'SELECT, INSERT'),
  ('ob_rest_podcast', 'thoughts',                'SELECT'),
  -- the metadata merge, and find_or_create_source / link_source_to_thread (both SECURITY INVOKER: they find or
  -- insert the transcript's source and upsert its thread link as the caller)
  ('ob_rest_podcast', 'sources',                 'SELECT, INSERT, UPDATE'),
  ('ob_rest_podcast', 'thread_sources',          'SELECT, INSERT, UPDATE'),
  -- the sources insert's tombstone gate (trg_sources_tombstone_gate, SECURITY INVOKER) reads the tombstones
  ('ob_rest_podcast', 'source_tombstones',       'SELECT'),
  -- openbrain-gmail-pull: inserts ops-plane thoughts (return=representation reads the row back)
  ('ob_rest_gmail_pull', 'thoughts',    'SELECT, INSERT'),
  -- openbrain-gmail-prune: previews and deletes expired gmail thoughts; the delete trigger
  -- (touch_entities_for_deleted_thought, SECURITY INVOKER) touches the linked entities
  ('ob_rest_gmail_prune', 'thoughts',          'SELECT, DELETE'),
  ('ob_rest_gmail_prune', 'thought_entities',  'SELECT'),
  ('ob_rest_gmail_prune', 'entities',          'UPDATE');
-- the delete trigger's UPDATE ... WHERE id IN (...) reads entities.id too
INSERT INTO _rda_map VALUES ('ob_rest_gmail_prune', 'entities', 'SELECT');
-- the wiki's note mirror deletes thoughts too (same trigger)
-- (ob_rest_wiki already holds SELECT/UPDATE on entities and SELECT on thought_entities)

-- whole extensions a caller's queries need: match_thoughts orders by pgvector's distance operator
CREATE TEMP TABLE _rda_ext (role_name TEXT, ext TEXT) ON COMMIT DROP;
INSERT INTO _rda_ext VALUES ('ob_rest_digest', 'vector');

CREATE TEMP TABLE _rda_fn (role_name TEXT, fn TEXT) ON COMMIT DROP;
INSERT INTO _rda_fn VALUES
  ('ob_rest_wiki',    'post_research_notification'),
  ('ob_rest_wiki',    'contract_registry_has'),
  ('ob_rest_digest',  'match_thoughts'),
  ('ob_rest_digest',  'rest_setting_get'),
  ('ob_rest_podcast', 'find_or_create_source'),
  ('ob_rest_podcast', 'link_source_to_thread'),
  ('ob_rest_podcast', 'rest_setting_get');

DO $$
DECLARE
  m RECORD;
  f RECORD;
  missing TEXT;
BEGIN
  -- a map entry naming a relation or function that does not exist is a broken map, not a skip
  SELECT string_agg(DISTINCT rel, ', ') INTO missing FROM _rda_map
   WHERE to_regclass('public.' || quote_ident(rel)) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'rest door: the door map names relations that do not exist: %', missing USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(DISTINCT x.fn, ', ') INTO missing FROM _rda_fn x
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = x.fn AND p.pronamespace = 'public'::regnamespace);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'rest door: the door map names functions that do not exist: %', missing USING ERRCODE = '55000';
  END IF;

  FOR m IN SELECT * FROM _rda_map LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I', m.privs, m.rel, m.role_name);
  END LOOP;
  FOR f IN SELECT x.role_name, p.oid::regprocedure AS sig FROM _rda_fn x
             JOIN pg_proc p ON p.proname = x.fn AND p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, f.role_name);
  END LOOP;
  FOR f IN SELECT DISTINCT x.role_name, p.oid::regprocedure AS sig FROM _rda_ext x
             JOIN pg_extension e ON e.extname = x.ext
             JOIN pg_depend d ON d.refclassid = 'pg_extension'::regclass AND d.refobjid = e.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
             JOIN pg_proc p ON p.oid = d.objid LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, f.role_name);
  END LOOP;
END $$;

-- Generated from the map: the sequences behind the columns a door role INSERTs (serial / identity), and the
-- functions the defaults and the CHECK constraints of the tables it writes call (they run as the caller).
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN SELECT DISTINCT m.role_name, s.oid::regclass AS seq
             FROM _rda_map m
             JOIN pg_depend d ON d.refobjid = ('public.' || quote_ident(m.rel))::regclass AND d.classid = 'pg_class'::regclass
                             AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
             JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
            WHERE m.privs ~ 'INSERT' LOOP
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I', g.seq, g.role_name);
  END LOOP;
  FOR g IN SELECT DISTINCT m.role_name, p.oid::regprocedure AS sig
             FROM _rda_map m
             JOIN pg_attrdef ad ON ad.adrelid = ('public.' || quote_ident(m.rel))::regclass
             JOIN pg_depend d ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid AND d.refclassid = 'pg_proc'::regclass
             JOIN pg_proc p ON p.oid = d.refobjid AND p.pronamespace = 'public'::regnamespace
            WHERE m.privs ~ '(INSERT|UPDATE)' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', g.sig, g.role_name);
  END LOOP;
  FOR g IN SELECT DISTINCT m.role_name, p.oid::regprocedure AS sig
             FROM _rda_map m
             JOIN pg_constraint co ON co.conrelid = ('public.' || quote_ident(m.rel))::regclass AND co.contype = 'c'
             JOIN pg_depend d ON d.classid = 'pg_constraint'::regclass AND d.objid = co.oid AND d.refclassid = 'pg_proc'::regclass
             JOIN pg_proc p ON p.oid = d.refobjid AND p.pronamespace = 'public'::regnamespace
            WHERE m.privs ~ '(INSERT|UPDATE)' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', g.sig, g.role_name);
  END LOOP;
END $$;

-- Generated from the map: on a table with row security, a door role gets a copy of each policy service_role has
-- there (same command, permissive/restrictive, USING and WITH CHECK) - the door serves what it served before,
-- narrowed to the role's table grants - and EXECUTE on the functions those policies call. A policy TO PUBLIC
-- already applies to the door roles and is not copied.
DO $$
DECLARE
  g RECORD;
  n INT := 0;
BEGIN
  FOR g IN SELECT DISTINCT m.role_name, c.relname, pol.polname, pol.polpermissive, pol.polcmd,
                  pg_get_expr(pol.polqual, pol.polrelid) AS qual, pg_get_expr(pol.polwithcheck, pol.polrelid) AS wc
             FROM (SELECT DISTINCT role_name, rel FROM _rda_map) m
             JOIN pg_class c ON c.oid = ('public.' || quote_ident(m.rel))::regclass AND c.relrowsecurity
             JOIN pg_policy pol ON pol.polrelid = c.oid AND 'service_role'::regrole::oid = ANY (pol.polroles)
            ORDER BY 1, 2, 3 LOOP
    n := n + 1;
    EXECUTE format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %I%s%s',
      left('rest_door_' || substr(md5(g.role_name || '/' || g.relname || '/' || g.polname), 1, 10) || '_' || g.polname, 63),
      g.relname,
      CASE WHEN g.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE g.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
      g.role_name,
      CASE WHEN g.qual IS NULL THEN '' ELSE ' USING (' || g.qual || ')' END,
      CASE WHEN g.wc IS NULL THEN '' ELSE ' WITH CHECK (' || g.wc || ')' END);
  END LOOP;
  FOR g IN SELECT DISTINCT r.rolname AS role_name, p.oid::regprocedure AS sig
             FROM pg_policy pol
             JOIN pg_roles r ON r.oid = ANY (pol.polroles) AND r.rolname ~ '^ob_rest_'
             JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid AND d.refclassid = 'pg_proc'::regclass
             JOIN pg_proc p ON p.oid = d.refobjid AND p.pronamespace = 'public'::regnamespace
            WHERE pol.polname LIKE 'rest\_door\_%' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', g.sig, g.role_name);
  END LOOP;
  RAISE NOTICE 'rest door: % policy cop(ies) for the door roles', n;
END $$;

-- Generated: what the code a door role runs calls in turn. A SECURITY INVOKER function, a trigger on a table the
-- role writes, or a CHECK constraint runs with the CALLER's privileges, so every public function named in its body
-- needs EXECUTE too (credibility_stamp_ok -> credibility_is_unit, find_or_create_source -> contract_url_key,
-- trg_thoughts_fingerprint -> pgcrypto's digest, ...). PostgreSQL records no dependency for a plpgsql / plain sql
-- body, so the closure is taken over the function sources: a public function whose name appears called
-- (`name(` or `public.name(`) in the body of one the role runs as itself. A SECURITY DEFINER function runs as its
-- owner: its body adds nothing. Section 5 still refuses any owner-argument function this pulls in.
DO $$
DECLARE
  added INT;
  rounds INT := 0;
BEGIN
  CREATE TEMP TABLE _rda_run (role_name TEXT, fn OID, PRIMARY KEY (role_name, fn)) ON COMMIT DROP;
  -- roots: what the role may execute now, the trigger functions of the tables it writes, the CHECK functions there
  INSERT INTO _rda_run
  SELECT DISTINCT r.rolname, p.oid FROM pg_roles r JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace
   WHERE r.rolname ~ '^ob_rest_(wiki|viewer|entity|digest|podcast|gmail_pull|gmail_prune)$' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
  ON CONFLICT DO NOTHING;
  INSERT INTO _rda_run
  SELECT DISTINCT m.role_name, t.tgfoid FROM _rda_map m
    JOIN pg_trigger t ON t.tgrelid = ('public.' || quote_ident(m.rel))::regclass AND NOT t.tgisinternal
   WHERE m.privs ~ '(INSERT|UPDATE|DELETE)'
  ON CONFLICT DO NOTHING;
  LOOP
    rounds := rounds + 1;
    INSERT INTO _rda_run
    SELECT DISTINCT run.role_name, callee.oid
      FROM _rda_run run
      JOIN pg_proc caller ON caller.oid = run.fn AND NOT caller.prosecdef AND caller.prolang IN (
             SELECT oid FROM pg_language WHERE lanname IN ('plpgsql', 'sql'))
      JOIN pg_proc callee ON callee.pronamespace = 'public'::regnamespace
       AND caller.prosrc ~* ('(^|[^a-z0-9_.])(public\.)?' || callee.proname || '\s*\(')
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;
    EXIT WHEN added = 0 OR rounds > 20;
  END LOOP;
  -- grant: everything in the closure except the trigger functions themselves (a trigger needs no EXECUTE to fire)
  DECLARE
    g RECORD;
  BEGIN
    FOR g IN SELECT run.role_name, p.oid::regprocedure AS sig FROM _rda_run run JOIN pg_proc p ON p.oid = run.fn
              WHERE p.pronamespace = 'public'::regnamespace AND p.prorettype <> 'trigger'::regtype
                AND NOT has_function_privilege(run.role_name, p.oid, 'EXECUTE') LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', g.sig, g.role_name);
    END LOOP;
  END;
  RAISE NOTICE 'rest door: the call closure took % round(s)', rounds;
END $$;

-- ------------------------------------------------------------
-- 5. Assertions (the file refuses rather than leaving a half door): no door role, nor the authenticator, can
--    run a function that takes an owner argument; PUBLIC can run nothing in public; the authenticator reaches
--    only door roles and no role with BYPASSRLS / superuser.
-- ------------------------------------------------------------
DO $$
DECLARE
  bad TEXT;
  n_regrant INT;
BEGIN
  SELECT string_agg(r.rolname || ':' || p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p CROSS JOIN pg_roles r
   WHERE p.pronamespace = 'public'::regnamespace AND (r.rolname ~ '^ob_rest_')
     AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
     AND (pg_get_function_identity_arguments(p.oid) ~* '\m(p_owner|p_owner_sub|owner_sub|p_sub|p_user_id|p_requester)\M'
          OR p.proname IN ('research_job_report_owner', 'setting_get', 'setting_problem', 'user_setting_set'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'rest door: a door role can run an owner-argument function: %', bad USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'rest door: PUBLIC can still run: %', bad USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(r.rolname, ', ') INTO bad
    FROM pg_roles r
   WHERE pg_has_role('ob_rest_authenticator', r.oid, 'MEMBER') AND r.rolname <> 'ob_rest_authenticator'
     AND (r.rolname !~ '^ob_rest_(wiki|viewer|entity|digest|podcast|gmail_pull|gmail_prune)$' OR r.rolsuper OR r.rolbypassrls);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'rest door: the authenticator reaches a role that is not a door role: %', bad USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO n_regrant FROM _rda_regrant;
  RAISE NOTICE 'rest door: % function grant(s) made in place of PUBLIC''s this run (% recorded in all); 7 door roles',
    n_regrant, (SELECT count(*) FROM rest_door.regrants);
END $$;

COMMIT;

-- PostgREST schema-cache reload (a running PostgREST picks up rest_setting_get without a restart).
NOTIFY pgrst, 'reload schema';
