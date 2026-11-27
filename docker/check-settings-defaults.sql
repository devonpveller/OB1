-- check-settings-defaults.sql - rwr-settings-defaults (slot 730): is the settings catalog in the shape the workbench relies on?
-- Read-only; prints counts only, never a value of a person.
--   psql -X -A -t -q -f check-settings-defaults.sql
-- Lines: "check: <rule>=<n>" (n = violations; 0 is good), then "check: OK" or "check: FAIL".
WITH r AS (
  SELECT 'user_keys_missing' AS what, 8 - (SELECT count(*) FROM public.settings_keys WHERE tier = 'user' AND key IN (
      'research.default_depth', 'research.ask_over_fetch', 'library.how_far_out', 'library.recent_size', 'library.clear_on_signout',
      'library.hidden_suggestions', 'podcast.default_format', 'podcast.episode_minutes')) AS n
  UNION ALL SELECT 'key_without_tag', (SELECT count(*) FROM public.settings_keys WHERE tag IS NULL)
  UNION ALL SELECT 'admin_limit_without_range', (SELECT count(*) FROM public.settings_keys k WHERE k.key IN (
      'research.max_fetch', 'research.max_fetch_timeouts', 'research.max_rounds', 'research.relevant_target', 'research.max_wall_ms',
      'research.search_k', 'research.confidence_floor', 'research.reuse_max_distance', 'research.kb_sources_k',
      'curator.shortlist_k', 'curator.new_thread_min_confidence', 'curator.merge_floor_distance', 'curator.conflict_distance')
      AND NOT (k.validation ? 'min' AND k.validation ? 'max'))
  UNION ALL SELECT 'admin_limit_editable', (SELECT count(*) FROM public.settings_keys WHERE tier = 'admin' AND store = 'settings' AND editable)
  UNION ALL SELECT 'preset_value_out_of_range', (SELECT count(*) FROM public.settings_limit_preset_values v WHERE public.setting_problem(NULL, v.key, v.value) IS NOT NULL)
  UNION ALL SELECT 'group_presets_name_different_keys', (SELECT count(*) FROM public.settings_limit_presets p
      WHERE (SELECT count(*) FROM public.settings_limit_preset_values v WHERE v.grp = p.grp AND v.preset = p.preset)
         <> (SELECT count(DISTINCT v.key) FROM public.settings_limit_preset_values v WHERE v.grp = p.grp))
  UNION ALL SELECT 'stored_limit_outside_range', (SELECT count(*) FROM public.contract_settings c JOIN public.settings_keys k ON k.key = c.key
      WHERE k.tier = 'admin' AND k.store = 'settings' AND public.setting_problem(NULL, c.key, c.value) IS NOT NULL)
  UNION ALL SELECT 'audit_privileges_extra', (SELECT count(*) FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      WHERE has_table_privilege('service_role', 'public.settings_admin_audit', p) OR has_table_privilege('ob_workbench', 'public.settings_admin_audit', p))
  UNION ALL SELECT 'audit_triggers_missing', 3 - (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.settings_admin_audit'::regclass AND NOT tgisinternal AND tgenabled = 'O')
  UNION ALL SELECT 'limit_writers_not_workbench_only', (SELECT count(*) FROM unnest(ARRAY['public.settings_limits_apply(text,text,text)',
      'public.settings_limits_reset(text,text)', 'public.admin_setting_clear(text,text)', 'public.admin_setting_write(text,text,jsonb)']) f
      WHERE has_function_privilege('service_role', f, 'EXECUTE') OR NOT has_function_privilege('ob_workbench', f, 'EXECUTE'))
  UNION ALL SELECT 'audit_context_privileges', (SELECT count(*) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      WHERE has_table_privilege('service_role', 'public.settings_audit_context', p) OR has_table_privilege('ob_workbench', 'public.settings_audit_context', p))
  UNION ALL SELECT 'contract_settings_truncate_not_refused', 1 - (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.contract_settings'::regclass AND tgname = 'trg_contract_settings_no_truncate' AND NOT tgisinternal AND tgenabled = 'O' AND (tgtype & 32) = 32 AND (tgtype & 1) = 0)
  UNION ALL SELECT 'limit_triggers_missing', 3 - (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
      AND ((tgrelid = 'public.contract_settings'::regclass AND tgname IN ('trg_contract_settings_bounds', 'trg_contract_settings_audit'))
        OR (tgrelid = 'public.user_settings'::regclass AND tgname = 'trg_user_settings_rules')))
)
SELECT 'check: ' || what || '=' || n FROM r
UNION ALL SELECT 'check: ' || CASE WHEN (SELECT sum(n) FROM r) = 0 THEN 'OK' ELSE 'FAIL' END;
