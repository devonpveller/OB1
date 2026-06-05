-- ============================================================
-- Research threads, sessions, joins, and source dedup.
--
-- The net-new schema for the Integrated Knowledge System
-- (concept §5 / implementation plan Phase 1). Adds the
-- cross-tool organising primitives on top of the existing
-- `sources` table:
--
--   threads          — durable, named lines of inquiry
--   thread_sources   — M:N source↔thread join (link_type + status
--                       lifecycle: automatic|suggested|deliberate ×
--                       confirmed|pending|hidden|inactive)
--   sessions         — ephemeral provenance records (owui / ON / manual)
--   session_sources  — M:N source↔session join ("where did this come from?")
--
-- Plus:
--   sources.content_hash  — dedup key (additive column, Phase 1.2)
--   find_or_create_source — dedup-aware insert (Phase 1.3)
--   link_source_to_thread / set_thread_source_status — lifecycle
--     helpers (Phase 1.4); all upsert/flag, NEVER delete.
--
-- Conventions mirror init-sources.sql / init-source-graph.sql:
--   * Idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
--   * *_touch_updated_at trigger for updated_at.
--   * RLS enabled; service_role FOR ALL, authenticated SELECT.
--   * NO DROP TABLE / TRUNCATE / unqualified DELETE (OB1 guardrail).
--
-- Ordered to run AFTER init-sources.sql (sources must exist) and after
-- init-grants.sql so the explicit grants below are additive. Mounted in
-- compose as 70-init-threads.sql.
--
-- NOTE on ON DELETE CASCADE for source_id FKs: this mirrors the repo
-- convention (source_extraction_queue / source_entities). Durable links
-- depend on sources NOT being deleted out from under them — see audit C1
-- / Phase 3.0, which replaces the /research/persist hard-DELETE with
-- find_or_create_source so source ids are stable across re-runs.
-- ============================================================

-- ── 1.2 — extend sources with a dedup hash (additive, allowed) ─────────
ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_sources_content_hash ON public.sources (content_hash);

