-- revert-graph-plane-rls.sql
--
-- THE REVERT TWIN of init-graph-plane-rls.sql. It restores the state that file changed and
-- NOTHING ELSE. It does not drop a table, a column, a row or the ob_thought_visible()
-- function - a function nothing references is inert, and dropping it would make this revert
-- itself irreversible if the migration is re-applied.
--
-- WHAT IT PUTS BACK, statement for statement:
--   1. the wide USING (true) policies from init-graph.sql / init-source-graph.sql /
--      init-ideas.sql, under their ORIGINAL names;
--   2. FORCE ROW LEVEL SECURITY cleared on the eight tables (RLS stays ENABLED - it was
--      enabled before the migration too);
--   3. TRUNCATE / REFERENCES / TRIGGER re-granted to service_role and authenticated;
--   4. the three function bodies restored VERBATIM from init-graph.sql, including
--      SECURITY DEFINER on all three and the ungated queue_entity_extraction;
--   5. the wide USING(true) policy on agent_memory_audit_events, and the agent_memories
--      policies without their thought_id WITH CHECK arm, both verbatim as 180 left them;
--   6. `security_invoker` cleared on the four views that lacked it before the migration;
--   7. the write privileges section 6a withdrew from the agent-memory corpus and
--      idea_revisions, re-granted to the roles that held them, and the two
--      ORACLE-DISPOSITION comments removed.
--
-- APPLYING THIS RE-OPENS THE MEASURED DISCLOSURE: after it runs, an unauthenticated caller on
-- open-brain_obnet can once again read entity_extraction_queue.source_fingerprint - sha256 of
-- a thought's content - for a thought it cannot see. That is what a revert of this migration
-- MEANS, and it is written here so nobody applies it without knowing.

BEGIN;

-- ==========================================================================================
-- 1. RESTORE THE WIDE POLICIES UNDER THEIR ORIGINAL NAMES
-- ==========================================================================================
DROP POLICY IF EXISTS thought_entities_plane                  ON public.thought_entities;
DROP POLICY IF EXISTS thought_entities_plane_read             ON public.thought_entities;
DROP POLICY IF EXISTS entity_extraction_queue_plane           ON public.entity_extraction_queue;
DROP POLICY IF EXISTS entity_extraction_queue_plane_read      ON public.entity_extraction_queue;
DROP POLICY IF EXISTS thought_edges_plane                     ON public.thought_edges;
DROP POLICY IF EXISTS idea_revisions_plane                    ON public.idea_revisions;
DROP POLICY IF EXISTS idea_revisions_plane_read               ON public.idea_revisions;
DROP POLICY IF EXISTS entities_shared_vocabulary_all          ON public.entities;
DROP POLICY IF EXISTS entities_shared_vocabulary_read         ON public.entities;
DROP POLICY IF EXISTS edges_shared_vocabulary_all             ON public.edges;
DROP POLICY IF EXISTS edges_shared_vocabulary_read            ON public.edges;
DROP POLICY IF EXISTS source_entities_shared_vocabulary_all   ON public.source_entities;
DROP POLICY IF EXISTS source_entities_shared_vocabulary_read  ON public.source_entities;
DROP POLICY IF EXISTS consolidation_log_shared_vocabulary_all ON public.consolidation_log;
DROP POLICY IF EXISTS consolidation_log_shared_vocabulary_read ON public.consolidation_log;

CREATE POLICY thought_entities_service_role_all ON public.thought_entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY thought_entities_authenticated_select ON public.thought_entities
  FOR SELECT TO authenticated USING (true);

CREATE POLICY entity_extraction_queue_service_role_all ON public.entity_extraction_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY entity_extraction_queue_authenticated_select ON public.entity_extraction_queue
  FOR SELECT TO authenticated USING (true);

-- init-graph.sql names this one in double quotes; kept verbatim.
CREATE POLICY "service_role full access" ON public.thought_edges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY idea_revisions_service_role_all ON public.idea_revisions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY idea_revisions_authenticated_select ON public.idea_revisions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY entities_service_role_all ON public.entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY entities_authenticated_select ON public.entities
  FOR SELECT TO authenticated USING (true);

CREATE POLICY edges_service_role_all ON public.edges
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY edges_authenticated_select ON public.edges
  FOR SELECT TO authenticated USING (true);

CREATE POLICY source_entities_service_role_all ON public.source_entities
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY source_entities_authenticated_select ON public.source_entities
  FOR SELECT TO authenticated USING (true);

