-- prc-scope-probe.sql - the slot 575 lab's probes (run-private-report-claims-scope-lab.ps1). One transaction, ROLLED BACK:
-- it changes nothing (every write probe, the R4 rows' dropped NOT NULL included, goes with the rollback).
-- psql -v a=<sub A> -v b=<sub B> -X -A -t -q -f. Prints "key=value" lines: states and counts, never a claim's text.
BEGIN;
SELECT set_config('lab.a', :'a', true) AS a, set_config('lab.b', :'b', true) AS b;
CREATE FUNCTION pg_temp.v(p_k TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT v FROM public.lab_prc_scope WHERE k = p_k $$;
-- a wiki write as a person (p_author) or a machine (NULL): saved | withheld (the guard dropped it) | refused (42501)
CREATE FUNCTION pg_temp.try_page(p_slug TEXT, p_class TEXT, p_body TEXT, p_author TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE n INT := -1;
BEGIN
    PERFORM set_config('ob.page_author', coalesce(p_author, ''), true);
    BEGIN
        WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES (p_slug, p_class, 'probe', p_body) RETURNING 1)
        SELECT count(*) INTO n FROM w;
        RAISE EXCEPTION 'probe rollback' USING ERRCODE = 'P0001';
    EXCEPTION
        WHEN SQLSTATE '42501' THEN PERFORM set_config('ob.page_author', '', true); RETURN 'refused';
        WHEN SQLSTATE 'P0001' THEN PERFORM set_config('ob.page_author', '', true); RETURN CASE WHEN n = 1 THEN 'saved' ELSE 'withheld' END;
    END;
END $$;
-- R4: a row of a NULL kind (a legacy row: the NOT NULL dropped for the probe) naming B's claim by id and text, on the
-- shared tree: as-typed | rewritten | dropped
CREATE FUNCTION pg_temp.try_r4(p_tbl TEXT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_job  UUID := pg_temp.v('job')::uuid;
    v_body TEXT := 'Legacy: ' || pg_temp.v('t_b1') || ' (' || pg_temp.v('b1') || ')';
    v_got  TEXT := NULL;
    v_ch   UUID;
BEGIN
    BEGIN
        IF p_tbl = 'jobs' THEN
            ALTER TABLE public.research_jobs ALTER COLUMN branch_kind DROP NOT NULL;
            INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor)
            VALUES ('queued', 'manual', v_body, v_job, v_job, 'synth', NULL, 'a shared question') RETURNING query INTO v_got;
        ELSIF p_tbl = 'steers' THEN
            INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor)
            VALUES ('queued', 'manual', 'a human branch', v_job, v_job, 'synth', 'steer', 'a shared question') RETURNING id INTO v_ch;
            ALTER TABLE public.research_steers ALTER COLUMN steer_kind DROP NOT NULL;
            INSERT INTO public.research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor, gap, actor_sub)
            VALUES (v_job, v_job, v_ch, NULL, 'synth', v_body, 'a topic', 'a shared question', jsonb_build_object('claim_id', pg_temp.v('b1'), 'text', v_body), 'system:research')
            RETURNING text INTO v_got;
        ELSE
            ALTER TABLE public.research_job_events ALTER COLUMN type DROP NOT NULL;
            INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload)
            VALUES (v_job, v_job, NULL, 'steering', jsonb_build_object('claim_id', pg_temp.v('b1'), 'text', v_body))
            RETURNING payload ->> 'text' INTO v_got;
        END IF;
        RAISE EXCEPTION 'probe rollback' USING ERRCODE = 'P0001';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        RETURN CASE WHEN v_got IS NULL THEN 'dropped' WHEN v_got = v_body THEN 'as-typed' ELSE 'rewritten' END;
    END;
END $$;
-- a machine gap branch naming B's claim on the shared tree (570's guard, unchanged by 575): opened | dropped
CREATE FUNCTION pg_temp.try_gap() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_id UUID; v_job UUID := pg_temp.v('job')::uuid;
BEGIN
    BEGIN
        INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, gap_ref)
        VALUES ('queued', 'manual', 'Verify: ' || pg_temp.v('t_b1'), v_job, v_job, 'reuse', 'gap', 'a shared question', 'claim:' || pg_temp.v('b1'))
        RETURNING id INTO v_id;
        RAISE EXCEPTION 'probe rollback' USING ERRCODE = 'P0001';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN RETURN CASE WHEN v_id IS NULL THEN 'dropped' ELSE 'opened' END;
    END;
END $$;
-- where a claim is: shared | owner (in B's store, linked to B's report) | withheld (570's or 575's archive only) | gone
CREATE FUNCTION pg_temp.where_claim(p_k TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN EXISTS (SELECT 1 FROM public.claims c WHERE c.id::text = pg_temp.v(p_k)) THEN 'shared'
        WHEN EXISTS (SELECT 1 FROM public.inlet_private_claims c WHERE c.id::text = pg_temp.v(p_k) AND c.inlet_owner_sub = current_setting('lab.b')
                       AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id AND pc.report_id::text = pg_temp.v('b_rep'))) THEN 'owner'
        WHEN EXISTS (SELECT 1 FROM public.inlet_private_claims c WHERE c.id::text = pg_temp.v(p_k)) THEN 'other-store'
        WHEN to_regclass('public.private_report_claims_archive') IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.private_report_claims_archive a WHERE a.action = 'x' AND a.restored_at IS NULL AND a.ref = pg_temp.v(p_k)) THEN 'withheld'
        ELSE 'gone' END
