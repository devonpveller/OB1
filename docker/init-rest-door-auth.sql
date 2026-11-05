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
-- LATER SLOTS AND THE DOOR (rw-rest-door-auth review R2). A slot after 450 adds what a door caller needs to THE DOOR
-- MAP below (section 4) - never by its own GRANT to an ob_rest_* role: every run of this file takes each door role's
-- grants away and grants again from the map, so a direct grant does not survive a re-run. A map line for an object a
-- later slot creates carries that slot's number (`slot` column): it is skipped (NOTICE) until the object exists, and
-- the chain's last mount (990, this file again) grants it on a fresh volume; on live, re-run this file after the slot.
--
-- OWNER ARGUMENTS (section 5). No door role may run a function that takes an owner (an argument named p_owner /
-- owner_sub / p_sub / p_user_id / p_requester, or the named owner functions) - EXCEPT a pure predicate: a function that
-- returns boolean, is IMMUTABLE (it may not read a table), and is not SECURITY DEFINER. Such a function answers a
-- question about the value it is given (a CHECK's "is this owner well formed") and can read or write nothing for an owner.
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
                           'ob_rest_gmail_pull', 'ob_rest_gmail_prune', 'ob_rest_import'] LOOP
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
            WHERE a.member = 'ob_rest_authenticator'::regrole::oid AND r.rolname !~ '^ob_rest_(wiki|viewer|entity|digest|podcast|gmail_pull|gmail_prune|import)$' LOOP
    EXECUTE format('REVOKE %I FROM ob_rest_authenticator', m.rolname);
  END LOOP;
END $$;
GRANT ob_rest_wiki, ob_rest_viewer, ob_rest_entity, ob_rest_digest, ob_rest_podcast, ob_rest_gmail_pull, ob_rest_gmail_prune,
      ob_rest_import
   TO ob_rest_authenticator;

-- ------------------------------------------------------------
-- 2. rest_setting_get(p_key): a setting read for the owner the TOKEN names, of a key the token's ROLE may read.
--    PostgREST puts the verified claims in request.jwt.claims (and has switched to the claim's role); a door role
--    has no way to set that GUC itself (no SQL, no function that sets one). The key allow-list is each caller's
--    `setting` lines in section 4 (rest_door.setting_keys): a key prefix per role, and only USER-tier keys - an
--    admin-tier key (the shared store) is never readable from the door.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rest_door.setting_keys (
    role_name  TEXT NOT NULL,
    key_prefix TEXT NOT NULL CHECK (key_prefix ~ '^[a-z][a-z0-9_]*\.$'),
    PRIMARY KEY (role_name, key_prefix)
);
REVOKE ALL ON rest_door.setting_keys FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.rest_setting_get(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_claims JSONB;
  v_sub TEXT;
  v_role TEXT;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION WHEN others THEN
    v_claims := NULL;
  END;
  v_sub := NULLIF(btrim(COALESCE(v_claims ->> 'sub', '')), '');
  v_role := COALESCE(v_claims ->> 'role', '');
  IF v_sub IS NULL OR v_sub ILIKE 'service:%' THEN
    RAISE EXCEPTION 'rest_setting_get: the token names no owner' USING ERRCODE = '42501';
  END IF;
  -- the claim's role is the role PostgREST switched to; it must also be the session's role (no claims set by hand)
  IF v_role = '' OR v_role IS DISTINCT FROM current_setting('role', true) THEN
    RAISE EXCEPTION 'rest_setting_get: no caller role' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rest_door.setting_keys k
                  WHERE k.role_name = v_role AND left(p_key, length(k.key_prefix)) = k.key_prefix)
     OR NOT EXISTS (SELECT 1 FROM public.settings_keys sk WHERE sk.key = p_key AND sk.tier = 'user') THEN
    RAISE EXCEPTION 'rest_setting_get: this caller may not read that setting' USING ERRCODE = '42501';
  END IF;
  RETURN public.setting_get(v_sub, p_key);
END
$fn$;
COMMENT ON FUNCTION public.rest_setting_get(TEXT) IS
  'rw-rest-door-auth: setting_get for the owner in the verified token''s sub, of a user-tier key the caller''s role may read (rest_door.setting_keys).';
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
-- R1 (the review): a restore with --no-acl (the runbook's) recreates every function under the CURRENT default ACLs -
-- PUBLIC no longer holds them, so the query above finds nothing - and drops the stand-in grants, while
-- rest_door.regrants comes back as data. Every archived stand-in whose function and role exist is granted again.
DO $$
DECLARE
  g RECORD;
  n INT := 0;
BEGIN
  FOR g IN SELECT to_regprocedure(x.signature) AS fn, x.role_name FROM rest_door.regrants x
            WHERE to_regprocedure(x.signature) IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = x.role_name)
              AND NOT has_function_privilege(x.role_name, to_regprocedure(x.signature), 'EXECUTE') LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', g.fn, g.role_name);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'rest door: % archived stand-in grant(s) given back (after a restore without ACLs; 0 otherwise)', n;
END $$;
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
                           'ob_rest_gmail_pull', 'ob_rest_gmail_prune', 'ob_rest_import'] LOOP
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

