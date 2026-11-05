-- inlet-owner-plant.sql - rw-inlet-owner's lab plant (synthetic rows only; never point it at a live database).
--   psql -v ON_ERROR_STOP=1 -v mark=<random token> -v phase=plant|late -f inlet-owner-plant.sql
-- Plants personal data with a marker (:mark) in EVERY personal field a second user could read - thought content and
-- metadata, an email-body source (title, content, url, metadata, chunk), a podcast transcript, a claim drawn only from
-- an email body, a claim drawn from an email body AND a shared article (the mixed case), a claim grounded only on the
-- private claim (the chain), a job's email-body seed and its result (cited_sources, reuse_claims, a Gmail URL in the
-- rendered text), a shared article's Gmail ids, a Gmail URL in a shared chunk and a claim, and the wiki pages that
-- present them (a thought leaf, an entity page linking it, the email body's leaf, an entity page whose evidence is a
-- private thought and links nothing, a note linking a thought). Controls carry 'ctl' + the marker in shared rows only:
-- a shared article, a shared claim, a clean entity page, a job with an ordinary seed.
-- phase=late plants the rows a SECOND run must pick up (new unowned rows arriving after the first run).
-- Ids are recorded in public.lab_inlet_owner_plant (k, v) - this lab database only.
\set ON_ERROR_STOP on
CREATE TABLE IF NOT EXISTS public.lab_inlet_owner_plant (k TEXT PRIMARY KEY, v JSONB NOT NULL);
SELECT set_config('lab.mark', :'mark', false), set_config('lab.phase', :'phase', false) \gset
DO $$
DECLARE
    m    TEXT := current_setting('lab.mark');
    ph   TEXT := current_setting('lab.phase');
    dim  INT := (SELECT atttypmod FROM pg_attribute WHERE attrelid = 'public.thoughts'::regclass AND attname = 'embedding');
    sdim INT := (SELECT atttypmod FROM pg_attribute WHERE attrelid = 'public.sources'::regclass AND attname = 'embedding');
    cdim INT := (SELECT atttypmod FROM pg_attribute WHERE attrelid = 'public.source_chunks'::regclass AND attname = 'embedding');
    v    TEXT; sv TEXT; cv TEXT;
    t_gmail BIGINT; t_act BIGINT; t_chat BIGINT; t_mcp BIGINT; t_pers BIGINT;
    s_mail UUID; s_pod UUID; s_art UUID; s_art2 UUID; s_late UUID;
    c_priv UUID; c_mixed UUID; c_chain UUID; c_shared UUID;
    e_priv BIGINT; e_mixed BIGINT; e_clean BIGINT;
    j_seed UUID; j_ctl UUID; th UUID; j_svc UUID; j_svcb UUID; j_body UUID; j_bodyb UUID; j_pod UUID;
    mail_url TEXT;
