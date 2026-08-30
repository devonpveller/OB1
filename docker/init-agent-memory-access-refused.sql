-- init-agent-memory-access-refused.sql
--
-- Adds 'access_refused' to the agent_memory_audit_events event_type CHECK.
--
-- WHY. dark-factory-unification U5's Validated by column requires that an agent reaching for
-- personal-plane data "is mechanically stopped AND THE ATTEMPT IS VISIBLE IN AN AUDIT
-- RECORD". The stopping is one half; without a record, a refusal is indistinguishable from a
-- request that never happened, and nobody can tell a probing agent from a quiet one.
--
-- The type did not exist. The vendored schema's event types cover the LIFECYCLE of a memory
-- (written, returned, used, ignored, confirmed, edited, rejected, superseded, disputed) and
-- have no vocabulary for an access that was DENIED. Reusing one of them would file a refusal
-- under an event that means something else, which is worse than no record: a reader counting
-- 'memory_ignored' would be counting refusals too.
--
-- ADDITIVE AND REVERSIBLE: widens a CHECK, drops nothing, rewrites no row.
--
-- TWO PLACES, ALWAYS: mounted in the initdb chain for fresh volumes, and applied to the live
-- volume per documentation/implementation-guide/agent-memory-plane/PROMOTION-RUNBOOK.md.

ALTER TABLE public.agent_memory_audit_events
  DROP CONSTRAINT IF EXISTS agent_memory_audit_events_event_type_check;

ALTER TABLE public.agent_memory_audit_events
  ADD CONSTRAINT agent_memory_audit_events_event_type_check CHECK (
    event_type IN (
      'recall_requested',
      'memory_returned',
      'memory_used',
      'memory_ignored',
      'memory_written',
      'memory_confirmed',
      'memory_edited',
      'memory_rejected',
      'memory_superseded',
      'memory_disputed',
      'access_refused'
    )
  );
