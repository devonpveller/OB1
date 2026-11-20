-- inlet-owner-r5-extra.sql - rw-inlet-owner round 5: the delta plants of tester attempt 4 and of round 5 (lab only),
-- on top of inlet-owner-catalog.sql's plant (its ids in public.lab_catalog_ids).
--   psql -v ON_ERROR_STOP=1 -v case=f2|f6|late -v mark=<token> -f inlet-owner-r5-extra.sql
--   f2    tester attempt 4 F2 (dos-filed-repro): a 'filed' event in the seeded tree whose synthesis_id is the email-body
--         source THIS run moves private. Round 4 refused the whole run on it ("still names private data").
--   f6    round 5 (found reading 440 for F1): a seeded tree with TWO gap branches that carry a gap_ref - the engine writes
--         one per gap (uq_research_jobs_tree_gap); round 4 gave every tree job the same gap_ref 'private-text', so such a
--         tree aborted the run on the unique index (live: 10 trees).
--   late  rows that arrive after a run in a tree the run made private: a new gap branch with its steer and events, a
--         new filed session; the marker :mark in each. The next run must rebuild them; the run after has nothing to do.
\set ON_ERROR_STOP on
SELECT set_config('lab.case', :'case', false), set_config('lab.mark', :'mark', false) \gset
DO $$
DECLARE
    c TEXT := current_setting('lab.case'); m TEXT := current_setting('lab.mark');
    jr UUID := (SELECT v::uuid FROM public.lab_catalog_ids WHERE k = 'seeded_root');
    sm UUID := (SELECT v::uuid FROM public.lab_catalog_ids WHERE k = 'moved_source');
    jb UUID; sess UUID;
BEGIN
    IF c = 'f2' THEN
        -- (one filed event per job: on the tree's gap branch)
        INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload)
        VALUES ((SELECT v::uuid FROM public.lab_catalog_ids WHERE k = 'seeded_branch'), jr, 'f1', 'filed', 'due_process', jsonb_build_object('synthesis_id', sm, 'research_key', 'rs-f2'));
    ELSIF c = 'f6' THEN
        INSERT INTO public.research_jobs (status, origin, query, anchor, root_job_id, parent_job_id, rooted_step_id, branch_kind, gap_ref)
        VALUES ('done', 'manual', 'How does a relate to b?', 'x', jr, jr, 's1', 'interhub', 'interhub:a|b') RETURNING id INTO jb;
        INSERT INTO public.research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor, gap, actor_sub)
        VALUES (jr, jr, jb, 'interhub', 's1', 'a <-> b', 't', 'x', jsonb_build_object('a', jsonb_build_object('label', 'a'), 'b', jsonb_build_object('label', 'b'), 'density', 0.1), 'system:gap');
    ELSIF c = 'late' THEN
        INSERT INTO public.research_jobs (status, origin, query, anchor, root_job_id, parent_job_id, rooted_step_id, branch_kind, gap_ref)
        VALUES ('done', 'manual', 'Verify: late ' || m, 'late anchor ' || m, jr, jr, 'late' || m, 'gap', 'claim:late' || m) RETURNING id INTO jb;
        INSERT INTO public.research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor, gap, caller, context_snapshot, actor_sub)
        VALUES (jr, jr, jb, 'gap', 'late' || m, 'late steer ' || m, 'late topic ' || m, 'late anchor ' || m,
                jsonb_build_object('claim_id', 'x', 'text', m, 'score', 0.1, 'threshold', 0.2), 'c' || m, jsonb_build_object('k', m), 'system:gap');
        INSERT INTO public.sessions (origin_tool, query_text, metadata) VALUES ('owui', 'late session ' || m, jsonb_build_object('k', m)) RETURNING id INTO sess;
        INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload, trail) VALUES
          (jb, jr, 'late' || m, 'stage', 'due_process', jsonb_build_object('note', m), jsonb_build_object('t', m)),
          (jb, jr, NULL, 'filed', 'due_process', jsonb_build_object('synthesis_id', NULL, 'research_key', 'k' || m, 'session_id', sess), NULL);
        INSERT INTO public.research_cancels (job_id, actor_sub, caller, reason, outcome) VALUES (jb, 'system:gap', 'c', 'late reason ' || m, 'already_terminal');
    END IF;
END $$;
