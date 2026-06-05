-- P5 (TASKS 5.2) — content_type reference table + FK (replaces the inline CHECK
-- in init-sources.sql), so a new format is one INSERT, no DDL.
--
-- ⚠ Live-DB order matters: create table → seed existing + new values → drop the
-- old CHECK → add the FK (the FK-add FAILS if any value already in `sources` is
-- unseeded). On a fresh volume `sources` is empty so the seed is just the known
-- set; the SELECT-DISTINCT pass is the live-DB safety net. `find_or_create_source`'s
-- 'web_article' default stays valid.
--
-- Additive + idempotent (G2/G3).

CREATE TABLE IF NOT EXISTS public.content_types (
    value      TEXT PRIMARY KEY,
    label      TEXT,
    category   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1. Seed the existing CHECK set + the new P5 formats.
INSERT INTO public.content_types (value, label, category) VALUES
    ('web_article',        'Web article',         'web'),
    ('pdf',                'PDF',                 'document'),
    ('youtube_transcript', 'YouTube transcript',  'transcript'),
    ('podcast_transcript', 'Podcast transcript',  'transcript'),
    ('paper',              'Paper',               'document'),
    ('manual',             'Manual entry',        'manual'),
    ('research_synthesis', 'Research synthesis',  'synthesis'),
    ('docx',               'Word document',       'document'),
    ('pptx',               'Presentation',        'document'),
    ('image',              'Image',               'image'),
    ('audio',              'Audio / video (STT)', 'audio'),
    ('txt',                'Plain text',          'document'),
    ('md',                 'Markdown',            'document')
ON CONFLICT (value) DO NOTHING;

-- 2. Catch any value already present in `sources` we didn't list (live-DB
--    safety) so the FK-add below can never fail on an unseeded value.
INSERT INTO public.content_types (value, label, category)
SELECT DISTINCT content_type, content_type, 'legacy'
FROM public.sources
WHERE content_type IS NOT NULL
ON CONFLICT (value) DO NOTHING;

-- 3. Drop the old inline CHECK (Postgres auto-named it sources_content_type_check).
ALTER TABLE public.sources DROP CONSTRAINT IF EXISTS sources_content_type_check;

-- 4. Add the FK (ADD CONSTRAINT has no IF NOT EXISTS — guard with a catalog check).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_content_type_fkey') THEN
        ALTER TABLE public.sources
            ADD CONSTRAINT sources_content_type_fkey
            FOREIGN KEY (content_type) REFERENCES public.content_types(value);
    END IF;
END $$;
