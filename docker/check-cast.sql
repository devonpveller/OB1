-- check-cast.sql - rwr-cast-edit-api (slot 560): is the cast model in the shape the workbench relies on? Read-only;
-- prints counts only, never a presenter's text, an id or an owner.
--   psql -X -A -t -q -f check-cast.sql
-- Lines: "check: <what>=<count>" for each rule, then "check: OK" or "check: FAIL" (a FAIL names the rule).
-- Rules: 560 is applied (the columns, the grounding table with row-level security, the four registries); no SHARED
-- presenter links a source that is not a shared source (Q12); no shared team has an unshared member, no shared format
-- an unshared team (a shared row never exposes an unshared one); every grounding row, team member and format belongs to
-- the owner of the row it hangs on (no cross-owner link); at most one default format per owner.
WITH r AS (
  SELECT 'columns_missing' AS what, (
      SELECT count(*) FROM (VALUES
        ('podcast_presenters', 'role'), ('podcast_presenters', 'focus'), ('podcast_presenters', 'stance'),
        ('podcast_presenters', 'tone'), ('podcast_presenters', 'speaking_style'), ('podcast_presenters', 'system_prompt'),
        ('podcast_presenters', 'system_prompt_mode'), ('podcast_presenters', 'notes'), ('podcast_presenters', 'shared'),
        ('podcast_presenters', 'copied_from'), ('podcast_teams', 'user_seat'), ('podcast_teams', 'shared'),
        ('podcast_teams', 'copied_from'), ('podcast_formats', 'kind'), ('podcast_formats', 'use_for'),
        ('podcast_formats', 'is_default'), ('podcast_formats', 'shared'), ('podcast_formats', 'copied_from')) AS c(t, col)
       WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = c.t AND i.column_name = c.col)
    ) AS n, 0 AS want
  UNION ALL
  SELECT 'grounding_table_without_rls', (
      SELECT count(*) FROM (SELECT 1) x WHERE NOT EXISTS (
        SELECT 1 FROM pg_class WHERE oid = to_regclass('public.podcast_presenter_grounding') AND relrowsecurity))
    , 0
  UNION ALL
  SELECT 'registry_entries', (
      SELECT count(*) FROM public.contract_registry_entries
       WHERE registry IN ('podcast_format_kinds', 'podcast_format_uses', 'podcast_prompt_modes', 'podcast_grounding_kinds')), 12
)
SELECT 'check: ' || what || '=' || n FROM r;

-- the data rules need 560's objects: run only when they exist
DO $$
DECLARE
  bad TEXT[] := ARRAY[]::TEXT[];
  n BIGINT;
BEGIN
  IF to_regclass('public.podcast_presenter_grounding') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'podcast_formats' AND column_name = 'shared') THEN
    RAISE NOTICE 'check: slot 560 is not applied';
    RAISE NOTICE 'check: FAIL (560 not applied)';
    RETURN;
  END IF;
  SELECT count(*) INTO n FROM public.podcast_presenter_grounding g JOIN public.podcast_presenters p ON p.id = g.presenter_id
   WHERE p.shared AND g.kind = 'source' AND NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id::text = g.ref);
  RAISE NOTICE 'check: shared_presenter_private_links=%', n; IF n > 0 THEN bad := array_append(bad, 'shared_presenter_private_links'); END IF;
  SELECT count(*) INTO n FROM public.podcast_teams t JOIN public.podcast_team_members m ON m.team_id = t.id
    JOIN public.podcast_presenters p ON p.id = m.presenter_id WHERE t.shared AND NOT p.shared;
  RAISE NOTICE 'check: shared_team_unshared_members=%', n; IF n > 0 THEN bad := array_append(bad, 'shared_team_unshared_members'); END IF;
  SELECT count(*) INTO n FROM public.podcast_formats f JOIN public.podcast_teams t ON t.id = f.team_id WHERE f.shared AND NOT t.shared;
  RAISE NOTICE 'check: shared_format_unshared_team=%', n; IF n > 0 THEN bad := array_append(bad, 'shared_format_unshared_team'); END IF;
  SELECT count(*) INTO n FROM public.podcast_presenter_grounding g JOIN public.podcast_presenters p ON p.id = g.presenter_id WHERE g.owner_sub <> p.owner_sub;
  RAISE NOTICE 'check: grounding_cross_owner=%', n; IF n > 0 THEN bad := array_append(bad, 'grounding_cross_owner'); END IF;
  SELECT count(*) INTO n FROM public.podcast_team_members m JOIN public.podcast_teams t ON t.id = m.team_id
    JOIN public.podcast_presenters p ON p.id = m.presenter_id WHERE t.owner_sub <> p.owner_sub;
  RAISE NOTICE 'check: team_member_cross_owner=%', n; IF n > 0 THEN bad := array_append(bad, 'team_member_cross_owner'); END IF;
  SELECT count(*) INTO n FROM public.podcast_formats f JOIN public.podcast_teams t ON t.id = f.team_id WHERE f.owner_sub <> t.owner_sub;
  RAISE NOTICE 'check: format_team_cross_owner=%', n; IF n > 0 THEN bad := array_append(bad, 'format_team_cross_owner'); END IF;
  SELECT count(*) INTO n FROM public.podcast_presenters p JOIN public.podcast_voice_links v ON v.id = p.voice_link_id WHERE p.owner_sub <> v.owner_sub;
  RAISE NOTICE 'check: voice_cross_owner=%', n; IF n > 0 THEN bad := array_append(bad, 'voice_cross_owner'); END IF;
  SELECT count(*) INTO n FROM (SELECT owner_sub FROM public.podcast_formats WHERE is_default GROUP BY owner_sub HAVING count(*) > 1) d;
  RAISE NOTICE 'check: owners_with_two_defaults=%', n; IF n > 0 THEN bad := array_append(bad, 'owners_with_two_defaults'); END IF;
  SELECT count(*) INTO n FROM public.podcast_teams t WHERE (SELECT count(*) FROM public.podcast_team_members m WHERE m.team_id = t.id) + 1 > 26;
  RAISE NOTICE 'check: teams_over_26_seats=%', n; IF n > 0 THEN bad := array_append(bad, 'teams_over_26_seats'); END IF;
  IF (SELECT count(*) FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name IN ('podcast_presenters', 'podcast_teams', 'podcast_formats') AND c.column_name IN
          ('role', 'focus', 'stance', 'tone', 'speaking_style', 'system_prompt', 'system_prompt_mode', 'notes', 'shared', 'copied_from',
           'user_seat', 'kind', 'use_for', 'is_default')) <> 18 THEN bad := array_append(bad, 'columns_missing'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.podcast_presenter_grounding'::regclass AND relrowsecurity) THEN bad := array_append(bad, 'grounding_table_without_rls'); END IF;
  IF (SELECT count(*) FROM public.contract_registry_entries
        WHERE registry IN ('podcast_format_kinds', 'podcast_format_uses', 'podcast_prompt_modes', 'podcast_grounding_kinds')) <> 12 THEN
    bad := array_append(bad, 'registry_entries');
  END IF;
  IF array_length(bad, 1) IS NULL THEN RAISE NOTICE 'check: OK';
  ELSE RAISE NOTICE 'check: FAIL (%)', array_to_string(bad, ', '); END IF;
END $$;
