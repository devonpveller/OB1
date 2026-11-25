-- check-document-versions.sql - rwr-doc-versions-api (slot 620): is the snapshots table in the shape the workbench
-- relies on? Read-only; prints counts and rule names only, never a snapshot's name, an owner or a hash.
--   psql -X -A -t -q -f check-document-versions.sql
-- Lines: "check: <what>=<count>" for each rule, then "check: OK" or "check: FAIL (<rules>)".
-- Rules: the table, its columns and its row-level security exist; service_role holds exactly SELECT and INSERT on it
-- and no other role (PUBLIC included) holds any right; no row has a malformed commit or blob id, an empty or over-long
-- name, an unknown kind, or an empty owner.
DO $$
DECLARE
  bad TEXT[] := ARRAY[]::TEXT[];
  n BIGINT;
BEGIN
  IF to_regclass('public.document_snapshots') IS NULL THEN
    RAISE NOTICE 'check: slot 620 is not applied';
    RAISE NOTICE 'check: FAIL (620 not applied)';
    RETURN;
  END IF;
  SELECT count(*) INTO n FROM (VALUES ('id'), ('owner_sub'), ('actor_sub'), ('commit_hash'), ('blob_hash'), ('name'), ('kind'), ('created_at')) c(col)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = 'document_snapshots' AND i.column_name = c.col);
  RAISE NOTICE 'check: columns_missing=%', n; IF n > 0 THEN bad := array_append(bad, 'columns_missing'); END IF;
  SELECT count(*) INTO n FROM pg_class WHERE oid = 'public.document_snapshots'::regclass AND NOT relrowsecurity;
  RAISE NOTICE 'check: table_without_rls=%', n; IF n > 0 THEN bad := array_append(bad, 'table_without_rls'); END IF;
  -- grants: exactly SELECT and INSERT for service_role, nothing for anyone else
  SELECT count(*) INTO n FROM (
    SELECT ro.rolname, a.privilege_type
      FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
     WHERE cl.oid = 'public.document_snapshots'::regclass AND ro.oid <> cl.relowner AND NOT ro.rolsuper
       AND NOT (ro.rolname = 'service_role' AND a.privilege_type IN ('SELECT', 'INSERT'))
  ) x;
  RAISE NOTICE 'check: unexpected_grants=%', n; IF n > 0 THEN bad := array_append(bad, 'unexpected_grants'); END IF;
  SELECT count(*) INTO n FROM (SELECT 1 FROM pg_class cl, aclexplode(cl.relacl) a
     WHERE cl.oid = 'public.document_snapshots'::regclass AND a.grantee = 0) x;
  RAISE NOTICE 'check: public_grants=%', n; IF n > 0 THEN bad := array_append(bad, 'public_grants'); END IF;
  SELECT count(*) INTO n FROM (VALUES ('SELECT'), ('INSERT')) p(priv)
   WHERE NOT EXISTS (SELECT 1 FROM pg_class cl, aclexplode(cl.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                      WHERE cl.oid = 'public.document_snapshots'::regclass AND ro.rolname = 'service_role' AND a.privilege_type = p.priv);
  RAISE NOTICE 'check: service_role_grants_missing=%', n; IF n > 0 THEN bad := array_append(bad, 'service_role_grants_missing'); END IF;
  -- the data rules
  SELECT count(*) INTO n FROM public.document_snapshots WHERE commit_hash !~ '^[0-9a-f]{40}$' OR blob_hash !~ '^[0-9a-f]{40}$';
  RAISE NOTICE 'check: malformed_ids=%', n; IF n > 0 THEN bad := array_append(bad, 'malformed_ids'); END IF;
  SELECT count(*) INTO n FROM public.document_snapshots WHERE char_length(name) NOT BETWEEN 1 AND 120 OR kind NOT IN ('named', 'before_restore');
  RAISE NOTICE 'check: bad_name_or_kind=%', n; IF n > 0 THEN bad := array_append(bad, 'bad_name_or_kind'); END IF;
  SELECT count(*) INTO n FROM public.document_snapshots WHERE owner_sub = '' OR actor_sub = '';
  RAISE NOTICE 'check: empty_owner=%', n; IF n > 0 THEN bad := array_append(bad, 'empty_owner'); END IF;
  IF array_length(bad, 1) IS NULL THEN RAISE NOTICE 'check: OK'; ELSE RAISE NOTICE 'check: FAIL (%)', array_to_string(bad, ', '); END IF;
END $$;
