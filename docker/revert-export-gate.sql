-- Revert init-export-gate.sql (research-workbench P6b, rw-p6b-gate).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-export-gate.sql
--
-- What it does: drops export_runs (THIS DISCARDS every user's export history and the stored files of
-- passed exports), removes the export_required_sections registry, and takes the gate flag off the pdf
-- format. Redeploy the pre-P6b workbench image with this revert: the P6b image records every PDF export
-- in export_runs and refuses one it cannot record.
\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS public.export_runs;

DELETE FROM public.contract_registry_entries WHERE registry = 'export_required_sections';
DELETE FROM public.contract_registries WHERE name = 'export_required_sections';

UPDATE public.contract_registry_entries
   SET definition = definition - 'gate'
 WHERE registry = 'export_formats' AND key = 'pdf';

COMMIT;
NOTIFY pgrst, 'reload schema';
