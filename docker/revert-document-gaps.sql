-- Revert init-document-gaps.sql (research-workbench redesign, rwr-doc-gaps-api; slot 650).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-document-gaps.sql
--
-- THIS DISCARDS every gap row: take a pg_dump first if any of it matters. Nothing else is touched (a gap never
-- changed a document, a source or a claim). The pre-gaps workbench image must be redeployed with this revert,
-- since the gaps image reads this table. Independent of the other slots.
\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS public.document_gaps;

DELETE FROM public.contract_registry_entries WHERE registry IN ('gap_origins', 'gap_states');
DELETE FROM public.contract_registries WHERE name IN ('gap_origins', 'gap_states');

COMMIT;
NOTIFY pgrst, 'reload schema';
