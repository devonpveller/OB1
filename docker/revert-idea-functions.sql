-- Revert init-idea-functions.sql (rw-p8a4-ideas).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-idea-functions.sql
-- Drops the owner-checked idea functions, the write guard and the dossier-per-job index, and restores
-- slot 230's trg_ideas_notify. Rows are kept: revisions, room dossier entries, metadata.promoted /
-- metadata.resurfaced and refinery_members rows stay (they are harmless to the older code). Run it only after
-- the workbench and openbrain-mcp images without these calls are back in place. Safe to run twice.
\set ON_ERROR_STOP on
BEGIN;
DROP TRIGGER IF EXISTS trg_ideas_write_guard ON public.ideas;
DROP TRIGGER IF EXISTS trg_idea_revisions_write_guard ON public.idea_revisions;
DROP FUNCTION IF EXISTS public.trg_ideas_write_guard();
DROP FUNCTION IF EXISTS public.trg_idea_revisions_write_guard();
DROP FUNCTION IF EXISTS public.idea_edit(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT);
DROP FUNCTION IF EXISTS public.idea_research(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.idea_promote(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.idea_deliver_dossier(UUID, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.idea_resurface(UUID, DOUBLE PRECISION, INT);
DROP FUNCTION IF EXISTS public.refinery_engage(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.ideas_door_open();
DROP INDEX IF EXISTS public.uq_workspace_room_entries_dossier_job;
-- slot 230's notification trigger, as it was
CREATE OR REPLACE FUNCTION public.trg_ideas_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.post_research_notification('informational', 'a new idea has been added',
                                                  NULL, 'idea:' || NEW.id::text, NULL, NULL);
    ELSIF NEW.dossier_source_id IS NOT NULL
          AND NEW.dossier_source_id IS DISTINCT FROM OLD.dossier_source_id THEN
        PERFORM public.post_research_notification('informational', 'dossier delivered',
                                                  NULL, 'idea:' || NEW.id::text || ':dossier:' || NEW.dossier_source_id::text,
                                                  NULL, NULL);
    END IF;
    RETURN NEW;
END;
$$;
COMMIT;
