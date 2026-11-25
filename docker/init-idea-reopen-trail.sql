-- ============================================================
-- Reopening an idea writes a trail line (research-workbench redesign, rw-idea-reopen-trail). Fresh-volume slot 690.
--
-- What this file adds, and only this, on top of slot 510 (public.user_document_trail; slot 510 itself is NOT edited):
--   kind 'reopened'   one line per idea reopened from the archive (POST /workbench/ideas/{id}/reopen and the refinery
--                     open of documents/refinery.ts). owner_sub = the idea's owner, actor_sub = the caller.
--   idea_id UUID      the subject of a 'reopened' line: the idea's id. Nullable; NULL for every other kind.
--   path NULLABLE     a 'reopened' line has no vault path (an idea may have no document); every other kind still needs one.
--   a shape CHECK     user_document_trail_subject_check: a 'reopened' line has an idea id and NO path, document id or
--                     trashed_at; any other line has a path and no idea id. Together with the table's columns (no title, no
--                     body, no note column) a reopen line cannot carry idea text.
-- Grants, RLS and the append-only triggers of slot 510 are untouched (service_role holds SELECT, INSERT only).
--
-- Idempotent. Applied to a live DB by hand (psql -f, BEFORE the new workbench image; a fresh backup first), then
-- check-idea-reopen-trail.sql. ORDER: do not re-run slot 510 after 'reopened' rows exist (its kind CHECK is the narrow one).
-- Revert: revert-idea-reopen-trail.sql (THIS DISCARDS the 'reopened' lines).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f init-idea-reopen-trail.sql
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
ALTER TABLE public.user_document_trail ADD COLUMN IF NOT EXISTS idea_id UUID;
ALTER TABLE public.user_document_trail ALTER COLUMN path DROP NOT NULL;
ALTER TABLE public.user_document_trail DROP CONSTRAINT IF EXISTS user_document_trail_kind_check;
ALTER TABLE public.user_document_trail ADD CONSTRAINT user_document_trail_kind_check
    CHECK (kind IN ('delete_forever', 'empty_trash', 'nightly_expired', 'restored', 'unarchived', 'reopened'));
ALTER TABLE public.user_document_trail DROP CONSTRAINT IF EXISTS user_document_trail_subject_check;
ALTER TABLE public.user_document_trail ADD CONSTRAINT user_document_trail_subject_check
    CHECK ((kind = 'reopened' AND idea_id IS NOT NULL AND path IS NULL AND document_id IS NULL AND trashed_at IS NULL)
        OR (kind <> 'reopened' AND idea_id IS NULL AND path IS NOT NULL));
COMMIT;
NOTIFY pgrst, 'reload schema';
