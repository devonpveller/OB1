-- D29/D30 (2026-10-15): only operator-written notes under notes/ and ai_note (D29) are internal.
-- Synthetic fixture rows for run_db_tests.py, loaded BEFORE init-intake.sql on a THROWAWAY
-- database. Nothing here is live data: every row is invented to stand for one origin marker
-- a real writer stamps today (writer inventory: init-intake.sql section 3).
-- Each row carries metadata.fixture = <tag>; the runner reads the `-- expect <tag> <label>`
-- lines below and compares them with what the backfill wrote.
\set ON_ERROR_STOP 1
BEGIN;
-- A schema-only dump has an EMPTY content_types table; sources.content_type references it.
INSERT INTO public.content_types (value, label, category) VALUES
  ('web_article','Web article','web'), ('pdf','PDF','document'), ('manual','Manual','manual'),
  ('research_synthesis','Research synthesis','synthesis'),
  ('podcast_transcript','Podcast transcript','transcript')
ON CONFLICT DO NOTHING;

-- ---- sources ------------------------------------------------------------------------------
-- expect src-synthesis unscreened
-- expect src-podcast unscreened
-- expect ext-web unscreened
-- expect ext-gmail unscreened
-- expect src-research-stage unscreened
-- expect src-backfiller unscreened
-- expect src-upload unscreened
-- expect src-open-notebook-manual unscreened
-- expect src-nomarker unscreened
-- expect src-synthesis-with-url unscreened
-- expect src-synthesis-wrong-source unscreened
-- expect src-podcast-no-episode unscreened
-- expect src-podcast-via-capture unscreened
INSERT INTO public.sources (url, title, content, content_type, research_key, metadata) VALUES
 (NULL, 's1', 'synthesis body', 'research_synthesis', 'rk-1', '{"fixture":"src-synthesis","source":"deep-research","claim":"c"}'),
 ('https://on.example.test/ep1.mp3', 's2', 'our podcast script', 'podcast_transcript', NULL, '{"fixture":"src-podcast","source":"daily-digest-podcast","episode":"e1"}'),
 ('https://example.test/a', 's3', 'web page', 'web_article', NULL, '{"fixture":"ext-web","source":"ingest_url"}'),
 ('https://example.test/b', 's4', 'web page b', 'web_article', NULL, '{"fixture":"ext-gmail","source":"deep-research-source","gmail_id":"g1"}'),
 ('https://example.test/c', 's5', 'staged', 'web_article', NULL, '{"fixture":"src-research-stage","source":"research-stage"}'),
 ('https://en.wikipedia.org/wiki/X', 's6', 'wiki', 'web_article', NULL, '{"fixture":"src-backfiller","source":"grounding_backfiller"}'),
 (NULL, 's7', 'uploaded pdf text', 'pdf', NULL, '{"fixture":"src-upload","source_format":"pdf"}'),
 (NULL, 's8', 'pasted', 'manual', NULL, '{"fixture":"src-open-notebook-manual","source":"open_notebook"}'),
 ('https://example.test/d', 's9', 'no markers', 'web_article', NULL, '{"fixture":"src-nomarker"}'),
 ('https://example.test/e', 's10', 'forged', 'research_synthesis', 'rk-2', '{"fixture":"src-synthesis-with-url","source":"deep-research"}'),
 (NULL, 's11', 'forged', 'research_synthesis', 'rk-3', '{"fixture":"src-synthesis-wrong-source","source":"capture_with_thread"}'),
 ('https://on.example.test/ep2.mp3', 's12', 'x', 'podcast_transcript', NULL, '{"fixture":"src-podcast-no-episode","source":"daily-digest-podcast"}'),
 ('https://example.test/f', 's13', 'x', 'podcast_transcript', NULL, '{"fixture":"src-podcast-via-capture","source":"capture_with_thread","episode":"e9"}');
-- Make updated_at distinguishable from now(), so a backfill that fired trg_sources_touch shows.
UPDATE public.sources SET updated_at = '2026-01-01T00:00:00Z' WHERE metadata ? 'fixture';