$$;
CREATE FUNCTION pg_temp.page(p_k TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN EXISTS (SELECT 1 FROM public.wiki_pages w WHERE w.slug = pg_temp.v(p_k)) THEN 'present' ELSE 'absent' END
$$;
SELECT line FROM (
    SELECT 1 AS o, 'page_hub=' || pg_temp.page('hub') AS line
    UNION ALL SELECT 2, 'page_index=' || pg_temp.page('index')
    UNION ALL SELECT 3, 'page_clean_hub=' || pg_temp.page('clean_hub')
    UNION ALL SELECT 4, 'page_person_note=' || pg_temp.page('note')
    UNION ALL SELECT 5, 'page_frag=' || pg_temp.page('frag_page')
    UNION ALL SELECT 6, 'claim_b1=' || pg_temp.where_claim('b1')
    UNION ALL SELECT 7, 'claim_m=' || pg_temp.where_claim('m')
    UNION ALL SELECT 8, 'claim_f1=' || pg_temp.where_claim('f1')
    UNION ALL SELECT 9, 'claim_f2=' || pg_temp.where_claim('f2')
    UNION ALL SELECT 10, 'claim_fd=' || pg_temp.where_claim('fd')
    UNION ALL SELECT 11, 'claim_fc=' || pg_temp.where_claim('fc')
    UNION ALL SELECT 12, 'job_names_f1=' || (SELECT count(*) FROM public.research_jobs j, jsonb_array_elements(j.result -> 'reuse_claims') e
                                              WHERE j.id::text = pg_temp.v('job') AND e ->> 'id' = pg_temp.v('f1'))
    UNION ALL SELECT 13, 'job_names_fc=' || (SELECT count(*) FROM public.research_jobs j, jsonb_array_elements(j.result -> 'reuse_claims') e
                                              WHERE j.id::text = pg_temp.v('job') AND e ->> 'id' = pg_temp.v('fc'))
    UNION ALL SELECT 14, 'job_claims_reused=' || (SELECT metrics ->> 'claims_reused' FROM public.research_jobs WHERE id::text = pg_temp.v('job'))
    UNION ALL SELECT 15, 'fc_edge_onto_f1=' || (SELECT count(*) FROM public.claim_sources WHERE claim_id::text = pg_temp.v('fc') AND parent_claim_id::text = pg_temp.v('f1'))
    -- R1 writes (each rolled back): a new hub / an AI note (machine text, no author) carrying B's claim; person notes
    UNION ALL SELECT 20, 'write_hub=' || pg_temp.try_page('content/notebooks/' || pg_temp.v('nb') || '-2/' || pg_temp.v('nb') || '-2', 'note', 'Hub. ' || pg_temp.v('t_b1'), NULL)
    UNION ALL SELECT 21, 'write_index=' || pg_temp.try_page('content/notebooks/index-probe', 'note', 'Index. ' || pg_temp.v('t_b2'), NULL)
    UNION ALL SELECT 22, 'write_ai_note=' || pg_temp.try_page('content/notebooks/' || pg_temp.v('nb') || '/prc-ai-note', 'note', 'AI note. ' || pg_temp.v('t_b2'), NULL)
    UNION ALL SELECT 23, 'write_note_a_with_b=' || pg_temp.try_page('notes/prc-probe-a-' || pg_temp.v('r'), 'note', 'My note. ' || pg_temp.v('t_b1'), current_setting('lab.a'))
    UNION ALL SELECT 24, 'write_note_b_own=' || pg_temp.try_page('notes/prc-probe-b-' || pg_temp.v('r'), 'note', 'My note. ' || pg_temp.v('t_b1'), current_setting('lab.b'))
    UNION ALL SELECT 25, 'write_note_no_author=' || pg_temp.try_page('notes/prc-probe-n-' || pg_temp.v('r'), 'note', 'A note. ' || pg_temp.v('t_b1'), NULL)
    UNION ALL SELECT 26, 'write_clean_hub=' || pg_temp.try_page('content/notebooks/prc-clean2/prc-clean2', 'note', 'Nothing private here at all.', NULL)
    UNION ALL SELECT 27, 'write_entity_b1=' || pg_temp.try_page('content/topic/prc-probe-b1', 'entity', 'Compiled. ' || pg_temp.v('t_b1'), NULL)
    UNION ALL SELECT 28, 'write_entity_f1=' || pg_temp.try_page('content/topic/prc-probe-f1', 'entity', 'Compiled. ' || pg_temp.v('t_f1') || ', again.', NULL)
    UNION ALL SELECT 33, 'gap_branch_for_b1=' || pg_temp.try_gap()
) x ORDER BY o;
-- R4 (each rolled back), one statement each: the probe's ALTER TABLE needs no other open scan of the table
SELECT 'r4_job=' || pg_temp.try_r4('jobs');
SELECT 'r4_steer=' || pg_temp.try_r4('steers');
SELECT 'r4_event=' || pg_temp.try_r4('events');
ROLLBACK;
