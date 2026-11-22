-- Revert rescan-withheld-text.sql (research-workbench rw-withheld-text-rescan): every rescan run not yet reverted (or
-- only -v batch=<uuid>) puts its withheld wiki_pages rows back from public.inlet_owner_archive, byte-identical (the
-- archived to_jsonb image; generated columns recompute), with triggers off (session_replication_role = replica: the
-- guard would refuse them - that is why they were withheld). A row whose slug was written again since (a clean
-- rebuild) is kept and counted, as 440's revert does. Any restored row that is not byte-identical to its archive image
-- stops the revert: nothing restored. The archive rows are marked restored, the run marked reverted (an unfinished run
-- is closed: a later scan starts a new run). Move the rows' vault files back first and restart the viewer after.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-withheld-text-rescan.sql [-v batch=<uuid>]
-- Output: counts and md5(slug) prefixes only. Order against 440: revert this before revert-inlet-owner.sql (which
-- would also restore these batches, the newest first, if run alone).
\set ON_ERROR_STOP on
\if :{?batch}
\else
\set batch ''
\endif
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;
SELECT set_config('rescan.batch', :'batch', true) AS batch_set \gset
DO $$
DECLARE
    v_only     TEXT := nullif(btrim(current_setting('rescan.batch', true)), '');
    v_cols     TEXT;
    v_batch    UUID;
    v_want     BIGINT;
    v_n        BIGINT;
    v_same     BIGINT;
    v_restored BIGINT := 0;
    v_kept     BIGINT := 0;
    v_runs     INT := 0;
BEGIN
    IF to_regclass('public.inlet_owner_rescan_runs') IS NULL THEN
        RAISE NOTICE 'withheld-text rescan revert: no rescan ever ran - nothing to restore';
        RETURN;
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('rw-withheld-text-rescan')) THEN
        RAISE EXCEPTION 'withheld-text rescan revert: a rescan is running (it holds the lock); nothing restored' USING ERRCODE = '55000';
    END IF;
    IF v_only IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.inlet_owner_rescan_runs WHERE batch::text = v_only AND reverted_at IS NULL) THEN
        RAISE EXCEPTION 'withheld-text rescan revert: no unreverted run %; nothing restored', left(v_only, 8) USING ERRCODE = '55000';
    END IF;
    LOCK TABLE public.wiki_pages IN SHARE ROW EXCLUSIVE MODE;
    SELECT string_agg(quote_ident(at.attname), ', ' ORDER BY at.attnum) INTO v_cols
      FROM pg_attribute at
     WHERE at.attrelid = 'public.wiki_pages'::regclass AND at.attnum > 0 AND NOT at.attisdropped AND at.attgenerated = '';
    PERFORM set_config('session_replication_role', 'replica', true);
    FOR v_batch IN
        SELECT r.batch FROM public.inlet_owner_rescan_runs r
         WHERE r.reverted_at IS NULL AND (v_only IS NULL OR r.batch::text = v_only)
         ORDER BY r.started_at DESC
    LOOP
        v_runs := v_runs + 1;
        SELECT count(*) INTO v_want FROM public.inlet_owner_archive a
         WHERE a.batch = v_batch AND a.action = 'w' AND a.restored_at IS NULL;
        CREATE TEMP TABLE IF NOT EXISTS _rv_back (slug TEXT PRIMARY KEY) ON COMMIT DROP;
        TRUNCATE _rv_back;
        EXECUTE format('WITH ins AS (
                            INSERT INTO public.wiki_pages (%s)
                            SELECT %s FROM public.inlet_owner_archive a, jsonb_populate_record(NULL::public.wiki_pages, a.row_data) x
                             WHERE a.batch = $1 AND a.action = ''w'' AND a.restored_at IS NULL
                            ON CONFLICT (slug) DO NOTHING
                            RETURNING slug)
                        INSERT INTO _rv_back SELECT slug FROM ins',
                       v_cols, regexp_replace(v_cols, '([^, ]+)', 'x.\1', 'g'))
            USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        -- byte-identical: every row written back is exactly its archive image
        SELECT count(*) INTO v_same
          FROM _rv_back b
          JOIN public.wiki_pages w ON w.slug = b.slug
          JOIN public.inlet_owner_archive a ON a.batch = v_batch AND a.action = 'w' AND a.restored_at IS NULL AND a.ref = b.slug
         WHERE to_jsonb(w) = a.row_data;
        IF v_same <> v_n THEN
            RAISE EXCEPTION 'withheld-text rescan revert: % of % restored row(s) of run % are not byte-identical to the archive; nothing restored',
                v_n - v_same, v_n, left(v_batch::text, 8) USING ERRCODE = '55000';
        END IF;
        v_restored := v_restored + v_n;
        v_kept := v_kept + (v_want - v_n);
        IF v_want - v_n > 0 THEN
            RAISE NOTICE 'withheld-text rescan revert: run % - % row(s) kept (rewritten since): %', left(v_batch::text, 8), v_want - v_n,
                (SELECT string_agg(left(md5(a.ref), 12), ' ' ORDER BY md5(a.ref)) FROM public.inlet_owner_archive a
                  WHERE a.batch = v_batch AND a.action = 'w' AND a.restored_at IS NULL AND a.ref NOT IN (SELECT slug FROM _rv_back));
        END IF;
        RAISE NOTICE 'withheld-text rescan revert: run % - % row(s) restored: %', left(v_batch::text, 8), v_n,
            coalesce((SELECT string_agg(left(md5(slug), 12), ' ' ORDER BY md5(slug)) FROM _rv_back), '');
        UPDATE public.inlet_owner_archive a SET restored_at = now() WHERE a.batch = v_batch AND a.action = 'w' AND a.restored_at IS NULL;
        UPDATE public.inlet_owner_rescan_runs SET reverted_at = now() WHERE batch = v_batch;
    END LOOP;
    PERFORM set_config('session_replication_role', 'origin', true);
    IF v_runs = 0 THEN
        RAISE NOTICE 'withheld-text rescan revert: no run to revert - nothing to restore';
    ELSE
        RAISE NOTICE 'withheld-text rescan revert: % run(s) reverted, % row(s) restored byte-identical, % kept (rewritten since)', v_runs, v_restored, v_kept;
    END IF;
END $$;
COMMIT;
