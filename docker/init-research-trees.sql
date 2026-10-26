-- ============================================================
-- Research workbench P4a - job trees, steer records, the event schema (rw-p4a-trees).
--
-- Governing plan (private plan store): implementation-guide/research-workbench/
--   03-PLAN.md P4a, 01-OPEN-ITEMS.md D1 / D3 / D15 / D16 / D17 (amended 2026-09-25 20:27) / D18,
--   06-EXPANSION.md §3.3.
--
-- What this file adds, and only this:
--   1. research_jobs becomes a TREE: parent_job_id, root_job_id, rooted_step_id (the parent's stage
--      event the branch is rooted at), branch_kind (root | steer | gap | interhub | idea), anchor
--      (a branch's anchor is its parent's query), the per-tree topic estimate and the cumulative
--      tree report (both on the root), gap_ref (one gap branch per gap per tree).
--   2. research_steers: every branch-opening steer - human, gap (D15) or inter-hub (D1) - with the
--      topic estimate and anchor it was made against (NOT NULL).
--   3. research_job_events: the typed event stream (AG-UI-shaped). Every event carries
--      kind = steering | due_process; a per-source event carries its trail; a stage event has the
--      job's step id (s1, s2, ...) a steer names; a human steer and a gap are distinct types.
--   4. On-demand idea engagement (D17 amended): an idea captured or changed queues its research at
--      once (a BEFORE INSERT trigger on idea_revisions), coalescing so a change during a run queues
--      exactly ONE follow-up run. The refinery's nightly drain is removed with this (crontab).
--
-- No topic or hub table: hubs are neighbourhoods computed from the claim graph (D1, emergent).
-- The grounding chain (sources -> claims -> reports) is untouched.
-- Conventions mirror init-export.sql: idempotent, additive, RLS on with a service_role FOR ALL
-- policy, no DROP TABLE / TRUNCATE / unqualified DELETE. Mounted in compose as
-- 260-init-research-trees.sql (after P6a's 250). Fresh-volume only; the live DB gets it by hand
-- (psql -f, the operator's gated deploy). Revert: revert-research-trees.sql.
-- ============================================================

-- ── 1. research_jobs: the tree columns ─────────────────────────────────
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS parent_job_id  UUID REFERENCES public.research_jobs(id);
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS root_job_id    UUID REFERENCES public.research_jobs(id);
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS rooted_step_id TEXT;
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS branch_kind    TEXT NOT NULL DEFAULT 'root';
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS anchor         TEXT;
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS topic_estimate TEXT;
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS tree_report    JSONB;
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS gap_ref        TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_jobs_branch_kind_check') THEN
        ALTER TABLE public.research_jobs ADD CONSTRAINT research_jobs_branch_kind_check
            CHECK (branch_kind IN ('root', 'steer', 'gap', 'interhub', 'idea'));
    END IF;
    -- A root (or an idea's research) has no parent; every branch names its parent, its tree, the
    -- step it is rooted at and its anchor.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_jobs_branch_shape_check') THEN
        ALTER TABLE public.research_jobs ADD CONSTRAINT research_jobs_branch_shape_check CHECK (
            (branch_kind IN ('root', 'idea') AND parent_job_id IS NULL AND root_job_id IS NULL)
            OR (branch_kind IN ('steer', 'gap', 'interhub')
                AND parent_job_id IS NOT NULL AND root_job_id IS NOT NULL
                AND rooted_step_id IS NOT NULL AND anchor IS NOT NULL));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_research_jobs_parent ON public.research_jobs (parent_job_id);
CREATE INDEX IF NOT EXISTS idx_research_jobs_root   ON public.research_jobs (root_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_jobs_tree_gap
    ON public.research_jobs (root_job_id, gap_ref) WHERE gap_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_research_jobs_idea_open
    ON public.research_jobs (refinery_id, status) WHERE branch_kind = 'idea';

-- ── 2. research_steers ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.research_steers (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_job_id      UUID NOT NULL REFERENCES public.research_jobs(id),
    parent_job_id    UUID NOT NULL REFERENCES public.research_jobs(id),
    child_job_id     UUID NOT NULL UNIQUE REFERENCES public.research_jobs(id),
    steer_kind       TEXT NOT NULL CHECK (steer_kind IN ('human', 'gap', 'interhub')),
    step_id          TEXT NOT NULL,
    text             TEXT NOT NULL CHECK (btrim(text) <> ''),
    -- what the steer was made against, at the moment it was made
    topic_estimate   TEXT NOT NULL CHECK (btrim(topic_estimate) <> ''),
    anchor           TEXT NOT NULL CHECK (btrim(anchor) <> ''),
    gap              JSONB,             -- gap steers: the claim + score + threshold, or the hub pair
    caller           TEXT,
    context_snapshot JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (steer_kind = 'human' OR gap IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_research_steers_root   ON public.research_steers (root_job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_research_steers_parent ON public.research_steers (parent_job_id);

-- ── 3. research_job_events ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.research_job_events (
    id          BIGSERIAL PRIMARY KEY,
    job_id      UUID NOT NULL REFERENCES public.research_jobs(id),
    root_job_id UUID NOT NULL REFERENCES public.research_jobs(id),
    step_id     TEXT,
    type        TEXT NOT NULL CHECK (type IN ('stage', 'source', 'human_steer', 'gap', 'interhub_gap',
                                              'branch_open', 'branch_close', 'topic')),
    kind        TEXT NOT NULL CHECK (kind IN ('steering', 'due_process')),
    trail       JSONB,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT research_job_events_stage_step  CHECK (type <> 'stage' OR step_id IS NOT NULL),
    CONSTRAINT research_job_events_source_trail CHECK (type <> 'source' OR (trail IS NOT NULL AND jsonb_typeof(trail) = 'object')),
    CONSTRAINT research_job_events_human_steer CHECK (type <> 'human_steer'
        OR (kind = 'steering' AND payload ? 'topic_estimate' AND payload ? 'anchor' AND payload ? 'step_id')),
    CONSTRAINT research_job_events_gap CHECK (type <> 'gap'
        OR (payload ? 'claim_id' AND payload ? 'score' AND payload ? 'threshold')),
    CONSTRAINT research_job_events_interhub CHECK (type <> 'interhub_gap'
        OR (payload ? 'a' AND payload ? 'b' AND payload ? 'density'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_job_events_step
    ON public.research_job_events (job_id, step_id) WHERE step_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_research_job_events_job  ON public.research_job_events (job_id, id);
CREATE INDEX IF NOT EXISTS idx_research_job_events_root ON public.research_job_events (root_job_id, id);

-- ── 4. on-demand idea engagement (D17 amended) ──────────────────────────
-- Queue an idea's research NOW, coalescing: an idea has at most one QUEUED research job. A change
-- while nothing is queued queues one (during a run, that is the one follow-up run); a change while
-- one is queued folds into it (latest revision wins). Serialised per idea by an advisory lock.
CREATE OR REPLACE FUNCTION public.research_idea_queue(p_idea_id UUID, p_revision INT, p_summary TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_title  TEXT;
    v_domain TEXT;
    v_prior  TEXT;
    v_query  TEXT;
    v_job    UUID;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('research_idea:' || p_idea_id::text));
    SELECT title, domain INTO v_title, v_domain FROM public.ideas WHERE id = p_idea_id;
    -- The refinery's research frame (IR §3), moved here from its nightly drain: gather evidence,
    -- never judge worth; a changed idea builds on what its last finished research found (IR.3).
    SELECT left(btrim(result ->> 'synthesis'), 2000) INTO v_prior FROM public.research_jobs
     WHERE refinery_id = p_idea_id AND branch_kind = 'idea' AND status = 'done'
     ORDER BY finished_at DESC NULLS LAST LIMIT 1;
    v_query := 'Gather evidence to help the user decide whether to build this idea for the '
        || coalesce(v_domain, 'ai-stack') || '. Do NOT judge whether it is worth building - present the '
        || 'evidence and the gaps only; the value decision is the user''s.'
        || E'\n\n' || 'Idea: "' || coalesce(v_title, '') || '" - ' || coalesce(p_summary, '')
        || E'\n\n' || 'Find and cite: (1) existing products or tools in industry that already do this or '
        || 'something adjacent, and for each, its value proposition (the problem it claims to solve and '
        || 'how it positions itself); (2) what prior research already established about this feature, '
        || 'directly or adjacently. Surface where this idea differs from what already exists (gaps in the '
        || 'landscape) as open questions.'
        || CASE WHEN coalesce(v_prior, '') <> '' THEN
               E'\n\n' || 'The user previously explored this idea; prior research found:' || E'\n' || v_prior
               || E'\n\n' || 'The idea has since been updated (see it above). Build on the prior findings - '
               || 'focus on what is new or changed, and note anything the prior research missed.'
           ELSE '' END;
    SELECT id INTO v_job FROM public.research_jobs
     WHERE refinery_id = p_idea_id AND branch_kind = 'idea' AND status = 'queued'
     ORDER BY created_at LIMIT 1 FOR UPDATE;
    IF v_job IS NOT NULL THEN
        UPDATE public.research_jobs
           SET query = v_query, anchor = v_query,
               options = options || jsonb_build_object('idea_revision', p_revision)
         WHERE id = v_job;
    ELSE
        INSERT INTO public.research_jobs (status, origin, caller, query, anchor, branch_kind, refinery_id, inlet_ref, options)
        VALUES ('queued', 'mattermost', 'idea-engagement', v_query, v_query, 'idea', p_idea_id,
                jsonb_build_object('kind', 'idea', 'id', p_idea_id::text),
                jsonb_build_object('idea_revision', p_revision, 'lane', 'research-branch'))
        RETURNING id INTO v_job;
    END IF;
    UPDATE public.ideas SET last_job_id = v_job::text WHERE id = p_idea_id;
    RETURN v_job;
END;
$$;

-- Every change to an idea is appended as a revision (capture = revision 1, update_idea = n+1);
-- the revision row is stamped with the job that will research it.
CREATE OR REPLACE FUNCTION public.trg_idea_revisions_engage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.research_job_id IS NULL THEN
        NEW.research_job_id := public.research_idea_queue(NEW.idea_id, NEW.revision, NEW.summary)::text;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_idea_revisions_engage ON public.idea_revisions;
CREATE TRIGGER trg_idea_revisions_engage
    BEFORE INSERT ON public.idea_revisions
    FOR EACH ROW EXECUTE FUNCTION public.trg_idea_revisions_engage();

-- ── RLS + grants (mirror init-export.sql) ───────────────────────────────
ALTER TABLE public.research_steers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_job_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS research_steers_service_role_all     ON public.research_steers;
DROP POLICY IF EXISTS research_job_events_service_role_all ON public.research_job_events;
CREATE POLICY research_steers_service_role_all     ON public.research_steers
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY research_job_events_service_role_all ON public.research_job_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.research_steers     TO service_role;
GRANT ALL ON public.research_job_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.research_job_events_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.research_idea_queue(UUID, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.research_idea_queue(UUID, INT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
