-- ============================================================
-- Cast editing (research-workbench redesign, rwr-cast-edit-api; plan 02-BUILD-PLAN.md phase 7).
--
-- What this file adds to slot 330's presenter model, and only this:
--   podcast_presenters   role, focus, stance, tone, speaking_style (how the presenter reads), system_prompt and
--                        system_prompt_mode (built: the renderer builds the presenter's lines from the fields; own:
--                        the owner's own text), notes (the owner's own: never shown to anyone else, never copied),
--                        shared (Q12: one shared pool every account sees), copied_from (a copy names its original).
--   podcast_teams        user_seat (where the user sits in the speaking order: 0 .. members), shared, copied_from.
--   podcast_formats      kind, use_for (what it is for), is_default (at most one per owner), shared, copied_from.
--   podcast_presenter_grounding  the presenter's grounded-in links, in order: a source (a shared source, or one of the
--                        owner's private sources) or a topic. Owner-scoped like every row of the model.
--   four registries (D18, never a closed list in a schema): podcast_format_kinds, podcast_format_uses,
--                        podcast_prompt_modes, podcast_grounding_kinds.
--
-- Every new column has a default that reads as "not set", so every existing row - the presenters captured from Open
-- Notebook, every team an episode or a render request names - renders exactly as before (the golden-script test,
-- recipes/daily-digest/src/podcast/cast-fields.test.ts). No row is changed, moved or deleted. No per-presenter model
-- route is added here: choosing a model per task is phase J (models, keys, egress), which the operator gated.
--
-- Privacy: a presenter's grounded-in link to a private source, its notes and every unshared row are the owner's
-- alone; the workbench reads them only through the identity seam's subject (contracts/repo/cast.ts). Nothing here
-- writes to a shared table (sources, claims, thoughts, the wiki), a trail or a log.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING); re-running it changes nothing. Fresh-volume slot 560 (after
-- 540, before 570); the live DB gets it by hand: a fresh backup, then psql -f BEFORE the new workbench and podcast
-- images (the podcast image reads the new columns and falls back to the old ones when they are missing). Revert:
-- revert-cast.sql (after the previous workbench and podcast images are back). Check: check-cast.sql.
-- ============================================================

INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('podcast_format_kinds',    'rwr-cast-edit-api', 'what shape an episode of a podcast format takes'),
    ('podcast_format_uses',     'rwr-cast-edit-api', 'what a podcast format is used for'),
    ('podcast_prompt_modes',    'rwr-cast-edit-api', 'how a presenter''s system prompt is made: built from its fields, or the owner''s own'),
    ('podcast_grounding_kinds', 'rwr-cast-edit-api', 'what a presenter''s grounded-in link points at')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('podcast_format_kinds', 'conversation', 'conversation', '{"meaning":"hosts talk it through together (every format before rwr-cast-edit-api)"}'),
    ('podcast_format_kinds', 'briefing',     'briefing',     '{"meaning":"a short run through the points"}'),
    ('podcast_format_kinds', 'debate',       'debate',       '{"meaning":"hosts take sides"}'),
    ('podcast_format_kinds', 'interview',    'interview',    '{"meaning":"one host asks, the others answer"}'),
    ('podcast_format_uses', 'daily',      'the daily episode',  '{}'),
    ('podcast_format_uses', 'research',   'a research run',     '{}'),
    ('podcast_format_uses', 'document',   'a document',         '{}'),
    ('podcast_format_uses', 'discussion', 'a live discussion',  '{}'),
    ('podcast_prompt_modes', 'built', 'built from the fields', '{"meaning":"the renderer writes the presenter''s lines from name, background, personality and the fields set"}'),
    ('podcast_prompt_modes', 'own',   'the owner''s own',      '{"meaning":"the renderer uses system_prompt as the presenter''s lines"}'),
    ('podcast_grounding_kinds', 'source', 'a source', '{"ref":"the source id: a shared source, or one of the owner''s private sources"}'),
    ('podcast_grounding_kinds', 'topic',  'a topic',  '{"ref":"the topic, as words"}')
ON CONFLICT (registry, key) DO NOTHING;

ALTER TABLE public.podcast_presenters
    ADD COLUMN IF NOT EXISTS role               TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS focus              TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS stance             TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS tone               TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS speaking_style     TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS system_prompt      TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS system_prompt_mode TEXT NOT NULL DEFAULT 'built',  -- registry podcast_prompt_modes
    ADD COLUMN IF NOT EXISTS notes              TEXT NOT NULL DEFAULT '',       -- the owner's alone: never shown or copied
    ADD COLUMN IF NOT EXISTS shared             BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS copied_from        TEXT;

ALTER TABLE public.podcast_teams
    ADD COLUMN IF NOT EXISTS user_seat   INT CHECK (user_seat IS NULL OR (user_seat >= 0 AND user_seat < 26)),  -- NULL = after the last
    ADD COLUMN IF NOT EXISTS shared      BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS copied_from TEXT;

ALTER TABLE public.podcast_formats
    ADD COLUMN IF NOT EXISTS kind        TEXT NOT NULL DEFAULT 'conversation',   -- registry podcast_format_kinds
    ADD COLUMN IF NOT EXISTS use_for     TEXT[] NOT NULL DEFAULT '{}',           -- keys of podcast_format_uses; {} = any
    ADD COLUMN IF NOT EXISTS is_default  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS shared      BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS copied_from TEXT;

CREATE TABLE IF NOT EXISTS public.podcast_presenter_grounding (
    presenter_id TEXT NOT NULL REFERENCES public.podcast_presenters (id) ON DELETE CASCADE,
    owner_sub    TEXT NOT NULL,
    position     INT NOT NULL CHECK (position >= 0 AND position < 100),
    kind         TEXT NOT NULL,   -- registry podcast_grounding_kinds
    ref          TEXT NOT NULL,   -- the source id, or the topic's words
    PRIMARY KEY (presenter_id, position)
);

CREATE INDEX IF NOT EXISTS idx_podcast_presenters_shared ON public.podcast_presenters (shared) WHERE shared;
CREATE INDEX IF NOT EXISTS idx_podcast_teams_shared ON public.podcast_teams (shared) WHERE shared;
CREATE INDEX IF NOT EXISTS idx_podcast_formats_shared ON public.podcast_formats (shared) WHERE shared;
CREATE UNIQUE INDEX IF NOT EXISTS uq_podcast_formats_default ON public.podcast_formats (owner_sub) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_podcast_presenter_grounding_owner ON public.podcast_presenter_grounding (owner_sub);

-- ── RLS + grants (the P0 shape, as slot 330) ───────────────────────────
ALTER TABLE public.podcast_presenter_grounding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS podcast_presenter_grounding_service_role_all ON public.podcast_presenter_grounding;
CREATE POLICY podcast_presenter_grounding_service_role_all ON public.podcast_presenter_grounding
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.podcast_presenter_grounding TO service_role;

NOTIFY pgrst, 'reload schema';
