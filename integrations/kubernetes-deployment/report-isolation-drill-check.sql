-- report-isolation-drill-check.sql - one state line per fact (key=value), read by run-filed-e2e.ps1 [4d] between the
-- steps of the slot-390 drill. Counts and hashes only, never content. A LAB database only.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
WITH d AS (SELECT name, id FROM public._ri_drill)
SELECT 'shared_idea=' || count(*) FROM public.sources s WHERE s.id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))
UNION ALL SELECT 'shared_other=' || count(*) FROM public.sources s WHERE s.id::text IN (SELECT id FROM d WHERE name IN ('s3', 's4', 'w'))
UNION ALL SELECT 'deps_idea=' || (
      (SELECT count(*) FROM public.session_sources x WHERE x.source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2')))
    + (SELECT count(*) FROM public.thread_sources x WHERE x.source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2')))
    + (SELECT count(*) FROM public.source_chunks x WHERE x.source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2')))
    + (SELECT count(*) FROM public.wiki_pages x WHERE x.slug IN (SELECT 'content/source/' || id FROM d WHERE name IN ('s1', 's2'))))
UNION ALL SELECT 'deps_other=' || (
      (SELECT count(*) FROM public.session_sources x WHERE x.source_id::text IN (SELECT id FROM d WHERE name = 's3'))
    + (SELECT count(*) FROM public.thread_sources x WHERE x.source_id::text IN (SELECT id FROM d WHERE name = 's3'))
    + (SELECT count(*) FROM public.source_chunks x WHERE x.source_id::text IN (SELECT id FROM d WHERE name = 's3'))
    + (SELECT count(*) FROM public.wiki_pages x WHERE x.slug IN (SELECT 'content/source/' || id FROM d WHERE name = 's3')))
UNION ALL SELECT 'claims_on_idea_reports=' || count(*) FROM public.claims c WHERE c.synthesis_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))
UNION ALL SELECT 'claims_present=' || count(*) FROM public.claims c WHERE c.id::text IN (SELECT id FROM d WHERE name IN ('c1', 'c2', 'c3'))
UNION ALL SELECT 'claim_edge_c1=' || count(*) FROM public.claim_sources x WHERE x.claim_id::text = (SELECT id FROM d WHERE name = 'c1')
UNION ALL SELECT 'dossier_i1=' || CASE WHEN i.dossier_source_id::text = (SELECT id FROM d WHERE name = 's1') THEN 's1'
                                       WHEN i.dossier_source_id IS NULL THEN 'null' ELSE 'other' END
            FROM public.ideas i WHERE i.id::text = (SELECT id FROM d WHERE name = 'i1')
UNION ALL SELECT 'fn=' || count(*) FROM pg_proc WHERE proname = 'research_job_report_owner'
UNION ALL SELECT 'guard=' || count(*) FROM pg_trigger WHERE tgname = 'trg_report_isolation_wiki_guard'
-- round 3: any thread field, any shared source's notebook label, any wiki page carrying a moved report's text
UNION ALL SELECT 'thread_report_text=' || count(*) FROM public.threads t
           WHERE t.name LIKE '%DrillReport%' OR coalesce(t.description, '') LIKE '%DrillReport%' OR coalesce(t.slug, '') LIKE '%drillreport%'
UNION ALL SELECT 'thread_embeddings=' || count(t.embedding) FROM public.threads t WHERE t.id::text IN (SELECT id FROM d WHERE name IN ('tnew', 'thread', 'tlink', 'ta', 'tb'))
UNION ALL SELECT 'notebook_report_text=' || count(*) FROM public.sources s WHERE coalesce(s.notebook, '') LIKE '%DrillReport%'
UNION ALL SELECT 'wiki_report_text=' || count(*) FROM public.wiki_pages w WHERE w.body LIKE '%DrillReport%' OR w.title LIKE '%DrillReport%'
UNION ALL SELECT 'tnew_desc=' || coalesce(replace((SELECT t.description FROM public.threads t WHERE t.id::text = (SELECT id FROM d WHERE name = 'tnew')), ' ', '_'), 'null')
UNION ALL SELECT 'wiki_report_pages=' || count(*) FROM public.wiki_pages w
           WHERE w.slug IN (SELECT 'content/source/' || id FROM d WHERE name = 's1') OR w.slug IN (SELECT id FROM d WHERE name = 'entity_page')
UNION ALL SELECT 'entity_ts=' || md5(coalesce((SELECT e.updated_at::text FROM public.entities e WHERE e.id::text = (SELECT id FROM d WHERE name = 'e')), ''))
UNION ALL SELECT 'snapshot=' || md5(coalesce((SELECT string_agg(to_jsonb(s)::text, '|' ORDER BY s.id) FROM public.sources s WHERE s.id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))), '')
    || coalesce((SELECT string_agg(to_jsonb(x)::text, '|' ORDER BY x.session_id, x.source_id) FROM public.session_sources x WHERE x.source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))), '')
    || coalesce((SELECT string_agg(to_jsonb(x)::text, '|' ORDER BY x::text) FROM public.thread_sources x WHERE x.source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))), '')
    || coalesce((SELECT string_agg(to_jsonb(x)::text, '|' ORDER BY x::text) FROM public.source_chunks x WHERE x.source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))), '')
    || coalesce((SELECT string_agg(to_jsonb(x)::text, '|' ORDER BY x.slug) FROM public.wiki_pages x WHERE x.slug IN (SELECT 'content/source/' || id FROM d WHERE name IN ('s1', 's2'))), '')
    -- round 2: the WHOLE rows the move sets NULL in (claims, the idea) and the entity it bumps, and the cited page
    || coalesce((SELECT string_agg(to_jsonb(c)::text, '|' ORDER BY c.id) FROM public.claims c WHERE c.id::text IN (SELECT id FROM d WHERE name IN ('c1', 'c2'))), '')
    || coalesce((SELECT to_jsonb(i)::text FROM public.ideas i WHERE i.id::text = (SELECT id FROM d WHERE name = 'i1')), '')
    || coalesce((SELECT to_jsonb(e)::text FROM public.entities e WHERE e.id::text = (SELECT id FROM d WHERE name = 'e')), '')
    || coalesce((SELECT string_agg(to_jsonb(x)::text, '|' ORDER BY x.source_id) FROM public.source_entities x WHERE x.source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))), '')
    || coalesce((SELECT to_jsonb(w)::text FROM public.wiki_pages w WHERE w.slug = (SELECT id FROM d WHERE name = 'entity_page')), '')
    -- round 3: the whole thread rows, the relabelled web source, every notebook hub page
    || coalesce((SELECT string_agg(to_jsonb(t)::text, '|' ORDER BY t.id) FROM public.threads t WHERE t.id::text IN (SELECT id FROM d WHERE name IN ('tnew', 'thread', 'tlink', 'ta', 'tb'))), '')
    || coalesce((SELECT to_jsonb(s)::text FROM public.sources s WHERE s.id::text = (SELECT id FROM d WHERE name = 'w')), '')
    || coalesce((SELECT string_agg(to_jsonb(w)::text, '|' ORDER BY w.slug) FROM public.wiki_pages w WHERE w.slug LIKE 'notebooks/%'), ''));