-- THE DOOR MAP: one block per caller. A caller's whole grant is its block - the tables (with privileges), the
-- functions, whole extensions, and the setting-key prefixes rest_setting_get lets it read. Everything else a
-- role gets (sequences, functions in defaults / CHECKs / copied policies, the call closure) is generated from
-- these lines below. To change what a caller may do, change its block and nothing else.
--   kind: table (object = relation, privs = privileges) | column (object = relation.column, privs) |
--         function (object = name, every overload) | extension (object = extension name: all its functions) |
--         setting (object = key prefix, e.g. 'digest.')
--   slot (5th column): NULL = the object must exist (a missing one is a broken map: the file refuses); a number = a
--         LATER slot creates it - skipped with a NOTICE until it exists (see the header, LATER SLOTS AND THE DOOR)
CREATE TEMP TABLE _rda_door (role_name TEXT, kind TEXT, object TEXT, privs TEXT, slot INT) ON COMMIT DROP;
INSERT INTO _rda_door (role_name, kind, object, privs) VALUES
  -- == openbrain-wiki ==================================================================================
  -- wiki-service.mjs, the shared wiki-pages / reconcile / compile-notify modules, and the two children it spawns
  -- (entity-wiki/generate-wiki.mjs, wiki-synthesis/scripts/synthesize-notebooks.mjs)
  ('ob_rest_wiki', 'table', 'entities',               'SELECT, UPDATE'),
  ('ob_rest_wiki', 'table', 'thought_entities',       'SELECT'),
  ('ob_rest_wiki', 'table', 'source_entities',        'SELECT'),
  ('ob_rest_wiki', 'table', 'edges',                  'SELECT'),
  ('ob_rest_wiki', 'table', 'threads',                'SELECT, INSERT, UPDATE'),
  ('ob_rest_wiki', 'table', 'thread_sources',         'SELECT, INSERT'),
  ('ob_rest_wiki', 'table', 'sources',                'SELECT'),
  ('ob_rest_wiki', 'table', 'thoughts',               'SELECT, INSERT, UPDATE, DELETE'),  -- the note-file mirror (ops plane by policy)
  ('ob_rest_wiki', 'table', 'wiki_pages',             'SELECT, INSERT, UPDATE, DELETE'),
  ('ob_rest_wiki', 'function', 'post_research_notification', NULL),
  -- post_research_notification is SECURITY INVOKER: it checks the class in the registry view, upserts the notification
  ('ob_rest_wiki', 'table', 'contract_registry_view', 'SELECT'),
  ('ob_rest_wiki', 'table', 'research_notifications', 'SELECT, INSERT, UPDATE'),
  ('ob_rest_wiki', 'function', 'contract_registry_has', NULL),

  -- == openbrain-wiki-viewer ===========================================================================
  -- reads, and the reconcile's repair upsert
  ('ob_rest_viewer', 'table', 'wiki_pages', 'SELECT, INSERT, UPDATE'),

  -- == openbrain-entity-worker (supabase-js) ===========================================================
  ('ob_rest_entity', 'table', 'entities',                'SELECT, INSERT, UPDATE'),
  ('ob_rest_entity', 'table', 'thought_entities',        'SELECT, INSERT, UPDATE, DELETE'),
  ('ob_rest_entity', 'table', 'edges',                   'SELECT, INSERT, UPDATE'),
  ('ob_rest_entity', 'table', 'entity_extraction_queue', 'SELECT, UPDATE'),
  ('ob_rest_entity', 'table', 'source_extraction_queue', 'SELECT, UPDATE'),
  ('ob_rest_entity', 'table', 'thoughts',                'SELECT'),
  ('ob_rest_entity', 'table', 'sources',                 'SELECT'),
  ('ob_rest_entity', 'table', 'source_entities',         'SELECT, INSERT, UPDATE, DELETE'),

  -- == openbrain-digest ================================================================================
  ('ob_rest_digest', 'table', 'thoughts', 'SELECT'),
  ('ob_rest_digest', 'function', 'match_thoughts', NULL),
  ('ob_rest_digest', 'extension', 'vector', NULL),          -- match_thoughts orders by pgvector's distance operator
  ('ob_rest_digest', 'function', 'rest_setting_get', NULL),
  ('ob_rest_digest', 'setting', 'digest.', NULL),

  -- == openbrain-podcast (the render service and the link-enrich run it spawns) ========================
  ('ob_rest_podcast', 'table', 'podcast_render_requests', 'SELECT, UPDATE'),
  ('ob_rest_podcast', 'table', 'podcast_teams',           'SELECT'),
  ('ob_rest_podcast', 'table', 'podcast_team_members',    'SELECT'),
  ('ob_rest_podcast', 'table', 'podcast_presenters',      'SELECT'),
  ('ob_rest_podcast', 'table', 'podcast_voice_links',     'SELECT'),
  ('ob_rest_podcast', 'table', 'podcast_episodes',        'SELECT, INSERT'),
  ('ob_rest_podcast', 'table', 'thoughts',                'SELECT'),
  ('ob_rest_podcast', 'function', 'rest_setting_get', NULL),
  ('ob_rest_podcast', 'setting', 'podcast.', NULL),
  -- rw-boundary-digest (slot 460): link-enrich's loop-close stores the transcript on the owner's own episode row
  -- (PresenterStore.setTranscript: PATCH podcast_episodes?id=eq.&owner_sub=eq.&select=id, {transcript}) instead of a
  -- shared sources row + thread link - so UPDATE of that one column (the filter and the returned id are read under the
  -- table SELECT above), and none of the old loop-close grants (sources writes, thread_sources, source_tombstones,
  -- find_or_create_source, link_source_to_thread). The column exists only once slot 460 ran: the grant is skipped
  -- (NOTICE) until then, and the chain's slot 990 re-run applies it on a fresh volume.
  ('ob_rest_podcast', 'column', 'podcast_episodes.transcript', 'UPDATE'),

  -- == openbrain-gmail-pull ============================================================================
  -- inserts ops-plane thoughts (return=representation reads the row back)
  ('ob_rest_gmail_pull', 'table', 'thoughts', 'SELECT, INSERT'),

  -- == openbrain-gmail-prune ===========================================================================
  -- previews and deletes expired gmail thoughts; the delete trigger (touch_entities_for_deleted_thought, SECURITY
  -- INVOKER) touches the linked entities (UPDATE ... WHERE id IN (SELECT entity_id FROM thought_entities ...))
  ('ob_rest_gmail_prune', 'table', 'thoughts',         'SELECT, DELETE'),
  ('ob_rest_gmail_prune', 'table', 'thought_entities', 'SELECT'),
  ('ob_rest_gmail_prune', 'table', 'entities',         'SELECT, UPDATE');

