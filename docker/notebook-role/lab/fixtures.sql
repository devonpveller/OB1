-- Lab fixtures for flows.py (run as postgres on the LAB database only; synthetic rows).
\set ON_ERROR_STOP on
BEGIN;
-- a schema-only restore has an empty registry (sources.content_type references it)
INSERT INTO public.content_types (value, label, category) VALUES
    ('web_article', 'Web article', 'web'), ('manual', 'Manual', 'manual'),
    ('research_synthesis', 'Research synthesis', 'synthesis')
ON CONFLICT DO NOTHING;
INSERT INTO public.threads (id, name, description) VALUES
    ('11111111-1111-4111-8111-000000000001', 'lab thread one', 'fixture'),
    ('11111111-1111-4111-8111-000000000002', 'lab thread two', 'fixture');
INSERT INTO public.sources (id, url, title, content, content_type, embedding, content_hash) VALUES
    ('22222222-2222-4222-8222-000000000001', 'https://lab.example/s1', 'lab source one', 'alpha beta gamma',
     'web_article', array_fill(0.01::real, ARRAY[1024])::public.vector, md5('alpha beta gamma')),
    ('22222222-2222-4222-8222-000000000002', NULL, 'lab source two', 'delta epsilon',
     'manual', array_fill(0.02::real, ARRAY[1024])::public.vector, md5('delta epsilon')),
    ('22222222-2222-4222-8222-000000000003', NULL, 'lab note', 'a synthesis note',
     'research_synthesis', NULL, md5('a synthesis note'));
INSERT INTO public.thread_sources (thread_id, source_id, link_type, status, suggestion_reason, confirmed_at) VALUES
    ('11111111-1111-4111-8111-000000000001', '22222222-2222-4222-8222-000000000001', 'automatic', 'confirmed', NULL, now()),
    ('11111111-1111-4111-8111-000000000001', '22222222-2222-4222-8222-000000000003', 'automatic', 'confirmed', NULL, now()),
    ('11111111-1111-4111-8111-000000000002', '22222222-2222-4222-8222-000000000001', 'suggested', 'pending', 'similar', NULL),
    ('11111111-1111-4111-8111-000000000002', '22222222-2222-4222-8222-000000000002', 'suggested', 'hidden', 'similar', NULL);
INSERT INTO public.source_chunks (source_id, idx, content, embedding)
SELECT '22222222-2222-4222-8222-000000000001', i, 'chunk ' || i, array_fill(0.01::real, ARRAY[1024])::public.vector
  FROM generate_series(0, 3) AS i;
-- an erased url: the url gate must refuse it for open_notebook too
INSERT INTO public.source_tombstones (source_id, url, url_key, title, reason_type, eraser_kind)
VALUES (gen_random_uuid(), 'https://lab.example/erased-page',
        public.contract_url_key('https://lab.example/erased-page'), 'erased', 'lab', 'lab');
COMMIT;
