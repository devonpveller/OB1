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
    j_seed UUID; j_ctl UUID; th UUID;
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

    -- the wiki
    INSERT INTO public.wiki_pages (slug, page_class, title, body, links, frontmatter) VALUES
      ('content/thought/' || t_gmail, 'thought', 'Thought #' || t_gmail, '# Thought' || chr(10) || 'an email ' || m || ' about the quarterly plan', '[]', jsonb_build_object('id', t_gmail)),
      ('content/topic/priv-' || left(md5(m || 'p'), 10), 'entity', 'Priv ' || m, 'the topic ' || m || ' per [[content/thought/' || t_gmail || '|a mail]]', jsonb_build_array('content/thought/' || t_gmail), jsonb_build_object('entity_id', e_priv)),
      ('content/source/' || s_mail, 'source', 'Subject ' || m, 'the email body ' || m, '[]', jsonb_build_object('id', s_mail)),
      ('content/topic/mixed-' || left(md5(m || 'x'), 10), 'entity', 'Mixed ctl' || m, 'a topic synthesised from a chat: ' || m || ' and the article ctl' || m, '[]', jsonb_build_object('entity_id', e_mixed)),
      ('notes/note-' || left(md5(m || 'n'), 10), 'note', 'My note ' || m, 'see thought/' || t_chat, '[]', '{}'),
      ('content/topic/clean-' || left(md5(m || 'c'), 10), 'entity', 'Clean ctl' || m, 'a clean page about the article ctl' || m, jsonb_build_array('content/source/' || s_art2), jsonb_build_object('entity_id', e_clean));

    INSERT INTO public.lab_inlet_owner_plant VALUES ('plant', jsonb_build_object(
        'mark', m, 'thoughts', jsonb_build_array(t_gmail, t_act, t_chat, t_mcp, t_pers),
        'sources', jsonb_build_object('mail', s_mail, 'pod', s_pod, 'art', s_art, 'art2', s_art2),
        'claims', jsonb_build_object('priv', c_priv, 'mixed', c_mixed, 'chain', c_chain, 'shared', c_shared),
        'entities', jsonb_build_object('priv', e_priv, 'mixed', e_mixed, 'clean', e_clean),
        'jobs', jsonb_build_object('seed', j_seed, 'ctl', j_ctl), 'thread', th,
        'pages', jsonb_build_object('leaf', 'content/thought/' || t_gmail, 'linking', 'content/topic/priv-' || left(md5(m || 'p'), 10),
                                    'srcleaf', 'content/source/' || s_mail, 'evidence', 'content/topic/mixed-' || left(md5(m || 'x'), 10),
                                    'note', 'notes/note-' || left(md5(m || 'n'), 10), 'clean', 'content/topic/clean-' || left(md5(m || 'c'), 10))))
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;
