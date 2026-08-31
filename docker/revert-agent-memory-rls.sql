-- revert-agent-memory-rls.sql
--
-- THE REVERT PATH for init-agent-memory-rls.sql. NOT MOUNTED in the initdb chain - it is an
-- operator tool, applied by hand:
--
--   Get-Content -Raw OB1\docker\revert-agent-memory-rls.sql |
--     docker exec -i openbrain-db psql -U postgres -d openbrain -v ON_ERROR_STOP=1
--
-- WHY IT EXISTS AS A FILE. "Revert path: re-run the previous definition" is a sentence, and a
-- sentence is not a revert path at 3am. This restores the exact policy set that
-- init-agent-memory.sql created, clears FORCE ROW LEVEL SECURITY, turns RLS on thoughts back
-- off, and re-grants what section 8 revoked.
--
-- WHAT IT DELIBERATELY DOES NOT UNDO: the two added columns (agent_memories.user_id,
-- thoughts.user_id), their indexes, the six predicate functions, the two views and the
-- ob_plane_personal role. Dropping a column is not reversible and this file is the REVERSIBLE
-- half; with the policies wide again all of it is inert. Drop them by hand only if you have
-- decided the tenancy axis is going away for good.

BEGIN;

-- 1. thoughts: back to no row security at all (its state before the migration).
DROP POLICY IF EXISTS thoughts_ops_plane      ON public.thoughts;
DROP POLICY IF EXISTS thoughts_personal_plane ON public.thoughts;
ALTER TABLE public.thoughts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.thoughts DISABLE ROW LEVEL SECURITY;

-- 2. the agent-memory tables: back to FOR ALL TO service_role USING (true).
DROP POLICY IF EXISTS agent_memories_ops_plane             ON public.agent_memories;
DROP POLICY IF EXISTS agent_memories_personal_plane        ON public.agent_memories;
DROP POLICY IF EXISTS agent_memory_source_refs_plane       ON public.agent_memory_source_refs;
DROP POLICY IF EXISTS agent_memory_artifacts_plane         ON public.agent_memory_artifacts;
DROP POLICY IF EXISTS agent_memory_relations_plane         ON public.agent_memory_relations;
DROP POLICY IF EXISTS agent_memory_review_actions_plane    ON public.agent_memory_review_actions;
DROP POLICY IF EXISTS agent_memory_recall_items_plane      ON public.agent_memory_recall_items;
DROP POLICY IF EXISTS agent_memory_recall_traces_plane     ON public.agent_memory_recall_traces;

CREATE POLICY agent_memories_service_role_all ON public.agent_memories
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_memory_source_refs_service_role_all ON public.agent_memory_source_refs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_memory_artifacts_service_role_all ON public.agent_memory_artifacts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_memory_relations_service_role_all ON public.agent_memory_relations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_memory_review_actions_service_role_all ON public.agent_memory_review_actions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_memory_recall_traces_service_role_all ON public.agent_memory_recall_traces
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_memory_recall_items_service_role_all ON public.agent_memory_recall_items
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.agent_memories              NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_source_refs    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_artifacts      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_relations      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_review_actions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_recall_traces  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_recall_items   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memory_audit_events   NO FORCE ROW LEVEL SECURITY;

-- 3. the grants section 8 removed.
GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.agent_memories,
  public.agent_memory_source_refs,
  public.agent_memory_artifacts,
  public.agent_memory_relations,
  public.agent_memory_review_actions,
  public.agent_memory_recall_traces,
  public.agent_memory_recall_items,
  public.agent_memory_audit_events,
  public.thoughts
TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
