-- ============================================================
-- The research room store (research-workbench rw-p8a3-room, D2 / D17 item 3). Slot 340.
-- Chat IS the room (operator 2026-11-01): one per-user room store in the workbench; the room is the
-- conversation record of an idea (its refinery) or of a research session, and a scoped chat message is a
-- room entry. Mattermost is never read and never written from here (a thread that started a session is
-- its inlet, linked back from the session card). P7b's podcast-from-discussion and stance map read the
-- room transcript from these tables.
--   * workspace_rooms: one row per (owner, subject). owner_sub = the identity seam's subject; every read
--     and write in the workbench filters by it (another user's room answers 404). An idea has ONE room
--     (its owner's); a research session is shared knowledge, so each user keeps their own room on it.
--     The chat scope is per user and lives on the room: scope_enabled = false reads the whole knowledge
--     database; scope_enabled = true reads only scope_sources - an EMPTY list reads nothing (never the
--     whole vault). `draft` is the idea's accreting draft (written by rw-p8a4; empty until then).
--   * workspace_room_entries: the transcript, in order. kind 'user' / 'assistant' (the scoped chat) and
--     'dossier' (a refinery dossier delivered into the idea's room - rw-p8a4 writes it). `context` holds
--     the sources an assistant answer was given (ids and chunk indexes, never their text).
--   * idea_room(idea): the idea's room, created under the idea's owner when it is first asked for; NULL
--     for an idea with no such id. For rw-p8a4's dossier delivery and the workbench alike.
-- Service-role only, like slot 300: the workbench reads and writes these filtered by the caller's
-- subject, never another's. Additive and idempotent; no existing table changes. Fresh-volume slot 340;
-- live: psql -f BEFORE the new workbench image. Revert: revert-rooms.sql (discards every transcript).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.workspace_rooms (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub        TEXT NOT NULL,
    actor_sub        TEXT NOT NULL DEFAULT 'system:outside-seam',
    subject_kind     TEXT NOT NULL CHECK (subject_kind IN ('idea', 'session')),
    subject_id       UUID NOT NULL,
    scope_enabled    BOOLEAN NOT NULL DEFAULT false,
    scope_sources    UUID[] NOT NULL DEFAULT '{}',
    draft            TEXT NOT NULL DEFAULT '',
    draft_updated_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workspace_rooms_one_per_owner UNIQUE (owner_sub, subject_kind, subject_id),
    CONSTRAINT workspace_rooms_scope_size CHECK (cardinality(scope_sources) <= 200)
);
-- one long-lived room per idea (D17 item 5: `thread_root` bound to the room)
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_rooms_idea ON public.workspace_rooms (subject_id) WHERE subject_kind = 'idea';
CREATE INDEX IF NOT EXISTS idx_workspace_rooms_owner ON public.workspace_rooms (owner_sub, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.workspace_room_entries (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id    UUID NOT NULL REFERENCES public.workspace_rooms(id) ON DELETE CASCADE,
    seq        BIGINT GENERATED ALWAYS AS IDENTITY,
    actor_sub  TEXT NOT NULL DEFAULT 'system:outside-seam',
    kind       TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'dossier')),
    body       TEXT NOT NULL CHECK (length(body) <= 200000),
    -- [{"source_id": "<uuid>", "chunk": <idx>, "held": <bool>}] - what an answer was given; never text
    context    JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(context) = 'array'),
    meta       JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspace_room_entries_room ON public.workspace_room_entries (room_id, seq);

ALTER TABLE public.workspace_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_room_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_rooms_service_role_all ON public.workspace_rooms;
CREATE POLICY workspace_rooms_service_role_all ON public.workspace_rooms
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS workspace_room_entries_service_role_all ON public.workspace_room_entries;
CREATE POLICY workspace_room_entries_service_role_all ON public.workspace_room_entries
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.workspace_rooms TO service_role;
GRANT ALL ON public.workspace_room_entries TO service_role;

-- The idea's room (get or create), under the idea's owner. NULL = no such idea, or an idea with no owner.
CREATE OR REPLACE FUNCTION public.idea_room(p_idea_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner TEXT; v_id UUID;
BEGIN
    SELECT owner_sub INTO v_owner FROM public.ideas WHERE id = p_idea_id;
    IF v_owner IS NULL OR v_owner = '' THEN RETURN NULL; END IF;
    INSERT INTO public.workspace_rooms (owner_sub, actor_sub, subject_kind, subject_id)
    VALUES (v_owner, 'system:idea-room', 'idea', p_idea_id)
    ON CONFLICT DO NOTHING;
    SELECT id INTO v_id FROM public.workspace_rooms WHERE subject_kind = 'idea' AND subject_id = p_idea_id;
    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.idea_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.idea_room(UUID) TO service_role;
NOTIFY pgrst, 'reload schema';
