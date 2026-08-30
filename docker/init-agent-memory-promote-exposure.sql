-- init-agent-memory-promote-exposure.sql
--
-- Adds `promote_exposure` to the agent_memory_review_actions CHECK.
--
-- WHY. PLAN §1.1 (access-bounds-writes, operator-DECIDED 2026-08-25) makes human review the
-- ONLY path that widens a memory's exposure - "a `promote_exposure` action beside the
-- existing `restrict_scope`". The vendored schema's CHECK lists nine actions and this is not
-- among them, because the exposure model postdates it. Without this migration a memory
-- demoted to the personal plane by the taint rule or the PII heuristic could never be
-- elevated: the conservative direction, but not the designed one, and a reviewer would have
-- no legitimate way to correct a false demotion.
--
-- ADDITIVE AND REVERSIBLE. It widens a CHECK; it drops nothing and rewrites no row. The
-- rollback is the same statement with the original nine-value list, and no data becomes
-- invalid under it unless a promote_exposure row has been written.
--
-- TWO PLACES, ALWAYS (the standing invariant - there is no migration runner here):
--   1. mounted in the initdb chain, so a FRESH volume gets it;
--   2. applied to the live volume by hand per
--      documentation/implementation-guide/agent-memory-plane/PROMOTION-RUNBOOK.md.
-- A file that reaches only one of the two makes a rebuilt database differ from the running
-- one, silently. Two files were in exactly that state before the harness checked for it.

ALTER TABLE public.agent_memory_review_actions
  DROP CONSTRAINT IF EXISTS agent_memory_review_actions_action_check;

ALTER TABLE public.agent_memory_review_actions
  ADD CONSTRAINT agent_memory_review_actions_action_check CHECK (
    action IN (
      'confirm',
      'edit',
      'evidence_only',
      'restrict_scope',
      'promote_exposure',
      'mark_stale',
      'merge',
      'reject',
      'dispute',
      'supersede'
    )
  );
