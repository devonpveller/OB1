-- Revert init-document-trail.sql (rwr-docs-lifecycle-api).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-document-trail.sql
-- Drops the user documents' removal trail (THIS DISCARDS every user_document_trail ROW: which document
-- was removed for good, when, by whom). The vault's git history of each removal is not touched.
-- Redeploy the workbench image from before this item with this revert.
\set ON_ERROR_STOP on
BEGIN;
DROP TABLE IF EXISTS public.user_document_trail;   -- its two triggers go with it
DROP FUNCTION IF EXISTS public.user_document_trail_no_edit();
COMMIT;
NOTIFY pgrst, 'reload schema';