BEGIN
    v  := '[' || array_to_string(array_fill('0.02'::text, ARRAY[greatest(dim, 1)]), ',') || ']';
    sv := '[' || array_to_string(array_fill('0.02'::text, ARRAY[greatest(sdim, 1)]), ',') || ']';
    cv := '[' || array_to_string(array_fill('0.02'::text, ARRAY[greatest(cdim, 1)]), ',') || ']';
    IF ph = 'late' THEN
        -- a second run's input: a new unowned gmail thought, a new email-body source, a new email-body seed
        mail_url := 'https://mail.google.com/mail/u/0/#inbox/late' || m;
        INSERT INTO public.thoughts (content, embedding, metadata, exposure)
        VALUES ('late mail ' || m || 'late', v::vector, jsonb_build_object('source', 'gmail', 'gmail_id', 'late' || m), 'ops') RETURNING id INTO t_gmail;
        INSERT INTO public.sources (url, title, content, content_type, metadata)
        VALUES (mail_url, 'late body ' || m || 'late', 'late email body ' || m || 'late', 'web_article', jsonb_build_object('source', 'gmail-link-enrich'))
        RETURNING id INTO s_late;
        INSERT INTO public.research_jobs (status, origin, query, options)
        VALUES ('done', 'manual', 'late digest job', jsonb_build_object('seed_sources', jsonb_build_array(
            jsonb_build_object('url', mail_url, 'title', 'late seed ' || m || 'late', 'content', 'late seed body ' || m || 'late'))))
        RETURNING id INTO j_seed;
        -- the late job is the digest's (service-owned), with the subject as its question and in an event
        UPDATE public.research_jobs SET query = 'late subject ' || m || 'late' WHERE id = j_seed;
        INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES (j_seed, 'service:digest', 'service:digest', 'late subject ' || m || 'late');
        INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload)
        VALUES (j_seed, j_seed, 's1', 'stage', 'due_process', jsonb_build_object('current_artifact', jsonb_build_object('label', mail_url)));
        INSERT INTO public.lab_inlet_owner_plant VALUES ('late', jsonb_build_object('thought', t_gmail, 'source', s_late, 'job', j_seed))
        ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
        RETURN;
    END IF;

    mail_url := 'https://mail.google.com/mail/u/0/#inbox/' || m;
    -- thoughts: one per inlet (all private after the migration) + one already 'personal' with no owner
    INSERT INTO public.thoughts (content, embedding, metadata, exposure)
    VALUES ('an email ' || m || ' about the quarterly plan', v::vector, jsonb_build_object('source', 'gmail', 'gmail_id', 'g' || m, 'gmail_labels', jsonb_build_array('brain/' || m)), 'ops')
    RETURNING id INTO t_gmail;
    INSERT INTO public.thoughts (content, embedding, metadata, exposure)
    VALUES ('searched for ' || m || ' near home', v::vector, jsonb_build_object('source', 'google_activity', 'product', 'Search'), 'ops') RETURNING id INTO t_act;
    INSERT INTO public.thoughts (content, embedding, metadata, exposure)
    VALUES ('a chat ' || m || ' about a trip', v::vector, jsonb_build_object('source', 'chatgpt', 'title', 'chat ' || m), 'ops') RETURNING id INTO t_chat;
    INSERT INTO public.thoughts (content, embedding, metadata, exposure)
    VALUES ('a note to self ' || m, v::vector, jsonb_build_object('source', 'mcp', 'type', 'observation'), 'ops') RETURNING id INTO t_mcp;
    INSERT INTO public.thoughts (content, embedding, metadata, exposure)
    VALUES ('a personal mail ' || m, v::vector, jsonb_build_object('source', 'gmail'), 'personal') RETURNING id INTO t_pers;

    -- sources: the email body (link-enrich's fallback), a podcast transcript, two shared articles (one with Gmail ids)
    INSERT INTO public.sources (url, title, content, content_type, metadata, embedding)
    VALUES (mail_url, 'Subject ' || m, 'the email body ' || m || ' with the plan', 'web_article',
            jsonb_build_object('gmail_id', 'g' || m, 'gmail_thread_id', 't' || m, 'gmail_labels', jsonb_build_array('brain/' || m)), sv::vector)
    RETURNING id INTO s_mail;
    INSERT INTO public.sources (url, title, content, content_type, metadata)
    VALUES ('https://podcast.example/episode/p' || m, 'Episode ' || m, 'the transcript ' || m || ' of today''s digest', 'podcast_transcript',
            jsonb_build_object('source', 'daily-digest-podcast', 'gmail_labels', jsonb_build_array('brain/' || m), 'subject', 'Subject ' || m))
    RETURNING id INTO s_pod;
    INSERT INTO public.sources (url, title, content, content_type, metadata)
    VALUES ('https://news.example/a/ctl' || m, 'Article ctl' || m, 'a public article ctl' || m || ' about the plan; see https://mail.google.com/mail/u/0/#inbox/x' || m, 'web_article',
            jsonb_build_object('gmail_id', 'g' || m, 'gmail_thread_id', 't' || m, 'gmail_labels', jsonb_build_array('brain/' || m), 'thread_url', mail_url))
    RETURNING id INTO s_art;
    INSERT INTO public.sources (url, title, content, content_type, metadata)
    VALUES ('https://news.example/b/ctl' || m, 'Article two ctl' || m, 'another public article ctl' || m, 'web_article', '{}'::jsonb)
    RETURNING id INTO s_art2;
    INSERT INTO public.source_chunks (source_id, idx, content, embedding) VALUES (s_mail, 0, 'chunk of the email body ' || m, cv::vector);
    INSERT INTO public.source_chunks (source_id, idx, content, embedding) VALUES (s_pod, 0, 'chunk of the transcript ' || m, cv::vector);
    INSERT INTO public.source_chunks (source_id, idx, content, embedding) VALUES (s_art, 0, 'chunk of the article ctl' || m || ' cites mail.google.com/mail/u/0/#inbox/c' || m, cv::vector);

    -- claims: private (email body only), mixed (email body + article), chain (only on the private claim), shared
    INSERT INTO public.claims (text) VALUES ('the plan ' || m || ' is due in May') RETURNING id INTO c_priv;
    INSERT INTO public.claims (text) VALUES ('the plan ctl' || m || ' has three parts') RETURNING id INTO c_mixed;
    INSERT INTO public.claims (text) VALUES ('so the plan ' || m || ' slips') RETURNING id INTO c_chain;
    INSERT INTO public.claims (text) VALUES ('the article ctl' || m || ' is public; it once cited mail.google.com/mail/u/0/#inbox/k' || m) RETURNING id INTO c_shared;
    INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES (c_priv, s_mail, 'states'), (c_priv, s_pod, 'corroborates');
    INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES (c_mixed, s_mail, 'states'), (c_mixed, s_art, 'corroborates');
    INSERT INTO public.claim_sources (claim_id, parent_claim_id, edge_type) VALUES (c_chain, c_priv, 'inferred_from');
    INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES (c_shared, s_art2, 'states');

    -- the graph: an entity whose only evidence is a private thought, one with private + shared evidence, a clean one
    INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('topic', 'Priv topic ' || left(md5(m), 6), 'priv topic ' || left(md5(m), 6)) RETURNING id INTO e_priv;
    INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('topic', 'Mixed ctl' || m, 'mixed ctl' || m) RETURNING id INTO e_mixed;
    INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('topic', 'Clean ctl' || m, 'clean ctl' || m) RETURNING id INTO e_clean;
    INSERT INTO public.thought_entities (thought_id, entity_id, mention_role, confidence, source, evidence)
    VALUES (t_gmail, e_priv, 'mentioned', 0.9, 'entity_worker', jsonb_build_object('quote', 'quoting ' || m)),
           (t_chat, e_mixed, 'mentioned', 0.9, 'entity_worker', jsonb_build_object('quote', 'quoting ' || m));
    INSERT INTO public.source_entities (source_id, entity_id, mention_role, confidence)
    VALUES (s_mail, e_mixed, 'mentioned', 0.9), (s_art, e_mixed, 'mentioned', 0.9), (s_art2, e_clean, 'mentioned', 0.9);
    INSERT INTO public.threads (name, description) VALUES ('Thread ctl' || m, 'a shared thread') RETURNING id INTO th;
    INSERT INTO public.thread_sources (thread_id, source_id) VALUES (th, s_mail), (th, s_art);

    -- jobs: a digest job seeded with the email body, its result citing it and reusing the private claim; a control
    INSERT INTO public.research_jobs (status, origin, query, options, result)
    VALUES ('done', 'manual', 'digest article job',
            jsonb_build_object('seed_sources', jsonb_build_array(
                jsonb_build_object('url', mail_url, 'title', 'Subject ' || m, 'content', 'the email body ' || m),
                jsonb_build_object('url', 'https://news.example/a/ctl' || m, 'title', 'Article ctl' || m, 'content', 'a public article ctl' || m))),
            jsonb_build_object('outcome', 'ok', 'synthesis', 'a shared report ctl' || m,
                'cited_sources', jsonb_build_array(jsonb_build_object('url', mail_url, 'title', 'Subject ' || m),
                                                   jsonb_build_object('url', 'https://podcast.example/episode/p' || m, 'title', 'Episode ' || m),
                                                   jsonb_build_object('url', 'https://news.example/a/ctl' || m, 'title', 'Article ctl' || m)),
                'reuse_claims', jsonb_build_array(jsonb_build_object('id', c_priv, 'text', 'the plan ' || m || ' is due in May'),
                                                  jsonb_build_object('id', c_shared, 'text', 'the article ctl' || m || ' is public')),
                'rendered', '[1]: ' || mail_url || ' (Subject)'))
    RETURNING id INTO j_seed;
    INSERT INTO public.research_jobs (status, origin, query, options, result)
    VALUES ('done', 'manual', 'control job', jsonb_build_object('seed_sources', jsonb_build_array(
                jsonb_build_object('url', 'https://news.example/b/ctl' || m, 'title', 'Article two ctl' || m, 'content', 'x'))),
            jsonb_build_object('outcome', 'ok', 'cited_sources', jsonb_build_array(jsonb_build_object('url', 'https://news.example/b/ctl' || m, 'title', 'Article two ctl' || m))))
    RETURNING id INTO j_ctl;

    -- round 2 (tester 1): a SERVICE-owned digest job (everyone reads it in full) seeded with the email body: the question
    -- is the email's subject, the prompt row is the digest's, the events carry the Gmail URL and the subject (stage
    -- artifact label, source trail, topic), the result names the moved source and the private claim in claims[] /
    -- sources[]; a branch of it carries the subject as its anchor
    INSERT INTO public.research_jobs (status, origin, query, anchor, topic_estimate, options, result)
    VALUES ('done', 'manual', 'Subject ' || m, 'Subject ' || m, 'the topic of Subject ' || m,
            jsonb_build_object('seed_sources', jsonb_build_array(jsonb_build_object('url', mail_url, 'title', 'Subject ' || m, 'content', 'the email body ' || m))),
            jsonb_build_object('outcome', 'ok', 'synthesis', 'a digest report ctl' || m,
                'claims', jsonb_build_array(jsonb_build_object('id', c_priv, 'text', 'the plan ' || m || ' is due in May'),
                                            jsonb_build_object('id', c_shared, 'text', 'the article ctl' || m || ' is public')),
                'sources', jsonb_build_array(jsonb_build_object('id', s_mail, 'url', mail_url, 'title', 'Subject ' || m),
                                             jsonb_build_object('id', s_art2, 'url', 'https://news.example/b/ctl' || m, 'title', 'Article two ctl' || m)),
                'cited_sources', jsonb_build_array(jsonb_build_object('url', mail_url, 'title', 'Subject ' || m))))
    RETURNING id INTO j_svc;
    INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES (j_svc, 'service:digest', 'service:digest', 'Subject ' || m);
    INSERT INTO public.research_jobs (status, origin, query, anchor, root_job_id, parent_job_id, rooted_step_id, branch_kind)
    VALUES ('done', 'manual', 'Subject ' || m, 'Subject ' || m, j_svc, j_svc, 's1', 'gap')
    RETURNING id INTO j_svcb;
    INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, trail, payload) VALUES
      (j_svc, j_svc, 's1', 'stage', 'due_process', NULL, jsonb_build_object('current_artifact', jsonb_build_object('label', mail_url, 'kind', 'source'), 'stage', 'fetch')),
      (j_svc, j_svc, NULL, 'source', 'due_process', jsonb_build_object('url', mail_url, 'title', 'Subject ' || m, 'decision', 'admitted'),
         jsonb_build_object('sources', jsonb_build_array(jsonb_build_object('url', mail_url, 'title', 'Subject ' || m)), 'count', 1)),
      (j_svc, j_svc, NULL, 'topic', 'due_process', NULL, jsonb_build_object('topic', 'Subject ' || m, 'anchor', 'Subject ' || m)),
      (j_svcb, j_svc, NULL, 'topic', 'due_process', NULL, jsonb_build_object('topic', 'the topic of Subject ' || m));
    -- round 3 (tester attempt 2, P1b): the marker ONLY in the seed BODY and in the text a model derived from it - the
    -- question, the subject, the url and every id are clean (the url is a Gmail url WITHOUT the marker). A daily-digest job
    -- (service-owned), its branch, and a podcast-transcript-seeded job (the moved transcript as its seed)
    INSERT INTO public.research_jobs (status, origin, query, options, result, progress, error)
    VALUES ('done', 'manual', 'Daily digest: a newsletter',
            jsonb_build_object('seed_sources', jsonb_build_array(jsonb_build_object(
                'url', 'https://mail.google.com/mail/u/0/#inbox/' || left(md5(m || 'body'), 12), 'title', 'A newsletter',
                'content', 'the newsletter body says ' || m || 'b about the merger and the new office'))),
            jsonb_build_object('outcome', 'ok', 'report_type', 'digest', 'synthesis', 'The merger ' || m || 'b was announced this week.',
                'claims', jsonb_build_array(), 'cited_sources', jsonb_build_array(),
                'gaps', jsonb_build_array(jsonb_build_object('query', 'what about ' || m || 'b', 'score', 0.4))),
            jsonb_build_object('phase', 'done', 'message', 'read the newsletter about ' || m || 'b'),
            'stopped after reading ' || m || 'b')
    RETURNING id INTO j_body;
    INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES (j_body, 'service:daily-digest', 'service:daily-digest', 'Daily digest: a newsletter');
    INSERT INTO public.research_jobs (status, origin, query, anchor, root_job_id, parent_job_id, rooted_step_id, branch_kind, tree_report, progress)
    VALUES ('done', 'manual', 'Daily digest: a newsletter', 'Daily digest: a newsletter', j_body, j_body, 's1', 'gap',
            jsonb_build_object('summary', 'a summary of ' || m || 'b and its people', 'branches', 1),
            jsonb_build_object('phase', 'done', 'message', 'the branch read ' || m || 'b'))
    RETURNING id INTO j_bodyb;
    INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, trail, payload) VALUES
      (j_body, j_body, 's1', 'stage', 'due_process', NULL, jsonb_build_object('stage', 'synth', 'note', 'the body mentions ' || m || 'b')),
      (j_bodyb, j_body, 's2', 'stage', 'due_process', NULL, jsonb_build_object('stage', 'synth', 'note', 'the branch quotes ' || m || 'b'));
    INSERT INTO public.research_jobs (status, origin, query, options, result, progress)
    VALUES ('done', 'manual', 'Podcast: the daily episode',
            jsonb_build_object('seed_sources', jsonb_build_array(jsonb_build_object(
                'url', 'https://podcast.example/episode/p' || m, 'title', 'The daily episode', 'content', 'the transcript says ' || m || 'q twice'))),
            jsonb_build_object('outcome', 'ok', 'synthesis', 'The episode discussed ' || m || 'q at length.', 'cited_sources', jsonb_build_array()),
            jsonb_build_object('phase', 'done', 'message', 'listened to ' || m || 'q'))
    RETURNING id INTO j_pod;
    INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES (j_pod, 'service:podcast', 'service:podcast', 'Podcast: the daily episode');

    -- round 2 (tester 3): a typed edge from the private-only entity (the entity worker writes them from the mail it read)
    INSERT INTO public.edges (from_entity_id, to_entity_id, relation, support_count, confidence, metadata)
    VALUES (e_priv, e_clean, 'works_with', 1, 0.8, jsonb_build_object('thought_id', t_gmail));

    -- the wiki
    INSERT INTO public.wiki_pages (slug, page_class, title, body, links, frontmatter) VALUES
      ('content/thought/' || t_gmail, 'thought', 'Thought #' || t_gmail, '# Thought' || chr(10) || 'an email ' || m || ' about the quarterly plan', '[]', jsonb_build_object('id', t_gmail)),
      ('content/topic/priv-' || left(md5(m || 'p'), 10), 'entity', 'Priv ' || m, 'the topic ' || m || ' per [[content/thought/' || t_gmail || '|a mail]] '
         || (SELECT string_agg('para' || g || ' word' || (g * 7 % 13), ' ') FROM generate_series(1, 90) g), jsonb_build_array('content/thought/' || t_gmail), jsonb_build_object('entity_id', e_priv)),
      ('content/source/' || s_mail, 'source', 'Subject ' || m, 'the email body ' || m, '[]', jsonb_build_object('id', s_mail)),
      ('content/topic/mixed-' || left(md5(m || 'x'), 10), 'entity', 'Mixed ctl' || m, 'a topic synthesised from a chat: ' || m || ' and the article ctl' || m, '[]', jsonb_build_object('entity_id', e_mixed)),
      ('notes/note-' || left(md5(m || 'n'), 10), 'note', 'My note ' || m, 'see thought/' || t_chat, '[]', '{}'),
      ('content/topic/clean-' || left(md5(m || 'c'), 10), 'entity', 'Clean ctl' || m, 'a clean page about the article ctl' || m, jsonb_build_array('content/source/' || s_art2), jsonb_build_object('entity_id', e_clean));

    INSERT INTO public.lab_inlet_owner_plant VALUES ('plant', jsonb_build_object(
        'mark', m, 'thoughts', jsonb_build_array(t_gmail, t_act, t_chat, t_mcp, t_pers),
        'sources', jsonb_build_object('mail', s_mail, 'pod', s_pod, 'art', s_art, 'art2', s_art2),
        'claims', jsonb_build_object('priv', c_priv, 'mixed', c_mixed, 'chain', c_chain, 'shared', c_shared),
        'entities', jsonb_build_object('priv', e_priv, 'mixed', e_mixed, 'clean', e_clean),
        'jobs', jsonb_build_object('seed', j_seed, 'ctl', j_ctl, 'svc', j_svc, 'svcbranch', j_svcb, 'body', j_body, 'bodybranch', j_bodyb, 'pod', j_pod), 'thread', th,
        'pages', jsonb_build_object('leaf', 'content/thought/' || t_gmail, 'linking', 'content/topic/priv-' || left(md5(m || 'p'), 10),
                                    'srcleaf', 'content/source/' || s_mail, 'evidence', 'content/topic/mixed-' || left(md5(m || 'x'), 10),
                                    'note', 'notes/note-' || left(md5(m || 'n'), 10), 'clean', 'content/topic/clean-' || left(md5(m || 'c'), 10))))
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;

