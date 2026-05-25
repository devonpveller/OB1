-- Open Brain — knowledge-graph layer for the self-hosted docker stack.
--
-- Ports schemas/entity-extraction + schemas/typed-reasoning-edges to the
-- deployable raw-Postgres `thoughts` table. The wiki-compiler stack
-- (entity-extraction worker → typed-edge-classifier → entity-wiki →
-- wiki-synthesis) depends on these tables.
--
-- ADAPTATIONS vs upstream (see tracker F9 / D14 — non-destructive):
--   * thoughts.id is BIGINT here (BIGSERIAL), not Supabase's UUID, so
--     every FK to thoughts(id) is BIGINT (upstream uses UUID).
--   * thoughts.content_fingerprint is ADDED here (additive — allowed by
--     the CLAUDE.md guardrail; never alters/drops existing columns) and
--     auto-populated by a BEFORE trigger. Index is NON-unique so the
--     existing Deno capture path (plain INSERT, no ON CONFLICT) cannot
--     break on duplicate content.
--   * No-op roles service_role / authenticated / anon are created so the
--     upstream RLS policies + GRANTs apply verbatim (server connects as
--     superuser → RLS bypassed; this matches the 20-init-extensions
--     auth-shim philosophy).
--   * upsert_thought() is a self-contained shim (existence check, no
--     reliance on a UNIQUE constraint).
--
-- Runs after 10-init.sql (thoughts) and 20-init-extensions.sql (auth
-- shim). Idempotent.

-- ============================================================
-- 0. ROLE SHIM — no-op roles so upstream GRANT/POLICY ... TO <role>
--    succeed. NOLOGIN; the MCP server connects as the superuser.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END $$;