CREATE POLICY consolidation_log_service_role_all ON public.consolidation_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY consolidation_log_authenticated_select ON public.consolidation_log
  FOR SELECT TO authenticated USING (true);

-- ==========================================================================================
-- 2. CLEAR FORCE (RLS itself stays ENABLED - it was enabled before the migration too)
-- ==========================================================================================
ALTER TABLE public.thought_entities        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.entity_extraction_queue NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.thought_edges           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.idea_revisions          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.entities                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.edges                   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.source_entities         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.consolidation_log       NO FORCE ROW LEVEL SECURITY;

-- ==========================================================================================
-- 3. RE-GRANT
-- ==========================================================================================
GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.thought_entities,
  public.entity_extraction_queue,
  public.thought_edges,
  public.idea_revisions,
  public.entities,
  public.edges,
  public.source_entities,
  public.consolidation_log
TO service_role;

-- authenticated held SELECT only on these before the migration, except that init-grants.sql's
-- ALTER DEFAULT PRIVILEGES had also handed it TRUNCATE/REFERENCES/TRIGGER on the graph tables
-- (measured 2026-08-31: authenticated had SELECT only). Restoring SELECT alone is therefore
-- the true previous state, and it is what the policies above already imply.
GRANT SELECT ON TABLE
  public.thought_entities,
  public.entity_extraction_queue,
  public.idea_revisions,
  public.entities,
  public.edges,
  public.source_entities,
  public.consolidation_log
TO authenticated;

-- ==========================================================================================
-- 4. RESTORE THE FUNCTION BODIES VERBATIM FROM init-graph.sql
-- ==========================================================================================
CREATE OR REPLACE FUNCTION public.queue_entity_extraction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
$fn$;

CREATE OR REPLACE FUNCTION public.touch_entities_for_deleted_thought()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  UPDATE public.entities
     SET updated_at = now()
   WHERE id IN (
     SELECT entity_id FROM public.thought_entities
      WHERE thought_id = OLD.id
   );
  RETURN OLD;
END;
$fn$;

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
AS $fn$
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
$fn$;

-- ==========================================================================================
-- 5. UNDO SECTION 2b - agent_memory_audit_events and the agent_memories WITH CHECK arm
-- ==========================================================================================
-- APPLYING THIS RE-OPENS A SECOND MEASURED DISCLOSURE: an unauthenticated caller on
-- open-brain_obnet can once again read the id, event history, timestamps and payload notes of
-- audit rows belonging to memories it cannot see; and `POST /agent_memories` can once again
-- distinguish a hidden thought from a nonexistent one by 201 versus 23503.
DROP POLICY IF EXISTS agent_memory_audit_events_plane      ON public.agent_memory_audit_events;
DROP POLICY IF EXISTS agent_memory_audit_events_plane_read ON public.agent_memory_audit_events;
DROP POLICY IF EXISTS agent_memory_audit_events_closed     ON public.agent_memory_audit_events;

CREATE POLICY agent_memory_audit_events_service_role_all ON public.agent_memory_audit_events
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Restored VERBATIM from init-agent-memory-rls.sql - USING and WITH CHECK identical again,
-- with no thought_id arm.
DROP POLICY IF EXISTS agent_memories_ops_plane      ON public.agent_memories;
DROP POLICY IF EXISTS agent_memories_personal_plane ON public.agent_memories;

CREATE POLICY agent_memories_ops_plane ON public.agent_memories
  AS PERMISSIVE FOR ALL TO service_role
  USING      (public.ob_memory_on_ops_plane(metadata))
  WITH CHECK (public.ob_memory_on_ops_plane(metadata));

CREATE POLICY agent_memories_personal_plane ON public.agent_memories
  AS PERMISSIVE FOR ALL TO service_role
  USING      (user_id IS NOT NULL AND user_id = public.ob_current_user_id())
  WITH CHECK (user_id IS NOT NULL AND user_id = public.ob_current_user_id());

-- Restored VERBATIM from init-agent-memory-rls.sql: USING on the ops-plane predicate,
-- WITH CHECK unconditionally open. THAT OPEN WITH CHECK IS AN ABSENCE ARM - it permits a
-- trace whose exposure cannot be established - which is why section 2c of the migration
-- narrowed it. Putting it back is part of what reverting means.
DROP POLICY IF EXISTS agent_memory_recall_traces_plane ON public.agent_memory_recall_traces;

