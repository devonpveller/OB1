-- Fixture sources for the P6b disposable run (rw-p6b-gate), applied by run-export-gate-tests.ps1 to a
-- DISPOSABLE database after the initdb chain. Authored: every id is f6b00000-..., every title made up.
-- All are web pages (no persistent identifier): the export cites them as the pages they are, with no
-- resolver and no egress. G4 is re-titled AFTER a document pins it (the runner adds revision 2): the
-- reference panel and the exported file must still agree (acceptance 2).
INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES
  ('f6b00000-0000-4000-8000-000000000001', 'https://example.org/p6b/g1', 'Gate fixture page one on layout checks',
   'Gate fixture page one: an authored page about layout checks.', 'web_article', 'example.org', '{}'),
  ('f6b00000-0000-4000-8000-000000000002', 'https://example.org/p6b/g2', 'Gate fixture page two on reference lists',
   'Gate fixture page two: an authored page about reference lists.', 'web_article', 'example.org', '{}'),
  ('f6b00000-0000-4000-8000-000000000003', 'https://example.org/p6b/g3', 'Gate fixture page three added by hand',
   'Gate fixture page three: an authored page a user adds deliberately.', 'web_article', 'example.org', '{}'),
  ('f6b00000-0000-4000-8000-000000000004', 'https://example.org/p6b/g4', 'Gate fixture page four as first pinned',
   'Gate fixture page four: an authored page, re-titled after it was pinned.', 'web_article', 'example.org', '{}');
NOTIFY pgrst, 'reload schema';
