-- Revert init-rooms.sql (rw-p8a3-room).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-rooms.sql
-- Drops the room store and idea_room(). THIS DISCARDS every room transcript, chat scope and draft.
-- Run it only after the workbench image without /workbench/rooms is back in place.
\set ON_ERROR_STOP on
BEGIN;
DROP FUNCTION IF EXISTS public.idea_room(UUID);
DROP TABLE IF EXISTS public.workspace_room_entries;
DROP TABLE IF EXISTS public.workspace_rooms;
COMMIT;