CREATE POLICY agent_memory_recall_traces_plane ON public.agent_memory_recall_traces
  AS PERMISSIVE FOR ALL TO service_role
  USING (public.ob_trace_on_ops_plane(request_payload)) WITH CHECK (true);

-- ==========================================================================================
-- 6. UNDO SECTION 6b - the view sweep
-- ==========================================================================================
-- These FOUR views, and only these four, lacked `security_invoker` when the migration ran;
-- the state is named here rather than re-derived because "every view that lacks it" is not
-- something a revert can compute AFTER the migration set them all. Measured on the live
-- database 2026-08-31 (pg_class.reloptions).
--
-- `v_agent_memories` and `v_thoughts` are deliberately NOT touched: init-agent-memory-rls.sql
-- created them WITH security_invoker and this migration never changed them, so clearing the
-- flag here would revert a file this file is not the twin of - and would open the boundary
-- that file's own comment at line 343 exists to hold shut.
ALTER VIEW public.ideas_owed_research  RESET (security_invoker);
ALTER VIEW public.research_run_metrics RESET (security_invoker);
ALTER VIEW public.reusable_claims      RESET (security_invoker);
ALTER VIEW public.ungrounded_claims    RESET (security_invoker);

-- ob_relation_governed() is deliberately NOT dropped, for the same reason ob_thought_visible
-- is not: a function nothing references is inert, and dropping it would make this revert
-- irreversible if the migration is re-applied.


-- ==========================================================================================
-- 7. UNDO SECTION 6a - the withdrawn write privileges, and the two disposition comments
-- ==========================================================================================
-- APPLYING THIS RE-OPENS A THIRD MEASURED DISCLOSURE: with INSERT back on idea_revisions, an
-- unauthenticated caller can once again separate an EXISTING hidden revision from an absent
-- one by 23505 versus success on idea_revisions_pkey, and the agent-memory corpus regains a
-- write door nothing deployed uses.
--
-- The corpus is re-derived the same way section 6a derives it, with ONE deliberate
-- difference: section 6a screens the parent arm with `ob_relation_governed()`, and this file
-- screens it with `confrelid <> thoughts` instead. The reason is ordering - section 5 above
-- has already restored the wide policy on agent_memory_audit_events by the time this runs, so
-- a governed-ness test here would be measuring a world this very file is in the middle of
-- changing. The two filters select the same set on this schema (the parent arm yields
-- agent_memories and agent_memory_recall_traces either way); the revert's is the one that
-- does not depend on the state it is undoing.
-- `authenticated` is NOT re-granted: it never held INSERT, UPDATE or DELETE on any of these
-- tables (measured on the live database 2026-08-31), and a revert that grants a privilege the
-- world never had is not a revert.
DO $$
DECLARE
  v_corpus TEXT[];
  v_t      TEXT;
BEGIN
  SELECT array_agg(DISTINCT t ORDER BY t) INTO v_corpus FROM (
    SELECT 'agent_memories'::text AS t
    UNION
    SELECT c.conrelid::regclass::text
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
       AND c.confrelid = 'public.agent_memories'::regclass
       AND NOT EXISTS (SELECT 1 FROM pg_constraint g
                        WHERE g.contype = 'f' AND g.connamespace = 'public'::regnamespace
                          AND g.conrelid = c.conrelid
                          AND g.confrelid = 'public.thoughts'::regclass)
    UNION
    SELECT p.confrelid::regclass::text
      FROM pg_constraint p
     WHERE p.contype = 'f' AND p.connamespace = 'public'::regnamespace
       AND p.conrelid IN (SELECT c.conrelid FROM pg_constraint c
                           WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
                             AND c.confrelid = 'public.agent_memories'::regclass
                             AND NOT EXISTS (SELECT 1 FROM pg_constraint g
                                              WHERE g.contype = 'f'
                                                AND g.connamespace = 'public'::regnamespace
                                                AND g.conrelid = c.conrelid
                                                AND g.confrelid = 'public.thoughts'::regclass))
       AND p.confrelid <> 'public.thoughts'::regclass
  ) s;

  FOREACH v_t IN ARRAY v_corpus || ARRAY['idea_revisions'] LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', v_t);
  END LOOP;

  RAISE NOTICE 'revert-graph-plane-rls: write door re-opened on % relation(s): %, idea_revisions',
               array_length(v_corpus,1) + 1, array_to_string(v_corpus, ', ');
END $$;

COMMENT ON CONSTRAINT thoughts_pkey      ON public.thoughts      IS NULL;
COMMENT ON CONSTRAINT thought_edges_pkey ON public.thought_edges IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
