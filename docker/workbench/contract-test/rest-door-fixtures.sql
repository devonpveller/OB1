-- rest-door-fixtures.sql - synthetic rows for the rw-rest-door-auth lab (run-rest-door-auth-lab.ps1). Lab only.
-- Two users: lab-operator (the run owner the digest's / podcast's tokens name) and lab-other (a second user).
-- The ids the probe needs go to lab.seed (a schema PostgREST does not serve).
CREATE SCHEMA IF NOT EXISTS lab;
CREATE TABLE IF NOT EXISTS lab.seed (k TEXT PRIMARY KEY, v TEXT NOT NULL);

DO $$
DECLARE
  e1 BIGINT; e2 BIGINT; t1 BIGINT; tp BIGINT; s1 UUID; th UUID; rr UUID; ep UUID;
BEGIN
  INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('tool', 'Lab Entity', 'lab entity') RETURNING id INTO e1;
  INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('tool', 'Lab Entity Two', 'lab entity two') RETURNING id INTO e2;
  -- an ops-plane thought (the door's plane), queued for extraction by the thoughts trigger
  INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('lab ops thought about the lab entity', '{"exposure":"ops"}', 'ops') RETURNING id INTO t1;
  INSERT INTO public.thought_entities (thought_id, entity_id, mention_role, source) VALUES (t1, e1, 'mentioned', 'lab');
  -- an expired gmail thought the prune deletes
  INSERT INTO public.thoughts (content, metadata, exposure)
    VALUES ('lab gmail to prune', '{"source":"gmail","gmail_id":"lab-gmail-1","email_date":"2001-01-01","exposure":"ops"}', 'ops') RETURNING id INTO tp;
  -- an owner-stamped personal thought (rw-inlet-owner's class): no door role may read it without a credential
  INSERT INTO public.thoughts (content, metadata, exposure, user_id) VALUES ('lab private thought of the operator', '{}', 'personal', 'lab-operator');
  INSERT INTO public.sources (url, title, content, content_type) VALUES ('https://lab.invalid/a', 'Lab source', 'lab source body', 'web_article') RETURNING id INTO s1;
  INSERT INTO public.threads (name, slug) VALUES ('Lab notebook', 'lab-notebook') RETURNING id INTO th;
  INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES ('content/tool/lab-wiki-page', 'entity', 'Lab Wiki Page', 'lab body', '[]');

  INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice) VALUES ('lab-voice', 'lab-operator', 'local', 'lab');
  INSERT INTO public.podcast_presenters (id, owner_sub, name, voice_link_id) VALUES ('lab-presenter', 'lab-operator', 'Lab Presenter', 'lab-voice');
  INSERT INTO public.podcast_teams (id, owner_sub, name) VALUES ('lab-team', 'lab-operator', 'Lab Team');
  INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ('lab-team', 0, 'lab-presenter');
  INSERT INTO public.podcast_render_requests (requester_sub, actor_sub, team_id, title, input)
    VALUES ('lab-operator', 'lab-operator', 'lab-team', 'Lab render', '{"lab":true}') RETURNING id INTO rr;

  INSERT INTO public.podcast_episodes (owner_sub, title, team_id, audio_format, archive_dir)
    VALUES ('lab-operator', 'Lab episode (seed)', 'lab-team', 'mp3', '/lab/seed') RETURNING id INTO ep;
  -- the operator's and the second user's settings; an idea of the operator's
  PERFORM public.user_setting_set('lab-operator', 'digest.window_hours', '48'::jsonb, 'lab-operator', NULL);
  PERFORM public.user_setting_set('lab-other', 'digest.window_hours', '6'::jsonb, 'lab-other', NULL);
  PERFORM public.user_setting_set('lab-operator', 'podcast.team', '"lab-team"'::jsonb, 'lab-operator', NULL);
  PERFORM public.idea_capture('lab-operator', 'lab-operator', 'Lab idea', 'a private idea of the operator', NULL, NULL);

  INSERT INTO lab.seed VALUES ('entity_id', e1), ('entity2_id', e2), ('thought_id', t1), ('prune_thought_id', tp),
    ('source_id', s1), ('thread_id', th), ('team_id', 'lab-team'), ('render_id', rr), ('wiki_slug', 'content/tool/lab-wiki-page'),
    ('notify_class', 'informational'), ('transcript_type', 'podcast_transcript'), ('episode_id', ep)
  ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;
