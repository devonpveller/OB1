-- check-cast-plant.sql - rwr-cast-edit-api: drives the DATA-RULE FAIL branch of ../../check-cast.sql. LAB ONLY (run-cast-tests.ps1
-- step [5e], on the lab database, never a live one).
--   psql -X -A -t -q -v ON_ERROR_STOP=1 -v rule=<rule name> -v check=/tmp/check-cast.sql -f check-cast-plant.sql
-- Inside ONE transaction that is always rolled back: plants exactly one violation of the named rule (foreign keys and
-- triggers are off for the session so bad data can be planted; the unique index that stops two defaults is dropped
-- inside the transaction), runs check-cast.sql, and rolls back. Expected output: "check: FAIL (<rule>)".
\set QUIET on
SELECT (:'rule' = 'columns_missing') AS r_cols, (:'rule' = 'grounding_table_without_rls') AS r_rls, (:'rule' = 'registry_entries') AS r_reg,
       (:'rule' = 'shared_presenter_private_links') AS r_priv, (:'rule' = 'shared_team_unshared_members') AS r_tm,
       (:'rule' = 'shared_format_unshared_team') AS r_ft, (:'rule' = 'grounding_cross_owner') AS r_gx, (:'rule' = 'team_member_cross_owner') AS r_mx,
       (:'rule' = 'format_team_cross_owner') AS r_fx, (:'rule' = 'voice_cross_owner') AS r_vx, (:'rule' = 'owners_with_two_defaults') AS r_def,
       (:'rule' = 'teams_over_26_seats') AS r_26 \gset
BEGIN;
SET LOCAL session_replication_role = replica;
-- a clean base: two owners, each a voice; a shared presenter, a shared team of it, a shared format of the team (all valid)
INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice) VALUES ('cc-va', 'cc-owner-a', 'local-tts', 'v'), ('cc-vb', 'cc-owner-b', 'local-tts', 'v');
INSERT INTO public.podcast_presenters (id, owner_sub, name, voice_link_id, shared) VALUES ('cc-pa', 'cc-owner-a', 'cc a', 'cc-va', true), ('cc-pb', 'cc-owner-b', 'cc b', 'cc-vb', true);
INSERT INTO public.podcast_teams (id, owner_sub, name, shared) VALUES ('cc-ta', 'cc-owner-a', 'cc team', true);
INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ('cc-ta', 0, 'cc-pa');
INSERT INTO public.podcast_formats (id, owner_sub, name, team_id, shared) VALUES ('cc-fa', 'cc-owner-a', 'cc format', 'cc-ta', true);
\if :r_priv
  INSERT INTO public.podcast_presenter_grounding (presenter_id, owner_sub, position, kind, ref) VALUES ('cc-pa', 'cc-owner-a', 0, 'source', '99999999-9999-4999-8999-999999999999');
\endif
\if :r_tm
  UPDATE public.podcast_presenters SET shared = false WHERE id = 'cc-pa';
\endif
\if :r_ft
  UPDATE public.podcast_teams SET shared = false WHERE id = 'cc-ta';
\endif
\if :r_gx
  INSERT INTO public.podcast_presenter_grounding (presenter_id, owner_sub, position, kind, ref) VALUES ('cc-pa', 'cc-owner-b', 0, 'topic', 'x');
\endif
\if :r_mx
  INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ('cc-ta', 1, 'cc-pb');
\endif
\if :r_fx
  UPDATE public.podcast_formats SET owner_sub = 'cc-owner-b' WHERE id = 'cc-fa';
\endif
\if :r_vx
  UPDATE public.podcast_presenters SET voice_link_id = 'cc-vb' WHERE id = 'cc-pa';
\endif
\if :r_def
  DROP INDEX public.uq_podcast_formats_default;
  INSERT INTO public.podcast_formats (id, owner_sub, name, team_id, shared, is_default) VALUES ('cc-fb', 'cc-owner-a', 'cc format 2', 'cc-ta', true, true);
  UPDATE public.podcast_formats SET is_default = true WHERE id = 'cc-fa';
\endif
\if :r_26
  INSERT INTO public.podcast_presenters (id, owner_sub, name, voice_link_id, shared)
    SELECT 'cc-m' || i, 'cc-owner-a', 'cc m' || i, 'cc-va', true FROM generate_series(1, 25) i;
  INSERT INTO public.podcast_team_members (team_id, position, presenter_id) SELECT 'cc-ta', i, 'cc-m' || i FROM generate_series(1, 25) i;
\endif
\if :r_cols
  ALTER TABLE public.podcast_presenters RENAME COLUMN notes TO notes_renamed_by_the_plant;
\endif
\if :r_rls
  ALTER TABLE public.podcast_presenter_grounding DISABLE ROW LEVEL SECURITY;
\endif
\if :r_reg
  DELETE FROM public.contract_registry_entries WHERE registry = 'podcast_format_kinds' AND key = (SELECT min(key) FROM public.contract_registry_entries WHERE registry = 'podcast_format_kinds');
\endif
\i :check
ROLLBACK;
