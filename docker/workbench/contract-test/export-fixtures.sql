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

NOTIFY pgrst, 'reload schema';
