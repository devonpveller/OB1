-- Fixture sources for the P6a disposable run (rw-p6a-resolve), applied by run-export-tests.ps1 to a
-- DISPOSABLE database after the initdb chain. Authored: every id is f6a00000-..., every DOI is under
-- the 10.5555 test prefix, every title is made up. The record titles say "Fixture paper record N";
-- the stub's resolved titles say "Resolved title N (...)", so an export that printed the record
-- instead of the resolved metadata is visible.
INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata)
SELECT ('f6a00000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'https://doi.org/10.5555/p6a.' || lpad(n::text, 3, '0'),
       'Fixture paper record ' || n,
       'Fixture paper record ' || n || ': the opening line of an authored fixture text.',
       'paper', 'doi.org', '{}'::jsonb
  FROM generate_series(1, 100) n;

INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES
  -- 101: the dead DOI (404 from both services)
  ('f6a00000-0000-4000-8000-000000000101', 'https://doi.org/10.5555/p6a.dead', 'Fixture paper record dead',
   'Fixture paper record dead: an authored fixture text whose identifier resolves nowhere.', 'paper', 'doi.org', '{}'),
  -- 102: a web page without a persistent identifier (cited as the page it is, nothing resolved)
  ('f6a00000-0000-4000-8000-000000000102', 'https://example.org/p6a/web-page', 'A fixture web page',
   'A fixture web page: the opening line of an authored page.', 'web_article', 'example.org', '{}'),
  -- 103: an arXiv work (OpenAlex by doi:10.48550/arxiv.*)
  ('f6a00000-0000-4000-8000-000000000103', 'https://arxiv.org/abs/2101.00001', 'Fixture arXiv record',
   'Fixture arXiv record: the opening line of an authored preprint.', 'paper', 'arxiv.org', '{}'),
  -- 104: a DOI declared in the metadata (the P3a scholarly record's shape), URL elsewhere
  ('f6a00000-0000-4000-8000-000000000104', 'https://example.org/p6a/publisher-page', 'Fixture declared-DOI record',
   'Fixture declared-DOI record: the opening line of an authored text.', 'paper', 'example.org',
   '{"scholarly": {"doi": "10.5555/p6a.095"}}');

-- rw-p6a-resolve attempt 2: the tester's hostile shapes as fixtures.
-- 105-109: the stub answers these with a redirect or an echoing 200 (stub-scholarly.ts)
INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata)
SELECT ('f6a00000-0000-4000-8000-' || lpad((104 + n)::text, 12, '0'))::uuid,
       'https://doi.org/10.5555/p6a.' || c,
       'Fixture hostile-answer record ' || c,
       'Fixture hostile-answer record ' || c || ': an authored fixture text.', 'paper', 'doi.org', '{}'::jsonb
  FROM (VALUES (1, 'r01'), (2, 'r02'), (3, 'r03'), (4, 'r04'), (5, 't01')) AS v(n, c);

-- 110-115: identifiers outside the grammar, declared in the metadata (each refused before any request)
INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata)
SELECT ('f6a00000-0000-4000-8000-' || lpad((109 + n)::text, 12, '0'))::uuid,
       'https://example.org/p6a/hostile-' || n,
       'Fixture hostile-identifier record ' || n,
       'Fixture hostile-identifier record ' || n || ': an authored fixture text.', 'paper', 'example.org',
       jsonb_build_object('doi', d)
  FROM (VALUES (1, '10.5555/adv.inj@evil.stub'), (2, '10.5555/../../../x'), (3, '10.5555/adv.001,10.5555/adv.002'),
               (4, '10.5555/adv?api_key=stolen&x=http://evil.stub/'), (5, '10.5555/' || repeat('a', 300)),
               (6, '10.5555/adv.inj' || chr(252) || chr(8364))) AS v(n, d);

-- 116: a DOI no other note cites (the egress case: its resolution is never cached before)
INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES
  ('f6a00000-0000-4000-8000-000000000116', 'https://doi.org/10.5555/p6a.e01', 'Fixture egress record',
   'Fixture egress record: an authored fixture text.', 'paper', 'doi.org', '{}');

-- rw-p6a-resolve attempt 3: 117-118, the stub answers a 200 whose title holds the key / mailto split by
-- an empty citeproc tag (s01: <i></i> and <b></b>; s02: <sc></sc> and <span class="nocase"></span>)
INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES
  ('f6a00000-0000-4000-8000-000000000117', 'https://doi.org/10.5555/p6a.s01', 'Fixture split-key record s01',
   'Fixture split-key record s01: an authored fixture text.', 'paper', 'doi.org', '{}'),
  ('f6a00000-0000-4000-8000-000000000118', 'https://doi.org/10.5555/p6a.s02', 'Fixture split-key record s02',
   'Fixture split-key record s02: an authored fixture text.', 'paper', 'doi.org', '{}');

NOTIFY pgrst, 'reload schema';
