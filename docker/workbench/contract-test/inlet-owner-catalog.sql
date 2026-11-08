-- inlet-owner-catalog.sql - rw-inlet-owner round 5: the CATALOG-DRIVEN case (lab only; synthetic rows; never point it
-- at a live database). The operator's plan change of 2026-11-05: the test stops naming the tables it checks by hand.
--   psql -v ON_ERROR_STOP=1 -v phase=plant -v mark=<token> -v ctl=<token> -v write_set=<t1,t2,...> -f inlet-owner-catalog.sql
--   (then slot 440 runs)
--   psql -v ON_ERROR_STOP=1 -v phase=check -v mark=<token> -v ctl=<token> -f inlet-owner-catalog.sql
--
-- What it does:
--   plant  1. writes ONE seeded tree the way the engine, the curator and the persist route write one (a digest root
--             seeded with an email body, a gap branch with its steer, events, the prompt, the staging session, the filed
--             session, the filed synthesis, a cited article the filing re-stamped, the thread the filing named, the thread
--             links, the claim drawn from the synthesis, a cancel, an admission trail row), and the same CONTROL tree
--             seeded with an ordinary article. Every row is registered with its role in lab_catalog_rows.
--          2. ENUMERATES the tables from the catalog: every public table with a foreign key onto research_jobs or a uuid
--             column named *job_id, plus every table of :write_set that exists (the runner reads :write_set out of the
--             research service, the curator, the persist route, the workbench sessions and the digest / podcast code).
--             A table found here must either hold a row of the seeded tree (a foreign key onto one of its jobs, or a row
--             the plant registered), or be declared below (lab_catalog_not_tree) with its reason. Anything else FAILS:
--             a table added later that nobody planted or declared fails this case without a change to it.
--          3. ENUMERATES every text, varchar, jsonb and text[] column of each of those tables (information_schema) and
--             writes the marker into it, on every row of the seeded tree (:mark) and of the control (:ctl), one column at
--             a time. A column whose own constraints refuse free text (a CHECK, an enum) is recorded as refused - it
--             cannot hold seed text. A foreign-key text column holds only its parent's key and is not written.
--   check  4. as service_role (PostgREST's anonymous role; every app role reads through it), scans EVERY column of
--             EVERY public table it can read: a seed marker anywhere is a FAIL, unless that (table, row role, column)
--             is in the declared residual list below (lab_catalog_allowed), with its reason.
--          5. the owner's private store still holds the marker for every table the rebuild rewrote or moved.
--          6. the control tree keeps every marker it was given (440 changes no unseeded tree).
-- Output: lines 'CATALOG <kind> ...' and the summary 'CATALOG RESULT ok|FAILED <n>'.
\set ON_ERROR_STOP on
\if :{?write_set}
\else
\set write_set ''
\endif
SELECT set_config('lab.mark', :'mark', false), set_config('lab.ctl', :'ctl', false), set_config('lab.phase', :'phase', false),
       set_config('lab.write_set', :'write_set', false) \gset

SELECT (current_setting('lab.phase') = 'plant') AS is_plant \gset
\if :is_plant
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        CREATE ROLE ob_app_memory NOLOGIN NOSUPERUSER NOBYPASSRLS;
        GRANT service_role TO ob_app_memory;
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.lab_catalog_rows (tree TEXT NOT NULL, tbl TEXT NOT NULL, role TEXT NOT NULL, key JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS public.lab_catalog_tables (tbl TEXT PRIMARY KEY, why TEXT NOT NULL, status TEXT, n_rows INT);
CREATE TABLE IF NOT EXISTS public.lab_catalog_cols (tbl TEXT, col TEXT, tree TEXT, status TEXT, PRIMARY KEY (tbl, col, tree));
CREATE TABLE IF NOT EXISTS public.lab_catalog_jobs (tree TEXT NOT NULL, id UUID PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.lab_catalog_ids (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- the tables the research paths write that hold no row of a seeded tree, and why (reviewed by hand; a new table is
-- NOT here, so it fails until someone plants it or declares it)
CREATE TABLE IF NOT EXISTS public.lab_catalog_not_tree (tbl TEXT PRIMARY KEY, why TEXT NOT NULL);
INSERT INTO public.lab_catalog_not_tree VALUES
  ('public.thoughts', 'the owner stamp (step 1): every thought is the owner''s; a tree writes none'),
  ('public.wiki_pages', 'compiled output: withheld by step 6 (links, evidence, a retitled synthesis)'),
  ('public.ideas', 'the idea lane (slots 370/380: owner-isolated); a seeded digest tree is never an idea job'),
  ('public.idea_revisions', 'the idea lane (slot 380)'),
  ('public.held_sources', 'an idea''s held sources (refinery_id, the idea lane)'),
  ('public.held_source_chunks', 'an idea''s held sources'),
  ('public.refinery_user_sources', 'the idea lane'),
  ('public.workspace_users', 'identity: subjects only'),
  ('public.contract_registry_entries', 'the registry of report types (configuration)'),
  ('public.contract_registries', 'configuration'),
  ('public.credibility_trigger_state', 'numbers and timestamps of the credibility worker'),
  ('public.credibility_rescore_confirmations', 'the credibility worker''s confirmations (numbers, codes)'),
  ('public.source_tombstones', 'refused urls (public pages)'),
  ('public.source_tombstone_attempts', 'refused urls'),
  ('public.podcast_teams', 'podcast configuration'),
  ('public.podcast_team_members', 'podcast configuration'),
  ('public.podcast_presenters', 'podcast configuration'),
  ('public.podcast_voice_links', 'podcast configuration'),
  ('public.podcast_formats', 'podcast configuration (the podcast stores write it through this.#req("POST", ...))'),
  ('public.podcast_render_requests', 'the owner''s render requests (owner-keyed)'),
  ('public.podcast_episodes', 'the owner''s episode (owner_sub; 460 keeps the script there, readers filter by owner)'),
  ('public.research_private_reports', 'an IDEA job''s private report (slot 390''s store); a seeded tree is not an idea job'),
  ('public.research_private_report_claims', 'slot 390''s store'),
  ('public.research_prompt_moves', 'who owned a prompt before slot 320 (subjects only; its revert''s key)'),
  ('public.source_entities', 'shared vocabulary: a moved source''s rows are archived by step 2'),
  ('public.source_extraction_queue', 'a work queue of source ids'),
  ('public.entities', 'shared vocabulary (topics stay shared, 380)'),
  ('public.thread_embeddings', 'vectors only'),
  -- round 6: the tables the recursive scan of the workbench and the other writers adds; none holds a research tree's text
  ('public.admin_audit', 'the admin action log (subjects, action codes, ids)'),
  ('public.contract_settings', 'contract configuration (keys and values set by an admin)'),
  ('public.export_runs', 'a user''s export runs (owner-keyed; slot 310)'),
  ('public.import_job_payloads', 'an intake import''s file bytes (job_id is an IMPORT job: a foreign key onto import_jobs)'),
  ('public.notification_acks', 'a user''s notification acknowledgements (ids)'),
  ('public.reference_holders', 'the reference system''s holders (P2a; ids, codes)'),
  ('public.reference_holder_state', 'the reference system''s holder state (P2a)'),
  ('public.reference_resolutions', 'the reference system''s resolutions (P2a)'),
  ('public.refinery_hidden', 'the idea lane (slots 370/380)'),
  ('public.refinery_members', 'the idea lane'),
  ('public.refinery_picked_links', 'the idea lane'),
  ('public.refinery_state', 'the idea lane'),
  ('public.user_document_listings', 'a user''s own document listings (owner-keyed; P2b)'),
  ('public.user_settings', 'a user''s settings (slot 400; owner-keyed, read through setting_get)'),
  ('public.workspace_impersonation', 'admin identity records (subjects)'),
  ('public.workspace_rooms', 'a user''s rooms (slot 340; owner-keyed)'),
  ('public.workspace_room_entries', 'a user''s room transcript (slot 340; owner-keyed)'),
  ('public.import_jobs', 'an intake import (the owner''s, owner_sub); its source_id has a foreign key onto sources, so a moved source''s import row is archived and handled by step 2 - not planted here'),
  ('public.source_disputes', 'a dispute of a source (foreign key onto sources): step 2 archives a moved source''s rows and applies the key - not planted here'),
  ('public.cleanup_actions', 'the cleanup view''s per-user action log (owner_sub); 440''s source rule moves a moved source''s rows - not planted here'),
  ('public.reference_records', 'a reference to a SHARED source''s span; 440''s source rule moves a moved source''s rows - not planted here')
ON CONFLICT (tbl) DO NOTHING;

DO $$
DECLARE
    m   TEXT := current_setting('lab.mark');
    cm  TEXT := current_setting('lab.ctl');
    tr  TEXT; mk TEXT; seedurl TEXT; q TEXT; i INT;
    sm UUID; cl2 UUID; jr UUID; jb UUID; st UUID; sess UUID; sst UUID; th UUID; syn UUID; sc UUID; cl UUID; rk TEXT; can BIGINT; adm UUID;
    ev BIGINT;
BEGIN
    FOR i IN 1 .. 2 LOOP
        tr := CASE i WHEN 1 THEN 'seeded' ELSE 'control' END;
        mk := CASE i WHEN 1 THEN m ELSE cm END;
        q := 'Daily digest: subject ' || mk || ' q';
        rk := 'rs-' || encode(sha256(convert_to(tr || mk, 'UTF8')), 'hex');
        rk := left(rk, 43);
        IF i = 1 THEN
            -- the email body the seed came from (moved private by step 2)
            seedurl := 'https://mail.google.com/mail/u/0/#inbox/' || substr(md5(mk), 1, 16);
            INSERT INTO public.sources (url, title, content, content_type, metadata)
            VALUES (seedurl, 'Subject ' || mk, 'the email body ' || mk, 'web_article', jsonb_build_object('gmail_id', 'g' || mk))
            RETURNING id INTO sm;
            INSERT INTO public.lab_catalog_rows VALUES (tr, 'public.sources', 'moved', jsonb_build_object('id', sm));
            -- a claim drawn ONLY from the email body (private) and one grounded only on it (the chain): their own edges
            -- must reach the owner's store (inlet_private_claim_sources, the coordinator's round-5 addition)
            INSERT INTO public.claims (text) VALUES ('a private claim ' || mk) RETURNING id INTO cl;
            INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES (cl, sm, 'states');
            INSERT INTO public.lab_catalog_ids VALUES ('priv_claim', cl::text), ('moved_source', sm::text);
            -- round 6 (tester attempt 5 F2): the research run's credibility record of the SEED itself, keyed by the moved
            -- email body (no foreign key): an author name lifted from the email body, a corroboration, a trail event
            INSERT INTO public.source_credibility_history (source_id, family, claim_kind, score, total, model_version, signals, reasons)
            VALUES (sm, 'general', 'fact', 0.3, 0.3, 'v1', jsonb_build_object('author_identity', 'Zq' || mk || 'name'),
                    jsonb_build_array('author stated (Zq' || mk || 'name): +0.1'));
            INSERT INTO public.source_trail_events (source_id, kind, detail) VALUES (sm, 'found_via', jsonb_build_object('note', 'trail ' || mk));
            INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by) VALUES (sm, 1, 'an edit ' || mk, 'Subject ' || mk, 'lab');
            INSERT INTO public.page_compile_marks (page_ref, source_id, reason) VALUES ('content/source/' || sm, sm, 'mark ' || mk);
            INSERT INTO public.claims (text) VALUES ('a chained claim ' || mk) RETURNING id INTO cl2;
            INSERT INTO public.claim_sources (claim_id, parent_claim_id, edge_type) VALUES (cl2, cl, 'inferred_from');
            INSERT INTO public.lab_catalog_ids VALUES ('chain_claim', cl2::text);
        ELSE
            seedurl := 'https://public.example/article/' || mk;
        END IF;
        -- the root, its gap branch
        INSERT INTO public.research_jobs (status, origin, query, options, result, progress, metrics, error, tree_report, finished_at, topic_estimate, anchor)
        VALUES ('done', 'manual', q, jsonb_build_object('seed_sources', jsonb_build_array(jsonb_build_object('url', seedurl, 'title', 'seed', 'content', 'body ' || mk))),
                jsonb_build_object('outcome', 'ok', 'synthesis', 'syn ' || mk), jsonb_build_object('phase', 'done', 'message', 'pm'),
                jsonb_build_object('claims_reused', 1), 'e', jsonb_build_object('summary', 'ts'), now(), 'topic ' || mk, 'anchor ' || mk)
        RETURNING id INTO jr;
        INSERT INTO public.research_jobs (status, origin, query, anchor, root_job_id, parent_job_id, rooted_step_id, branch_kind, gap_ref, result)
        VALUES ('done', 'manual', 'Verify: ' || mk, q, jr, jr, 's1', 'gap', 'claim:' || gen_random_uuid(), jsonb_build_object('outcome', 'ok', 'synthesis', 'b'))
        RETURNING id INTO jb;
        INSERT INTO public.lab_catalog_jobs VALUES (tr, jr), (tr, jb);
        INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES (jr, 'service:daily-digest', 'service:daily-digest', q);
        INSERT INTO public.research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor, gap, caller, context_snapshot, actor_sub)
        VALUES (jr, jr, jb, 'gap', 's1', 'gap ' || mk, 'topic ' || mk, q, jsonb_build_object('claim_id', gen_random_uuid(), 'text', mk, 'score', 0.4, 'threshold', 0.5),
                'daily-digest', jsonb_build_object('n', mk), 'system:gap')
        RETURNING id INTO st;
        -- the thread the filing named, the staging session (the job's), the filed session
        INSERT INTO public.threads (name, description) VALUES ('Newsletters ' || mk, 'Research on ' || q || ' and more') RETURNING id INTO th;
        INSERT INTO public.sessions (origin_tool, query_text, thread_id, metadata) VALUES ('owui', q, th, jsonb_build_object('source', 'research-service')) RETURNING id INTO sst;
        UPDATE public.research_jobs SET session_id = sst WHERE id = jr;
        INSERT INTO public.sessions (origin_tool, query_text, thread_id, metadata)
        VALUES ('owui', q, th, jsonb_build_object('research_key', rk, 'kind', 'deep', 'model', 'm-' || mk)) RETURNING id INTO sess;
        -- the filed synthesis (persist: title = the question) and a cited article the filing re-stamped
        INSERT INTO public.sources (url, title, content, content_type, research_key, research_query, metadata)
        VALUES (NULL, left(q, 200), 'the report ' || mk, 'research_synthesis', rk, q,
                jsonb_build_object('source', 'deep-research', 'claim', 'claim ' || mk, 'needs', jsonb_build_array('need ' || mk),
                                   'followup_queries', jsonb_build_array('fq ' || mk), 'prose_synthesis', 'prose ' || mk, 'report_type', 'general-report'))
        RETURNING id INTO syn;
        INSERT INTO public.sources (url, title, content, content_type, research_key, research_query, metadata)
        VALUES ('https://cited.example/a/' || mk, 'Cited article', 'a public article', 'web_article', rk, q,
                jsonb_build_object('source', 'deep-research-source', 'research_key', rk, 'originating_query', q, 'session_id', sess))
        RETURNING id INTO sc;
        INSERT INTO public.session_sources (session_id, source_id) VALUES (sess, syn), (sess, sc), (sst, sc);
        INSERT INTO public.thread_sources (thread_id, source_id, link_type, status, suggestion_reason) VALUES (th, syn, 'suggested', 'pending', 'it matches ' || q), (th, sc, 'automatic', 'confirmed', NULL);
        INSERT INTO public.source_chunks (source_id, idx, content) VALUES (syn, 0, 'the report ' || mk);
        INSERT INTO public.claims (text) VALUES ('a claim of the report ' || mk) RETURNING id INTO cl;
        INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES (cl, syn, 'states');
        -- the events (a stage, the filed event naming the synthesis, the session and the thread)
        INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload) VALUES
          (jr, jr, 's1', 'stage', 'due_process', jsonb_build_object('stage', 'gather', 'note', 'n ' || mk)),
          (jr, jr, NULL, 'filed', 'due_process', jsonb_build_object('synthesis_id', syn, 'research_key', rk, 'session_id', sess, 'thread_id', th, 'sources_written', 1));
        -- a cancel and an admission trail row that hang on the tree's jobs
        INSERT INTO public.research_cancels (job_id, actor_sub, caller, reason, outcome) VALUES (jb, 'system:gap', 'daily-digest', 'reason ' || mk, 'already_terminal')
        RETURNING id INTO can;
        adm := gen_random_uuid();
        INSERT INTO public.research_admission_trail (id, job_id, session_id, url, url_key, kind, claim_kind, family, score, total, floor, model_version, signals, reasons, path, source_id)
        VALUES (adm, jr, sst, 'https://cited.example/a/' || mk, 'cited.example/a/' || mk, 'admitted', 'fact', 'news', 0.5, 1, 0.2, 'v1',
                jsonb_build_object('s', 1), jsonb_build_array('because ' || mk), jsonb_build_array(jsonb_build_object('q', q)), sc);
        INSERT INTO public.lab_catalog_rows VALUES
          (tr, 'public.research_steers', 'tree', jsonb_build_object('id', st)),
          (tr, 'public.threads', 'thread', jsonb_build_object('id', th)),
          (tr, 'public.sessions', 'session', jsonb_build_object('id', sst)),
          (tr, 'public.sessions', 'session', jsonb_build_object('id', sess)),
          (tr, 'public.sources', 'synthesis', jsonb_build_object('id', syn)),
          (tr, 'public.sources', 'cited', jsonb_build_object('id', sc)),
          (tr, 'public.session_sources', 'link', jsonb_build_object('session_id', sess, 'source_id', syn)),
          (tr, 'public.thread_sources', 'synthesis-link', jsonb_build_object('thread_id', th, 'source_id', syn)),
          (tr, 'public.thread_sources', 'cited-link', jsonb_build_object('thread_id', th, 'source_id', sc)),
          (tr, 'public.source_chunks', 'synthesis', jsonb_build_object('source_id', syn, 'idx', 0)),
          (tr, 'public.claims', 'synthesis-claim', jsonb_build_object('id', cl)),
          (tr, 'public.claim_sources', 'synthesis-claim', jsonb_build_object('claim_id', cl, 'source_id', syn));
        INSERT INTO public.lab_catalog_ids VALUES (tr || '_thread', th::text), (tr || '_q', q), (tr || '_root', jr::text), (tr || '_branch', jb::text);
        IF i = 1 THEN
            INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
            VALUES (sm, sc, 'weak', 0.1, 'the email line ' || mk, 'fact', 'supports', 'v1');
        END IF;
    END LOOP;
END $$;

-- 2. the tables, from the catalog
DO $$
DECLARE r RECORD; n INT; ws TEXT[] := string_to_array(nullif(current_setting('lab.write_set'), ''), ',');
BEGIN
    INSERT INTO public.lab_catalog_tables (tbl, why)
    SELECT DISTINCT format('%I.%I', ns.nspname, c.relname), 'a foreign key onto research_jobs, or a *job_id / *job_ref / *source_id / *session_id column'
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND c.relname NOT LIKE 'lab\_%'
       AND c.relname NOT LIKE 'inlet\_%'
       -- round 6: a key by NAME, whatever its type or foreign key: *job_id, *job_ref, *source_id, *session_id
       AND (EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype = 'f' AND con.confrelid = 'public.research_jobs'::regclass)
            OR (a.attname ~ '(^|_)(job_id|job_ref|source_id|session_id)$'
                AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype = 'f' AND a.attnum = ANY (con.conkey)
                                   AND con.confrelid NOT IN ('public.research_jobs'::regclass, 'public.sessions'::regclass, 'public.sources'::regclass))))
    ON CONFLICT (tbl) DO NOTHING;
    INSERT INTO public.lab_catalog_tables (tbl, why)
    SELECT DISTINCT format('%I.%I', ns.nspname, c.relname), 'written by the research paths (the code scan)'
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY (coalesce(ws, ARRAY[]::text[]))
    ON CONFLICT (tbl) DO NOTHING;
    -- the job-tied tables' rows of each tree, by their job column (generic)
    -- the rows of each tree by a key column (generic): a job key -> the tree's jobs ('tree'); a source key -> the moved
    -- email body ('moved-source'); a session key -> the tree's sessions ('session-row')
    CREATE TEMP TABLE lab_keyset (tree TEXT, kind TEXT, id TEXT) ON COMMIT DROP;
    INSERT INTO lab_keyset SELECT tree, 'job', id::text FROM public.lab_catalog_jobs;
    INSERT INTO lab_keyset SELECT 'seeded', 'source', v FROM public.lab_catalog_ids WHERE k = 'moved_source';
    INSERT INTO lab_keyset SELECT tree, 'session', key ->> 'id' FROM public.lab_catalog_rows WHERE tbl = 'public.sessions' AND role = 'session';
    FOR r IN SELECT DISTINCT t.tbl, a.attname AS col,
                    CASE WHEN a.attname ~ '(^|_)source_id$' THEN 'source' WHEN a.attname ~ '(^|_)session_id$' THEN 'session' ELSE 'job' END AS kind
               FROM public.lab_catalog_tables t JOIN pg_attribute a ON a.attrelid = t.tbl::regclass
              WHERE a.attnum > 0 AND NOT a.attisdropped
                AND (a.attname ~ '(^|_)(job_id|job_ref|source_id|session_id)$' OR (a.attname = 'id' AND t.tbl = 'public.research_jobs')
                     OR EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conrelid = t.tbl::regclass AND con.contype = 'f'
                                   AND con.confrelid = 'public.research_jobs'::regclass AND a.attnum = ANY (con.conkey))) LOOP
        EXECUTE format($q$INSERT INTO public.lab_catalog_rows (tree, tbl, role, key)
                          SELECT DISTINCT j.tree, %L, CASE %L WHEN 'job' THEN 'tree' WHEN 'source' THEN 'moved-source' ELSE 'session-row' END, (SELECT jsonb_object_agg(pa.attname, to_jsonb(t) -> pa.attname)
                                                                 FROM pg_index ix JOIN pg_attribute pa ON pa.attrelid = ix.indrelid AND pa.attnum = ANY (ix.indkey)
                                                                WHERE ix.indrelid = %L::regclass AND ix.indisprimary)
                            FROM %s t JOIN lab_keyset j ON j.kind = %L AND j.id = t.%I::text
                           WHERE NOT EXISTS (SELECT 1 FROM public.lab_catalog_rows x WHERE x.tbl = %L AND x.tree = j.tree
                                              AND x.key = (SELECT jsonb_object_agg(pa.attname, to_jsonb(t) -> pa.attname)
                                                             FROM pg_index ix JOIN pg_attribute pa ON pa.attrelid = ix.indrelid AND pa.attnum = ANY (ix.indkey)
                                                            WHERE ix.indrelid = %L::regclass AND ix.indisprimary))$q$,
                       r.tbl, r.kind, r.tbl, r.tbl, r.kind, r.col, r.tbl, r.tbl);
    END LOOP;
    UPDATE public.lab_catalog_tables t
       SET n_rows = (SELECT count(*) FROM public.lab_catalog_rows x WHERE x.tbl = t.tbl AND x.tree = 'seeded'),
           status = CASE WHEN EXISTS (SELECT 1 FROM public.lab_catalog_rows x WHERE x.tbl = t.tbl AND x.tree = 'seeded') THEN 'planted'
                         WHEN EXISTS (SELECT 1 FROM public.lab_catalog_not_tree d WHERE d.tbl = t.tbl) THEN 'declared'
                         -- a table with FORCED row security is owner-only already (420's private hand-back): no app role reads it
                         WHEN (SELECT relforcerowsecurity FROM pg_class WHERE oid = t.tbl::regclass) THEN 'declared'
                         -- a table neither service_role nor ob_app_memory may read (an owner-only archive, e.g. slot 390's)
                         WHEN NOT has_table_privilege('service_role', t.tbl::regclass, 'SELECT')
                              AND NOT has_table_privilege('ob_app_memory', t.tbl::regclass, 'SELECT') THEN 'declared'
                         ELSE 'UNPLANTED' END;
    -- a registered row's table is checked too (sources, threads, ... that the code scan may not list)
    INSERT INTO public.lab_catalog_tables (tbl, why, status, n_rows)
    SELECT x.tbl, 'a row of the seeded tree (registered by the plant)', 'planted', count(*) FROM public.lab_catalog_rows x
     WHERE x.tree = 'seeded' GROUP BY x.tbl
    ON CONFLICT (tbl) DO NOTHING;
END $$;

-- 3. the marker in every text-like column of every row of both trees (one column at a time; triggers off, as the
--    engine's own write would not fire a later guard)
DO $$
DECLARE r RECORD; k RECORD; mk TEXT; expr TEXT; wh TEXT; n INT; st TEXT;
BEGIN
    FOR r IN SELECT c.table_schema || '.' || c.table_name AS tbl, c.column_name AS col, c.data_type, c.udt_name
               FROM information_schema.columns c
              WHERE (c.table_schema || '.' || c.table_name) IN (SELECT tbl FROM public.lab_catalog_tables WHERE status = 'planted')
                AND (c.data_type IN ('text', 'character varying', 'jsonb') OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))
              ORDER BY 1, 2 LOOP
        FOR mk IN SELECT unnest(ARRAY['seeded', 'control']) LOOP
            -- a foreign-key column holds its parent's key only; a generated column is computed
            IF EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
                        WHERE con.conrelid = r.tbl::regclass AND con.contype = 'f' AND a.attname = r.col)
               OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.tbl::regclass AND a.attname = r.col AND a.attgenerated <> '') THEN
                INSERT INTO public.lab_catalog_cols VALUES (r.tbl, r.col, mk, 'fk-or-generated') ON CONFLICT DO NOTHING;
                CONTINUE;
            END IF;
            expr := CASE WHEN r.data_type = 'jsonb' THEN
                        format($e$CASE jsonb_typeof(%1$I) WHEN 'object' THEN %1$I || jsonb_build_object(%2$L, %2$L)
                                                          WHEN 'array' THEN %1$I || to_jsonb(%2$L::text)
                                                          ELSE jsonb_build_object(%2$L, %2$L) END$e$, r.col,
                               CASE mk WHEN 'seeded' THEN current_setting('lab.mark') ELSE current_setting('lab.ctl') END)
                    WHEN r.data_type = 'ARRAY' THEN format('array_append(coalesce(%I, ARRAY[]::text[]), %L)', r.col,
                               CASE mk WHEN 'seeded' THEN current_setting('lab.mark') ELSE current_setting('lab.ctl') END)
                    ELSE format('coalesce(%I || '' '', '''') || %L', r.col,
                               CASE mk WHEN 'seeded' THEN current_setting('lab.mark') ELSE current_setting('lab.ctl') END) END;
            n := 0; st := 'written';
            BEGIN
                PERFORM set_config('session_replication_role', 'replica', true);
                FOR k IN SELECT key FROM public.lab_catalog_rows WHERE tbl = r.tbl AND tree = mk LOOP
                    SELECT string_agg(format('t.%I::text = %L', e.key, e.value #>> '{}'), ' AND ') INTO wh FROM jsonb_each(k.key) e;
                    EXECUTE format('UPDATE %s t SET %I = %s WHERE %s', r.tbl, r.col, expr, wh);
                    n := n + 1;
                END LOOP;
                PERFORM set_config('session_replication_role', 'origin', true);
            EXCEPTION WHEN OTHERS THEN
                st := 'refused ' || SQLSTATE;
                PERFORM set_config('session_replication_role', 'origin', true);
            END;
            IF n = 0 AND st = 'written' THEN st := 'no-row'; END IF;
            INSERT INTO public.lab_catalog_cols VALUES (r.tbl, r.col, mk, st) ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;
END $$;
-- the thread the filing named quotes the root's question as the engine left it (the curator writes the description from
-- the question): its exact text, the marker included
UPDATE public.lab_catalog_ids i SET v = j.query FROM public.lab_catalog_ids r, public.research_jobs j
 WHERE i.k IN ('seeded_q', 'control_q') AND r.k = replace(i.k, '_q', '_root') AND j.id = r.v::uuid;
UPDATE public.threads t SET description = coalesce(t.description, '') || ' Also: ' || q.v
  FROM public.lab_catalog_ids i, public.lab_catalog_ids q
 WHERE i.k IN ('seeded_thread', 'control_thread') AND q.k = replace(i.k, '_thread', '_q') AND t.id = i.v::uuid;
-- round 6 (tester attempt 5 F1, F6; the coordinator's T19 variant): the seeded question as FREE TEXT where no link ties
-- it to the tree - a legacy synthesis titled with it (upper case, doubled spaces) and no filed event; a session whose
-- query text contains it; a notebook (thread) whose description quotes it and that no tree session names; a thread whose
-- slug is its slug form; a wiki page titled with it; a short email subject (11 characters) reused whole as a thread name.
-- None is registered: a marker found in any of them after 440 is a LEAK.
DO $$
DECLARE q TEXT := (SELECT v FROM public.lab_catalog_ids WHERE k = 'seeded_q'); m TEXT := current_setting('lab.mark'); x UUID;
BEGIN
    INSERT INTO public.sources (url, title, content, content_type, research_query)
    VALUES (NULL, upper(replace(q, ' ', '  ')), 'an older report', 'research_synthesis', NULL) RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('free_synth', x::text);
    INSERT INTO public.sessions (origin_tool, query_text, metadata) VALUES ('owui', 'Research: ' || q || ' (resend)', '{}'::jsonb) RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('free_session', x::text);
    INSERT INTO public.threads (name, description, status) VALUES ('Industry news', 'Covers: ' || lower(q) || '; and more', 'active') RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('free_notebook', x::text);
    INSERT INTO public.threads (name, description, slug, status)
    VALUES ('Renamed thread', 'renamed', btrim(regexp_replace(lower(q), '[^a-z0-9]+', '-', 'g'), '-'), 'active') RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('free_slug_thread', x::text);
    INSERT INTO public.wiki_pages (slug, page_class, title, body, links)
    VALUES ('research/free-' || substr(md5(m), 1, 8), 'research', q, 'The report.', '[]'::jsonb);
    INSERT INTO public.lab_catalog_ids VALUES ('free_page', 'research/free-' || substr(md5(m), 1, 8));
    -- round 8 (tester attempt 6 F1): a SHARED article whose title carries the seeded question and whose tags are the
    -- default empty array (NOT NULL): the sweep cuts the title, the tags stay '{}' exactly
    IF current_setting('lab.r8_no_f1', true) IS DISTINCT FROM 'on' THEN
        INSERT INTO public.sources (url, title, content, content_type)
        VALUES ('https://shared.example/fwd/' || substr(md5(m), 1, 8), 'Fwd: RE: ' || upper(q) || '  follow-up', 'a public page', 'web_article') RETURNING id INTO x;
        INSERT INTO public.lab_catalog_ids VALUES ('r8_empty_tags', x::text);
    END IF;
    -- round 8 (F2): the seeded question inside an UNRELATED job's event payload, every space a newline (one) or a tab
    -- (the other), so the JSON text glues 'n' / 't' onto every word
    INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'an unrelated job ' || substr(md5(m), 1, 6)) RETURNING id INTO x;
    INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload) VALUES
      (x, x, 's1', 'stage', 'due_process', jsonb_build_object('note', 'Summary: ' || replace(q, ' ', chr(10)) || ' went well')),
      (x, x, 's2', 'stage', 'due_process', jsonb_build_object('note', 'Summary: ' || replace(q, ' ', chr(9)) || ' went well'));
    INSERT INTO public.lab_catalog_ids VALUES ('r8_json_job', x::text);
    -- round 8 (F4): a 5-character TOPIC of a seeded-tree job, reused as a whole thread name, a whole jsonb string and a
    -- whole text[] element in shared rows
    INSERT INTO public.research_jobs (status, origin, query, anchor, topic_estimate, root_job_id, parent_job_id, rooted_step_id, branch_kind)
    SELECT 'done', 'manual', 'Verify: short topic', 'x', 'Pyxis', v::uuid, v::uuid, 's1', 'gap' FROM public.lab_catalog_ids WHERE k = 'seeded_root';
    INSERT INTO public.threads (name, description) VALUES ('Pyxis', 'a short-topic thread') RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('r8_short_thread', x::text);
    INSERT INTO public.sources (url, title, content, content_type, tags, metadata)
    VALUES ('https://shared.example/short/' || substr(md5(m), 1, 8), 'An ordinary page', 'a public page', 'web_article',
            ARRAY['misc', 'Pyxis', NULL], jsonb_build_object('subject', 'Pyxis', 'n', 1)) RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('r8_short_source', x::text);
    -- round 9 (tester attempt 7 G1): a seeded-tree topic in Greek (a final sigma); a SHARED claim carries it upper-cased
    -- (the prefilter's lower() and the pattern's case-insensitive match fold the final sigma differently; convert_from's
    -- result is collation "C", where upper() folds ASCII only, hence the COLLATE)
    INSERT INTO public.research_jobs (status, origin, query, anchor, topic_estimate, root_job_id, parent_job_id, rooted_step_id, branch_kind)
    SELECT 'done', 'manual', 'Verify: greek topic', 'x', convert_from(decode('ce9720ceb5cf84ceaecf83ceb9ceb120cf83cf8dcebdcebfceb4cebfcf8220cf84ceb7cf8220ceb5cf84ceb1ceb9cf81ceb5ceafceb1cf8220cebeceb5cebaceb9cebdceac20ceb1cf8dcf81ceb9cebf', 'hex'), 'UTF8'), v::uuid, v::uuid, 's2', 'gap'
      FROM public.lab_catalog_ids WHERE k = 'seeded_root';
    INSERT INTO public.claims (text) VALUES ('Reported: ' || upper(convert_from(decode('ce9720ceb5cf84ceaecf83ceb9ceb120cf83cf8dcebdcebfceb4cebfcf8220cf84ceb7cf8220ceb5cf84ceb1ceb9cf81ceb5ceafceb1cf8220cebeceb5cebaceb9cebdceac20ceb1cf8dcf81ceb9cebf', 'hex'), 'UTF8') COLLATE "default") || ' (wire)') RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('r9_greek_claim', x::text);
    -- round 9 (G10): a seeded-tree topic with an accented word; its slug form (montr-alaise) as a thread slug and as a
    -- wiki page's slug
    INSERT INTO public.research_jobs (status, origin, query, anchor, topic_estimate, root_job_id, parent_job_id, rooted_step_id, branch_kind)
    SELECT 'done', 'manual', 'Verify: accented topic', 'x', convert_from(decode('546865206d6f6e7472c3a9616c6169736520717561727465726c7920706c616e20726576696577', 'hex'), 'UTF8'), v::uuid, v::uuid, 's3', 'gap'
      FROM public.lab_catalog_ids WHERE k = 'seeded_root';
    INSERT INTO public.threads (name, description, slug, status)
    VALUES ('Quarterly thread', 'a thread', 'the-montr-alaise-quarterly-plan-review', 'active') RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('r9_accent_thread', x::text);
    INSERT INTO public.wiki_pages (slug, page_class, title, body, links)
    VALUES ('research/the-montr-alaise-quarterly-plan-review', 'research', 'Quarterly review', 'The report.', '[]'::jsonb);
    -- round 9 (tester attempt 7 item 5): a seeded-tree topic that IS a code value ('Done'): a status = 'done' outside the
    -- tree stays 'done' (a CHECK column), and the run is not refused
    INSERT INTO public.research_jobs (status, origin, query, anchor, topic_estimate, root_job_id, parent_job_id, rooted_step_id, branch_kind)
    SELECT 'done', 'manual', 'Verify: code topic', 'x', 'Done', v::uuid, v::uuid, 's4', 'gap' FROM public.lab_catalog_ids WHERE k = 'seeded_root';
    INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'another unrelated job ' || substr(md5(m), 1, 6)) RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('r9_done_job', x::text);
    -- the short subject: an email body titled with it (moved), and a thread named exactly it
    INSERT INTO public.sources (url, title, content, content_type)
    VALUES ('https://mail.google.com/mail/u/0/#inbox/' || substr(md5(m || 'short'), 1, 16), 'Acme layoff', 'a short mail ' || m, 'web_article');
    INSERT INTO public.threads (name, description) VALUES ('Acme layoff', 'a thread') RETURNING id INTO x;
    INSERT INTO public.lab_catalog_ids VALUES ('free_short_thread', x::text);
END $$;
SELECT 'CATALOG TABLE ' || tbl || ' ' || status || ' rows=' || coalesce(n_rows, 0) || ' (' || why || ')' FROM public.lab_catalog_tables ORDER BY status, tbl;
SELECT 'CATALOG PLANTED columns written=' || count(*) FILTER (WHERE status = 'written') || ' refused=' || count(*) FILTER (WHERE status LIKE 'refused%')
       || ' fk/generated=' || count(*) FILTER (WHERE status = 'fk-or-generated')
  FROM public.lab_catalog_cols WHERE tree = 'seeded';
\else
-- ── check ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- the declared residuals: a seed marker found in one of these after 440 is by design (reason given); anything else FAILS.
-- (tbl, role of the row - '*' any, col, the json keys of that column that must still be clean even so)
CREATE TEMP TABLE lab_catalog_allowed (tbl TEXT, role TEXT, col TEXT, clean_keys TEXT[], why TEXT);
INSERT INTO lab_catalog_allowed VALUES
  ('public.research_jobs', 'tree', 'caller', NULL, 'the API key''s configured name, set by the service from the authenticated caller (420 classifies by it); never request text'),
  ('public.research_jobs', 'tree', 'origin', NULL, 'the origin code the service writes'),
  ('public.research_jobs', 'tree', 'origin_claimed', NULL, 'the origin the caller claimed (a code; 290)'),
  ('public.research_jobs', 'tree', 'origin_registry', NULL, 'a registry code'),
  ('public.research_jobs', 'tree', 'boundary', NULL, '420''s boundary record (codes and hashes, written by 420''s classifier; a legacy tree predates it)'),
  ('public.research_prompts', 'tree', 'owner_sub', NULL, 'a subject: who owns the prompt'),
  ('public.research_prompts', 'tree', 'actor_sub', NULL, 'a subject: who acted'),
  ('public.research_steers', 'tree', 'actor_sub', NULL, 'a subject: who opened the branch'),
  ('public.research_steers', 'tree', 'steer_kind', NULL, 'a code'),
  ('public.sources', 'synthesis', 'content', NULL, 'D4: the report of a non-derived job stays shared'),
  ('public.sources', 'synthesis', 'metadata', ARRAY['needs', 'followup_queries', 'originating_query', 'research_query'], 'D4: the report (claim, prose_synthesis) stays shared; the question-derived keys must be clean'),
  ('public.sources', 'synthesis', 'tags', NULL, 'the synthesis''s tags (the curator''s topic words over the shared report, D4)'),
  ('public.sources', 'synthesis', 'notebook', NULL, 'the caller''s notebook label'),
  ('public.sources', 'synthesis', 'domain', NULL, 'the source''s own field'),
  ('public.sources', 'synthesis', 'content_hash', NULL, 'a hash of the shared report'),
  ('public.sources', 'synthesis', 'research_key', NULL, 'a hash (rs-sha1 of the question)'),
  ('public.sources', 'synthesis', 'run_kind', NULL, 'a code'),
  ('public.sources', 'synthesis', 'retracted_by', NULL, 'a subject'),
  ('public.sources', 'synthesis', 'last_edited_by', NULL, 'a subject'),
  ('public.sources', 'synthesis', 'suppression_reason', NULL, 'the retraction reason a reviewer typed (a shared source''s own field)'),
  ('public.sources', 'synthesis', 'suppression_context', NULL, 'the retraction context (a shared source''s own field)'),
  ('public.sources', 'synthesis', 'url', NULL, 'the synthesis url (research://...)'),
  ('public.sources', 'cited', '*', ARRAY['originating_query'], 'a PUBLIC article the filing re-stamped: its own title, url, content, tags ... are the article''s; only the provenance question (research_query, metadata.originating_query) is the tree''s'),
  ('public.source_chunks', 'synthesis', 'content', NULL, 'D4: the shared report''s chunks'),
  ('public.claims', 'synthesis-claim', '*', NULL, 'D4: a claim drawn from the shared report stays shared'),
  ('public.claim_sources', 'synthesis-claim', '*', NULL, 'D4: its edge'),
  ('public.threads', 'thread', 'name', NULL, 'a SHARED thread over many researches: the curator''s own wording of the shared report (D4); the tree''s exact question is cut (checked below)'),
  ('public.threads', 'thread', 'description', NULL, 'as name'),
  ('public.threads', 'thread', 'slug', NULL, 'the wiki''s pinned slug of the shared thread'),
  ('public.thread_sources', 'cited-link', '*', NULL, 'a public article''s link'),
  ('public.thread_sources', '*', 'link_type', NULL, 'a code'),
  ('public.thread_sources', '*', 'status', NULL, 'a code'),
  ('public.sessions', 'session', 'origin_tool', NULL, 'a code (CHECK)');
DO $$
DECLARE
    m TEXT := current_setting('lab.mark'); cm TEXT := current_setting('lab.ctl');
    r RECORD; x RECORD; n BIGINT; fails INT := 0; hits INT := 0; allowed INT := 0; ok BOOLEAN; wh TEXT; kk TEXT; v_role TEXT;
BEGIN
    CREATE TEMP TABLE lab_hits (tbl TEXT, col TEXT, role TEXT, n BIGINT, verdict TEXT) ON COMMIT DROP;
    -- 4. every column of every table service_role can read, read AS service_role (RLS applies)
    FOR r IN SELECT c.table_schema || '.' || c.table_name AS tbl, c.column_name AS col
               FROM information_schema.columns c JOIN pg_class pc ON pc.oid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
              WHERE c.table_schema = 'public' AND pc.relkind IN ('r', 'p')   -- (the stored rows: a view reads these)
                AND c.table_name NOT LIKE 'lab\_%'
                AND (has_table_privilege('service_role', pc.oid, 'SELECT') OR has_table_privilege('ob_app_memory', pc.oid, 'SELECT'))
                AND (c.data_type IN ('text', 'character varying', 'jsonb', 'json') OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))
              ORDER BY 1, 2 LOOP
        -- round 6: any case (F6), read as each role (ob_app_memory: a direct grant to it is read too)
        n := 0;
        FOREACH kk IN ARRAY ARRAY['service_role', 'ob_app_memory'] LOOP
            EXECUTE format('SET LOCAL ROLE %I', kk);
            BEGIN
                EXECUTE format('SELECT greatest(%s, count(*)) FROM %s t WHERE t.%I::text ILIKE %L', n, r.tbl, r.col, '%' || m || '%') INTO n;
            EXCEPTION WHEN insufficient_privilege THEN NULL;
            END;
            EXECUTE 'RESET ROLE';
        END LOOP;
        IF n = 0 THEN CONTINUE; END IF;
        hits := hits + 1;
        ok := false; v_role := NULL;
        -- every row of this table holding the marker must be a registered row whose (role, col) is declared
        FOR x IN EXECUTE format('SELECT to_jsonb(t) AS j FROM %s t WHERE t.%I::text ILIKE %L', r.tbl, r.col, '%' || m || '%') LOOP
            SELECT lr.role INTO v_role FROM public.lab_catalog_rows lr
             WHERE lr.tbl = r.tbl AND lr.tree = 'seeded' AND x.j @> lr.key LIMIT 1;
            ok := v_role IS NOT NULL AND EXISTS (SELECT 1 FROM lab_catalog_allowed a WHERE a.tbl = r.tbl AND a.role IN (v_role, '*') AND a.col IN (r.col, '*'));
            IF ok THEN
                -- a declared jsonb column: its question-derived keys must be clean all the same
                FOR kk IN SELECT unnest(a.clean_keys) FROM lab_catalog_allowed a WHERE a.tbl = r.tbl AND a.role IN (v_role, '*') AND a.col IN (r.col, '*') AND a.clean_keys IS NOT NULL LOOP
                    IF (x.j -> r.col -> kk)::text ILIKE '%' || m || '%' THEN ok := false; END IF;
                END LOOP;
                IF (r.tbl, r.col) = ('public.sources', 'research_query') THEN ok := false; END IF;   -- the provenance question, never declared
            END IF;
            EXIT WHEN NOT ok;
        END LOOP;
        IF ok THEN allowed := allowed + 1; ELSE fails := fails + 1; END IF;
        INSERT INTO lab_hits VALUES (r.tbl, r.col, coalesce(v_role, '(an unregistered row)'), n, CASE WHEN ok THEN 'declared' ELSE 'LEAK' END);
    END LOOP;
    FOR r IN SELECT * FROM lab_hits ORDER BY verdict DESC, tbl, col LOOP
        RAISE NOTICE 'CATALOG HIT % % % row(s) role=% %', r.verdict, r.tbl || '.' || r.col, r.n, r.role,
            coalesce((SELECT '(' || a.why || ')' FROM lab_catalog_allowed a WHERE a.tbl = r.tbl AND a.role IN (r.role, '*') AND a.col IN (r.col, '*') LIMIT 1), '');
    END LOOP;
    -- every catalog table must be planted or declared
    FOR r IN SELECT * FROM public.lab_catalog_tables WHERE status = 'UNPLANTED' LOOP
        RAISE NOTICE 'CATALOG UNPLANTED % (%): no row of the seeded tree and no declaration - plant it or declare it', r.tbl, r.why;
        fails := fails + 1;
    END LOOP;
    -- 5. the owner's private store holds the seed marker for every table the rebuild rewrote or moved
    FOR r IN SELECT DISTINCT t.tbl FROM public.lab_catalog_cols t WHERE t.tree = 'seeded' AND t.status = 'written'
                AND t.tbl IN ('public.research_jobs', 'public.research_job_events', 'public.research_steers', 'public.sessions',
                              'public.research_cancels', 'public.research_admission_trail') LOOP
        IF r.tbl = 'public.research_jobs' THEN
            SELECT count(*) INTO n FROM public.inlet_private_jobs p WHERE p.row_data::text LIKE '%' || m || '%';
        ELSIF r.tbl = 'public.research_job_events' THEN
            SELECT count(*) INTO n FROM public.inlet_private_job_events p WHERE p.row_data::text LIKE '%' || m || '%';
        ELSE
            SELECT count(*) INTO n FROM public.inlet_private_rows p WHERE p.tbl = r.tbl AND p.row_data::text LIKE '%' || m || '%';
        END IF;
        RAISE NOTICE 'CATALOG PRIVATE % holds the marker in the owner''s store: % row(s)', r.tbl, n;
        IF n = 0 THEN fails := fails + 1; END IF;
    END LOOP;
    -- 6. the control tree keeps every marker it was written with (outside the rows the steps 1-6 change by design: none)
    FOR r IN SELECT c.tbl, c.col FROM public.lab_catalog_cols c WHERE c.tree = 'control' AND c.status = 'written' LOOP
        EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I::text LIKE %L', r.tbl, r.col, '%' || cm || '%') INTO n;
        IF n = 0 THEN
            RAISE NOTICE 'CATALOG CONTROL LOST % . %: the unseeded tree lost its text', r.tbl, r.col;
            fails := fails + 1;
        END IF;
    END LOOP;
    -- 7. (point 4) the tree's exact question is cut from the shared thread the filing named; the control's is not
    SELECT count(*) INTO n FROM public.threads t, public.lab_catalog_ids i, public.lab_catalog_ids q
     WHERE i.k = 'seeded_thread' AND q.k = 'seeded_q' AND t.id = i.v::uuid AND position(q.v IN coalesce(t.name, '') || coalesce(t.description, '')) > 0;
    RAISE NOTICE 'CATALOG THREAD the seeded tree''s question in its thread''s name or description: % (want 0)', n;
    IF n <> 0 THEN fails := fails + 1; END IF;
    SELECT count(*) INTO n FROM public.threads t, public.lab_catalog_ids i, public.lab_catalog_ids q
     WHERE i.k = 'control_thread' AND q.k = 'control_q' AND t.id = i.v::uuid AND position(q.v IN coalesce(t.description, '')) > 0;
    IF n <> 1 THEN RAISE NOTICE 'CATALOG THREAD the control''s thread lost its question'; fails := fails + 1; END IF;
    -- 8. (the coordinator) the private claim's own edges, and the chained claim's, are in the owner's store, keyed by claim
    BEGIN
        EXECUTE $q$SELECT count(*) FROM public.inlet_private_claim_sources p, public.lab_catalog_ids i
                    WHERE i.k IN ('priv_claim', 'chain_claim') AND p.claim_id = i.v::uuid
                      AND p.owner_sub = (SELECT owner_sub FROM public.inlet_owner WHERE singleton)$q$ INTO n;
    EXCEPTION WHEN undefined_table THEN n := -1;
    END;
    RAISE NOTICE 'CATALOG CLAIM-EDGES the private claims'' own edges in the owner''s store: % (want 2)', n;
    IF n <> 2 THEN fails := fails + 1; END IF;
    SELECT count(*) INTO n FROM public.claim_sources cs, public.lab_catalog_ids i WHERE i.k IN ('priv_claim', 'chain_claim') AND cs.claim_id = i.v::uuid;
    IF n <> 0 THEN RAISE NOTICE 'CATALOG CLAIM-EDGES % private edge(s) still shared', n; fails := fails + 1; END IF;
    -- 9. (round 6) the free-text variants: the short subject used whole as a thread name is replaced; the moved email
    -- body's credibility rows left the shared tables (the marker scan above covers the rest)
    SELECT count(*) INTO n FROM public.threads t, public.lab_catalog_ids i WHERE i.k = 'free_short_thread' AND t.id = i.v::uuid AND lower(t.name) = 'acme layoff';
    RAISE NOTICE 'CATALOG SHORT a thread named exactly a short email subject: % still so named (want 0)', n;
    IF n <> 0 THEN fails := fails + 1; END IF;
    SELECT (SELECT count(*) FROM public.source_credibility_history WHERE source_id = i.v::uuid) + (SELECT count(*) FROM public.source_trail_events WHERE source_id = i.v::uuid)
         + (SELECT count(*) FROM public.source_corroborations WHERE from_source_id = i.v::uuid OR to_source_id = i.v::uuid)
      INTO n FROM public.lab_catalog_ids i WHERE i.k = 'moved_source';
    RAISE NOTICE 'CATALOG MOVED-SOURCE rows still keyed by the moved email body in shared tables: % (want 0)', n;
    IF n <> 0 THEN fails := fails + 1; END IF;
    SELECT count(*) INTO n FROM public.wiki_pages w, public.lab_catalog_ids i WHERE i.k = 'free_page' AND w.slug = i.v;
    RAISE NOTICE 'CATALOG PAGE the page titled with the seeded question still served: % (want 0)', n;
    IF n <> 0 THEN fails := fails + 1; END IF;
    -- 10. (round 8) F1: the cut article's empty tags stay '{}'; F4: the 5-character topic replaced as a whole thread name,
    -- a whole jsonb string and a whole text[] element (the NULL element and the other element kept)
    SELECT count(*) INTO n FROM public.sources s, public.lab_catalog_ids i WHERE i.k = 'r8_empty_tags' AND s.id = i.v::uuid AND s.tags = '{}'::text[]
       AND s.title NOT ILIKE '%' || m || '%';
    IF EXISTS (SELECT 1 FROM public.lab_catalog_ids WHERE k = 'r8_empty_tags') THEN
        RAISE NOTICE 'CATALOG EMPTY-TAGS the article whose title carried the question: cut, tags still ''{}'': % (want 1)', n;
        IF n <> 1 THEN fails := fails + 1; END IF;
    END IF;
    SELECT count(*) INTO n FROM public.threads t, public.lab_catalog_ids i WHERE i.k = 'r8_short_thread' AND t.id = i.v::uuid AND lower(t.name) = 'pyxis';
    RAISE NOTICE 'CATALOG SHORT-TOPIC a thread named exactly a 5-character topic: % still so named (want 0)', n;
    IF n <> 0 THEN fails := fails + 1; END IF;
    SELECT count(*) INTO n FROM public.sources s, public.lab_catalog_ids i WHERE i.k = 'r8_short_source' AND s.id = i.v::uuid
       AND s.tags IS NOT DISTINCT FROM ARRAY['misc', 'private-text', NULL]::text[] AND s.metadata = jsonb_build_object('subject', 'private-text', 'n', 1);
    RAISE NOTICE 'CATALOG SHORT-TOPIC the whole text[] element and the whole jsonb string replaced, the rest kept: % (want 1)', n;
    IF n <> 1 THEN fails := fails + 1; END IF;
    -- 11. (round 9) G1: the upper-cased Greek topic cut from the shared claim; G10: the accented topic's slug form cleared
    -- from the thread and its page withheld; the code value: status 'done' outside the tree kept
    SELECT count(*) INTO n FROM public.claims c, public.lab_catalog_ids i WHERE i.k = 'r9_greek_claim' AND c.id = i.v::uuid
       AND c.text = 'Reported: private-text (wire)';
    RAISE NOTICE 'CATALOG GREEK the shared claim carrying the upper-cased Greek topic: % cut (want 1)', n;
    IF n <> 1 THEN fails := fails + 1; END IF;
    SELECT count(*) INTO n FROM public.threads t, public.lab_catalog_ids i WHERE i.k = 'r9_accent_thread' AND t.id = i.v::uuid AND t.slug IS NOT NULL;
    RAISE NOTICE 'CATALOG ACCENT-SLUG the thread slugged with the accented topic''s slug form: % still slugged (want 0)', n;
    IF n <> 0 THEN fails := fails + 1; END IF;
    SELECT count(*) INTO n FROM public.wiki_pages WHERE slug = 'research/the-montr-alaise-quarterly-plan-review';
    RAISE NOTICE 'CATALOG ACCENT-SLUG the page at the accented topic''s slug form still served: % (want 0)', n;
    IF n <> 0 THEN fails := fails + 1; END IF;
    SELECT count(*) INTO n FROM public.research_jobs j, public.lab_catalog_ids i WHERE i.k = 'r9_done_job' AND j.id = i.v::uuid AND j.status = 'done';
    RAISE NOTICE 'CATALOG CODE-VALUE a job outside the tree whose status equals a seeded topic (Done): % still done (want 1)', n;
    IF n <> 1 THEN fails := fails + 1; END IF;
    -- (and the code value inside json: no job's progress phase - 'done' in the seeded and the control tree - was rewritten)
    SELECT count(*) INTO n FROM public.research_jobs j WHERE j.progress ->> 'phase' = 'private-text';
    RAISE NOTICE 'CATALOG CODE-VALUE a job progress phase rewritten by the short seed text (Done): % (want 0)', n;
    IF n <> 0 THEN fails := fails + 1; END IF;
    RAISE NOTICE 'CATALOG SUMMARY columns with the seed marker: % (declared %, leaks %); tables % (planted %, declared %, unplanted %)',
        hits, allowed, hits - allowed, (SELECT count(*) FROM public.lab_catalog_tables),
        (SELECT count(*) FROM public.lab_catalog_tables WHERE status = 'planted'), (SELECT count(*) FROM public.lab_catalog_tables WHERE status = 'declared'),
        (SELECT count(*) FROM public.lab_catalog_tables WHERE status = 'UNPLANTED');
    RAISE NOTICE 'CATALOG RESULT % %', CASE WHEN fails = 0 THEN 'ok' ELSE 'FAILED' END, fails;
END $$;
\endif
