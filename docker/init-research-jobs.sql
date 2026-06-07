-- ============================================================
-- Research jobs — async job+poll substrate for the research service (P4.1).
--
-- Governing plan: documentation/implementation-guide/research-engine-for-OB/
--   PLAN-research-engine.md §5 + OD-3 (async job+poll, optional live stream).
--
-- POST /research creates a `research_jobs` row (status=queued) and returns its
-- id; the harness runs in the background, updating progress/status; inlets poll
-- GET /research/jobs/:id (or subscribe to the SSE stream) for status + result.
-- This survives long runs and client disconnects and works for headless agents.
--
-- The reuse economics (PLAN §6 / P4.5) are recorded per run in `metrics`
-- (claims_reused / claims_freshly_gathered / gap_ratio) so the compounding
-- trend is observable — `research_run_metrics` exposes it for trend tracking.
--
-- Conventions mirror init-threads.sql / init-claims.sql:
--   * Idempotent (CREATE ... IF NOT EXISTS).
--   * *_touch_updated_at trigger.
--   * RLS enabled; service_role FOR ALL, authenticated SELECT.
--   * NO DROP TABLE / TRUNCATE / unqualified DELETE (OB1 guardrail).
--
-- Ordered AFTER init-threads.sql (70) — references threads + sessions. Mounted
-- in compose as 96-init-research-jobs.sql. Additive + operator-applied (G2/G10).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.research_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status      TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','done','error','cancelled')),
    origin      TEXT NOT NULL DEFAULT 'owui'
        CHECK (origin IN ('owui','agent','notebook','manual')),
    query       TEXT NOT NULL,
    -- explicit thread scope (bypasses curator resolution when set); nullable.
    thread_id   UUID REFERENCES public.threads(id) ON DELETE SET NULL,
    -- the staging session that holds this run's candidate sources (P3).
    session_id  UUID REFERENCES public.sessions(id) ON DELETE SET NULL,
    options     JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {depth, freshness, confidence_floor}
    progress    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {phase, message, counters}
    result      JSONB,                                -- {synthesis, claims[], cited_sources[], thread_id, reuse_ratio}
    metrics     JSONB,                                -- {claims_reused, claims_freshly_gathered, gap_ratio, ...}
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_research_jobs_status     ON public.research_jobs (status);
CREATE INDEX IF NOT EXISTS idx_research_jobs_thread     ON public.research_jobs (thread_id);
CREATE INDEX IF NOT EXISTS idx_research_jobs_created_at ON public.research_jobs (created_at DESC);
-- Drain index: the oldest queued job first (a worker claims FOR UPDATE SKIP LOCKED).
CREATE INDEX IF NOT EXISTS idx_research_jobs_queued
    ON public.research_jobs (created_at) WHERE status = 'queued';

CREATE OR REPLACE FUNCTION public.research_jobs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_research_jobs_touch ON public.research_jobs;
CREATE TRIGGER trg_research_jobs_touch
    BEFORE UPDATE ON public.research_jobs
    FOR EACH ROW EXECUTE FUNCTION public.research_jobs_touch_updated_at();

-- Trend view (P4.5): the reuse ratio per finished run, newest first. The proof
-- the engine compounds — on a maturing thread, reuse should trend up.
CREATE OR REPLACE VIEW public.research_run_metrics AS
    SELECT id, thread_id, query, finished_at,
           (metrics ->> 'claims_reused')::int            AS claims_reused,
           (metrics ->> 'claims_freshly_gathered')::int  AS claims_freshly_gathered,
           (metrics ->> 'gap_ratio')::float              AS gap_ratio
    FROM public.research_jobs
    WHERE status = 'done' AND metrics IS NOT NULL
    ORDER BY finished_at DESC;

-- ── RLS + policies (mirror init-claims.sql) ─────────────────────────────
ALTER TABLE public.research_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_jobs_service_role_all     ON public.research_jobs;
DROP POLICY IF EXISTS research_jobs_authenticated_select ON public.research_jobs;
CREATE POLICY research_jobs_service_role_all     ON public.research_jobs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY research_jobs_authenticated_select ON public.research_jobs
    FOR SELECT TO authenticated USING (true);

GRANT ALL    ON public.research_jobs        TO service_role;
GRANT SELECT ON public.research_jobs        TO authenticated;
GRANT SELECT ON public.research_run_metrics TO service_role, authenticated;

-- PostgREST schema-cache reload (no-op if PostgREST not yet up).
NOTIFY pgrst, 'reload schema';
