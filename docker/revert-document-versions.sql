-- Revert init-document-versions.sql (rwr-doc-versions-api; slot 620).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-document-versions.sql
-- Drops the snapshots table (THIS DISCARDS every named snapshot and every "Before restoring vN" marker; the
-- documents, their text and their git history - which is where the versions live - are not touched). Put the
-- workbench image from before this item back FIRST (the new image's snapshot routes answer 503 without the table).
\set ON_ERROR_STOP on
BEGIN;
DROP TABLE IF EXISTS public.document_snapshots;
COMMIT;
NOTIFY pgrst, 'reload schema';
