-- ============================================================
-- Document gaps (research-workbench redesign, rwr-doc-gaps-api; plan 02-BUILD-PLAN.md phase 1; slot 650).
--
-- What this file adds, and only this:
--   document_gaps   one row per thing a document still needs ("what this document still needs"): the owner's
--                   subject (owner_sub, the identity seam's subject_sub - never caller-supplied), who acted
--                   (actor_sub), the document's vault path, the text, its normalised form (text_norm, the
--                   de-dup key), where it came from (origin), its state, the research run it was queued in
--                   (job_id) and when it was covered.
--   two registries (D18, never a closed list in a schema): gap_origins (user | selection | research | scan |
--                   topic) and gap_states (open | researching | covered | dismissed).
--
-- Per user (07-MULTI-USER): a gap is its owner's own context. Every read filters by owner_sub; another user's
-- gap by id is a missing one (the same answer). Nothing here reads or writes sources / claims: a gap is not
-- knowledge and no shared table, view or function carries its text. The research run the gaps are queued in
-- keeps its prompt owner-scoped through research_prompts, as the existing research path does.
--
-- De-dup at the database as well as in the route: at most ONE active (open or researching) gap per
-- (owner, document, normalised text); a dismissed gap is remembered per origin (at most one per owner,
-- document, normalised text and origin), so the same origin never brings it back.
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING); re-running it changes nothing. Depends only on the roles
-- of slot 480 (ob_workbench) and the service_role of the base chain. Fresh-volume slot 650; the live DB gets it by
-- hand (psql -f, BEFORE the new workbench image, a fresh DB backup first). Revert: revert-document-gaps.sql.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        RAISE EXCEPTION 'document gaps: slot 480 (init-owner-private-view.sql, the ob_workbench role) must be applied first' USING ERRCODE = '55000';
    END IF;
    IF to_regclass('public.contract_registries') IS NULL THEN
        RAISE EXCEPTION 'document gaps: the contract registries (init-research-contract.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;

INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('gap_origins', 'rwr-doc-gaps-api', 'where a document gap came from'),
    ('gap_states',  'rwr-doc-gaps-api', 'the state of a document gap')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('gap_origins', 'user',      'written by the person',  '{}'),
    ('gap_origins', 'selection', 'from selected text',     '{}'),
    ('gap_origins', 'research',  'found by research',      '{}'),
    ('gap_origins', 'scan',      'found by the text scan', '{}'),
    ('gap_origins', 'topic',     'from a topic',           '{}'),
    ('gap_states', 'open',        'open',        '{"meaning":"still needed, not yet being researched"}'),
    ('gap_states', 'researching', 'researching', '{"meaning":"queued in a research run (job_id); settled when that run ends"}'),
    ('gap_states', 'covered',     'covered',     '{"meaning":"a finished run backed it with a claim of two agreeing sources, or the person marked it covered; it rotates out of the open list"}'),
    ('gap_states', 'dismissed',   'dismissed',   '{"meaning":"the person put it aside; the same origin never brings it back"}')
ON CONFLICT (registry, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.document_gaps (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub   TEXT NOT NULL,
    actor_sub   TEXT NOT NULL,
    doc_path    TEXT NOT NULL,                  -- the owner's document (documents/<key>/...), checked by the route
    text        TEXT NOT NULL,                  -- per-user: never copied to a shared row, view or log
    text_norm   TEXT NOT NULL,                  -- the de-dup key (lower case, whitespace collapsed, edge punctuation off)
    origin      TEXT NOT NULL DEFAULT 'user',   -- registry gap_origins
    state       TEXT NOT NULL DEFAULT 'open',   -- registry gap_states
    job_id      UUID,                           -- the research run it was queued in (kept after the run ends; NULL for the moment between ticking and the run being queued)
    covered_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT document_gaps_text_ck CHECK (btrim(text) <> '' AND length(text) <= 2000 AND text_norm <> '')
);
CREATE INDEX IF NOT EXISTS idx_document_gaps_owner ON public.document_gaps (owner_sub, doc_path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_gaps_job ON public.document_gaps (job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_gaps_active
    ON public.document_gaps (owner_sub, doc_path, text_norm) WHERE state IN ('open', 'researching');
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_gaps_dismissed
    ON public.document_gaps (owner_sub, doc_path, text_norm, origin) WHERE state = 'dismissed';

-- ── RLS + grants (the slot 500 shape; ob_workbench is the workbench's own login role) ──
ALTER TABLE public.document_gaps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_gaps_service_role_all ON public.document_gaps;
CREATE POLICY document_gaps_service_role_all ON public.document_gaps FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS document_gaps_ob_workbench_all ON public.document_gaps;
CREATE POLICY document_gaps_ob_workbench_all ON public.document_gaps FOR ALL TO ob_workbench USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_gaps TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_gaps TO ob_workbench;

COMMIT;
NOTIFY pgrst, 'reload schema';
