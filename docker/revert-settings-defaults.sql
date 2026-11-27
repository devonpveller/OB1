-- Revert init-settings-defaults.sql (rwr-settings-defaults, slot 730).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-settings-defaults.sql
-- Removes the eight user keys and every person's stored value of them, the stored admin research / curator limits (the services
-- read their env values again), the presets, the user ceiling, the audit log (THIS DISCARDS THE LOG: pg_dump
-- public.settings_admin_audit first if it matters), the triggers on user_settings and contract_settings and the functions of
-- slot 730; the thirteen admin keys' validation goes back to {}. After it the catalog is as after slots 400 + 490 + 550.
-- ORDER: put the PREVIOUS workbench image back FIRST (the new one calls settings_limits_current / settings_user_ceiling and
-- reads the audit table), then run this file, before the revert of 550 / 490 / 400. Idempotent: a second run changes nothing.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS trg_user_settings_rules ON public.user_settings;
DROP TRIGGER IF EXISTS trg_contract_settings_bounds ON public.contract_settings;
DROP TRIGGER IF EXISTS trg_contract_settings_audit ON public.contract_settings;
DROP TRIGGER IF EXISTS trg_contract_settings_no_truncate ON public.contract_settings;

-- the stored admin limits go (the triggers are gone, so the removal writes no log line into a table about to be dropped)
DELETE FROM public.contract_settings WHERE key IN (
    'research.max_fetch', 'research.max_fetch_timeouts', 'research.max_rounds', 'research.relevant_target', 'research.max_wall_ms',
    'research.search_k', 'research.confidence_floor', 'research.reuse_max_distance', 'research.kb_sources_k',
    'curator.shortlist_k', 'curator.new_thread_min_confidence', 'curator.merge_floor_distance', 'curator.conflict_distance');

DROP FUNCTION IF EXISTS public.settings_limits_apply(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.settings_limits_reset(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.settings_limits_current(TEXT);
DROP FUNCTION IF EXISTS public.admin_setting_clear(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.admin_setting_write(TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.trg_contract_settings_no_truncate();
DROP FUNCTION IF EXISTS public.trg_contract_settings_bounds();
DROP FUNCTION IF EXISTS public.trg_contract_settings_audit();
DROP FUNCTION IF EXISTS public.trg_user_settings_rules();
DROP FUNCTION IF EXISTS public.settings_user_ceiling(TEXT);

-- the tables first (their triggers depend on settings_admin_audit_no_edit), then that function
DROP TABLE IF EXISTS public.settings_audit_context;
DROP TABLE IF EXISTS public.settings_admin_audit;
DROP TABLE IF EXISTS public.settings_limit_preset_values;
DROP TABLE IF EXISTS public.settings_limit_presets;
DROP TABLE IF EXISTS public.settings_limit_groups;
DROP TABLE IF EXISTS public.settings_user_ceilings;
DROP FUNCTION IF EXISTS public.settings_admin_audit_no_edit();

DELETE FROM public.user_settings WHERE key IN (
    'research.default_depth', 'research.ask_over_fetch', 'library.how_far_out', 'library.recent_size', 'library.clear_on_signout',
    'library.hidden_suggestions', 'podcast.default_format', 'podcast.episode_minutes');
DELETE FROM public.user_setting_tombstones WHERE key IN (
    'research.default_depth', 'research.ask_over_fetch', 'library.how_far_out', 'library.recent_size', 'library.clear_on_signout',
    'library.hidden_suggestions', 'podcast.default_format', 'podcast.episode_minutes');
DELETE FROM public.settings_keys WHERE key IN (
    'research.default_depth', 'research.ask_over_fetch', 'library.how_far_out', 'library.recent_size', 'library.clear_on_signout',
    'library.hidden_suggestions', 'podcast.default_format', 'podcast.episode_minutes');

UPDATE public.settings_keys SET validation = '{}'::jsonb
 WHERE tier = 'admin' AND validation IS DISTINCT FROM '{}'::jsonb AND key IN (
    'research.max_fetch', 'research.max_fetch_timeouts', 'research.max_rounds', 'research.relevant_target', 'research.max_wall_ms',
    'research.search_k', 'research.confidence_floor', 'research.reuse_max_distance', 'research.kb_sources_k',
    'curator.shortlist_k', 'curator.new_thread_min_confidence', 'curator.merge_floor_distance', 'curator.conflict_distance');

COMMIT;
NOTIFY pgrst, 'reload schema';
