-- rw-p1a-render test fixtures: the slice of the Open Brain schema that
-- generate-wiki (--ids) and synthesize-notebooks read, with SYNTHETIC rows only
-- (ids 901-906, thoughts 9001-9006, sources ...0001-...0102). Never a copy of
-- the live openbrain-db. Foreign keys exist so PostgREST can embed resources
-- exactly the way the recipes ask for them.
CREATE TABLE entities (
  id bigint PRIMARY KEY,
  canonical_name text NOT NULL,
  normalized_name text NOT NULL,
  entity_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z',
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE thoughts (
  id bigint PRIMARY KEY,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z'
);
CREATE TABLE thought_entities (
  thought_id bigint NOT NULL REFERENCES thoughts(id),
  entity_id bigint NOT NULL REFERENCES entities(id),
  mention_role text, confidence real, source text, evidence text,
  created_at timestamptz NOT NULL DEFAULT '2026-10-01T00:00:00Z',
  PRIMARY KEY (thought_id, entity_id)
);
CREATE TABLE edges (
  id bigserial PRIMARY KEY,
  from_entity_id bigint NOT NULL REFERENCES entities(id),
  to_entity_id bigint NOT NULL REFERENCES entities(id),
  relation text NOT NULL, support_count int, confidence real,
  metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE sources (
  id uuid PRIMARY KEY,
  url text, title text, content text, content_type text, notebook text,
  research_key text, research_query text, metadata jsonb,
  retraction_committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT '2026-10-02T00:00:00Z'
);
CREATE TABLE source_entities (
  source_id uuid NOT NULL REFERENCES sources(id),
  entity_id bigint NOT NULL REFERENCES entities(id),
  confidence real, mention_role text,
  created_at timestamptz NOT NULL DEFAULT '2026-10-02T00:00:00Z',
  PRIMARY KEY (source_id, entity_id)
);
CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, slug text, status text DEFAULT 'active', description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE thread_sources (
  thread_id uuid NOT NULL REFERENCES threads(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  link_type text, status text, confirmed_at timestamptz,
  PRIMARY KEY (thread_id, source_id)
);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

INSERT INTO entities (id, canonical_name, normalized_name, entity_type, metadata) VALUES
  (901, 'Ada Fixture',   'ada fixture',   'person', '{"wiki_slug":"person-ada-fixture"}'),
  (902, 'Bob Fixture',   'bob fixture',   'person', '{"wiki_slug":"person-bob-fixture"}'),
  (903, 'Fixture DB',    'fixture db',    'tool',   '{"wiki_slug":"tool-fixture-db"}'),
  (904, 'Carol Fixture', 'carol fixture', 'person', '{"wiki_slug":"person-carol-fixture"}'),
  (905, 'Dave Fixture',  'dave fixture',  'person', '{"wiki_slug":"person-dave-fixture"}'),
  (906, 'Erin Fixture',  'erin fixture',  'person', '{"wiki_slug":"person-erin-fixture"}');
INSERT INTO thoughts (id, content, metadata) VALUES
  (9001, 'Ada maintains the fixture database.', '{"type":"observation"}'),
  (9002, 'Bob and Ada should compare the renderers.', '{"type":"idea"}'),
  (9003, 'Carol tests the retry path.', '{"type":"observation"}'),
  (9004, 'Dave tests the structural path.', '{"type":"observation"}'),
  (9005, 'Erin tests the flush path.', '{"type":"observation"}');
INSERT INTO thought_entities (thought_id, entity_id, mention_role, confidence, source) VALUES
  (9001, 901, 'subject', 0.9, 'fixture'), (9002, 902, 'subject', 0.9, 'fixture'),
  (9003, 904, 'subject', 0.9, 'fixture'), (9004, 905, 'subject', 0.9, 'fixture'),
  (9005, 906, 'subject', 0.9, 'fixture');
INSERT INTO sources (id, url, title, content, content_type) VALUES
  ('00000000-0000-4000-8000-000000000001', 'https://example.invalid/fixture-article', 'Fixture Article',
   'The fixture article describes Ada Fixture.', 'web_article');
INSERT INTO threads (id, name, slug, status) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'Fixture Notebook', 'fixture-notebook', 'active');
INSERT INTO thread_sources (thread_id, source_id, link_type, status, confirmed_at) VALUES
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'automatic', 'confirmed', now());
