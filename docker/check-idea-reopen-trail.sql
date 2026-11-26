-- check-idea-reopen-trail.sql - rw-idea-reopen-trail (slot 690): is the trail table in the shape the workbench relies on?
-- Read-only; prints counts only, never a path or an id.
--   psql -X -A -t -q -f check-idea-reopen-trail.sql
-- Lines: "check: <rule>=<n>" (n = violations; 0 is good), then "check: OK" or "check: FAIL" naming the rules.
WITH r AS (
  SELECT 'idea_id_column_missing' AS what, (SELECT count(*) FROM (SELECT 1) x WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_document_trail' AND column_name = 'idea_id')) AS n
  UNION ALL SELECT 'path_still_not_null', (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.user_document_trail'::regclass AND attname = 'path' AND attnotnull)
  UNION ALL SELECT 'kind_check_without_reopened', (SELECT count(*) FROM (SELECT 1) x WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_document_trail'::regclass AND conname = 'user_document_trail_kind_check' AND pg_get_constraintdef(oid) LIKE '%reopened%'))
  UNION ALL SELECT 'shape_check_missing', (SELECT count(*) FROM (SELECT 1) x WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_document_trail'::regclass AND conname = 'user_document_trail_subject_check' AND convalidated))
  UNION ALL SELECT 'reopened_lines_with_text_or_path', (SELECT count(*) FROM jsonb_to_recordset(to_jsonb((SELECT coalesce(jsonb_agg(t), '[]') FROM public.user_document_trail t))) AS x(kind text, path text, document_id text, idea_id text) WHERE kind = 'reopened' AND (path IS NOT NULL OR document_id IS NOT NULL OR idea_id IS NULL))
  UNION ALL SELECT 'other_lines_with_idea_id_or_no_path', (SELECT count(*) FROM jsonb_to_recordset(to_jsonb((SELECT coalesce(jsonb_agg(t), '[]') FROM public.user_document_trail t))) AS x(kind text, path text, document_id text, idea_id text) WHERE kind <> 'reopened' AND (idea_id IS NOT NULL OR path IS NULL))
  UNION ALL SELECT 'service_role_extra_privileges', (SELECT count(*) FROM unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege('service_role', 'public.user_document_trail', p))
  UNION ALL SELECT 'append_only_triggers_missing', 3 - (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.user_document_trail'::regclass AND NOT tgisinternal AND tgenabled = 'O')
)
SELECT 'check: ' || what || '=' || n FROM r
UNION ALL SELECT 'check: ' || CASE WHEN (SELECT sum(n) FROM r) = 0 THEN 'OK' ELSE 'FAIL' END;
