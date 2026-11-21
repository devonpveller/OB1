-- ============================================================
-- Flag for cleanup (research-workbench redesign, rwr-flags-api; plan 02-BUILD-PLAN.md phase 5).
--
-- What this file adds, and only this:
--   user_flags   one row per flag a person raises on a source, a claim or a reference: "this is wrong /
--                low quality / a duplicate / other", an optional note, and where the flag was made from
--                (a document or a source). owner_sub is the identity seam's subject_sub (whose flag it is)
--                and actor_sub who acted (an admin while impersonating); neither is ever caller-supplied.
--   four registries (D18, never a closed list in a schema): flag_reasons (the four reasons),
--                flag_item_kinds (source | claim | reference), flag_from_kinds (document | source),
--                flag_states (open | withdrawn).
--
-- A flag changes NOTHING about the flagged item: no table of the shared knowledge is touched, no trigger
-- is placed on one, and nothing here reads or writes sources / claims / reference_records. The note is
-- per-user front-end context (07-MULTI-USER): it lives only here, and no shared view, function or trail
-- carries it. A person reads their own flags; an admin reads all of them.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING); re-running it changes nothing. Fresh-volume slot 500
-- (470 is the latest of the earlier chain; 450 is reserved for rw-rest-door-auth); the live DB gets it by
-- hand (psql -f, BEFORE the new workbench image, a fresh backup first). Revert: revert-flags.sql.
-- ============================================================

INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('flag_reasons',    'rwr-flags-api', 'why a source, claim or reference is flagged for cleanup'),
    ('flag_item_kinds', 'rwr-flags-api', 'what can be flagged for cleanup'),
    ('flag_from_kinds', 'rwr-flags-api', 'where a flag was made from: a document or a source'),
    ('flag_states',     'rwr-flags-api', 'the state of a flag (a flag never changes the flagged item)')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('flag_reasons', 'wrong_claim',  'wrong claim',  '{}'),
    ('flag_reasons', 'low_quality',  'low quality',  '{}'),
    ('flag_reasons', 'duplicate',    'duplicate',    '{}'),
    ('flag_reasons', 'other',        'other',        '{}'),
    ('flag_item_kinds', 'source',    'a source',     '{}'),
    ('flag_item_kinds', 'claim',     'a claim',      '{}'),
    ('flag_item_kinds', 'reference', 'a reference',  '{}'),
    ('flag_from_kinds', 'document',  'a document',   '{"ref":"the vault path of the document the flag was made in"}'),
    ('flag_from_kinds', 'source',    'a source',     '{"ref":"the id of the source screen the flag was made on"}'),
    ('flag_states', 'open',      'open',      '{"meaning":"raised, waiting for a person to decide"}'),
    ('flag_states', 'withdrawn', 'withdrawn', '{"meaning":"taken back by the person who raised it"}')
ON CONFLICT (registry, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.user_flags (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub   TEXT NOT NULL,
    actor_sub   TEXT NOT NULL,
    item_kind   TEXT NOT NULL,                  -- registry flag_item_kinds
    item_id     UUID NOT NULL,                  -- the source / claim / reference record id (never changed by a flag)
    reason      TEXT NOT NULL,                  -- registry flag_reasons
    note        TEXT NOT NULL DEFAULT '',       -- per-user: never copied to a shared row, view or log
    from_kind   TEXT NOT NULL,                  -- registry flag_from_kinds
    from_ref    TEXT NOT NULL,                  -- the document path / source id it was made from
    state       TEXT NOT NULL DEFAULT 'open',   -- registry flag_states
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_flags_owner ON public.user_flags (owner_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_flags_item ON public.user_flags (item_kind, item_id);

-- ── RLS + grants (the P0 shape) ─────────────────────────────────────────
ALTER TABLE public.user_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_flags_service_role_all ON public.user_flags;
CREATE POLICY user_flags_service_role_all ON public.user_flags FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.user_flags TO service_role;

NOTIFY pgrst, 'reload schema';
