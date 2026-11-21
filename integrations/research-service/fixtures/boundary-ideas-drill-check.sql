-- rw-boundary-ideas: the slot-580 drill's state (run-boundary-ideas-lab.ps1 [5]). Hashes and counts only, never content.
-- fns: md5 over pg_get_functiondef of the six functions 580 replaces (byte-identical restore = equal hashes);
-- own: how many of 580's own functions exist; trg: the binding trigger; idx: the two hand-back index definitions;
-- saved / archive: the copies 580 keeps and the revert's archive; open: idea hand-backs still open; jobs: md5 of every
-- research_jobs row (a revert changes no job).
DO $$
DECLARE
    v TEXT;
    n BIGINT;
BEGIN
    SELECT md5(string_agg(coalesce(pg_get_functiondef(to_regprocedure(f)), '-') || coalesce(obj_description(to_regprocedure(f), 'pg_proc'), ''), '|' ORDER BY f)) INTO v
      FROM unnest(ARRAY['public.research_idea_queue(uuid,integer,text)', 'public.trg_idea_revisions_engage()', 'public.idea_research_now(uuid)',
                        'public.idea_schedule_set(text,text,text,time,integer,text)', 'public.idea_schedule_drain(timestamptz)',
                        'public.idea_research(uuid,text,text)']) f;
    RAISE NOTICE 'DRILL fns=%', v;
    SELECT count(*) INTO n FROM pg_proc WHERE proname IN ('idea_handback_item', 'idea_handback_settle', 'idea_handback_review', 'idea_handback_decide',
                                                          'idea_handback_run_private', 'idea_handback_deliverables', 'idea_handback_stamp', 'trg_research_handbacks_idea_owner');
    RAISE NOTICE 'DRILL own=%', n;
    SELECT count(*) INTO n FROM pg_trigger WHERE tgname = 'trg_research_handbacks_idea_owner';
    RAISE NOTICE 'DRILL trg=%', n;
    SELECT md5(coalesce(string_agg(pg_get_indexdef(i.indexrelid), '|' ORDER BY c.relname), '')) INTO v
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname IN ('uq_handback_open', 'uq_handback_idea_pending');
    RAISE NOTICE 'DRILL idx=%', v;
    SELECT count(*) INTO n FROM pg_class WHERE relname = 'uq_handback_idea_pending';
    RAISE NOTICE 'DRILL idx_idea=%', n;
    SELECT CASE WHEN to_regclass('public.research_boundary_ideas_saved') IS NULL THEN -1 ELSE 0 END INTO n;
    IF n = 0 THEN EXECUTE 'SELECT count(*) FROM public.research_boundary_ideas_saved' INTO n; END IF;
    RAISE NOTICE 'DRILL saved=%', n;
    SELECT CASE WHEN to_regclass('public.research_boundary_ideas_archive') IS NULL THEN -1 ELSE 0 END INTO n;
    IF n = 0 THEN EXECUTE 'SELECT count(*) FROM public.research_boundary_ideas_archive' INTO n; END IF;
    RAISE NOTICE 'DRILL archive=%', n;
    SELECT count(*) INTO n FROM public.research_handbacks WHERE purpose = 'idea-research' AND state IN ('pending', 'queued', 'awaiting_owner');
    RAISE NOTICE 'DRILL open=%', n;
    SELECT count(*) INTO n FROM public.research_handbacks WHERE purpose = 'idea-research';
    RAISE NOTICE 'DRILL idea_handbacks=%', n;
    SELECT md5(coalesce(string_agg(to_jsonb(j)::text, '|' ORDER BY j.id), '')) INTO v FROM public.research_jobs j;
    RAISE NOTICE 'DRILL jobs=%', v;
    SELECT md5(coalesce(string_agg((r.idea_id::text || ':' || r.revision || ':' || coalesce(r.research_job_id, '-')), '|' ORDER BY r.idea_id, r.revision), '')) INTO v FROM public.idea_revisions r;
    RAISE NOTICE 'DRILL revisions=%', v;
END $$;
