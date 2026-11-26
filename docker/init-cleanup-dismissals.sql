-- ============================================================
-- Cleanup "Not again for this" (research-workbench redesign, rwr-cleanup; plan 02-BUILD-PLAN.md phase 5).
--
-- What this file adds, and only this:
--   cleanup_dismissals  one row per thing a person told Cleanup not to show them again: a reopen candidate
--                       (ref = the tombstone id) or a suggestion (ref = the scan's opaque key, rwr-cleanup-scan).
--                       owner_sub is the identity seam's subject_sub, never caller-supplied. A dismissal hides the
--                       thing for THAT person only; it changes nothing about the thing and nobody else's view.
--   dismissal_kinds     the registry of what can be dismissed (D18, never a closed list in a schema).
--
-- The ref is NOT checked against any shared table (no existence oracle: a dismissal is the person's own note).
-- Nothing here reads or writes sources / tombstones / claims, and no shared view, function or trail carries it.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING). Fresh-volume slot 700 (the latest earlier mount is 690);
-- the live DB gets it by hand (psql -f, BEFORE the new workbench image, a fresh backup first). Revert:
-- revert-cleanup-dismissals.sql.
-- ============================================================

INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('dismissal_kinds', 'rwr-cleanup', 'what a person can tell Cleanup not to show them again')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('dismissal_kinds', 'suggestion',       'a suggestion',       '{"ref":"the scan''s key for the suggestion"}'),
    ('dismissal_kinds', 'reopen_candidate', 'a reopen candidate', '{"ref":"the id of the erased source''s marker (tombstone)"}')
ON CONFLICT (registry, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.cleanup_dismissals (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub   TEXT NOT NULL,
    kind        TEXT NOT NULL,                  -- registry dismissal_kinds
    ref         TEXT NOT NULL,                  -- tombstone id / the scan's key
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_sub, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_cleanup_dismissals_owner ON public.cleanup_dismissals (owner_sub, created_at DESC);

ALTER TABLE public.cleanup_dismissals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cleanup_dismissals_service_role_all ON public.cleanup_dismissals;
CREATE POLICY cleanup_dismissals_service_role_all ON public.cleanup_dismissals FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON public.cleanup_dismissals TO service_role;

NOTIFY pgrst, 'reload schema';
