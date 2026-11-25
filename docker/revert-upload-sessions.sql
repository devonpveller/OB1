-- ============================================================
-- Revert of init-upload-sessions.sql (rwr-upload-sessions, slot 610): drops the two tables the slot added.
-- THIS DISCARDS every upload session row (unfinished uploads are lost; an add job already made from one is kept, but a
-- retry of it then answers "the file is gone; add it again"). The pieces on the openbrain-uploads volume are not touched
-- here: remove that volume after the revert if the space matters. Slot 610 changed no other table, row, role or grant.
-- Re-runnable.
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-upload-sessions.sql
-- Order: deploy the previous workbench image FIRST (it does not read these tables), then this file.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP TABLE IF EXISTS public.upload_session_pieces;
DROP TABLE IF EXISTS public.upload_sessions;
COMMIT;