-- ============================================================
-- 1. thoughts.content_fingerprint (ADDITIVE) + auto-populate.
--    Required by the entity-extraction auto-queue trigger and used
--    for dedup. NON-unique on purpose (see header).
-- ============================================================
ALTER TABLE public.thoughts
  ADD COLUMN IF NOT EXISTS content_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_thoughts_content_fingerprint
  ON public.thoughts (content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION public.thoughts_set_fingerprint()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.content IS NOT NULL THEN
    NEW.content_fingerprint :=
      encode(digest(NEW.content, 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$$;

-- pgcrypto provides digest(); pgvector image ships it but be safe.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TRIGGER IF EXISTS trg_thoughts_fingerprint ON public.thoughts;
CREATE TRIGGER trg_thoughts_fingerprint
  BEFORE INSERT OR UPDATE OF content ON public.thoughts
  FOR EACH ROW EXECUTE FUNCTION public.thoughts_set_fingerprint();

-- Backfill any pre-existing rows (idempotent).
UPDATE public.thoughts
  SET content_fingerprint = encode(digest(content, 'sha256'), 'hex')
  WHERE content_fingerprint IS NULL AND content IS NOT NULL;

-- ============================================================
-- 1b. upsert_thought shim — used by wiki-synthesis (gmail wiki) and
--     entity-wiki thought-output mode. Self-contained: matches by
--     content_fingerprint without needing a UNIQUE constraint.
--     Signature matches the script callers: (p_content, p_payload)
--     where p_payload may carry {"metadata": {...}}.
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_thought(
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS public.thoughts
LANGUAGE plpgsql
AS $$
DECLARE
  v_fp   TEXT := encode(digest(p_content, 'sha256'), 'hex');
  v_meta JSONB := COALESCE(p_payload->'metadata', '{}'::jsonb);
  v_row  public.thoughts;
BEGIN
  SELECT * INTO v_row FROM public.thoughts
    WHERE content_fingerprint = v_fp LIMIT 1;
  IF FOUND THEN
    UPDATE public.thoughts
       SET metadata = metadata || v_meta, updated_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.thoughts (content, metadata)
      VALUES (p_content, v_meta)
      RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;

-- ============================================================
-- 2. ENTITY EXTRACTION  (schemas/entity-extraction, BIGINT-adapted)
--    Prerequisite DO-block dropped: content_fingerprint is added by
--    section 1 above, so the upstream guard is satisfied by design.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.entities (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, normalized_name)
);

CREATE TABLE IF NOT EXISTS public.edges (
  id BIGSERIAL PRIMARY KEY,
  from_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  to_entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  support_count INT NOT NULL DEFAULT 1,
  confidence NUMERIC(3,2),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_entity_id, to_entity_id, relation)
);

-- thought_id is BIGINT here (upstream UUID) to match thoughts.id.
CREATE TABLE IF NOT EXISTS public.thought_entities (
  thought_id BIGINT NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  entity_id BIGINT NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  mention_role TEXT NOT NULL DEFAULT 'mentioned',
  confidence NUMERIC(3,2),
  source TEXT NOT NULL DEFAULT 'entity_worker',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (thought_id, entity_id, mention_role)
);

CREATE TABLE IF NOT EXISTS public.entity_extraction_queue (
  thought_id BIGINT PRIMARY KEY REFERENCES public.thoughts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  source_fingerprint TEXT,
  source_updated_at TIMESTAMPTZ,
  worker_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.consolidation_log (
  id BIGSERIAL PRIMARY KEY,
  operation TEXT NOT NULL,
  survivor_id BIGINT,
  loser_id BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON public.entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_normalized ON public.entities(normalized_name);
CREATE INDEX IF NOT EXISTS idx_edges_from ON public.edges(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON public.edges(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON public.edges(relation);
CREATE INDEX IF NOT EXISTS idx_thought_entities_entity ON public.thought_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_thought_entities_thought ON public.thought_entities(thought_id);
CREATE INDEX IF NOT EXISTS idx_extraction_queue_status
  ON public.entity_extraction_queue(status) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.queue_entity_extraction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.metadata->>'generated_by' IS NOT NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.entity_extraction_queue (thought_id, status, source_fingerprint, source_updated_at)
  VALUES (NEW.id, 'pending', NEW.content_fingerprint, NEW.updated_at)
  ON CONFLICT (thought_id) DO UPDATE SET
    status = 'pending',
    attempt_count = 0,
    last_error = NULL,
    queued_at = now(),
    source_fingerprint = EXCLUDED.source_fingerprint,
    source_updated_at = EXCLUDED.source_updated_at
  WHERE entity_extraction_queue.source_fingerprint IS DISTINCT FROM EXCLUDED.source_fingerprint;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_entity_extraction ON public.thoughts;
CREATE TRIGGER trg_queue_entity_extraction
  AFTER INSERT OR UPDATE OF content, metadata ON public.thoughts
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_entity_extraction();

-- Wiki delete-propagation. When a thought is deleted, every entity it
-- linked through thought_entities loses a citation; bump those entities'
-- updated_at so the next wiki compile's dirtyEntityIds() picks them up
-- and regenerates the page (orphan sweep then deletes any page whose
-- entity has fallen below WIKI_BATCH_MIN_LINKED). Without this, the
-- cascade FK silently drops thought_entities rows and the wiki keeps
-- ghost pages citing the deleted source.
CREATE OR REPLACE FUNCTION public.touch_entities_for_deleted_thought()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.entities
     SET updated_at = now()
   WHERE id IN (
     SELECT entity_id FROM public.thought_entities
      WHERE thought_id = OLD.id
   );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_entities_on_thought_delete ON public.thoughts;
CREATE TRIGGER trg_touch_entities_on_thought_delete
  BEFORE DELETE ON public.thoughts
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_entities_for_deleted_thought();

ALTER TABLE public.entities                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edges                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thought_entities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_extraction_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_log       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entities_service_role_all               ON public.entities;
DROP POLICY IF EXISTS edges_service_role_all                  ON public.edges;
DROP POLICY IF EXISTS thought_entities_service_role_all       ON public.thought_entities;
DROP POLICY IF EXISTS entity_extraction_queue_service_role_all ON public.entity_extraction_queue;
DROP POLICY IF EXISTS consolidation_log_service_role_all      ON public.consolidation_log;

CREATE POLICY entities_service_role_all ON public.entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY edges_service_role_all ON public.edges
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY thought_entities_service_role_all ON public.thought_entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY entity_extraction_queue_service_role_all ON public.entity_extraction_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY consolidation_log_service_role_all ON public.consolidation_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS entities_authenticated_select               ON public.entities;
DROP POLICY IF EXISTS edges_authenticated_select                  ON public.edges;
DROP POLICY IF EXISTS thought_entities_authenticated_select       ON public.thought_entities;
DROP POLICY IF EXISTS entity_extraction_queue_authenticated_select ON public.entity_extraction_queue;
DROP POLICY IF EXISTS consolidation_log_authenticated_select      ON public.consolidation_log;

CREATE POLICY entities_authenticated_select ON public.entities
  FOR SELECT TO authenticated USING (true);
CREATE POLICY edges_authenticated_select ON public.edges
  FOR SELECT TO authenticated USING (true);
CREATE POLICY thought_entities_authenticated_select ON public.thought_entities
  FOR SELECT TO authenticated USING (true);
CREATE POLICY entity_extraction_queue_authenticated_select ON public.entity_extraction_queue
  FOR SELECT TO authenticated USING (true);
CREATE POLICY consolidation_log_authenticated_select ON public.consolidation_log
  FOR SELECT TO authenticated USING (true);

GRANT ALL ON public.entities                TO service_role;
GRANT ALL ON public.edges                   TO service_role;
GRANT ALL ON public.thought_entities        TO service_role;
GRANT ALL ON public.entity_extraction_queue TO service_role;
GRANT ALL ON public.consolidation_log       TO service_role;
GRANT SELECT ON public.entities                TO authenticated;
GRANT SELECT ON public.edges                   TO authenticated;
GRANT SELECT ON public.thought_entities        TO authenticated;
GRANT SELECT ON public.entity_extraction_queue TO authenticated;
GRANT SELECT ON public.consolidation_log       TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.queue_entity_extraction() TO service_role;
GRANT EXECUTE ON FUNCTION public.touch_entities_for_deleted_thought() TO service_role;

-- ============================================================
-- 3. TYPED REASONING EDGES (schemas/typed-reasoning-edges,
--    BIGINT-adapted). Prerequisite DO-blocks dropped: thoughts +
--    edges exist by file ordering above.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.thought_edges (
  id BIGSERIAL PRIMARY KEY,
  from_thought_id BIGINT NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  to_thought_id BIGINT NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (
    relation IN ('supports', 'contradicts', 'evolved_into', 'supersedes', 'depends_on', 'related_to')
  ),
  confidence NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  decay_weight NUMERIC(3,2) CHECK (decay_weight IS NULL OR (decay_weight >= 0 AND decay_weight <= 1)),
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  classifier_version TEXT,
  support_count INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_thought_id, to_thought_id, relation),
  CHECK (from_thought_id <> to_thought_id)
);

CREATE INDEX IF NOT EXISTS idx_thought_edges_from_relation
  ON public.thought_edges (from_thought_id, relation);
CREATE INDEX IF NOT EXISTS idx_thought_edges_to_relation
  ON public.thought_edges (to_thought_id, relation);
CREATE INDEX IF NOT EXISTS idx_thought_edges_current
  ON public.thought_edges (from_thought_id, to_thought_id)
  WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS idx_thought_edges_valid_until
  ON public.thought_edges (valid_until)
  WHERE valid_until IS NOT NULL;

CREATE OR REPLACE FUNCTION public.thought_edges_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_thought_edges_updated_at ON public.thought_edges;
CREATE TRIGGER trg_thought_edges_updated_at
  BEFORE UPDATE ON public.thought_edges
  FOR EACH ROW EXECUTE FUNCTION public.thought_edges_set_updated_at();

ALTER TABLE public.thought_edges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role full access" ON public.thought_edges;
CREATE POLICY "service_role full access"
  ON public.thought_edges FOR ALL TO service_role
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated read" ON public.thought_edges;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.thought_edges TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.thought_edges_id_seq TO service_role;
REVOKE ALL ON public.thought_edges FROM authenticated;
REVOKE ALL ON public.thought_edges FROM anon;

CREATE OR REPLACE FUNCTION public.thought_edges_upsert(
  p_from_thought_id BIGINT,
  p_to_thought_id BIGINT,
  p_relation TEXT,
  p_confidence NUMERIC,
  p_support_count INT,
  p_classifier_version TEXT,
  p_valid_from TIMESTAMPTZ,
  p_valid_until TIMESTAMPTZ,
  p_metadata JSONB
)
RETURNS public.thought_edges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.thought_edges;
BEGIN
  INSERT INTO public.thought_edges (
    from_thought_id, to_thought_id, relation,
    confidence, support_count, classifier_version,
    valid_from, valid_until, metadata
  )
  VALUES (
    p_from_thought_id, p_to_thought_id, p_relation,
    p_confidence, COALESCE(p_support_count, 1), p_classifier_version,
    p_valid_from, p_valid_until, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (from_thought_id, to_thought_id, relation)
  DO UPDATE SET
    support_count = public.thought_edges.support_count + COALESCE(EXCLUDED.support_count, 1),
    confidence = GREATEST(public.thought_edges.confidence, EXCLUDED.confidence),
    valid_until = CASE
      WHEN public.thought_edges.valid_until IS NULL OR EXCLUDED.valid_until IS NULL THEN NULL
      ELSE GREATEST(public.thought_edges.valid_until, EXCLUDED.valid_until)
    END,
    valid_from = CASE
      WHEN public.thought_edges.valid_from IS NULL THEN EXCLUDED.valid_from
      WHEN EXCLUDED.valid_from IS NULL THEN public.thought_edges.valid_from
      ELSE LEAST(public.thought_edges.valid_from, EXCLUDED.valid_from)
    END,
    classifier_version = EXCLUDED.classifier_version,
    metadata = public.thought_edges.metadata || EXCLUDED.metadata,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.thought_edges_upsert(
  BIGINT, BIGINT, TEXT, NUMERIC, INT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.thought_edges_upsert(
  BIGINT, BIGINT, TEXT, NUMERIC, INT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB
) TO service_role;

-- Temporal validity on the entity `edges` table (idempotent).
ALTER TABLE public.edges
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decay_weight NUMERIC(3,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'edges_decay_weight_range'
  ) THEN
    ALTER TABLE public.edges
      ADD CONSTRAINT edges_decay_weight_range
      CHECK (decay_weight IS NULL OR (decay_weight >= 0 AND decay_weight <= 1));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_edges_temporal
  ON public.edges (valid_from, valid_until)
  WHERE valid_from IS NOT NULL OR valid_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edges_current
  ON public.edges (from_entity_id, to_entity_id)
  WHERE valid_until IS NULL;
