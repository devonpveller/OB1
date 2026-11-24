-- Revert init-cast.sql (research-workbench redesign, rwr-cast-edit-api; slot 560).
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-cast.sql
--
-- Put the previous openbrain-workbench and openbrain-podcast images back FIRST (the new ones read these columns).
-- THIS DISCARDS what 560 added: every presenter's role / focus / stance / tone / speaking style / system prompt /
-- notes and grounded-in links, every team's user seat, every format's kind / use-for / default, and every shared flag
-- and copied_from (take a pg_dump first if any of it matters). Rows themselves stay: a presenter, team or format made
-- through the new routes (a copy included) is an ordinary row of slot 330's model afterwards, private to its owner.
-- The schema afterwards is byte-identical to the one before 560 (run-cast-tests.ps1 compares the dumps).
\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS public.podcast_presenter_grounding;
DROP INDEX IF EXISTS public.idx_podcast_presenters_shared;
DROP INDEX IF EXISTS public.idx_podcast_teams_shared;
DROP INDEX IF EXISTS public.idx_podcast_formats_shared;
DROP INDEX IF EXISTS public.uq_podcast_formats_default;

ALTER TABLE public.podcast_presenters
    DROP COLUMN IF EXISTS role,
    DROP COLUMN IF EXISTS focus,
    DROP COLUMN IF EXISTS stance,
    DROP COLUMN IF EXISTS tone,
    DROP COLUMN IF EXISTS speaking_style,
    DROP COLUMN IF EXISTS system_prompt,
    DROP COLUMN IF EXISTS system_prompt_mode,
    DROP COLUMN IF EXISTS notes,
    DROP COLUMN IF EXISTS shared,
    DROP COLUMN IF EXISTS copied_from;

ALTER TABLE public.podcast_teams
    DROP COLUMN IF EXISTS user_seat,
    DROP COLUMN IF EXISTS shared,
    DROP COLUMN IF EXISTS copied_from;

ALTER TABLE public.podcast_formats
    DROP COLUMN IF EXISTS kind,
    DROP COLUMN IF EXISTS use_for,
    DROP COLUMN IF EXISTS is_default,
    DROP COLUMN IF EXISTS shared,
    DROP COLUMN IF EXISTS copied_from;

DELETE FROM public.contract_registry_entries
 WHERE registry IN ('podcast_format_kinds', 'podcast_format_uses', 'podcast_prompt_modes', 'podcast_grounding_kinds');
DELETE FROM public.contract_registries
 WHERE name IN ('podcast_format_kinds', 'podcast_format_uses', 'podcast_prompt_modes', 'podcast_grounding_kinds');

COMMIT;
NOTIFY pgrst, 'reload schema';
