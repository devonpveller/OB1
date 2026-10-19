-- ============================================================
-- wiki_pages - the viewer's index substrate (wiki-dynamic-index plan).
--
-- Governing spec: ai-stack documentation/implementation-guide/
--   wiki-dynamic-index/PLAN.md
--
-- WHY THIS TABLE EXISTS
--   The wiki's page prose is SYNTHESIZED by the compiler and lives only on
--   disk; the brain stores entities (name/type/metadata) and raw
--   thought/source text, not the LLM-written page bodies. Quartz therefore
--   had to derive its global indexes (search, nav tree, graph) by walking
--   every page each build - one non-incremental emitter (ContentIndex)
--   re-serialising ~75MB per rebuild, which is what pinned the rebuild at
--   ~2min and made a new note take minutes to appear.
--
--   This table is the compiler PUBLISHING what it wrote, so those indexes
--   become queries instead of whole-vault walks.
--
--   Since research-workbench D13 (P1a) the ROW IS WHAT IS PRESENTED: the
--   viewer renders every page from its row (no row = the pending-compile
--   state). Compile owns both the file (the durable copy: git vault,
--   backups) and the row; a compile whose rows do not land FAILS
--   (recipes/_shared/wiki-pages.mjs), and reconcile-wiki-pages.mjs measures
--   files vs rows per page_class and repairs drift on (re)connect.
--
-- WRITERS
--   recipes/entity-wiki/generate-wiki.mjs        entity pages
--   recipes/_shared/source-leaf.mjs              thought/source leaves
--   recipes/wiki-synthesis/.../synthesize-notebooks.mjs   notebook hubs
--   docker/workbench (note-commit)               user notes
--   docker/wiki-service (orphan sweeps)          DELETEs
--
-- Idempotent; safe to re-run. Additive only - no existing table is touched.
-- ============================================================

CREATE TABLE IF NOT EXISTS wiki_pages (
  -- Vault-relative path without extension, exactly the slug Quartz uses
  -- ("content/person/person-ada-lovelace", "notes/my-note", "index").
  slug        text PRIMARY KEY,
  -- entity | source | thought | notebook | note | root
  page_class  text NOT NULL,
  -- person/organization/tool/... for entity pages; NULL otherwise.
  entity_type text,
  title       text NOT NULL DEFAULT '',
  -- Markdown minus frontmatter. FTS input and search-snippet source.
  body        text NOT NULL DEFAULT '',
  tags        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Outgoing wikilink targets, for the graph endpoint.
  links       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The page's frontmatter as the compiler wrote it (P1a: the row is what is
-- presented, so it carries what the page shows - the ids the hydrated cards
-- key on, dates, aliases, cssclasses). Additive; a row written before this
-- column existed reads as {} until its next compile or the repair pass.
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS frontmatter jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Weighted FTS: a title hit outranks a body hit. GENERATED ALWAYS means the
-- writers never compute it and it can never drift from title/body.
-- 'english' is the stock config - no extension required (this DB has only
-- vector + pgcrypto; pg_trgm fuzzy matching is a later, optional phase).
ALTER TABLE wiki_pages
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body,  '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_wiki_pages_tsv    ON wiki_pages USING gin (search_tsv);
-- text_pattern_ops: prefix scans for the nav endpoint (slug LIKE 'content/person/%').
CREATE INDEX IF NOT EXISTS idx_wiki_pages_prefix ON wiki_pages (slug text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_class  ON wiki_pages (page_class);

-- Grants: init-grants.sql sets ALTER DEFAULT PRIVILEGES for service_role, so
-- a table created by the superuser is already reachable. Repeated here so a
-- LIVE apply (existing stack, where the initdb ordering does not replay) is
-- self-sufficient.
GRANT ALL ON wiki_pages TO service_role;

-- PostgREST caches the schema; without this a live apply 404s on /wiki_pages.
NOTIFY pgrst, 'reload schema';
