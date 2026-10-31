-- ============================================================
-- Podcasts - the presenter model and render requests (research-workbench P7a, rw-p7a-tts).
--
-- What this file adds, and only this:
--   1. podcast_voice_links    how a presenter sounds: a LiteLLM route (gateway model name), a voice
--                             of that route, a speed. Changing a link re-voices only that presenter.
--   2. podcast_presenters     a named voice with a personality and a backstory.
--   3. podcast_teams          an ordered cast; podcast_team_members holds the order (position 0 speaks
--                             a script's HOST A lines, 1 HOST B, ...).
--   4. podcast_formats        how an episode of a team is shaped (briefing, segments, language, the
--                             LiteLLM route that writes the script).
--   5. podcast_render_requests  a render somebody asked for: requester_sub is the identity seam's
--                             subject_sub (never a caller-supplied user); only that subject sees it.
--   6. podcast_episodes       NEW renders (origin 'render'): what the P7b library lists. Episodes
--                             archived from Open Notebook are NOT rows: they exist only as files in
--                             the archive folder (sidecar origin 'on-archive'), so no library, panel
--                             or search can offer them.
-- Every row carries owner_sub (07-MULTI-USER: podcast prompting and requests are private; profiles
-- captured from Open Notebook are owned by WORKSPACE_DEFAULT_SUB). `origin` records where a row
-- came from ('operator' configured it, 'on-capture' mapped it from an ON profile; origin_ref then
-- names the ON record id).
-- Idempotent (IF NOT EXISTS); re-running it changes nothing. Fresh-volume slot 310; the live DB
-- gets it by hand (psql -f, before the new images). Revert: revert-podcasts.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.podcast_voice_links (
    id          TEXT PRIMARY KEY,
    owner_sub   TEXT NOT NULL,
    route       TEXT NOT NULL,
    voice       TEXT NOT NULL,
    speed       REAL NOT NULL DEFAULT 1.0 CHECK (speed > 0.25 AND speed <= 4.0),
    origin      TEXT NOT NULL DEFAULT 'operator' CHECK (origin IN ('operator', 'on-capture')),
    origin_ref  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.podcast_presenters (
    id            TEXT PRIMARY KEY,
    owner_sub     TEXT NOT NULL,
    name          TEXT NOT NULL,
    personality   TEXT NOT NULL DEFAULT '',
    backstory     TEXT NOT NULL DEFAULT '',
    language      TEXT NOT NULL DEFAULT 'en-US',
    voice_link_id TEXT NOT NULL REFERENCES public.podcast_voice_links (id),
    origin        TEXT NOT NULL DEFAULT 'operator' CHECK (origin IN ('operator', 'on-capture')),
    origin_ref    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.podcast_teams (
    id          TEXT PRIMARY KEY,
    owner_sub   TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    origin      TEXT NOT NULL DEFAULT 'operator' CHECK (origin IN ('operator', 'on-capture')),
    origin_ref  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_sub, name)
);

CREATE TABLE IF NOT EXISTS public.podcast_team_members (
    team_id      TEXT NOT NULL REFERENCES public.podcast_teams (id) ON DELETE CASCADE,
    position     INT NOT NULL CHECK (position >= 0 AND position < 26),
    presenter_id TEXT NOT NULL REFERENCES public.podcast_presenters (id),
    PRIMARY KEY (team_id, position)
);

CREATE TABLE IF NOT EXISTS public.podcast_formats (
    id           TEXT PRIMARY KEY,
    owner_sub    TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    team_id      TEXT NOT NULL REFERENCES public.podcast_teams (id),
    briefing     TEXT NOT NULL DEFAULT '',
    segments     INT NOT NULL DEFAULT 5 CHECK (segments > 0),
    language     TEXT NOT NULL DEFAULT 'en-US',
    script_route TEXT NOT NULL DEFAULT 'local-large',
    origin       TEXT NOT NULL DEFAULT 'operator' CHECK (origin IN ('operator', 'on-capture')),
    origin_ref   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_sub, name)
);

CREATE TABLE IF NOT EXISTS public.podcast_episodes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub    TEXT NOT NULL,
    shared       BOOLEAN NOT NULL DEFAULT false,
    origin       TEXT NOT NULL DEFAULT 'render' CHECK (origin = 'render'),
    title        TEXT NOT NULL,
    team_id      TEXT REFERENCES public.podcast_teams (id),
    audio_format TEXT NOT NULL,
    seconds      REAL,
    archive_dir  TEXT NOT NULL,
    request_id   UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.podcast_render_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_sub TEXT NOT NULL,
    actor_sub     TEXT NOT NULL,
    team_id       TEXT NOT NULL REFERENCES public.podcast_teams (id),
    title         TEXT NOT NULL,
    input         JSONB NOT NULL,          -- the request itself (private: the requester's prompting)
    state         TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'rendering', 'done', 'failed')),
    episode_id    UUID REFERENCES public.podcast_episodes (id),
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_podcast_voice_links_owner ON public.podcast_voice_links (owner_sub);
CREATE INDEX IF NOT EXISTS idx_podcast_presenters_owner ON public.podcast_presenters (owner_sub);
CREATE INDEX IF NOT EXISTS idx_podcast_teams_owner ON public.podcast_teams (owner_sub);
CREATE INDEX IF NOT EXISTS idx_podcast_formats_owner ON public.podcast_formats (owner_sub);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_owner ON public.podcast_episodes (owner_sub);
CREATE INDEX IF NOT EXISTS idx_podcast_render_requests_requester ON public.podcast_render_requests (requester_sub);

-- podcasts(), presenters() and teams() are backed now: their not_implemented entries are retired
-- (a retired entry stays readable and is never reused; P0's registry rule).
UPDATE public.contract_registry_entries SET retired_at = now()
 WHERE registry = 'implementation_states' AND key IN ('podcasts', 'presenters', 'teams') AND retired_at IS NULL;

-- ── RLS + grants (the P0 shape) ─────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['podcast_voice_links', 'podcast_presenters', 'podcast_teams', 'podcast_team_members',
                             'podcast_formats', 'podcast_episodes', 'podcast_render_requests'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role_all', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role_all', t);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
