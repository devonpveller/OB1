-- Revert init-podcasts.sql (rw-p7a-tts).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-podcasts.sql
-- Drops the presenter model and the render requests (THIS DISCARDS every presenter, team, format,
-- voice link, render request and episode ROW). The archive FOLDER is not touched: every rendered and
-- archived episode stays on disk with its sidecar.
\set ON_ERROR_STOP on
BEGIN;
DROP TABLE IF EXISTS public.podcast_render_requests;
DROP TABLE IF EXISTS public.podcast_episodes;
DROP TABLE IF EXISTS public.podcast_formats;
DROP TABLE IF EXISTS public.podcast_team_members;
DROP TABLE IF EXISTS public.podcast_teams;
DROP TABLE IF EXISTS public.podcast_presenters;
DROP TABLE IF EXISTS public.podcast_voice_links;
COMMIT;
NOTIFY pgrst, 'reload schema';