-- == objects of LATER slots (the 5th column), each in its caller's block's spirit ===========================
INSERT INTO _rda_door (role_name, kind, object, privs, slot) VALUES
  -- rw-inlet-stamp (slot 470): every writer that stamps an owner reads it from the connection record
  ('ob_rest_gmail_pull',  'function', 'inlet_connection_owner', NULL, 470),   -- pull-gmail.ts (inlet-owner.ts)
  ('ob_rest_digest',      'function', 'inlet_connection_owner', NULL, 470),   -- src/app.ts (owner-sub.ts digestOwnerResolver)
  ('ob_rest_podcast',     'function', 'inlet_connection_owner', NULL, 470),   -- link-enrich.ts (owner-sub.ts digestOwner)
  ('ob_rest_wiki',        'function', 'inlet_connection_owner', NULL, 470),   -- wiki-service.mjs noteOwner (the vault)
  ('ob_rest_gmail_prune', 'table',    'inlet_connection_mail',  'SELECT, DELETE', 470),  -- prune-short-term.ts (per connection)

-- == the import scripts (google-activity-import, chatgpt-conversation-import: host CLIs the operator runs; slot 470) ====
  ('ob_rest_import', 'table',     'thoughts',       'SELECT, INSERT', NULL),   -- SELECT: match_thoughts (SECURITY INVOKER) reads them (ops plane by policy)
  ('ob_rest_import', 'function',  'match_thoughts', NULL,     NULL),   -- the ChatGPT import's dedup (filter.owner_scope)
  ('ob_rest_import', 'extension', 'vector',         NULL,     NULL);   -- match_thoughts orders by pgvector's distance

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _rda_door WHERE role_name !~ '^ob_rest_(wiki|viewer|entity|digest|podcast|gmail_pull|gmail_prune|import)$'
                                       OR (slot IS NOT NULL AND slot <= 450)
                                       OR kind NOT IN ('table', 'column', 'function', 'extension', 'setting')
                                       OR (kind IN ('table', 'column')) <> (privs IS NOT NULL)
                                       OR (kind = 'column' AND object !~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$')) THEN
    RAISE EXCEPTION 'rest door: a door map line has an unknown role or kind, or privileges on a non-table' USING ERRCODE = '55000';
  END IF;
END $$;
-- a later slot's object that does not exist yet: skipped, said
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN SELECT * FROM _rda_door d
            WHERE d.slot IS NOT NULL
              AND ((d.kind IN ('table', 'column') AND to_regclass('public.' || quote_ident(split_part(d.object, '.', 1))) IS NULL)
                OR (d.kind = 'function' AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = d.object AND p.pronamespace = 'public'::regnamespace))
                OR (d.kind = 'extension' AND NOT EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = d.object))) LOOP
    RAISE NOTICE 'rest door: % % of slot % does not exist yet - not granted to % (a re-run after slot % grants it)',
      g.kind, g.object, g.slot, g.role_name, g.slot;
  END LOOP;
  DELETE FROM _rda_door d
   WHERE d.slot IS NOT NULL
     AND ((d.kind IN ('table', 'column') AND to_regclass('public.' || quote_ident(split_part(d.object, '.', 1))) IS NULL)
       OR (d.kind = 'function' AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = d.object AND p.pronamespace = 'public'::regnamespace))
       OR (d.kind = 'extension' AND NOT EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = d.object)));
