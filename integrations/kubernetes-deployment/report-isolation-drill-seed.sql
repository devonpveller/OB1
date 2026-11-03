-- report-isolation-drill-seed.sql - rw-report-isolation's migration drill (run-filed-e2e.ps1 [4d]), a LAB database only.
-- Plants four research_synthesis sources the way the base filed them, each with the dependents the live rows carry
-- (a session and a thread link, a chunk, the extraction queue row the insert trigger adds, a claim, a wiki leaf row, an
-- idea's dossier pointer):
--   s1  an idea job's report (the idea's own branch job; result -> curator -> persist -> synthesis_id), the idea's dossier
--   s2  an idea job's report tied only by a revision stamp and the typed 'filed' event (the live shape: no refinery_id)
--   s3  a non-idea job's report                      -> stays shared
--   s4  filed by an idea job AND a non-idea job       -> stays shared (counted)
-- The ids land in public._ri_drill for report-isolation-drill-check.sql. Never run it against a live database.
\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS public._ri_drill (name TEXT PRIMARY KEY, id TEXT NOT NULL);
DO $$
DECLARE
    v_i1 UUID; v_i2 UUID; v_i4 UUID;
    v_j1 UUID; v_j2 UUID; v_j3 UUID; v_j4 UUID; v_j5 UUID;
    v_s1 UUID := gen_random_uuid(); v_s2 UUID := gen_random_uuid(); v_s3 UUID := gen_random_uuid(); v_s4 UUID := gen_random_uuid();
    v_w  UUID := gen_random_uuid();
    v_thread UUID; v_sess UUID; v_c1 UUID; v_c2 UUID; v_c3 UUID;
BEGIN
    v_i1 := public.idea_capture('drill-owner', 'service:drill', 'Drill idea one', 'drill idea one statement', NULL, NULL);
    v_i2 := public.idea_capture('drill-owner', 'service:drill', 'Drill idea two', 'drill idea two statement', NULL, NULL);
    v_i4 := public.idea_capture('drill-owner', 'service:drill', 'Drill idea four', 'drill idea four statement', NULL, NULL);
    SELECT id INTO v_j1 FROM public.research_jobs WHERE refinery_id = v_i1 AND branch_kind = 'idea';
    SELECT id INTO v_j4 FROM public.research_jobs WHERE refinery_id = v_i4 AND branch_kind = 'idea';
    INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'drill j2') RETURNING id INTO v_j2;
    UPDATE public.idea_revisions SET research_job_id = v_j2::text WHERE idea_id = v_i2 AND revision = 1;
    UPDATE public.research_jobs SET refinery_id = NULL, inlet_ref = NULL WHERE id = v_j2;
    INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'drill j3') RETURNING id INTO v_j3;
    INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'drill j5') RETURNING id INTO v_j5;

    INSERT INTO public.sources (id, url, title, content, content_type, research_key, research_query, metadata) VALUES
      (v_s1, NULL, 'Drill idea report one', 'DrillReportOne text', 'research_synthesis', 'rk-drill-1', 'drill q1', '{"claim":"DrillReportOne claim","prose_synthesis":"DrillProseOne"}'),
      (v_s2, NULL, 'Drill idea report two', 'DrillReportTwo text', 'research_synthesis', 'rk-drill-2', 'drill q2', '{"claim":"DrillReportTwo claim"}'),
      (v_s3, NULL, 'Drill shared report', 'DrillSharedThree text', 'research_synthesis', 'rk-drill-3', 'drill q3', '{}'),
      (v_s4, NULL, 'Drill conflicted report', 'DrillConflictFour text', 'research_synthesis', 'rk-drill-4', 'drill q4', '{}'),
      (v_w, 'https://example.org/drill-web', 'drill web', 'drill web text', 'web_article', NULL, NULL, '{}');
    INSERT INTO public.sessions (origin_tool, query_text) VALUES ('owui', 'drill') RETURNING id INTO v_sess;
    INSERT INTO public.session_sources (session_id, source_id) VALUES (v_sess, v_s1), (v_sess, v_s2), (v_sess, v_s3), (v_sess, v_w);
    INSERT INTO public.threads (name, status) VALUES ('Drill thread', 'active') RETURNING id INTO v_thread;
    PERFORM public.link_source_to_thread(v_thread, v_s1, 'automatic', NULL, 'confirmed');
    PERFORM public.link_source_to_thread(v_thread, v_s3, 'automatic', NULL, 'confirmed');
    INSERT INTO public.source_chunks (source_id, idx, content) VALUES (v_s1, 0, 'DrillReportOne chunk'), (v_s3, 0, 'DrillSharedThree chunk');
    SELECT f.id INTO v_c1 FROM public.find_or_create_claim('Drill claim one is a fact.', v_thread, v_s1, 'sourced', NULL, NULL, NULL, '{"claim_kind":"descriptive"}'::jsonb) f;
    SELECT f.id INTO v_c2 FROM public.find_or_create_claim('Drill claim two is a fact.', NULL, v_s2, 'sourced', NULL, NULL, NULL, '{"claim_kind":"descriptive"}'::jsonb) f;
    SELECT f.id INTO v_c3 FROM public.find_or_create_claim('Drill claim three is a fact.', v_thread, v_s3, 'sourced', NULL, NULL, NULL, '{"claim_kind":"descriptive"}'::jsonb) f;
    PERFORM public.link_claim_to_source(v_c1, v_w, 'states', 1.0);
    INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES
      ('content/source/' || v_s1::text, 'source', 'Drill idea report one', 'DrillReportOne leaf'),
      ('content/source/' || v_s3::text, 'source', 'Drill shared report', 'DrillSharedThree leaf');
    UPDATE public.ideas SET dossier_source_id = v_s1 WHERE id = v_i1;
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', v_s1::text))) WHERE id = v_j1;
    INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload)
    VALUES (v_j2, v_j2, 'filed', 'due_process', jsonb_build_object('synthesis_id', v_s2::text, 'research_key', 'rk-drill-2'));
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', v_s3::text))) WHERE id = v_j3;
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', v_s4::text))) WHERE id IN (v_j4, v_j5);

    INSERT INTO public._ri_drill (name, id) VALUES ('s1', v_s1), ('s2', v_s2), ('s3', v_s3), ('s4', v_s4), ('w', v_w), ('i1', v_i1), ('i2', v_i2),
      ('j1', v_j1), ('j2', v_j2), ('c1', v_c1), ('c2', v_c2), ('c3', v_c3), ('thread', v_thread), ('session', v_sess)
    ON CONFLICT (name) DO UPDATE SET id = EXCLUDED.id;
END $$;
COMMIT;
