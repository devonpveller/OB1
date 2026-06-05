-- P5 (TASKS 5.4) — durable import / grounding job state.
--
-- Persists job state so a workbench restart doesn't orphan in-flight imports,
-- backs ImportStatus.tsx history, and is LOAD-BEARING for P6: the
-- `staged`/`committed` pair drives the grounding badge's pending-vs-grounded
-- read (G11), and a failed ground-from-the-page attempt records its
-- `target_entity_ids` + terminal `error` here for the later "failed grounding
-- attempts" alerts surface.
--
-- Additive + idempotent (G2/G3).

CREATE TABLE IF NOT EXISTS public.import_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status            TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','extracting','embedding','linking','done','failed')),
    source_id         UUID REFERENCES public.sources(id) ON DELETE SET NULL,
    target_entity_ids BIGINT[] NOT NULL DEFAULT '{}',   -- entities.id is BIGINT
    target_notebook   TEXT,
    error             TEXT,
    staged            BOOLEAN NOT NULL DEFAULT false,    -- G11 grounding lifecycle
    committed         BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_status  ON public.import_jobs(status);
CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON public.import_jobs(created_at DESC);

CREATE OR REPLACE FUNCTION import_jobs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_import_jobs_touch ON public.import_jobs;
CREATE TRIGGER trg_import_jobs_touch
    BEFORE UPDATE ON public.import_jobs
    FOR EACH ROW EXECUTE FUNCTION import_jobs_touch_updated_at();