-- the private plane (absent before slot 390 first ran)
SELECT CASE WHEN to_regclass('public.research_private_reports') IS NULL THEN 'private=absent' END
 WHERE to_regclass('public.research_private_reports') IS NULL;
DO $$
DECLARE v TEXT;
BEGIN
    IF to_regclass('public.research_private_reports') IS NULL THEN RETURN; END IF;
    EXECUTE $q$
      WITH d AS (SELECT name, id FROM public._ri_drill)
      SELECT 'private=' || (SELECT count(*) FROM public.research_private_reports p WHERE p.migrated_source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2')))
        || ' private_owned=' || (SELECT count(*) FROM public.research_private_reports p WHERE p.migrated_source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))
                                     AND p.owner_sub = 'drill-owner' AND p.idea_id::text IN (SELECT id FROM d WHERE name IN ('i1', 'i2')))
        || ' private_s1_job=' || coalesce((SELECT CASE WHEN p.job_id::text = (SELECT id FROM d WHERE name = 'j1') THEN 'j1' ELSE coalesce(p.job_id::text, 'null') END
                                             FROM public.research_private_reports p WHERE p.migrated_source_id::text = (SELECT id FROM d WHERE name = 's1')), 'none')
        || ' private_s2_job=' || coalesce((SELECT CASE WHEN p.job_id::text = (SELECT id FROM d WHERE name = 'j2') THEN 'j2' ELSE coalesce(p.job_id::text, 'null') END
                                             FROM public.research_private_reports p WHERE p.migrated_source_id::text = (SELECT id FROM d WHERE name = 's2')), 'none')
        || ' private_text=' || (SELECT count(*) FROM public.research_private_reports p WHERE p.content IN ('DrillReportOne text', 'DrillReportTwo text'))
        || ' private_links=' || (SELECT count(*) FROM public.research_private_report_claims pc JOIN public.research_private_reports p ON p.id = pc.report_id
                                   WHERE p.migrated_source_id::text IN (SELECT id FROM d WHERE name IN ('s1', 's2'))
                                     AND pc.claim_id::text IN (SELECT id FROM d WHERE name IN ('c1', 'c2')))
        || ' archive_open=' || (SELECT count(*) FROM public.research_report_isolation_archive a WHERE a.restored_at IS NULL)
        || ' archive_restored=' || (SELECT count(*) FROM public.research_report_isolation_archive a WHERE a.restored_at IS NOT NULL)
        || ' archive_app_read=' || (CASE WHEN has_table_privilege('service_role', 'public.research_report_isolation_archive', 'SELECT') THEN 'yes' ELSE 'no' END)
    $q$ INTO v;
    RAISE NOTICE 'DRILL %', v;
END $$;
