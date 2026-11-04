-- ============================================================
-- Revert of slot 450 (init-rest-door-auth.sql, rw-rest-door-auth).
--
-- Put the DOOR back first (the old Caddyfile and the old openbrain-postgrest env: login postgres, anon role
-- service_role); the callers keep working on the old door (it strips the Authorization header they now send).
-- Then this file:
--   * EXECUTE to PUBLIC again on every function that had it before the first run (rest_door.fn_acl_before),
--     and the grants slot 450 made in its place taken away (rest_door.regrants), so every function's
--     effective ACL is what it was;
--   * postgres's default privileges grant EXECUTE to PUBLIC again (the built-in default);
--   * the door roles' policies, grants and the roles themselves, rest_setting_get, and the archive go.
-- With no archive (450 never ran, or this ran already) it says `no archive` and changes nothing.
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL search_path = pg_catalog, public;

DO $$
DECLARE
  g RECORD;
  r TEXT;
  n_pub INT := 0;
  n_rev INT := 0;
BEGIN
  IF to_regclass('rest_door.fn_acl_before') IS NULL THEN
    RAISE NOTICE 'rest door revert: no archive - nothing to revert';
    RETURN;
  END IF;

  -- 1. PUBLIC back where it was, the stand-in grants away
  FOR g IN SELECT p.oid::regprocedure AS sig FROM rest_door.fn_acl_before b
             JOIN pg_proc p ON p.oid::regprocedure::text = b.signature AND p.pronamespace = 'public'::regnamespace
            WHERE b.public_had LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', g.sig);
    n_pub := n_pub + 1;
  END LOOP;
  FOR g IN SELECT p.oid::regprocedure AS sig, x.role_name FROM rest_door.regrants x
             JOIN pg_proc p ON p.oid::regprocedure::text = x.signature AND p.pronamespace = 'public'::regnamespace
             JOIN pg_roles ro ON ro.rolname = x.role_name LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', g.sig, g.role_name);
    n_rev := n_rev + 1;
  END LOOP;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

  -- 2. the door roles: policies, grants, memberships, the roles
  FOR g IN SELECT pol.polname, c.relname FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
            WHERE c.relnamespace = 'public'::regnamespace AND pol.polname LIKE 'rest\_door\_%' LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', g.polname, g.relname);
  END LOOP;
  DROP FUNCTION IF EXISTS public.rest_setting_get(TEXT);
  FOREACH r IN ARRAY ARRAY['ob_rest_wiki', 'ob_rest_viewer', 'ob_rest_entity', 'ob_rest_digest', 'ob_rest_podcast',
                           'ob_rest_gmail_pull', 'ob_rest_gmail_prune', 'ob_rest_authenticator'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('DROP OWNED BY %I', r);   -- privileges only: the door roles own nothing
      EXECUTE format('DROP ROLE %I', r);
    END IF;
  END LOOP;

  DROP SCHEMA rest_door CASCADE;
  RAISE NOTICE 'rest door revert: EXECUTE to PUBLIC on % function(s) again, % stand-in grant(s) taken away, the door roles dropped',
    n_pub, n_rev;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
