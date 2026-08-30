-- agent_memories.idempotency_key must be unique PER WORKSPACE, not globally.
--
-- The original index (schemas/agent-memory/schema.sql) is:
--   CREATE UNIQUE INDEX idx_agent_memories_idempotency_key
--     ON public.agent_memories (idempotency_key) WHERE idempotency_key IS NOT NULL;
--
-- That makes an idempotency key a GLOBAL namespace across every tenant. Two workspaces
-- using an obvious key - "daily-summary-2026-08-29" - collide: the second one's INSERT is
-- rejected with a duplicate-key error even though the two memories have nothing to do with
-- each other. Paired with a lookup that also omitted workspace_id, the second tenant was
-- handed the FIRST tenant's memory id and thought id and told its write had already
-- succeeded. Neither tenant did anything unusual.
--
-- Additive and idempotent. The old index is dropped only after the new one exists, so a
-- re-run is safe and there is no window without a uniqueness guarantee.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memories_ws_idempotency_key
  ON public.agent_memories (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS public.idx_agent_memories_idempotency_key;

COMMIT;

NOTIFY pgrst, 'reload schema';
