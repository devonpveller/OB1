-- ============================================================
-- Source → entity graph (mirrors init-graph.sql for sources).
--
-- Lets the entity-extraction worker extract entities/relations
-- from `sources` content the same way it does for `thoughts`,
-- producing a REAL source↔entity link (`source_entities`) so the
-- wiki cites sources that are genuinely about an entity instead
-- of vacuuming semantically-near research in. Idempotent.
-- ============================================================

-- Per-source extraction queue (sources.id is UUID, so this is a
-- sibling of entity_extraction_queue, not the same table).
CREATE TABLE IF NOT EXISTS public.source_extraction_queue (
  source_id UUID PRIMARY KEY REFERENCES public.sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  source_fingerprint TEXT,
  worker_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Real source↔entity links (analogue of thought_entities).
CREATE TABLE IF NOT EXISTS public.source_entities (
  source_id UUID NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
  entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  mention_role TEXT,
  confidence REAL,
  evidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_source_entities_entity ON public.source_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_source_entities_source ON public.source_entities(source_id);
CREATE INDEX IF NOT EXISTS idx_source_extraction_queue_status
  ON public.source_extraction_queue(status) WHERE status = 'pending';

-- Auto-enqueue on source content change. source_fingerprint = md5(content)
-- so re-ingesting unchanged content does not re-queue.
CREATE OR REPLACE FUNCTION public.queue_source_extraction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.source_extraction_queue (source_id, status, source_fingerprint)
  VALUES (NEW.id, 'pending', md5(COALESCE(NEW.content, '')))
  ON CONFLICT (source_id) DO UPDATE SET
    status = 'pending',
    attempt_count = 0,
    last_error = NULL,
    queued_at = now(),
    source_fingerprint = EXCLUDED.source_fingerprint
  WHERE source_extraction_queue.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_source_extraction ON public.sources;
CREATE TRIGGER trg_queue_source_extraction
  AFTER INSERT OR UPDATE OF content ON public.sources
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_source_extraction();

-- RLS + policies (mirror init-graph.sql: service_role full, authenticated read).
ALTER TABLE public.source_extraction_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_entities         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS source_extraction_queue_service_role_all ON public.source_extraction_queue;
DROP POLICY IF EXISTS source_entities_service_role_all         ON public.source_entities;
CREATE POLICY source_extraction_queue_service_role_all ON public.source_extraction_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY source_entities_service_role_all ON public.source_entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS source_extraction_queue_authenticated_select ON public.source_extraction_queue;
DROP POLICY IF EXISTS source_entities_authenticated_select         ON public.source_entities;
CREATE POLICY source_extraction_queue_authenticated_select ON public.source_extraction_queue
  FOR SELECT TO authenticated USING (true);
CREATE POLICY source_entities_authenticated_select ON public.source_entities
  FOR SELECT TO authenticated USING (true);

GRANT ALL    ON public.source_extraction_queue TO service_role;
GRANT ALL    ON public.source_entities         TO service_role;
GRANT SELECT ON public.source_extraction_queue TO authenticated;
GRANT SELECT ON public.source_entities         TO authenticated;
GRANT EXECUTE ON FUNCTION public.queue_source_extraction() TO service_role;

-- Backfill: enqueue every existing source so the worker links the
-- sources already ingested (research history) on its next drain.
INSERT INTO public.source_extraction_queue (source_id, status, source_fingerprint)
SELECT id, 'pending', md5(COALESCE(content, '')) FROM public.sources
ON CONFLICT (source_id) DO NOTHING;

-- PostgREST schema-cache reload (no-op if not yet up).
NOTIFY pgrst, 'reload schema';
