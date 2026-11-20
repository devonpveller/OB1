-- plant-legacy.sql - rw-inlet-stamp's lab: the state before PD1's deploy - personal thoughts of every inlet with no
-- owner, as the live database holds them (gmail ops + personal, google_activity, chatgpt, mcp, agent-memory, a vault
-- note), each carrying the legacy marker. Slot 440 then gives them the operator's subject; slot 470 comes after it.
--   psql -v ON_ERROR_STOP=1 -v mark=<marker> -f plant-legacy.sql
INSERT INTO public.thoughts (content, metadata, exposure)
SELECT 'legacy ' || s.src || ' ' || :'mark', jsonb_build_object('source', s.src, 'exposure', s.exp, 'lab_legacy', true) || s.extra, s.exp
  FROM (VALUES ('gmail', 'ops', jsonb_build_object('gmail_id', 'legacy0001', 'gmail_labels', jsonb_build_array('INBOX'), 'email_date', '2026-01-01T00:00:00Z')),
               ('gmail', 'personal', jsonb_build_object('gmail_id', 'legacy0002', 'gmail_labels', jsonb_build_array('INBOX'), 'email_date', '2026-01-02T00:00:00Z')),
               ('google_activity', 'ops', '{}'::jsonb),
               ('chatgpt', 'ops', '{}'::jsonb),
               ('mcp', 'ops', '{}'::jsonb),
               ('agent-memory', 'ops', '{}'::jsonb),
               ('ai_note', 'ops', jsonb_build_object('note_path', 'content/notebooks/lab/legacy.md'))) AS s(src, exp, extra);
