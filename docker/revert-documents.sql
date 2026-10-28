-- Revert init-documents.sql (research-workbench P2b, rw-p2b-workspace).
--
-- Run BEFORE revert-references.sql and revert-research-contract.sql (P2b sits on both):
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-documents.sql
--
-- What it does, in order:
--   1. drops the pick-up table and the held-source revision snapshots (THIS DISCARDS the
--      refinery's picked-up links and every earlier held revision's text - pg_dump first if any
--      of it matters; the user documents themselves are vault files and are not touched);
--   2. drops the archive columns, the per-user acknowledgements and the listing's owner column;
--   3. removes the P2b registry entries and the progress_indicators registry.
-- The pre-P2b workbench image must be redeployed with this revert.
\set ON_ERROR_STOP on
BEGIN;

DROP TRIGGER IF EXISTS trg_held_sources_snapshot ON public.held_sources;
DROP FUNCTION IF EXISTS public.trg_held_sources_snapshot();
DROP TABLE IF EXISTS public.held_source_revisions;
DROP TABLE IF EXISTS public.refinery_picked_links;

ALTER TABLE public.refinery_state DROP COLUMN IF EXISTS archived_at;
ALTER TABLE public.refinery_state DROP COLUMN IF EXISTS archived_from;

DROP TABLE IF EXISTS public.notification_acks;
DROP TABLE IF EXISTS public.research_prompts;
DROP INDEX IF EXISTS public.idx_user_document_listings_owner;
ALTER TABLE public.user_document_listings DROP COLUMN IF EXISTS owner_sub;
ALTER TABLE public.user_document_listings DROP COLUMN IF EXISTS actor_sub;
DROP INDEX IF EXISTS public.idx_ideas_owner;
ALTER TABLE public.ideas DROP COLUMN IF EXISTS owner_sub;
ALTER TABLE public.ideas DROP COLUMN IF EXISTS actor_sub;

DELETE FROM public.contract_registry_entries
 WHERE (registry, key) IN (('job_kinds', 'compile'), ('job_kinds', 'held'), ('job_states', 'pending'),
                           ('job_states', 'held'), ('refinery_member_kinds', 'user_source'), ('node_kinds', 'report'))
    OR registry = 'progress_indicators';
DELETE FROM public.contract_registries WHERE name = 'progress_indicators';

COMMIT;