-- ── threads ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.threads (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','archived')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_threads_status ON public.threads (status);

CREATE OR REPLACE FUNCTION public.threads_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_threads_touch ON public.threads;
CREATE TRIGGER trg_threads_touch
    BEFORE UPDATE ON public.threads
    FOR EACH ROW EXECUTE FUNCTION public.threads_touch_updated_at();

-- ── thread_sources (M:N; one logical link per pair, status = lifecycle) ─
CREATE TABLE IF NOT EXISTS public.thread_sources (
    thread_id         UUID NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
    source_id         UUID NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
    link_type         TEXT NOT NULL DEFAULT 'automatic'
        CHECK (link_type IN ('automatic','suggested','deliberate')),
    status            TEXT NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('confirmed','pending','hidden','inactive')),
    suggestion_reason TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at      TIMESTAMPTZ,
    PRIMARY KEY (thread_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_sources_thread_status
    ON public.thread_sources (thread_id, status);
CREATE INDEX IF NOT EXISTS idx_thread_sources_source
    ON public.thread_sources (source_id);
CREATE INDEX IF NOT EXISTS idx_thread_sources_pending
    ON public.thread_sources (status) WHERE status = 'pending';

-- ── sessions (provenance; light audit records) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    origin_tool TEXT NOT NULL DEFAULT 'manual'
        CHECK (origin_tool IN ('owui','open_notebook','manual')),
    query_text  TEXT,
    -- nullable: sessions started outside a thread land in the inbox.
    -- SET NULL (not CASCADE): keep the provenance record if a thread is
    -- archived/removed.
    thread_id   UUID REFERENCES public.threads(id) ON DELETE SET NULL,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_thread     ON public.sessions (thread_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON public.sessions (created_at DESC);

-- ── session_sources (M:N) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.session_sources (
    session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    source_id  UUID NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_session_sources_source ON public.session_sources (source_id);

-- ============================================================
-- 1.3 — find_or_create_source: dedup-aware insert.
--   Match on url OR content_hash (whichever is provided/non-null).
--   If found, return existing id + was_duplicate=true (caller links to
--   thread/session). Else insert and return was_duplicate=false.
--   content_hash defaults to md5(content) when the caller omits it, so
--   dedup works even for content-only (no-URL) ingests.
--   Embeddings are computed in the app layer; pass them in (or NULL and
--   let the source-extraction worker / a backfill populate later).
-- ============================================================
CREATE OR REPLACE FUNCTION public.find_or_create_source(
    p_url          TEXT,
    p_content      TEXT,
    p_content_hash TEXT          DEFAULT NULL,
    p_title        TEXT          DEFAULT '',
    p_content_type TEXT          DEFAULT 'web_article',
    p_notebook     TEXT          DEFAULT NULL,
    p_domain       TEXT          DEFAULT NULL,
    p_embedding    VECTOR(1024)  DEFAULT NULL,
    p_metadata     JSONB         DEFAULT '{}'::jsonb
)
RETURNS TABLE (id UUID, was_duplicate BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
    v_hash TEXT := COALESCE(
        NULLIF(p_content_hash, ''),
        CASE WHEN COALESCE(p_content, '') <> '' THEN md5(p_content) ELSE NULL END
    );
    v_id   UUID;
BEGIN
    -- Prefer the oldest existing match so re-ingests fold into the
    -- canonical row (stable id — audit C1 / Phase 3.0).
    SELECT s.id INTO v_id
    FROM public.sources s
    WHERE (COALESCE(p_url, '') <> '' AND s.url = p_url)
       OR (v_hash IS NOT NULL AND s.content_hash = v_hash)
    ORDER BY s.created_at ASC
    LIMIT 1;

    IF v_id IS NOT NULL THEN
        -- Backfill content_hash on the existing row if it was missing
        -- (older rows predate the column). Never mutate content here.
        UPDATE public.sources
           SET content_hash = v_hash
         WHERE public.sources.id = v_id
           AND public.sources.content_hash IS NULL
           AND v_hash IS NOT NULL;
        id := v_id; was_duplicate := TRUE;
        RETURN NEXT;
        RETURN;
    END IF;

    INSERT INTO public.sources
        (url, title, content, content_type, notebook, domain,
         content_hash, embedding, metadata)
    VALUES
        (NULLIF(p_url, ''), COALESCE(p_title, ''), COALESCE(p_content, ''),
         p_content_type, p_notebook, p_domain,
         v_hash, p_embedding, COALESCE(p_metadata, '{}'::jsonb))
    RETURNING public.sources.id INTO v_id;

    id := v_id; was_duplicate := FALSE;
    RETURN NEXT;
END;
$$;

-- ============================================================
-- 1.4 — lifecycle helpers (thin; upsert/flag, never delete).
-- ============================================================

-- Create (or re-activate) a thread↔source link. Additive: never
-- downgrades a confirmed link, never deletes. Used for automatic
-- (capture), deliberate (add_to_thread), and suggested (worker) links.
CREATE OR REPLACE FUNCTION public.link_source_to_thread(
    p_thread_id UUID,
    p_source_id UUID,
    p_link_type TEXT DEFAULT 'deliberate',
    p_reason    TEXT DEFAULT NULL,
    p_status    TEXT DEFAULT 'confirmed'
)
RETURNS public.thread_sources
LANGUAGE plpgsql
AS $$
DECLARE
    v_row public.thread_sources;
BEGIN
    IF p_link_type NOT IN ('automatic','suggested','deliberate') THEN
        RAISE EXCEPTION 'invalid link_type %', p_link_type;
    END IF;
    IF p_status NOT IN ('confirmed','pending','hidden','inactive') THEN
        RAISE EXCEPTION 'invalid status %', p_status;
    END IF;

    INSERT INTO public.thread_sources
        (thread_id, source_id, link_type, status, suggestion_reason, confirmed_at)
    VALUES
        (p_thread_id, p_source_id, p_link_type, p_status, p_reason,
         CASE WHEN p_status = 'confirmed' THEN now() ELSE NULL END)
    ON CONFLICT (thread_id, source_id) DO UPDATE SET
        -- Re-activate a soft-removed link; otherwise keep the stronger
        -- state (never confirmed -> pending). A fresh confirmed link
        -- always wins (e.g. accepting a prior suggestion).
        status = CASE
            WHEN public.thread_sources.status = 'inactive' THEN EXCLUDED.status
            WHEN EXCLUDED.status = 'confirmed'             THEN 'confirmed'
            ELSE public.thread_sources.status
        END,
        link_type = CASE
            WHEN public.thread_sources.status = 'inactive' THEN EXCLUDED.link_type
            WHEN EXCLUDED.status = 'confirmed'             THEN EXCLUDED.link_type
            ELSE public.thread_sources.link_type
        END,
        suggestion_reason =
            COALESCE(public.thread_sources.suggestion_reason, EXCLUDED.suggestion_reason),
        confirmed_at = COALESCE(
            public.thread_sources.confirmed_at,
            CASE WHEN EXCLUDED.status = 'confirmed'
                   OR public.thread_sources.status = 'inactive' AND EXCLUDED.status = 'confirmed'
                 THEN now() ELSE NULL END)
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

-- Flip a thread↔source status (accept / hide / restore / soft-unlink).
-- Implements the §4.3 state machine. Never deletes a row.
CREATE OR REPLACE FUNCTION public.set_thread_source_status(
    p_thread_id UUID,
    p_source_id UUID,
    p_status    TEXT
)
RETURNS public.thread_sources
LANGUAGE plpgsql
AS $$
DECLARE
    v_row public.thread_sources;
BEGIN
    IF p_status NOT IN ('confirmed','pending','hidden','inactive') THEN
        RAISE EXCEPTION 'invalid status %', p_status;
    END IF;

    UPDATE public.thread_sources
       SET status = p_status,
           confirmed_at = CASE
               WHEN p_status = 'confirmed' THEN COALESCE(confirmed_at, now())
               ELSE confirmed_at
           END
     WHERE thread_id = p_thread_id AND source_id = p_source_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no thread_sources row for thread=% source=%',
            p_thread_id, p_source_id;
    END IF;
    RETURN v_row;
END;
$$;

-- ── RLS + policies (mirror init-source-graph.sql) ──────────────────────
ALTER TABLE public.threads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thread_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS threads_service_role_all         ON public.threads;
DROP POLICY IF EXISTS thread_sources_service_role_all  ON public.thread_sources;
DROP POLICY IF EXISTS sessions_service_role_all        ON public.sessions;
DROP POLICY IF EXISTS session_sources_service_role_all ON public.session_sources;
CREATE POLICY threads_service_role_all         ON public.threads
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY thread_sources_service_role_all  ON public.thread_sources
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sessions_service_role_all        ON public.sessions
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY session_sources_service_role_all ON public.session_sources
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS threads_authenticated_select         ON public.threads;
DROP POLICY IF EXISTS thread_sources_authenticated_select  ON public.thread_sources;
DROP POLICY IF EXISTS sessions_authenticated_select        ON public.sessions;
DROP POLICY IF EXISTS session_sources_authenticated_select ON public.session_sources;
CREATE POLICY threads_authenticated_select         ON public.threads
    FOR SELECT TO authenticated USING (true);
CREATE POLICY thread_sources_authenticated_select  ON public.thread_sources
    FOR SELECT TO authenticated USING (true);
CREATE POLICY sessions_authenticated_select        ON public.sessions
    FOR SELECT TO authenticated USING (true);
CREATE POLICY session_sources_authenticated_select ON public.session_sources
    FOR SELECT TO authenticated USING (true);

-- ── Grants (additive; init-grants.sql already covers future objects,
--    these make the file self-sufficient if run standalone) ────────────
GRANT ALL    ON public.threads         TO service_role;
GRANT ALL    ON public.thread_sources  TO service_role;
GRANT ALL    ON public.sessions        TO service_role;
GRANT ALL    ON public.session_sources TO service_role;
GRANT SELECT ON public.threads         TO authenticated;
GRANT SELECT ON public.thread_sources  TO authenticated;
GRANT SELECT ON public.sessions        TO authenticated;
GRANT SELECT ON public.session_sources TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_or_create_source(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, VECTOR, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_source_to_thread(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_thread_source_status(UUID, UUID, TEXT) TO service_role;

-- PostgREST schema-cache reload (no-op if PostgREST not yet up).
NOTIFY pgrst, 'reload schema';
