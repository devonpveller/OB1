-- Revert only the grant tightening of init-document-trail.sql (rwr-trail-grants-exact), keeping the table and its rows:
-- the append-only triggers go, and service_role gets back what the schema's default privileges gave it (ALL), which is
-- the table's ACL before this item. Use revert-document-trail.sql to remove the whole trail.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-document-trail-grants.sql
\set ON_ERROR_STOP on
BEGIN;
DROP TRIGGER IF EXISTS trg_user_document_trail_no_update ON public.user_document_trail;
DROP TRIGGER IF EXISTS trg_user_document_trail_no_truncate ON public.user_document_trail;
DROP FUNCTION IF EXISTS public.user_document_trail_no_edit();
GRANT ALL ON public.user_document_trail TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
