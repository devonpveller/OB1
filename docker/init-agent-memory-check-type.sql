-- init-agent-memory-check-type.sql
--
-- Adds 'check' to the agent_memories.memory_type CHECK.
--
-- WHY. dark-factory-unification §2's U3 row requires that "harness findings write
-- `memory_type='check'`" — the finding→durable-check pipeline agent-org already proved
-- (gym-007), extended to the harness, which §0 A5 names as "currently the violator" for
-- banking its lessons as prose instead.
--
-- The type did not exist. The vendored schema permits decision / output / lesson /
-- constraint / open_question / failure / artifact_reference / work_log, and a writeback
-- with memory_type='check' is rejected by the CHECK at runtime and by nothing at test time
-- if the pool is stubbed. U3 could not be implemented without this.
--
-- WHY A DISTINCT TYPE RATHER THAN 'lesson' OR 'constraint'. A check is not a thing learned
-- and not a boundary on scope: it is an EXECUTABLE artifact that either runs green or does
-- not. Recall, review and any later reflection pass all want to treat it differently — a
-- lesson is read, a check is RUN — and collapsing it into a neighbouring type would make
-- that distinction unrecoverable from the data.
--
-- ADDITIVE AND REVERSIBLE: it widens a CHECK, drops nothing, rewrites no row. The rollback
-- is the same statement with the original eight values, and no row becomes invalid under it
-- unless a 'check' memory has been written.
--
-- TWO PLACES, ALWAYS (there is no migration runner here):
--   1. mounted in the initdb chain, so a FRESH volume gets it;
--   2. applied to the live volume by hand per
--      documentation/implementation-guide/agent-memory-plane/PROMOTION-RUNBOOK.md.

ALTER TABLE public.agent_memories
  DROP CONSTRAINT IF EXISTS agent_memories_memory_type_check;

ALTER TABLE public.agent_memories
  ADD CONSTRAINT agent_memories_memory_type_check CHECK (
    memory_type IN (
      'decision',
      'output',
      'lesson',
      'constraint',
      'open_question',
      'failure',
      'artifact_reference',
      'work_log',
      'check'
    )
  );
