-- check-document-toplace.sql - rwr-doc-toplace-api (slot 630): is the "to place" queue in the shape the workbench relies on?
-- Read-only; prints counts only, never a path, an id, a quote or an owner.
--   psql -X -A -t -q -f check-document-toplace.sql
-- Lines: "check: <what>=<count>" for each rule, then "check: OK" or "check: FAIL (<rules>)".
-- Rules: 630 is applied (the table, row-level security on, the foreign key to the listing record with ON UPDATE / ON DELETE
-- CASCADE, the exactly-one-target check); the table's direct grants are exactly SELECT, INSERT, DELETE to service_role (nothing
-- to PUBLIC, nothing else); no orphan row (every row's path is a listing record); every row belongs to the owner of the
-- document it hangs on (no cross-owner row); no row is both or neither of a source and a claim.
DO $$
DECLARE
  bad TEXT[] := ARRAY[]::TEXT[];
  n BIGINT;
  acl TEXT;
BEGIN
  IF to_regclass('public.document_pending_refs') IS NULL THEN
    RAISE NOTICE 'check: slot 630 is not applied';
    RAISE NOTICE 'check: FAIL (630 not applied)';
    RETURN;
  END IF;

  SELECT count(*) INTO n FROM pg_class WHERE oid = 'public.document_pending_refs'::regclass AND relrowsecurity;
  RAISE NOTICE 'check: rls_on=%', n; IF n <> 1 THEN bad := array_append(bad, 'rls_on'); END IF;

  SELECT count(*) INTO n FROM pg_constraint c
   WHERE c.conrelid = 'public.document_pending_refs'::regclass AND c.contype = 'f'
     AND c.confrelid = 'public.user_document_listings'::regclass AND c.confupdtype = 'c' AND c.confdeltype = 'c';
  RAISE NOTICE 'check: listing_fk_cascade=%', n; IF n <> 1 THEN bad := array_append(bad, 'listing_fk_cascade'); END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.document_pending_refs'::regclass AND conname = 'document_pending_refs_one_target';
  RAISE NOTICE 'check: one_target_constraint=%', n; IF n <> 1 THEN bad := array_append(bad, 'one_target_constraint'); END IF;

  -- the direct grants: who holds which privilege (PUBLIC shows as grantee 0)
  SELECT string_agg(coalesce(ro.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(ro.rolname, 'PUBLIC'), a.privilege_type)
    INTO acl
    FROM pg_class cl, aclexplode(cl.relacl) a LEFT JOIN pg_roles ro ON ro.oid = a.grantee
   WHERE cl.oid = 'public.document_pending_refs'::regclass AND (ro.oid IS NULL OR ro.oid <> cl.relowner);
  RAISE NOTICE 'check: grants_exact=%', CASE WHEN acl = 'service_role:DELETE,service_role:INSERT,service_role:SELECT' THEN 1 ELSE 0 END;
  IF acl IS DISTINCT FROM 'service_role:DELETE,service_role:INSERT,service_role:SELECT' THEN bad := array_append(bad, 'grants_exact'); END IF;

  SELECT count(*) INTO n FROM public.document_pending_refs p
   WHERE NOT EXISTS (SELECT 1 FROM public.user_document_listings l WHERE l.path = p.path);
  RAISE NOTICE 'check: orphan_rows=%', n; IF n > 0 THEN bad := array_append(bad, 'orphan_rows'); END IF;

  SELECT count(*) INTO n FROM public.document_pending_refs p JOIN public.user_document_listings l ON l.path = p.path
   WHERE l.owner_sub <> p.owner_sub;
  RAISE NOTICE 'check: cross_owner_rows=%', n; IF n > 0 THEN bad := array_append(bad, 'cross_owner_rows'); END IF;

  SELECT count(*) INTO n FROM public.document_pending_refs WHERE (source_id IS NULL) = (claim_id IS NULL);
  RAISE NOTICE 'check: not_exactly_one_target=%', n; IF n > 0 THEN bad := array_append(bad, 'not_exactly_one_target'); END IF;

  IF array_length(bad, 1) IS NULL THEN
    RAISE NOTICE 'check: OK';
  ELSE
    RAISE NOTICE 'check: FAIL (%)', array_to_string(bad, ', ');
  END IF;
END $$;
