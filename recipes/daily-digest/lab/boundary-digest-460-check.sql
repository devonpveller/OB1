-- rw-boundary-digest: slot 460's structural checks, run by run-digest-boundary-lab.ps1 on the LAB database as the
-- superuser (never a live database). Prints `460-check: <name> ok` per check; any failure RAISEs (ON_ERROR_STOP).
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
    stamp JSONB := jsonb_build_object('version', 'pd0a-2', 'lexicon', repeat('a', 64), 'verdict_id', repeat('b', 64));
    root UUID;
    ok BOOLEAN;
    r TEXT;
    f TEXT;
    bad JSONB;
BEGIN
    -- 1. a derived root may carry the four run knobs
    INSERT INTO public.research_jobs (status, origin, caller, query, anchor, request_kind, boundary, options)
    VALUES ('done', 'manual', 'boundary', 'q one two', 'q one two', 'derived', stamp,
            '{"public_links":[],"queue_origin":"manual","mode":"article","gap_research":"preliminary","dry_run":true,"deadline_at":"2026-11-05T00:00:00.000Z"}')
    RETURNING id INTO root;
    RAISE NOTICE '460-check: a derived root with the run knobs is accepted ok';
    -- 2. anything else is still refused (420's TF8 allow-list), and so are bad shapes of the knobs
    FOREACH bad IN ARRAY ARRAY['{"notes":"x"}', '{"mode":"topic"}', '{"gap_research":"full"}', '{"dry_run":"yes"}',
        '{"deadline_at":"tomorrow"}', '{"deadline_at":"2026-11-05T00:00:00Z"}', '{"seed_sources":[]}', '{"context":{"dry_run":true}}']::jsonb[] LOOP
        BEGIN
            INSERT INTO public.research_jobs (status, origin, caller, query, anchor, request_kind, boundary, options)
            VALUES ('done', 'manual', 'boundary', 'q one two', 'q one two', 'derived', stamp, bad);
            RAISE EXCEPTION '460-check FAILED: accepted %', bad;
        EXCEPTION WHEN check_violation THEN NULL;
        END;
    END LOOP;
    RAISE NOTICE '460-check: unlisted keys and bad knob shapes refused ok';
    -- 3. a branch may not carry the knobs
    BEGIN
        INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, options)
        VALUES ('queued', 'manual', 'Verify: x', root, root, 's1', 'gap', 'q one two', '{"dry_run":true}');
        RAISE EXCEPTION '460-check FAILED: a branch carried dry_run';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE NOTICE '460-check: a branch may not carry the run knobs ok';
    -- 4. handback_deliver: EXECUTE for ob_app_memory only
    f := 'public.handback_deliver(uuid,text,boolean,jsonb)';
    IF NOT has_function_privilege('ob_app_memory', f, 'EXECUTE') THEN RAISE EXCEPTION '460-check FAILED: ob_app_memory cannot execute'; END IF;
    FOREACH r IN ARRAY ARRAY['service_role', 'anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND has_function_privilege(r, f, 'EXECUTE') THEN
            RAISE EXCEPTION '460-check FAILED: % can execute handback_deliver', r;
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure(f) AND a.grantee = 0) THEN
        RAISE EXCEPTION '460-check FAILED: PUBLIC can execute handback_deliver';
    END IF;
    RAISE NOTICE '460-check: handback_deliver EXECUTE for ob_app_memory only ok';
    -- 5. handback_deliver: the opening caller only, a queued row only, the two ids only
    PERFORM public.handback_open('lab-owner', 'gmail', 'g-460', NULL, 'digest-article', root, 'queued', '{}'::jsonb, NULL, '{"caller":"shared-key"}'::jsonb);
    IF public.handback_deliver(root, 'owui-tool', true, '{}'::jsonb) THEN RAISE EXCEPTION '460-check FAILED: another caller delivered'; END IF;
    BEGIN
        PERFORM public.handback_deliver(root, 'shared-key', true, '{"labels":["x"]}'::jsonb);
        RAISE EXCEPTION '460-check FAILED: a note key other than episode_id / thread_id';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
        PERFORM public.handback_deliver(root, 'shared-key', true, '{"episode_id":"zqGIDm2f6b88e4"}'::jsonb);
        RAISE EXCEPTION '460-check FAILED: a non-uuid episode id';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    ok := public.handback_deliver(root, 'shared-key', true, '{"episode_id":"11111111-2222-4333-8444-555555555555"}'::jsonb);
    IF NOT ok THEN RAISE EXCEPTION '460-check FAILED: the opening caller could not deliver'; END IF;
    IF public.handback_deliver(root, 'shared-key', false, '{}'::jsonb) THEN RAISE EXCEPTION '460-check FAILED: a delivered row was marked again'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.research_handbacks WHERE job_id = root AND state = 'delivered' AND deliver ->> 'episode_id' = '11111111-2222-4333-8444-555555555555') THEN
        RAISE EXCEPTION '460-check FAILED: the delivery was not recorded';
    END IF;
    RAISE NOTICE '460-check: handback_deliver - the opening caller, a queued row, two ids only ok';
    -- 6. the transcript column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'podcast_episodes' AND column_name = 'transcript') THEN
        RAISE EXCEPTION '460-check FAILED: no podcast_episodes.transcript';
    END IF;
    RAISE NOTICE '460-check: podcast_episodes.transcript present ok';
END $$;
ROLLBACK;
