-- ============================================================
-- Idea Refinery — the idea lifecycle aggregate (Idea Refinery IR.0).
--
-- Governing spec: documentation/implementation-guide/idea-refinery/
--   DESIGN-idea-refinery.md (§5 the aggregate, §6 the driver). This file is
--   the durable state the refinery drives: a raw idea is an OB `thought`; its
--   LIFECYCLE (research owed, dossier, thread, dormancy) is these tables.
--
--   ideas           — one row per idea, the lifecycle FSM (§2). `summary` is
--                     the current canonical statement; `embedding` powers
--                     dedup (DT-3) + resurfacing (§8). `thread_root` binds the
--                     Mattermost thread; `session_id` the honing session.
--   idea_revisions  — append-only lineage (mirrors init-source-revisions.sql):
--                     every edit is a revision; `research_job_id` is set ONLY
--                     on whichever revision a research run actually targeted, so
--                     rapid multi-chat edits COALESCE (§6 — one run per idea per
--                     cycle on its latest settled revision, not per revision).
--
-- Determinism lives here, not in the model: the `ideas_owed_research` view is
-- the "curated list" (§2/§6) — nothing flagged is ever silently skipped. The
-- MCP tools (capture_idea/update_idea/find_idea/research_idea) are the only
-- writers of `ideas`; research/delivery are set by the refinery service.
--
-- Conventions mirror init-claims.sql / init-sources.sql:
--   * Idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
--   * *_touch_updated_at trigger for updated_at.
--   * RLS enabled; service_role FOR ALL, authenticated SELECT.
--   * NO DROP TABLE / TRUNCATE / unqualified DELETE (OB1 guardrail).
--   * Never alters the core `thoughts` table (OB1 guardrail) — only references it.
--   * Embedding VECTOR(1024) (bge-m3), matching thoughts/claims.
--
-- Ordered to run AFTER init.sql (10, thoughts) and init-sources.sql (30):
--   thoughts + sources must exist. Mounted in compose as 98-init-ideas.sql.
--   Additive + operator-applied for the live DB (only auto-runs on a fresh
--   volume): docker exec -i openbrain-db psql -U <user> -d <db> < init-ideas.sql
-- ============================================================

-- ── ideas ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ideas (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         TEXT NOT NULL,
    -- current canonical statement of the idea (denormalized latest revision
    -- body, for cheap reads + embedding).
    summary       TEXT NOT NULL DEFAULT '',
    -- the evaluative/gathering frame (§3). v1 default 'ai-stack'.
    domain        TEXT NOT NULL DEFAULT 'ai-stack',
    -- lifecycle FSM (§2). Never deleted; 'archived' is the terminal rest state.
    status        TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','queued','researched','engaged',
                          'dirty','dormant','promoted','archived')),
    -- points at the latest idea_revisions.revision (the "settled state" a
    -- research cycle targets). Bumped by update_idea.
    current_revision INT NOT NULL DEFAULT 1,
    embedding     VECTOR(1024),                    -- bge-m3 (dedup DT-3 + resurface §8)
    -- Mattermost binding (§7): the root post id is the idea's thread; the
    -- headless session is bound lazily on first engagement (§7 lazy-seed).
    thread_root   TEXT,
    session_id    TEXT,
    -- the research job whose dossier is current, and the persisted synthesis
    -- source row (the dossier). SET NULL, not CASCADE: knowledge survives.
    last_job_id       TEXT,
    dossier_source_id UUID REFERENCES public.sources(id) ON DELETE SET NULL,
    -- who/what captured it (optional provenance).
    created_by    TEXT,
    -- dormancy (§8): last human turn drives the 14d fizzle; no nag.
    engaged_at    TIMESTAMPTZ,
    dormant_at    TIMESTAMPTZ,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ideas_status     ON public.ideas (status);
