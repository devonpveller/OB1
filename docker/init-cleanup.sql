-- ============================================================
-- The cleanup view's actions (research-workbench P8a, rw-p8a2-cleanup; D5 item 5).
--
-- What this file adds, and only this:
--   cleanup_actions   one row per action a user takes in the cleanup view: a sever (one connection
--                     or all), a manual erase, a lift, or a process-all run. owner_sub is the
--                     identity seam's subject_sub (whose action it is) and actor_sub who acted (an
--                     admin while impersonating); neither is ever a caller-supplied user.
--
-- Why a table: the D5 writes are SHARED knowledge (sources, their trail, the tombstones), but who
-- took a cleanup action is per-user front-end context (07-MULTI-USER). So the shared rows name the
-- action, never the user: the trail actor, the tombstone's eraser_user / lifted_by and a bulk run's
-- batch_run_id carry 'cleanup-action:<id>', and only the action's owner resolves that id (another
-- user's action by id is 404).
--
-- Idempotent (IF NOT EXISTS); re-running it changes nothing. Fresh-volume slot 340; the live DB gets
-- it by hand (psql -f, BEFORE the new workbench image). Revert: revert-cleanup.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cleanup_actions (
    id           UUID PRIMARY KEY,
    owner_sub    TEXT NOT NULL,
    actor_sub    TEXT NOT NULL,
    kind         TEXT NOT NULL,          -- sever | erase | lift | process_all
    reason_type  TEXT,                   -- erase and process_all: a key of the erasure_reasons registry
    source_id    UUID,                   -- sever / erase: the source acted on
    tombstone_id UUID,                   -- erase / lift: the tombstone made or lifted
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cleanup_actions_owner ON public.cleanup_actions (owner_sub, created_at DESC);

-- ── RLS + grants (the P0 shape) ─────────────────────────────────────────
ALTER TABLE public.cleanup_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cleanup_actions_service_role_all ON public.cleanup_actions;
CREATE POLICY cleanup_actions_service_role_all ON public.cleanup_actions FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.cleanup_actions TO service_role;

NOTIFY pgrst, 'reload schema';
