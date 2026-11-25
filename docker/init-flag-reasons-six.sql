-- ============================================================
-- Flag for cleanup: two more reasons (research-workbench redesign, rwr-flag-reasons-six; operator decision 2026-11-25).
--
-- What this file adds, and only this: two rows in the flag_reasons registry that init-flags.sql (slot 500) created --
-- 'outdated' and 'broken_link' -- so the dialog can offer the six reasons the approved Cleanup mockup shows (wrong claim,
-- low quality, duplicate, outdated, broken link, other). No table, column, policy or grant changes; existing flags are
-- untouched (their reasons are still registered). The route reads the registry, so no workbench code change is needed
-- for the server to accept them.
--
-- Idempotent (ON CONFLICT DO NOTHING); re-running it changes nothing. Needs slot 500 applied first. Fresh-volume slot 680
-- (660 is the latest taken on an in-flight branch); the live DB gets it by hand (psql -f, a fresh backup first).
-- Revert: revert-flag-reasons-six.sql. Check: check-flag-reasons-six.sql.
-- ============================================================

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('flag_reasons', 'outdated',     'outdated',     '{}'),
    ('flag_reasons', 'broken_link',  'broken link',  '{}')
ON CONFLICT (registry, key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
