-- ============================================================
-- init-research-filed.sql - research-workbench rw-curator-filed
-- ============================================================
-- A research run is never silently lost between the research service and the curator. The curator's
-- filing (POST /research/persist, ONE transaction) now also writes a typed 'filed' event into
-- research_job_events (P4a), in that same transaction, carrying the synthesis id. The research
-- service reads it to learn whether a curator call that timed out or dropped its connection actually
-- filed the run (and, if not, retries the hand-off; persist is idempotent on research_key).
--
-- Changes (additive, idempotent):
--   1. research_job_events.type admits 'filed'; a 'filed' event must carry synthesis_id + research_key.
--   2. at most ONE 'filed' event per job (partial unique index) - a re-run of the same persist updates it.
-- Mounted in compose as 280-init-research-filed.sql (after P2b's 270). Fresh-volume only; the live DB
-- gets it by hand BEFORE the new curator / kubernetes-deployment images are deployed
-- (psql -f, the operator's gated deploy). Revert: revert-research-filed.sql.
-- No DROP TABLE / TRUNCATE / unqualified DELETE.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE public.research_job_events DROP CONSTRAINT IF EXISTS research_job_events_type_check;
ALTER TABLE public.research_job_events ADD CONSTRAINT research_job_events_type_check
    CHECK (type IN ('stage', 'source', 'human_steer', 'gap', 'interhub_gap', 'branch_open', 'branch_close',
                    'topic', 'filed'));

ALTER TABLE public.research_job_events DROP CONSTRAINT IF EXISTS research_job_events_filed;
ALTER TABLE public.research_job_events ADD CONSTRAINT research_job_events_filed
    CHECK (type <> 'filed' OR (payload ? 'synthesis_id' AND payload ? 'research_key'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_job_events_filed
    ON public.research_job_events (job_id) WHERE type = 'filed';

COMMIT;
