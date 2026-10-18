-- Revert init-export.sql (research-workbench P6a, rw-p6a-resolve).
--
-- Run BEFORE revert-references.sql (the cache sits on P2a's reference_records):
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-export.sql
--
-- What it does: drops the resolution cache (THIS DISCARDS every cached CSL-JSON item - the next
-- export resolves again, which needs the resolver configured) and removes the P6a registry entries
-- and registries. The pre-P6a workbench image must be redeployed with this revert: the P6a image
-- reads these registries and refuses an export without them.
\set ON_ERROR_STOP on
BEGIN;

DROP TRIGGER IF EXISTS trg_reference_resolutions_validate ON public.reference_resolutions;
DROP FUNCTION IF EXISTS public.reference_resolutions_validate();
DROP TABLE IF EXISTS public.reference_resolutions;

DELETE FROM public.contract_registry_entries
 WHERE registry IN ('export_formats', 'citation_styles', 'reference_identifier_kinds');
DELETE FROM public.contract_registries
 WHERE name IN ('export_formats', 'citation_styles', 'reference_identifier_kinds');

COMMIT;
NOTIFY pgrst, 'reload schema';
