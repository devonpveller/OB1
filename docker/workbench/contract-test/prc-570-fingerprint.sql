-- fingerprint.sql (rw-570-perf equivalence): one md5 per table slot 570 touches, plus the archive and the moved /
-- withheld sets, with the values that differ between two runs of the SAME script on the SAME data masked:
--   the batch uuids (gen_random_uuid per run)        -> BATCH1, BATCH2 ... in archive order
--   the ids of the private copies 570 makes           -> PR:<research_key>
--   archive id / archived_at / restored_at            -> dropped (the archive's ORDER is kept as a rank, separately)
--   the copies' created_at / updated_at (now())      -> dropped for research_key LIKE 'prc570-%'
--   an entity bump's timestamp (clock_timestamp())    -> dropped for the bumped entities ('u' rows)
--   a shared claim's updated_at after an edge delete  -> dropped for the claims archived whole ('m' rows): the
--                                                        confidence recompute touches it with now()
-- Counts and md5s only: no row text.
CREATE TEMP TABLE _fp_map (k TEXT PRIMARY KEY, v TEXT NOT NULL);
DO $$
BEGIN
  IF to_regclass('public.private_report_claims_archive') IS NOT NULL THEN
    INSERT INTO _fp_map SELECT batch::text, 'BATCH' || row_number() OVER (ORDER BY min(id)) FROM public.private_report_claims_archive WHERE restored_at IS NULL GROUP BY batch;
  END IF;
END $$;
INSERT INTO _fp_map SELECT id::text, 'PR:' || research_key FROM public.research_private_reports WHERE research_key LIKE 'prc570-%' ON CONFLICT DO NOTHING;
CREATE TEMP TABLE _fp_bumped (id TEXT PRIMARY KEY);
CREATE TEMP TABLE _fp_touched (id TEXT PRIMARY KEY);
DO $$
BEGIN
  IF to_regclass('public.private_report_claims_archive') IS NOT NULL THEN
    INSERT INTO _fp_bumped SELECT DISTINCT ref FROM public.private_report_claims_archive WHERE action = 'u' AND restored_at IS NULL;
    INSERT INTO _fp_touched SELECT DISTINCT ref FROM public.private_report_claims_archive WHERE action = 'm' AND restored_at IS NULL;
  END IF;
END $$;
CREATE FUNCTION pg_temp.fp_mask(t TEXT) RETURNS TEXT LANGUAGE plpgsql STABLE AS $f$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT k, v FROM _fp_map ORDER BY k LOOP t := replace(t, r.k, r.v); END LOOP;
  RETURN t;
END $f$;
CREATE TEMP TABLE _fp (o INT, t TEXT, n BIGINT, h TEXT);
INSERT INTO _fp SELECT 1, 'claims', count(*), md5(coalesce(string_agg(CASE WHEN x.id::text IN (SELECT id FROM _fp_touched) THEN (to_jsonb(x) - 'updated_at')::text ELSE to_jsonb(x)::text END, '|' ORDER BY x.id), '')) FROM public.claims x;
INSERT INTO _fp SELECT 2, 'claim_sources', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.claim_sources x;
INSERT INTO _fp SELECT 3, 'links', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.report_id, x.claim_id), '')) FROM public.research_private_report_claims x;
INSERT INTO _fp SELECT 4, 'jobs', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_jobs x;
INSERT INTO _fp SELECT 5, 'wiki_pages', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.slug), '')) FROM public.wiki_pages x;
INSERT INTO _fp SELECT 6, 'corroborations', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.source_corroborations x;
INSERT INTO _fp SELECT 7, 'private_claims', count(*), md5(coalesce(string_agg(pg_temp.fp_mask(to_jsonb(x)::text), '|' ORDER BY x.id), '')) FROM public.inlet_private_claims x;
INSERT INTO _fp SELECT 8, 'private_edges', count(*), md5(coalesce(string_agg(pg_temp.fp_mask(to_jsonb(x)::text), '|' ORDER BY x.claim_id, x.edge_ref, pg_temp.fp_mask(x.batch::text)), '')) FROM public.inlet_private_claim_sources x;
INSERT INTO _fp SELECT 9, 'steers', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_steers x;
INSERT INTO _fp SELECT 10, 'events', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_job_events x;
INSERT INTO _fp SELECT 11, 'sources', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.sources x;
INSERT INTO _fp SELECT 12, 'private_reports', count(*), md5(coalesce(string_agg(pg_temp.fp_mask(CASE WHEN x.research_key LIKE 'prc570-%' THEN (to_jsonb(x) - 'created_at' - 'updated_at')::text ELSE to_jsonb(x)::text END), '|' ORDER BY x.research_key, x.id), '')) FROM public.research_private_reports x;
INSERT INTO _fp SELECT 13, 'threads', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.threads x;
INSERT INTO _fp SELECT 14, 'entities', count(*), md5(coalesce(string_agg(CASE WHEN x.id::text IN (SELECT id FROM _fp_bumped) THEN (to_jsonb(x) - 'updated_at')::text ELSE to_jsonb(x)::text END, '|' ORDER BY x.id), '')) FROM public.entities x;
INSERT INTO _fp SELECT 15, 'thread_sources', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.thread_id, x.source_id), '')) FROM public.thread_sources x;
-- (one md5 per row first: at live size the chunks' text with their embeddings exceeds 1 GB as one string)
INSERT INTO _fp SELECT 16, 'source_chunks', count(*), md5(coalesce(string_agg(md5(to_jsonb(x)::text), '|' ORDER BY x.source_id, x.idx), '')) FROM public.source_chunks x;
INSERT INTO _fp SELECT 17, 'link_fk', count(*), md5(coalesce(string_agg(conname || ' ' || pg_get_constraintdef(oid), '|' ORDER BY conname), '')) FROM pg_constraint
 WHERE conrelid = 'public.research_private_report_claims'::regclass AND contype = 'f';
INSERT INTO _fp SELECT 18, 'triggers', count(*), md5(coalesce(string_agg(tgrelid::regclass::text || ' ' || tgname || ' ' || pg_get_triggerdef(oid), '|' ORDER BY tgrelid::regclass::text, tgname), '')) FROM pg_trigger
 WHERE tgname LIKE 'trg_private_report_claims%' AND NOT tgisinternal;
INSERT INTO _fp SELECT 19, 'slot_functions', count(*), md5(coalesce(string_agg(p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, ''), '|' ORDER BY p.oid::regprocedure::text), '')) FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'private_report_claim%' OR p.proname LIKE 'trg_private_report_claims%');
DO $$
BEGIN
  IF to_regclass('public.private_report_claims_archive') IS NOT NULL THEN
    -- this run's archive (the rows not restored) as a multiset (what was moved / withheld / changed, as it was) and as a sequence (the insert order)
    INSERT INTO _fp SELECT 20, 'archive_set', count(*), md5(coalesce(string_agg(z.r, '|' ORDER BY z.r), ''))
      FROM (SELECT pg_temp.fp_mask(jsonb_build_object('b', a.batch, 'tbl', a.tbl, 'act', a.action, 'ref', a.ref, 'restored', a.restored_at IS NOT NULL,
                  'row', CASE WHEN a.action = 'u' THEN a.row_data - 'bumped_to' ELSE a.row_data END)::text) AS r
              FROM public.private_report_claims_archive a WHERE a.restored_at IS NULL) z;
    INSERT INTO _fp SELECT 21, 'archive_order', count(*), md5(coalesce(string_agg(z.r, '|' ORDER BY z.o), ''))
      FROM (SELECT a.id AS o, pg_temp.fp_mask(jsonb_build_object('b', a.batch, 'tbl', a.tbl, 'act', a.action, 'ref', a.ref,
                  'row', CASE WHEN a.action = 'u' THEN a.row_data - 'bumped_to' ELSE a.row_data END)::text) AS r
              FROM public.private_report_claims_archive a WHERE a.restored_at IS NULL) z;
    -- the ids themselves, relative to this run's first (tester attempt 1: the order of one action's rows is in the ids)
    INSERT INTO _fp SELECT 23, 'archive_ids', count(*), md5(coalesce(string_agg(z.r, '|' ORDER BY z.o), ''))
      FROM (SELECT a.id AS o, (a.id - min(a.id) OVER ())::text || ':' || a.action || ':' || pg_temp.fp_mask(coalesce(a.ref, '')) AS r
              FROM public.private_report_claims_archive a WHERE a.restored_at IS NULL) z;
    INSERT INTO _fp SELECT 22, 'archive_order_by_action', count(*), md5(coalesce(string_agg(z.r, '|' ORDER BY z.o), ''))
      FROM (SELECT a.id AS o, pg_temp.fp_mask(a.batch::text) || ':' || a.tbl || ':' || a.action AS r FROM public.private_report_claims_archive a WHERE a.restored_at IS NULL) z;
    -- the moved (k) and withheld (x) claim sets, the withheld pages (w), the moved / withheld syntheses (s), job reports (p)
    INSERT INTO _fp SELECT 30 + row_number() OVER (ORDER BY a.action)::int, 'set_' || a.action, count(*), md5(string_agg(pg_temp.fp_mask(a.ref), '|' ORDER BY pg_temp.fp_mask(a.ref)))
      FROM public.private_report_claims_archive a WHERE a.restored_at IS NULL GROUP BY a.action;
  END IF;
END $$;
SELECT o || ' ' || t || ' n=' || n || ' ' || h FROM _fp ORDER BY o, t;