CREATE INDEX IF NOT EXISTS idx_ideas_updated_at ON public.ideas (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_engaged_at ON public.ideas (engaged_at);
CREATE INDEX IF NOT EXISTS idx_ideas_metadata   ON public.ideas USING GIN (metadata);
CREATE INDEX IF NOT EXISTS idx_ideas_embedding
    ON public.ideas USING hnsw (embedding vector_cosine_ops);

-- ── idea_revisions (append-only lineage) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.idea_revisions (
    idea_id         UUID NOT NULL REFERENCES public.ideas(id) ON DELETE CASCADE,
    revision        INT  NOT NULL,
    -- the idea text at this revision.
    summary         TEXT NOT NULL,
    -- the OB thought this revision was captured as (ideas stay first-class OB
    -- captures, §5.1). SET NULL: a thought must never be deleted, but be safe.
    thought_id      BIGINT REFERENCES public.thoughts(id) ON DELETE SET NULL,
    -- the research run that targeted THIS revision. NULL = owes research (the
    -- coalescing key: only the revision a cycle actually researched is stamped).
    research_job_id TEXT,
    -- md5(normalized summary) — lets update_idea skip a no-op edit (same text).
    content_hash    TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (idea_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_idea_revisions_idea ON public.idea_revisions (idea_id);
CREATE INDEX IF NOT EXISTS idx_idea_revisions_job  ON public.idea_revisions (research_job_id);

-- ── updated_at trigger (mirror claims_touch_updated_at) ──────────────────
CREATE OR REPLACE FUNCTION public.ideas_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ideas_touch ON public.ideas;
CREATE TRIGGER trg_ideas_touch
    BEFORE UPDATE ON public.ideas
    FOR EACH ROW EXECUTE FUNCTION public.ideas_touch_updated_at();

-- ============================================================
-- The owed-research queue (§6.2) — the drain's single read-path.
-- An idea owes research when the current revision has no research run yet and
-- it is not archived. `is_fresh` = new/dirty (a user just captured/edited it);
-- everything else owing (e.g. dormant backfill) is the low-priority tail. The
-- drain reads: ORDER BY is_fresh DESC, created_at ASC — fresh before backfill.
-- ============================================================
CREATE OR REPLACE VIEW public.ideas_owed_research AS
    SELECT i.*,
           (i.status IN ('new','dirty')) AS is_fresh
    FROM public.ideas i
    JOIN public.idea_revisions r
      ON r.idea_id = i.id AND r.revision = i.current_revision
    WHERE i.status <> 'archived'
      AND r.research_job_id IS NULL;

-- ── RLS + policies (mirror init-claims.sql) ──────────────────────────────
ALTER TABLE public.ideas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idea_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ideas_service_role_all          ON public.ideas;
DROP POLICY IF EXISTS idea_revisions_service_role_all ON public.idea_revisions;
CREATE POLICY ideas_service_role_all          ON public.ideas
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY idea_revisions_service_role_all ON public.idea_revisions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ideas_authenticated_select          ON public.ideas;
DROP POLICY IF EXISTS idea_revisions_authenticated_select ON public.idea_revisions;
CREATE POLICY ideas_authenticated_select          ON public.ideas
    FOR SELECT TO authenticated USING (true);
CREATE POLICY idea_revisions_authenticated_select ON public.idea_revisions
    FOR SELECT TO authenticated USING (true);

-- ── Grants (additive; init-grants.sql covers future objects, these make the
--    file self-sufficient if run standalone) ───────────────────────────────
GRANT ALL    ON public.ideas          TO service_role;
GRANT ALL    ON public.idea_revisions TO service_role;
GRANT SELECT ON public.ideas          TO authenticated;
GRANT SELECT ON public.idea_revisions TO authenticated;
GRANT SELECT ON public.ideas_owed_research TO service_role, authenticated;

-- PostgREST schema-cache reload (no-op if PostgREST not yet up).
NOTIFY pgrst, 'reload schema';
