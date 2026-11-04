-- rw-boundary-core: the slot-420 drill's state (run-boundary-e2e.ps1 [5]). Hashes and counts only, never content.
-- jobs / prompts: md5 over to_jsonb of EVERY row of the touched tables (byte-identical restore = equal hashes);
-- cols / trg: research_jobs' live columns, the user triggers on research_jobs + research_prompts; fn: the report-owner
-- rule's definition; fn390: whether its body, settings and signature equal slot 390's text (public._bnd_ref_owner,
-- created by the drill from init-report-isolation.sql under another name).
DO $$
DECLARE
    v TEXT;
    n BIGINT;
BEGIN
    SELECT md5(coalesce(string_agg(to_jsonb(j)::text, '|' ORDER BY j.id), '')) INTO v FROM public.research_jobs j;
    RAISE NOTICE 'DRILL jobs=%', v;
    SELECT count(*) INTO n FROM public.research_jobs;
    RAISE NOTICE 'DRILL job_rows=%', n;
    SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.job_id), '')) INTO v FROM public.research_prompts p;
    RAISE NOTICE 'DRILL prompts=%', v;
    SELECT md5(string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum)) INTO v
      FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attnum > 0 AND NOT attisdropped;
    RAISE NOTICE 'DRILL cols=%', v;
    SELECT count(*) INTO n FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attname IN ('request_kind', 'boundary') AND NOT attisdropped;
    RAISE NOTICE 'DRILL kind_cols=%', n;
    SELECT coalesce(string_agg(tgname, ',' ORDER BY tgname), '-') INTO v FROM pg_trigger
     WHERE tgrelid IN ('public.research_jobs'::regclass, 'public.research_prompts'::regclass) AND NOT tgisinternal;
    RAISE NOTICE 'DRILL trg=%', md5(v);
    SELECT count(*) INTO n FROM pg_trigger WHERE tgname IN ('trg_research_jobs_boundary', 'trg_research_prompts_boundary');
    RAISE NOTICE 'DRILL guards=%', n;
    SELECT count(*) INTO n FROM pg_constraint WHERE conname = 'research_jobs_request_kind_check';
    RAISE NOTICE 'DRILL kind_check=%', n;
    SELECT md5(pg_get_functiondef('public.research_job_report_owner(uuid)'::regprocedure)) INTO v;
    RAISE NOTICE 'DRILL fn=%', v;
    SELECT md5(pg_get_functiondef('public.trg_idea_revisions_inlet()'::regprocedure)) INTO v;
    RAISE NOTICE 'DRILL fn_inlet=%', v;
    SELECT CASE WHEN to_regclass('public.research_request_boundary_saved') IS NULL THEN -1 ELSE 0 END INTO n;
    IF n = 0 THEN EXECUTE 'SELECT count(*) FROM public.research_request_boundary_saved' INTO n; END IF;
    RAISE NOTICE 'DRILL saved=%', n;
    SELECT md5(coalesce(obj_description('public.research_job_report_owner(uuid)'::regprocedure, 'pg_proc'), '')) INTO v;
    RAISE NOTICE 'DRILL fn_comment=%', v;
    IF to_regprocedure('public._bnd_ref_owner(uuid)') IS NULL THEN
        RAISE NOTICE 'DRILL fn390=noref';
    ELSE
        SELECT CASE WHEN a.prosrc = b.prosrc AND a.prosecdef = b.prosecdef AND a.provolatile = b.provolatile
                         AND a.proconfig IS NOT DISTINCT FROM b.proconfig AND a.prorettype = b.prorettype
                         AND a.proargnames IS NOT DISTINCT FROM b.proargnames AND a.proallargtypes IS NOT DISTINCT FROM b.proallargtypes
                    THEN 'same' ELSE 'differs' END INTO v
          FROM pg_proc a, pg_proc b
         WHERE a.oid = 'public.research_job_report_owner(uuid)'::regprocedure AND b.oid = 'public._bnd_ref_owner(uuid)'::regprocedure;
        RAISE NOTICE 'DRILL fn390=%', v;
    END IF;
    IF to_regclass('public.research_handbacks') IS NULL THEN
        RAISE NOTICE 'DRILL handbacks=none';
    ELSE
        EXECUTE 'SELECT count(*) FROM public.research_handbacks' INTO n;
        RAISE NOTICE 'DRILL handbacks=%', n;
    END IF;
    SELECT count(*) INTO n FROM pg_proc WHERE proname IN ('handback_open', 'handback_pending', 'handback_claim', 'handback_deliverables', 'handback_delivered', 'handback_owned');
    RAISE NOTICE 'DRILL handback_fns=%', n;
    IF to_regclass('public.research_request_boundary_archive') IS NULL THEN
        RAISE NOTICE 'DRILL archive=none';
    ELSE
        EXECUTE 'SELECT count(*) FROM public.research_request_boundary_archive' INTO n;
        RAISE NOTICE 'DRILL archive=%', n;
        EXECUTE $q$SELECT count(*) FROM public.research_request_boundary_archive WHERE tbl = 'public.research_handbacks'$q$ INTO n;
        RAISE NOTICE 'DRILL archive_handbacks=%', n;
        EXECUTE $q$SELECT count(*) FROM public.research_request_boundary_archive WHERE tbl = 'public.research_jobs' AND row_data ->> 'request_kind' = 'derived'$q$ INTO n;
        RAISE NOTICE 'DRILL archive_derived=%', n;
    END IF;
END $$;