END $$;
-- the views of the map the generators below read
CREATE TEMP TABLE _rda_map ON COMMIT DROP AS SELECT role_name, object AS rel, privs FROM _rda_door WHERE kind = 'table';
CREATE TEMP TABLE _rda_fn  ON COMMIT DROP AS SELECT role_name, object AS fn FROM _rda_door WHERE kind = 'function';
CREATE TEMP TABLE _rda_ext ON COMMIT DROP AS SELECT role_name, object AS ext FROM _rda_door WHERE kind = 'extension';
DELETE FROM rest_door.setting_keys;
INSERT INTO rest_door.setting_keys (role_name, key_prefix) SELECT role_name, object FROM _rda_door WHERE kind = 'setting';

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
  -- column grants, each guarded on its column existing (a later slot may add it; see the podcast block)
  FOR m IN SELECT role_name, split_part(object, '.', 1) AS rel, split_part(object, '.', 2) AS col, privs
             FROM _rda_door WHERE kind = 'column' LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || quote_ident(m.rel))
                AND a.attname = m.col AND a.attnum > 0 AND NOT a.attisdropped) THEN
      EXECUTE format('GRANT %s (%I) ON public.%I TO %I', m.privs, m.col, m.rel, m.role_name);
    ELSE
      RAISE NOTICE 'rest door: column %.% does not exist (yet): % of it NOT granted to %', m.rel, m.col, m.privs, m.role_name;
    END IF;
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
   WHERE r.rolname ~ '^ob_rest_(wiki|viewer|entity|digest|podcast|gmail_pull|gmail_prune|import)$' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
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
          OR p.proname IN ('research_job_report_owner', 'setting_get', 'setting_problem', 'user_setting_set'))
     -- a pure predicate is not an owner argument (header, OWNER ARGUMENTS): boolean, IMMUTABLE, not SECURITY DEFINER
     AND NOT (p.prorettype = 'boolean'::regtype AND p.provolatile = 'i' AND NOT p.prosecdef AND p.proretset = false
              AND p.proname NOT IN ('research_job_report_owner', 'setting_get', 'setting_problem', 'user_setting_set'));
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
     AND (r.rolname !~ '^ob_rest_(wiki|viewer|entity|digest|podcast|gmail_pull|gmail_prune|import)$' OR r.rolsuper OR r.rolbypassrls);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'rest door: the authenticator reaches a role that is not a door role: %', bad USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO n_regrant FROM _rda_regrant;
  RAISE NOTICE 'rest door: % function grant(s) made in place of PUBLIC''s this run (% recorded in all); 8 door roles',
    n_regrant, (SELECT count(*) FROM rest_door.regrants);
END $$;

COMMIT;

-- PostgREST schema-cache reload (a running PostgREST picks up rest_setting_get without a restart).
NOTIFY pgrst, 'reload schema';
