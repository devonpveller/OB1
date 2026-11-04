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
    v_thread UUID; v_sess UUID; v_c1 UUID; v_c2 UUID; v_c3 UUID; v_e BIGINT; v_tnew UUID; v_tlink UUID;
    v_i6 UUID; v_i7 UUID; v_j6 UUID; v_j7 UUID; v_s6 UUID := gen_random_uuid(); v_s7 UUID := gen_random_uuid(); v_w6 UUID := gen_random_uuid();
    v_ta UUID; v_tb UUID;
    v_i8 UUID; v_i9 UUID; v_j8 UUID; v_j9 UUID; v_s8 UUID := gen_random_uuid(); v_s9 UUID := gen_random_uuid(); v_w8 UUID := gen_random_uuid();
    v_tc UUID; v_td UUID;
    v_i10 UUID; v_j10 UUID; v_j11 UUID; v_s10 UUID := gen_random_uuid(); v_s11 UUID := gen_random_uuid(); v_tf UUID; v_tu UUID;
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
    -- round 2: an entity the report's extraction cited, and its wiki page citing the report (withheld by the move)
    INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('tool', 'Drill Tool', 'drill tool ' || v_s1::text)
    RETURNING id INTO v_e;
    INSERT INTO public.source_entities (source_id, entity_id, mention_role) VALUES (v_s1, v_e, 'mentioned');
    INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES
      ('content/tool/drill-tool-' || left(v_s1::text, 8), 'entity', 'Drill Tool',
       'The drill tool page cites [[content/source/' || v_s1::text || '|Drill idea report one]].', jsonb_build_array('content/source/' || v_s1::text));
    UPDATE public.ideas SET dossier_source_id = v_s1 WHERE id = v_i1;
    -- round 3: the base's curator minted a thread NAMED and DESCRIBED from s1 (decision 'new'), with a hub page, its
    -- web source labelled with that name; and rewrote the existing 'Drill thread' description from s2 (decision 'existing')
    INSERT INTO public.threads (name, description, status, slug, embedding)
    VALUES ('DrillReportOne minted thread', 'DrillReportOne text - the report''s first paragraph', 'active', 'drillreportone-minted-' || left(v_s1::text, 8),
            array_fill(0.01::real, ARRAY[1024])::vector)
    RETURNING id INTO v_tnew;
    PERFORM public.link_source_to_thread(v_tnew, v_s1, 'automatic', NULL, 'confirmed');
    PERFORM public.link_source_to_thread(v_tnew, v_w, 'automatic', NULL, 'confirmed');
    UPDATE public.sources SET notebook = 'DrillReportOne minted thread' WHERE id = v_w;
    UPDATE public.threads SET description = 'DrillReportTwo refreshed the description', embedding = array_fill(0.02::real, ARRAY[1024])::vector WHERE id = v_thread;
    -- a thread reached ONLY through a moved report's thread link (no job names it)
    INSERT INTO public.threads (name, description, status) VALUES ('Drill linked thread', 'DrillReportTwo described this one too', 'active') RETURNING id INTO v_tlink;
    PERFORM public.link_source_to_thread(v_tlink, v_s2, 'automatic', NULL, 'confirmed');
    PERFORM public.link_source_to_thread(v_tlink, v_s3, 'automatic', NULL, 'confirmed');
    INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES
      ('notebooks/drillreportone-minted-' || left(v_s1::text, 8) || '/drillreportone-minted-' || left(v_s1::text, 8), 'notebook',
       'DrillReportOne minted thread', 'DrillReportOne text - the hub of a thread the report named');
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', v_tnew::text, 'thread_decision', 'new',
                                                             'persist', jsonb_build_object('synthesis_id', v_s1::text))) WHERE id = v_j1;
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', v_thread::text, 'thread_decision', 'existing')) WHERE id = v_j2;
    INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload)
    VALUES (v_j2, v_j2, 'filed', 'due_process', jsonb_build_object('synthesis_id', v_s2::text, 'research_key', 'rk-drill-2'));
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', v_s3::text))) WHERE id = v_j3;
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', v_s4::text))) WHERE id IN (v_j4, v_j5);

    -- round 4 (tester attempt 3): the two stored shapes of a job whose FIRST attempt minted the thread - a resend that
    -- reused the filed thread ('explicit') and the filed-event recovery (no thread_decision) - each on its own idea job
    v_i6 := public.idea_capture('drill-owner', 'service:drill', 'Drill idea six', 'drill idea six statement', NULL, NULL);
    v_i7 := public.idea_capture('drill-owner', 'service:drill', 'Drill idea seven', 'drill idea seven statement', NULL, NULL);
    SELECT id INTO v_j6 FROM public.research_jobs WHERE refinery_id = v_i6 AND branch_kind = 'idea';
    SELECT id INTO v_j7 FROM public.research_jobs WHERE refinery_id = v_i7 AND branch_kind = 'idea';
    INSERT INTO public.sources (id, url, title, content, content_type, research_key, metadata) VALUES
      (v_s6, NULL, 'Drill idea report six', 'DrillReportSix text', 'research_synthesis', 'rk-drill-6', '{"claim":"DrillReportSix claim"}'),
      (v_s7, NULL, 'Drill idea report seven', 'DrillReportSeven text', 'research_synthesis', 'rk-drill-7', '{"claim":"DrillReportSeven claim"}'),
      (v_w6, 'https://example.org/drill-web-six', 'drill web six', 'drill web six text', 'web_article', NULL, '{}');
    INSERT INTO public.threads (name, description, status, slug) VALUES
      ('MintedName DrillReportSix', 'DrillReportSix described', 'active', 'mintedname-drillreportsix-' || left(v_s6::text, 8)) RETURNING id INTO v_ta;
    INSERT INTO public.threads (name, status) VALUES ('MintedName DrillReportSeven', 'active') RETURNING id INTO v_tb;
    PERFORM public.link_source_to_thread(v_ta, v_s6, 'automatic', NULL, 'confirmed');
    PERFORM public.link_source_to_thread(v_ta, v_w6, 'automatic', NULL, 'confirmed');
    PERFORM public.link_source_to_thread(v_tb, v_s7, 'automatic', NULL, 'confirmed');
    UPDATE public.sources SET notebook = 'MintedName DrillReportSix' WHERE id = v_w6;
    INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES
      ('notebooks/mintedname-drillreportsix-' || left(v_s6::text, 8) || '/mintedname-drillreportsix-' || left(v_s6::text, 8), 'notebook',
       'MintedName DrillReportSix', 'the hub of a thread a resend reused');
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', v_ta::text, 'thread_decision', 'explicit',
                                                             'persist', jsonb_build_object('synthesis_id', v_s6::text))) WHERE id = v_j6;
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', v_tb::text,
                                                             'persist', jsonb_build_object('synthesis_id', v_s7::text, 'sources_written', 0, 'session_id', NULL),
                                                             'recovered', jsonb_build_object('via', 'filed_event', 'attempt', 2, 'why', 'timeout'))) WHERE id = v_j7;
    -- round 5 (tester attempt 4): a job the boot recovery / the model-down requeue RE-RAN - created 3h ago, its first
    -- run minted tC 2h ago, the re-run started 1h ago and its 'explicit' resend reused tC (tC); and the same job caught
    -- mid-requeue, started_at reset to NULL (tD)
    v_i8 := public.idea_capture('drill-owner', 'service:drill', 'Drill idea eight', 'drill idea eight statement', NULL, NULL);
    v_i9 := public.idea_capture('drill-owner', 'service:drill', 'Drill idea nine', 'drill idea nine statement', NULL, NULL);
    SELECT id INTO v_j8 FROM public.research_jobs WHERE refinery_id = v_i8 AND branch_kind = 'idea';
    SELECT id INTO v_j9 FROM public.research_jobs WHERE refinery_id = v_i9 AND branch_kind = 'idea';
    INSERT INTO public.sources (id, url, title, content, content_type, research_key, metadata) VALUES
      (v_s8, NULL, 'Drill idea report eight', 'DrillReportEight text', 'research_synthesis', 'rk-drill-8', '{"claim":"DrillReportEight claim"}'),
      (v_s9, NULL, 'Drill idea report nine', 'DrillReportNine text', 'research_synthesis', 'rk-drill-9', '{"claim":"DrillReportNine claim"}'),
      (v_w8, 'https://example.org/drill-web-eight', 'drill web eight', 'drill web eight text', 'web_article', NULL, '{}');
    INSERT INTO public.threads (name, status, slug, created_at) VALUES
      ('MintedName DrillReportEight', 'active', 'mintedname-drillreporteight-' || left(v_s8::text, 8), now() - interval '2 hours') RETURNING id INTO v_tc;
    INSERT INTO public.threads (name, status, created_at) VALUES ('MintedName DrillReportNine', 'active', now() - interval '2 hours') RETURNING id INTO v_td;
    PERFORM public.link_source_to_thread(v_tc, v_s8, 'automatic', NULL, 'confirmed');
    PERFORM public.link_source_to_thread(v_tc, v_w8, 'automatic', NULL, 'confirmed');
    PERFORM public.link_source_to_thread(v_td, v_s9, 'automatic', NULL, 'confirmed');
    UPDATE public.sources SET notebook = 'MintedName DrillReportEight' WHERE id = v_w8;
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', v_tc::text, 'thread_decision', 'explicit',
                                                             'persist', jsonb_build_object('synthesis_id', v_s8::text))),
                                     created_at = now() - interval '3 hours', started_at = now() - interval '1 hour' WHERE id = v_j8;
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', v_td::text, 'thread_decision', 'explicit',
                                                             'persist', jsonb_build_object('synthesis_id', v_s9::text))),
                                     created_at = now() - interval '3 hours', started_at = NULL WHERE id = v_j9;
    -- round 6 (tester attempt 5, tF): the job that minted the thread (j10) ERRORED after filing - no curator answer, only
    -- its typed 'filed' event names the thread; a later job of the same idea (j11) filed into it as 'existing'
    v_i10 := public.idea_capture('drill-owner', 'service:drill', 'Drill idea ten', 'drill idea ten statement', NULL, NULL);
    SELECT id INTO v_j10 FROM public.research_jobs WHERE refinery_id = v_i10 AND branch_kind = 'idea';
    INSERT INTO public.research_jobs (status, origin, query, refinery_id) VALUES ('done', 'manual', 'drill j11', v_i10) RETURNING id INTO v_j11;
    INSERT INTO public.sources (id, url, title, content, content_type, research_key, metadata) VALUES
      (v_s10, NULL, 'Drill idea report ten', 'DrillReportTen text', 'research_synthesis', 'rk-drill-10', '{"claim":"DrillReportTen claim"}'),
      (v_s11, NULL, 'Drill idea report eleven', 'DrillReportEleven text', 'research_synthesis', 'rk-drill-11', '{"claim":"DrillReportEleven claim"}');
    INSERT INTO public.threads (name, status, created_at) VALUES ('MintedName DrillReportTen', 'active', now() - interval '2 hours') RETURNING id INTO v_tf;
    UPDATE public.research_jobs SET status = 'error', error = 'failed after filing', result = NULL, created_at = now() - interval '3 hours',
                                    started_at = now() - interval '3 hours' WHERE id = v_j10;
    INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload)
    VALUES (v_j10, v_j10, 'filed', 'due_process', jsonb_build_object('synthesis_id', v_s10::text, 'research_key', 'rk-drill-10', 'thread_id', v_tf::text));
    UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', v_tf::text, 'thread_decision', 'existing',
                                                             'persist', jsonb_build_object('synthesis_id', v_s11::text))) WHERE id = v_j11;
    -- an OLD thread no moved job is tied to (linked only to the shared s3): it keeps its name
    INSERT INTO public.threads (name, status, created_at) VALUES ('Drill untied thread', 'active', now() - interval '1 day') RETURNING id INTO v_tu;
    PERFORM public.link_source_to_thread(v_tu, v_s3, 'automatic', NULL, 'confirmed');
    -- the times the move reads: the other idea jobs created and started now; the two EXISTING threads (tE: a truly old
    -- thread keeps its name) were made a day before
    UPDATE public.research_jobs SET started_at = now() WHERE id IN (v_j1, v_j2, v_j6, v_j7);
    UPDATE public.threads SET created_at = now() - interval '1 day' WHERE id IN (v_thread, v_tlink);

    INSERT INTO public._ri_drill (name, id) VALUES ('s1', v_s1), ('s2', v_s2), ('s3', v_s3), ('s4', v_s4), ('w', v_w), ('i1', v_i1), ('i2', v_i2),
      ('j1', v_j1), ('j2', v_j2), ('c1', v_c1), ('c2', v_c2), ('c3', v_c3), ('thread', v_thread), ('session', v_sess),
      ('e', v_e::text), ('entity_page', 'content/tool/drill-tool-' || left(v_s1::text, 8)), ('tnew', v_tnew::text), ('tlink', v_tlink::text), ('ta', v_ta::text), ('tb', v_tb::text), ('tc', v_tc::text), ('td', v_td::text), ('tf', v_tf::text), ('tu', v_tu::text)
    ON CONFLICT (name) DO UPDATE SET id = EXCLUDED.id;
END $$;
COMMIT;
