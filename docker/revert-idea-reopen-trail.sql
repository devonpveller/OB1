-- Revert init-idea-reopen-trail.sql (rw-idea-reopen-trail, slot 690). THIS DISCARDS every 'reopened' trail line (they
-- cannot exist without the new kind and column). ORDER: put the previous workbench image back FIRST (the one that does not
-- write 'reopened' lines), then run this. Slot 510 is untouched and stays; the table is exactly as slot 510 left it.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-idea-reopen-trail.sql   (as the superuser)
\set ON_ERROR_STOP on
BEGIN;
-- the append-only trigger refuses every DELETE, even the superuser's: step it aside for this one statement, inside the transaction
ALTER TABLE public.user_document_trail DISABLE TRIGGER trg_user_document_trail_no_delete;
DELETE FROM public.user_document_trail WHERE kind = 'reopened';
ALTER TABLE public.user_document_trail ENABLE TRIGGER trg_user_document_trail_no_delete;
ALTER TABLE public.user_document_trail DROP CONSTRAINT IF EXISTS user_document_trail_subject_check;
ALTER TABLE public.user_document_trail DROP CONSTRAINT IF EXISTS user_document_trail_kind_check;
ALTER TABLE public.user_document_trail ADD CONSTRAINT user_document_trail_kind_check
    CHECK (kind IN ('delete_forever', 'empty_trash', 'nightly_expired', 'restored', 'unarchived'));
ALTER TABLE public.user_document_trail ALTER COLUMN path SET NOT NULL;
ALTER TABLE public.user_document_trail DROP COLUMN IF EXISTS idea_id;
COMMIT;
NOTIFY pgrst, 'reload schema';