-- round 4 (tester attempt 3, case 4a - the tester's plant, kept as a regression case): a service:daily-digest root seeded
-- with an email, the marker ONLY in values of the shapes round 3's allow-list kept (urls with text in the query / a path
-- / a Gmail-like host, *_id hex / digit strings, code-shaped tokens, *_at strings that only START with a date) and in JSON
-- KEYS (top level, under by_title, deep inside arrays of objects), and in an event's payload and trail urls; a tree seeded
-- only through a BRANCH (the unseeded root and sibling carry the marker); and an unseeded control tree that stays shared
DO $$
DECLARE
    ph TEXT := current_setting('lab.phase');
    p JSONB;
    m TEXT;
    hx TEXT;
    mail_url TEXT;
    j1 UUID; j1e BIGINT; r UUID; b1 UUID; b2 UUID; ctl UUID;
BEGIN
    IF ph <> 'plant' THEN RETURN; END IF;
    p := (SELECT v FROM public.lab_inlet_owner_plant WHERE k = 'plant');
    m := p ->> 'mark';
    hx := substr(md5(m || 'hx'), 1, 20);
    mail_url := 'https://mail.google.com/mail/u/0/#inbox/' || substr(md5(m || 'u'), 1, 16);
    INSERT INTO public.research_jobs (status, origin, query, options, result, progress, error, finished_at, metrics)
    VALUES ('done', 'manual', 'Daily digest: an adv3 newsletter',
            jsonb_build_object('seed_sources', jsonb_build_array(jsonb_build_object('url', mail_url, 'title', 'plain title', 'content', 'body ' || m || 'zbody'))),
            jsonb_build_object(
              'outcome', 'ok',
              'synthesis', 'derived ' || m || 'syn',
              'cited_sources', jsonb_build_array(
                  jsonb_build_object('url', 'https://news.example.org/a?note=' || m || 'qurl', 'title', 'x'),
                  jsonb_build_object('url', 'https://www.google.com/mail/u/0/?q=subject:' || m || 'gm', 'title', 'y'),
                  jsonb_build_object('url', 'https://inbox.google.com/mail/#search/' || m || 'ib', 'title', 'z'),
                  jsonb_build_object('url', 'https://example.org/' || m || 'path/segment', 'title', 'w'),
                  -- a shared source's EXACT url (kept, with the shared row's own title, never the job's)
                  jsonb_build_object('url', 'https://news.example/b/ctl' || m, 'title', 'job title ' || m || 'jt')),
              'message_id', hx,
              'thread_id', '1234567890123456',
              'status', m || 'st',
              'phase', m || 'ph',
              'report_type', m || 'rt',
              'type', 'ok',
              'created_at', '2026-11-04T10:00:00Z ' || m || 'ts',
              'started_at', '2026-11-04 ' || m || 'ts2',
              'finished_at', 'not a date ' || m || 'ts3',
              m || 'topkey', 'v',
              'by_title', jsonb_build_object(m || 'titlekey', jsonb_build_array(jsonb_build_object('n', 1))),
              'nested', jsonb_build_array(jsonb_build_object('b', jsonb_build_array(jsonb_build_object('c', jsonb_build_object(m || 'deepkey',
                  jsonb_build_array('s' || m || 'deepval', jsonb_build_object('url', 'https://deep.example.org/' || m || 'deepurl'))))))),
              'counts', jsonb_build_object('n', 7, 'ok', true)),
            jsonb_build_object('phase', 'done', 'message', 'msg ' || m || 'prog', 'url', 'https://prog.example.org/?x=' || m || 'progurl'),
            'err ' || m || 'err', now(),
            jsonb_build_object('claims_reused', 3, 'claims_freshly_gathered', 2, 'gap_ratio', 0.5,
                               'credibility', jsonb_build_object('note', 'cred ' || m || 'cred'), m || 'mkey', 1))
    RETURNING id INTO j1;
    INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES (j1, 'service:daily-digest', 'service:daily-digest', 'Daily digest: an adv3 newsletter');
    INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, trail, payload) VALUES
      (j1, j1, 's1', 'stage', 'due_process',
       jsonb_build_object('url', 'https://trail.example.org/?q=' || m || 'trailurl', 'kind', 'fetched'),
       jsonb_build_object('stage', 'synth', 'url', 'https://ev.example.org/' || m || 'evurl', 'status', m || 'evst', 'note', 'n ' || m || 'evnote')),
      (j1, j1, NULL, 'source', 'due_process',
       jsonb_build_object('url', 'https://news.example/b/ctl' || m, m || 'trailkey', jsonb_build_array(jsonb_build_object('x', 'deep ' || m || 'trdeep'))),
       jsonb_build_object('sources', jsonb_build_array(jsonb_build_object('url', 'https://e.example.org/?' || m || 'srcq')))),
      (j1, j1, NULL, 'gap', 'due_process', NULL,
       jsonb_build_object('claim_id', hx, 'score', 0.4, 'threshold', 0.5, 'query', 'gap ' || m || 'gapq'));
    SELECT id INTO j1e FROM public.research_job_events WHERE job_id = j1 AND type = 'stage' LIMIT 1;
    -- a tree seeded only through a BRANCH
    INSERT INTO public.research_jobs (status, origin, query, anchor, result, progress, finished_at)
    VALUES ('done', 'manual', 'Root question ' || m || 'rootq', 'Root anchor ' || m || 'roota',
            jsonb_build_object('outcome', 'ok', 'synthesis', 'root synthesis ' || m || 'rootsyn'),
            jsonb_build_object('phase', 'done', 'message', 'root msg ' || m || 'rootmsg'), now())
    RETURNING id INTO r;
    INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES (r, 'service:digest', 'service:digest', 'Root question ' || m || 'rootq');
    INSERT INTO public.research_jobs (status, origin, query, anchor, root_job_id, parent_job_id, rooted_step_id, branch_kind, options)
    VALUES ('done', 'manual', 'seeded branch', 'seeded branch', r, r, 's1', 'gap',
            jsonb_build_object('seed_sources', jsonb_build_array(jsonb_build_object('url', mail_url, 'title', 'branch seed title', 'content', 'branch body'))))
    RETURNING id INTO b1;
    INSERT INTO public.research_jobs (status, origin, query, anchor, root_job_id, parent_job_id, rooted_step_id, branch_kind, result, tree_report)
    VALUES ('done', 'manual', 'sibling ' || m || 'sibq', 'sibling ' || m || 'siba', r, r, 's2', 'gap',
            jsonb_build_object('outcome', 'ok', 'synthesis', 'sibling synthesis ' || m || 'sibsyn'),
            jsonb_build_object('summary', 'sibling summary ' || m || 'sibsum'))
    RETURNING id INTO b2;
    INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload) VALUES
      (r, r, 's1', 'stage', 'due_process', jsonb_build_object('stage', 'synth', 'note', 'root note ' || m || 'rootnote')),
      (b2, r, 's2', 'stage', 'due_process', jsonb_build_object('stage', 'synth', 'note', 'sibling note ' || m || 'sibnote'));
    -- the CONTROL tree (no seed): stays shared research output (its text carries ctl + the mark)
    INSERT INTO public.research_jobs (status, origin, query, result, finished_at)
    VALUES ('done', 'manual', 'ctl3 question ctl' || m || 'q', jsonb_build_object('outcome', 'ok', 'synthesis', 'ctl3 ctl' || m || 'syn'), now())
    RETURNING id INTO ctl;
    INSERT INTO public.lab_inlet_owner_plant VALUES ('adv3', jsonb_build_object('mail_url', mail_url, 'hx', hx, 'j1', j1, 'j1e', j1e, 'r', r, 'b1', b1, 'b2', b2, 'ctl', ctl))
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;
