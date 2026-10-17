-- Revert init-research-contract.sql (research-workbench P0, rw-p0-contract).
--
-- Run from OB1/docker so the relative include below resolves:
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-research-contract.sql
--
-- What it does, in order:
--   1. restores the pre-P0 claim scoring by re-running init-claims.sql (idempotent; its
--      CREATE OR REPLACE FUNCTION bodies are the originals), then drops the helpers P0 added;
--   2. drops the tombstone gate, the idea / idea-revision triggers and their functions;
--   3. maps research_jobs origins the old CHECK does not know back onto it (mattermost -> agent,
--      workspace -> manual, anything else unregistered -> manual), drops the registry FK and
--      its generated column, and restores the CHECK;
--   4. drops the tables, views and additive columns P0 created. THIS DISCARDS their data
--      (tombstones, attempts, trail events, held sources, refinery state, notifications,
--      settings, registries) - take a pg_dump first if any of it matters.
-- content_types.version is left in place (harmless, and P5's table predates P0).
\set ON_ERROR_STOP on
BEGIN;

\ir init-claims.sql
DROP FUNCTION IF EXISTS public.recompute_claims_for_source(UUID);
DROP FUNCTION IF EXISTS public.claim_edge_counts(UUID);

DROP TRIGGER IF EXISTS trg_sources_tombstone_gate ON public.sources;
DROP FUNCTION IF EXISTS public.trg_sources_tombstone_gate();
DROP TRIGGER IF EXISTS trg_ideas_notify ON public.ideas;
DROP FUNCTION IF EXISTS public.trg_ideas_notify();
DROP TRIGGER IF EXISTS trg_idea_revisions_inlet ON public.idea_revisions;
DROP FUNCTION IF EXISTS public.trg_idea_revisions_inlet();

UPDATE public.research_jobs SET origin = 'agent'  WHERE origin = 'mattermost';
UPDATE public.research_jobs SET origin = 'manual' WHERE origin NOT IN ('owui', 'agent', 'notebook', 'manual');
ALTER TABLE public.research_jobs DROP CONSTRAINT IF EXISTS research_jobs_origin_registry_fkey;
ALTER TABLE public.research_jobs DROP COLUMN IF EXISTS origin_registry;
ALTER TABLE public.research_jobs DROP CONSTRAINT IF EXISTS research_jobs_origin_check;
ALTER TABLE public.research_jobs ADD CONSTRAINT research_jobs_origin_check
    CHECK (origin IN ('owui', 'agent', 'notebook', 'manual'));
ALTER TABLE public.research_jobs DROP COLUMN IF EXISTS caller;
ALTER TABLE public.research_jobs DROP COLUMN IF EXISTS origin_claimed;
ALTER TABLE public.research_jobs DROP COLUMN IF EXISTS inlet_ref;
ALTER TABLE public.research_jobs DROP COLUMN IF EXISTS refinery_id;

DROP FUNCTION IF EXISTS public.source_blocking_dependence(UUID);
DROP FUNCTION IF EXISTS public.source_dependence(UUID);
DROP FUNCTION IF EXISTS public.post_research_notification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.contract_record_query_hit(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.contract_tombstone_for(TEXT);
DROP FUNCTION IF EXISTS public.source_lifecycle_state(TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.contract_registry_has(TEXT, TEXT);
DROP VIEW IF EXISTS public.contract_registry_view;

DROP TABLE IF EXISTS public.contract_settings;
DROP TABLE IF EXISTS public.research_notifications;
DROP TABLE IF EXISTS public.user_document_listings;
DROP TABLE IF EXISTS public.refinery_members;
DROP TABLE IF EXISTS public.refinery_state;
DROP TABLE IF EXISTS public.refinery_hidden;
DROP TABLE IF EXISTS public.refinery_user_sources;
DROP TABLE IF EXISTS public.held_source_chunks;
DROP TABLE IF EXISTS public.held_sources;
DROP TABLE IF EXISTS public.source_disputes;
DROP TABLE IF EXISTS public.source_tombstone_attempts;
DROP TABLE IF EXISTS public.source_tombstones;
DROP TABLE IF EXISTS public.page_compile_marks;
DROP TABLE IF EXISTS public.source_trail_events;
DROP TRIGGER IF EXISTS trg_contract_registry_entries_bump ON public.contract_registry_entries;
DROP FUNCTION IF EXISTS public.contract_registry_entries_bump();
DROP TABLE IF EXISTS public.contract_registry_entries;
DROP TABLE IF EXISTS public.contract_registries;

ALTER TABLE public.sources DROP COLUMN IF EXISTS suppression_reason;
ALTER TABLE public.sources DROP COLUMN IF EXISTS suppression_context;
ALTER TABLE public.sources DROP COLUMN IF EXISTS unlinked_at;

DROP FUNCTION IF EXISTS public.contract_url_key(TEXT);
DROP FUNCTION IF EXISTS public.contract_url_norm(TEXT);

COMMIT;
NOTIFY pgrst, 'reload schema';
