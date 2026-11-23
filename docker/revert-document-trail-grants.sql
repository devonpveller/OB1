-- Revert only the grant tightening of init-document-trail.sql (rwr-trail-grants-exact), keeping the table and its rows:
-- the append-only triggers go, and service_role gets back what the schema's default privileges gave it (ALL), which is
-- the table's ACL before this item. Use revert-document-trail.sql to remove the whole trail.
-- ORDER: put the previous workbench image back FIRST (the one that does not write restored / unarchived lines), then run
-- this. This file deletes those lines and narrows the kind CHECK; a workbench that still writes them would then get its
-- trail inserts refused (the put-back itself still succeeds, only its line is lost).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-document-trail-grants.sql
\set ON_ERROR_STOP on
BEGIN;
-- the triggers go first (the DELETE below would be refused by the no-delete trigger)
DROP TRIGGER IF EXISTS trg_user_document_trail_no_update ON public.user_document_trail;
DROP TRIGGER IF EXISTS trg_user_document_trail_no_truncate ON public.user_document_trail;
DROP TRIGGER IF EXISTS trg_user_document_trail_no_delete ON public.user_document_trail;
-- the kind CHECK goes back to the removal kinds only; the lines of a document put back are deleted (they could not exist before)
DELETE FROM public.user_document_trail WHERE kind IN ('restored', 'unarchived');
ALTER TABLE public.user_document_trail DROP CONSTRAINT IF EXISTS user_document_trail_kind_check;
ALTER TABLE public.user_document_trail ADD CONSTRAINT user_document_trail_kind_check
    CHECK (kind IN ('delete_forever', 'empty_trash', 'nightly_expired'));
DROP FUNCTION IF EXISTS public.user_document_trail_no_edit();
GRANT ALL ON public.user_document_trail TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