-- ---- thoughts -----------------------------------------------------------------------------
-- expect th-capture-ops unscreened
-- expect th-personal unscreened
-- expect th-idea unscreened
-- expect th-agent-memory unscreened
-- expect th-agent-org unscreened
-- expect th-user-note internal
-- expect th-ai-note internal
-- expect th-dossier unscreened
-- expect th-gmail-wiki unscreened
-- expect th-agent-memory-no-workspace unscreened
-- expect th-agent_memory-underscore unscreened
-- expect th-gmail unscreened
-- expect th-mcp-with-gmail-id unscreened
-- expect th-mcp-with-url unscreened
-- expect th-chatgpt unscreened
-- expect th-obsidian unscreened
-- expect th-nomarker unscreened
-- expect th-type-reference-only unscreened
-- expect th-dossier-other-generator unscreened
-- expect th-user-note-in-ai-tree unscreened
-- expect th-mcp-cloud unscreened
-- expect th-ai-note-no-path unscreened
INSERT INTO public.thoughts (content, exposure, user_id, metadata) VALUES
 ('t1', 'ops', NULL, '{"fixture":"th-capture-ops","source":"mcp","type":"observation","exposure":"ops"}'),
 ('t2', 'personal', 'u-test', '{"fixture":"th-personal","source":"mcp","exposure":"personal"}'),
 ('t3', 'ops', NULL, '{"fixture":"th-idea","source":"mcp","kind":"idea","type":"idea","exposure":"ops"}'),
 ('t4', 'ops', NULL, '{"fixture":"th-agent-memory","source":"agent-memory","workspace_id":"w1","exposure":"ops"}'),
 ('t5', 'ops', NULL, '{"fixture":"th-agent-org","source":"agent-org","event_id":7,"exposure":"ops"}'),
 ('t6', 'ops', NULL, '{"fixture":"th-user-note","source":"user_note","note_path":"notes/a.md","exposure":"ops"}'),
 ('t7', 'ops', NULL, '{"fixture":"th-ai-note","source":"ai_note","note_path":"content/b.md","exposure":"ops"}'),
 ('t8', 'ops', NULL, '{"fixture":"th-dossier","type":"dossier","generated_by":"recipes/entity-wiki/generate-wiki.mjs","exposure":"ops"}'),
 ('t9', 'ops', NULL, '{"fixture":"th-gmail-wiki","type":"reference","source_type":"gmail_wiki","gmail":{"thread_id":"x"},"exposure":"ops"}'),
 ('t10', 'ops', NULL, '{"fixture":"th-agent-memory-no-workspace","source":"agent-memory","exposure":"ops"}'),
 ('t11', 'ops', NULL, '{"fixture":"th-agent_memory-underscore","source":"agent_memory","workspace_id":"w","exposure":"ops"}'),
 ('t12', 'personal', 'u-test', '{"fixture":"th-gmail","source":"gmail","gmail_id":"g","exposure":"personal"}'),
 ('t13', 'ops', NULL, '{"fixture":"th-mcp-with-gmail-id","source":"mcp","gmail_id":"g2","exposure":"ops"}'),
 ('t14', 'ops', NULL, '{"fixture":"th-mcp-with-url","source":"mcp","url":"https://example.test/z","exposure":"ops"}'),
 ('t15', 'ops', NULL, '{"fixture":"th-chatgpt","source":"chatgpt","exposure":"ops"}'),
 ('t16', 'ops', NULL, '{"fixture":"th-obsidian","source":"obsidian","exposure":"ops"}'),
 ('t17', 'ops', NULL, '{"fixture":"th-nomarker","exposure":"ops"}'),
 ('t18', 'ops', NULL, '{"fixture":"th-type-reference-only","type":"reference","exposure":"ops"}'),
 ('t19', 'ops', NULL, '{"fixture":"th-dossier-other-generator","type":"dossier","generated_by":"elsewhere","exposure":"ops"}'),
 ('t20', 'ops', NULL, '{"fixture":"th-user-note-in-ai-tree","source":"user_note","note_path":"content/notebooks/x/y.md","exposure":"ops"}'),
 ('t21', 'ops', NULL, '{"fixture":"th-mcp-cloud","source":"mcp","origin":"cloud","share":"cloud","exposure":"ops"}'),
 ('t22', 'ops', NULL, '{"fixture":"th-ai-note-no-path","source":"ai_note","exposure":"ops"}');
UPDATE public.thoughts SET updated_at = '2026-01-01T00:00:00Z' WHERE metadata ? 'fixture';
COMMIT;
