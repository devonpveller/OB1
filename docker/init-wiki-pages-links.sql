-- wiki_pages.links containment index (no-rebuild Phase E / graph endpoint).
--
-- The graph needs BOTH directions: a page's outgoing links (jsonb array) and
-- its BACKLINKS (pages whose links contain this slug). Outgoing is a primary
-- key lookup; backlinks are a containment query -- `links @> '["slug"]'` --
-- which without an index is a sequential scan over ~41k rows on every graph
-- render. jsonb_path_ops is the smaller, faster GIN variant and supports @>,
-- which is the only operator this query uses.
--
-- Additive and idempotent; no existing object is altered.
CREATE INDEX IF NOT EXISTS idx_wiki_pages_links_gin
  ON wiki_pages USING gin (links jsonb_path_ops);

NOTIFY pgrst, 'reload schema';
