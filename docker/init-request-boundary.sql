-- ============================================================
-- The request boundary (research-workbench rw-boundary-core, plan 09 PD0a). Slot 420.
-- Operator 2026-11-04 ("PD0: approved", defaults D1-D12): research formed from personal data reaches the shared
-- store only as a de-personalised request; the private hand-back ties it to its owner.
--
--   * research_jobs.request_kind (derived | direct | personal | service | unclassified; DEFAULT 'unclassified' -
--     every existing row, decision D5) and research_jobs.boundary (the boundary stamp of a derived job).
--   * THE GUARD trg_research_jobs_boundary: a derived row carries no inlet_ref, no refinery_id, no seed_sources /
--     callback / on_behalf_of (or inlet / owner / deliver key) in options and no research_prompts row; a derived ROOT
--     also has its stamp, query = anchor, caller 'boundary' and branch_kind 'root'. No update turns a row into a
--     derived one or a derived one into anything else. A branch takes its parent's kind (a steer on a derived job
--     is 'direct': its actor's own words). The guard is a backstop: it proves no personal FIELD rides on a derived
--     row; the token gate (research-service boundary-gate.ts) decides the text.
--   * trg_research_prompts_boundary: no research_prompts row for a derived job.
--   * research_handbacks: who a derived request was formed for, from what, and where its result goes - ids,
--     hashes and codes, never the personal text (owner_view, the owner's own review of a refused idea, excepted).
--     RLS enabled AND forced, the one policy owner-only; NO grant to any app role: the delivering services reach it
--     only through the purpose-scoped SECURITY DEFINER functions below, the owner through handback_owned().
--   * research_job_report_owner(job): returns nothing when the job's root is a derived job (its report is shared
--     knowledge) - otherwise slot 390's rule, unchanged.
-- Fresh-volume slot 420; live: psql -f BEFORE the new research and workbench images (they read request_kind), a
-- fresh backup first. Revert: revert-request-boundary.sql (archives what it drops first; restores slot 390's rule).
-- One transaction, the whole file; the lock wait is bounded (as slots 380/390).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── the columns ─────────────────────────────────────────────────────────
-- ADD COLUMN with a constant default is catalogue-only (no table rewrite, no row trigger fires).
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS request_kind TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE public.research_jobs ADD COLUMN IF NOT EXISTS boundary JSONB;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_jobs_request_kind_check') THEN
        ALTER TABLE public.research_jobs ADD CONSTRAINT research_jobs_request_kind_check
            CHECK (request_kind IN ('derived', 'direct', 'personal', 'service', 'unclassified'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_research_jobs_request_kind ON public.research_jobs (request_kind) WHERE request_kind <> 'unclassified';
COMMENT ON COLUMN public.research_jobs.request_kind IS
    'rw-boundary-core (plan 09 2.4): derived = formed by the request boundary (shared output and report, query public); direct = typed by a signed-in user; personal = formed from personal data without the boundary (report private); service = no personal data, a RESEARCH_SERVICE_CALLERS caller; unclassified = every pre-420 row';

-- ── the guard ───────────────────────────────────────────────────────────
-- Round 2 (tester TF8, TF9): an ALLOW-list, not a field list. A derived ROOT's options hold only public_links (an array
-- of http(s) strings), queue_origin (a short name) and model_down_requeues (an integer the engine writes); its boundary
-- only version, lexicon (64 hex), verdict_id (64 hex), topic (<= 80 chars) and evidence (an array of {url, sha256});
-- nested keys included - anything else is refused. EVERY row under a derived root (its gap / inter-hub branches, and a
-- steer, which is 'direct') carries no inlet_ref, no refinery_id and options only lane / queue_origin /
-- model_down_requeues: no seed content, no personal link, nothing an idea stamp could make private.
CREATE OR REPLACE FUNCTION public.request_boundary_options_ok(p_options JSONB, p_root BOOLEAN)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_options IS NULL OR (jsonb_typeof(p_options) = 'object' AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(p_options) e(k, v)
         WHERE NOT CASE
             WHEN e.k = 'public_links' AND p_root THEN jsonb_typeof(e.v) = 'array' AND jsonb_array_length(e.v) <= 5
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e.v) l(x)
                                   WHERE jsonb_typeof(l.x) <> 'string' OR (l.x #>> '{}') !~ '^https?://[^\s?#]+$' OR length(l.x #>> '{}') > 2000)
             WHEN e.k = 'queue_origin' THEN jsonb_typeof(e.v) = 'string' AND (e.v #>> '{}') ~ '^[a-z0-9_-]{1,32}$'
             WHEN e.k = 'model_down_requeues' THEN jsonb_typeof(e.v) = 'number'
             WHEN e.k = 'lane' AND NOT p_root THEN e.v = '"research-branch"'::jsonb
             ELSE false END));
$$;

CREATE OR REPLACE FUNCTION public.request_boundary_stamp_ok(p_boundary JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_boundary IS NOT NULL AND jsonb_typeof(p_boundary) = 'object'
       AND p_boundary ?& ARRAY['version', 'lexicon', 'verdict_id']
       AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(p_boundary) e(k, v)
         WHERE NOT CASE
             WHEN e.k = 'version' THEN jsonb_typeof(e.v) = 'string' AND (e.v #>> '{}') ~ '^[a-z0-9.-]{1,32}$'
             WHEN e.k IN ('lexicon', 'verdict_id') THEN jsonb_typeof(e.v) = 'string' AND (e.v #>> '{}') ~ '^[0-9a-f]{64}$'
             WHEN e.k = 'topic' THEN jsonb_typeof(e.v) = 'string' AND length(e.v #>> '{}') <= 80
             WHEN e.k = 'evidence' THEN jsonb_typeof(e.v) = 'array' AND jsonb_array_length(e.v) <= 5
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e.v) x(o)
                                   WHERE jsonb_typeof(x.o) <> 'object'
                                      OR EXISTS (SELECT 1 FROM jsonb_object_keys(x.o) kk WHERE kk NOT IN ('url', 'sha256'))
                                      OR coalesce(x.o ->> 'url', '') !~ '^https?://[^\s?#]+$' OR length(x.o ->> 'url') > 2000
                                      OR coalesce(x.o ->> 'sha256', '') !~ '^[0-9a-f]{64}$')
             ELSE false END);
$$;

CREATE OR REPLACE FUNCTION public.trg_research_jobs_boundary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_parent TEXT;
    v_root   TEXT;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.parent_job_id IS NOT NULL THEN
        -- a branch takes its parent's kind; a steer on a derived job is its actor's ('direct')
        SELECT j.request_kind INTO v_parent FROM public.research_jobs j WHERE j.id = NEW.parent_job_id;
        IF v_parent IS NOT NULL THEN
            NEW.request_kind := CASE WHEN v_parent = 'derived' AND NEW.branch_kind = 'steer' THEN 'direct' ELSE v_parent END;
        END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.request_kind IS DISTINCT FROM OLD.request_kind
       AND (OLD.request_kind = 'derived' OR NEW.request_kind = 'derived') THEN
        RAISE EXCEPTION 'request boundary: request_kind % -> % refused (nothing becomes derived, a derived job stays derived)',
            OLD.request_kind, NEW.request_kind USING ERRCODE = '23514';
    END IF;
    -- the kind of the tree's root (a root: its own)
    IF NEW.parent_job_id IS NULL AND NEW.root_job_id IS NULL THEN
        v_root := NEW.request_kind;
    ELSE
        SELECT j.request_kind INTO v_root FROM public.research_jobs j WHERE j.id = coalesce(NEW.root_job_id, NEW.parent_job_id);
    END IF;
    IF NEW.request_kind = 'derived' OR v_root = 'derived' THEN
        IF NEW.inlet_ref IS NOT NULL THEN
            RAISE EXCEPTION 'request boundary: a derived job (or a branch of one) carries no inlet_ref' USING ERRCODE = '23514';
        END IF;
        IF NEW.refinery_id IS NOT NULL THEN
            RAISE EXCEPTION 'request boundary: a derived job (or a branch of one) carries no refinery_id' USING ERRCODE = '23514';
        END IF;
        IF NOT public.request_boundary_options_ok(NEW.options, NEW.parent_job_id IS NULL AND NEW.root_job_id IS NULL) THEN
            RAISE EXCEPTION 'request boundary: a derived job''s options hold only the allow-listed keys (public_links, queue_origin, model_down_requeues; a branch: lane, queue_origin, model_down_requeues)'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.parent_job_id IS NULL AND NEW.root_job_id IS NULL THEN
            IF NOT public.request_boundary_stamp_ok(NEW.boundary) THEN
                RAISE EXCEPTION 'request boundary: a derived job carries its boundary stamp and nothing else (version, lexicon, verdict_id, topic, evidence)' USING ERRCODE = '23514';
            END IF;
            IF NEW.anchor IS DISTINCT FROM NEW.query THEN
                RAISE EXCEPTION 'request boundary: a derived job''s anchor is its question' USING ERRCODE = '23514';
            END IF;
            IF NEW.caller IS DISTINCT FROM 'boundary' OR NEW.branch_kind <> 'root' THEN
                RAISE EXCEPTION 'request boundary: a derived root is written by the boundary only (caller boundary, branch_kind root)' USING ERRCODE = '23514';
            END IF;
        ELSIF NEW.boundary IS NOT NULL THEN
            RAISE EXCEPTION 'request boundary: only a derived root carries a boundary stamp' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM public.research_prompts p WHERE p.job_id = NEW.id) AND NEW.request_kind = 'derived' THEN
            RAISE EXCEPTION 'request boundary: a derived job has no research_prompts row (its question is public)' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_research_jobs_boundary() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_research_jobs_boundary ON public.research_jobs;
-- every INSERT; an UPDATE only of the columns the guard reads (the progress / status writes of a running job skip it)
CREATE TRIGGER trg_research_jobs_boundary
    BEFORE INSERT OR UPDATE OF request_kind, boundary, inlet_ref, refinery_id, options, query, anchor, caller, branch_kind, parent_job_id, root_job_id
    ON public.research_jobs FOR EACH ROW EXECUTE FUNCTION public.trg_research_jobs_boundary();

CREATE OR REPLACE FUNCTION public.trg_research_prompts_boundary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.research_jobs j WHERE j.id = NEW.job_id AND j.request_kind = 'derived') THEN
        RAISE EXCEPTION 'request boundary: a derived job has no research_prompts row (its question is public)' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_research_prompts_boundary() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_research_prompts_boundary ON public.research_prompts;
CREATE TRIGGER trg_research_prompts_boundary BEFORE INSERT OR UPDATE ON public.research_prompts
    FOR EACH ROW EXECUTE FUNCTION public.trg_research_prompts_boundary();

-- ── the private hand-back ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.research_handbacks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub      TEXT NOT NULL CHECK (btrim(owner_sub) <> '' AND owner_sub !~* '^(service|system|anonymous):'),
    inlet_kind     TEXT NOT NULL CHECK (inlet_kind IN ('idea', 'gmail', 'google_activity', 'brainstorm', 'document', 'chat')),
    inlet_id       TEXT NOT NULL,          -- the private id: idea id, gmail id, MM post id
    inlet_revision INT,
    purpose        TEXT NOT NULL CHECK (purpose IN ('idea-research', 'digest-article', 'digest-gap', 'brainstorm-gap')),
    job_id         UUID REFERENCES public.research_jobs(id) ON DELETE SET NULL,  -- NULL while pending or refused
    state          TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'refused', 'awaiting_owner', 'delivered', 'failed')),
    verdict        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verdict) = 'object'),
       -- the gate record: {boundary_version, lexicon_version, accepted_by, candidate_sha256, evidence:[{url, sha256}],
       --  refusal, tried, codes, verdict_id} - hashes and codes, never the personal text
    owner_view     JSONB,                  -- awaiting_owner only: the refused candidate and why; owner-only
    deliver        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(deliver) = 'object'),
       -- {idea_id} | {mm_channel, mm_root} | {digest_run, segment, gmail_id, gmail_thread_id, labels} | {episode_id}
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at   TIMESTAMPTZ,
    CHECK (owner_view IS NULL OR state = 'awaiting_owner')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_handback_open ON public.research_handbacks (inlet_kind, inlet_id, purpose)
    WHERE state IN ('pending', 'queued');
CREATE INDEX IF NOT EXISTS idx_handback_job ON public.research_handbacks (job_id);
CREATE INDEX IF NOT EXISTS idx_handback_owner ON public.research_handbacks (owner_sub, created_at DESC);
ALTER TABLE public.research_handbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_handbacks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS handback_owner ON public.research_handbacks;
CREATE POLICY handback_owner ON public.research_handbacks
    USING (owner_sub = public.ob_current_user_id()) WITH CHECK (owner_sub = public.ob_current_user_id());
-- no app role reads or writes the table directly: take back what the schema's default privileges grant
REVOKE ALL ON public.research_handbacks FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.research_handbacks'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_handbacks FROM %I', r.grantee);
    END LOOP;
END $$;
COMMENT ON TABLE public.research_handbacks IS
    'rw-boundary-core (plan 09 2.8): the private hand-back of a derived request - owner-only (forced RLS, no app grant); services read it only through the handback_* SECURITY DEFINER functions';

-- ── the purpose-scoped functions (the only door for the app role; owner rows by the caller-asserted owner) ──
-- the boundary's write (research-service POST /research/derived): a new row, or the open row of the same inlet and
-- purpose (pending / queued: the coalescing research_idea_queue does today) brought up to date
CREATE OR REPLACE FUNCTION public.handback_open(
    p_owner_sub TEXT, p_inlet_kind TEXT, p_inlet_id TEXT, p_inlet_revision INT, p_purpose TEXT, p_job_id UUID,
    p_state TEXT, p_verdict JSONB, p_owner_view JSONB, p_deliver JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id UUID;
BEGIN
    IF p_state NOT IN ('pending', 'queued', 'refused', 'awaiting_owner') THEN
        RAISE EXCEPTION 'handback_open: state % is not an opening state', p_state USING ERRCODE = '22023';
    END IF;
    IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.research_jobs j WHERE j.id = p_job_id AND j.request_kind = 'derived') THEN
        RAISE EXCEPTION 'handback_open: a hand-back names a derived job only' USING ERRCODE = '22023';
    END IF;
    IF p_state IN ('pending', 'queued') THEN
        SELECT h.id INTO v_id FROM public.research_handbacks h
         WHERE h.inlet_kind = p_inlet_kind AND h.inlet_id = p_inlet_id AND h.purpose = p_purpose AND h.state IN ('pending', 'queued')
         FOR UPDATE;
    END IF;
    IF v_id IS NULL THEN
        INSERT INTO public.research_handbacks (owner_sub, inlet_kind, inlet_id, inlet_revision, purpose, job_id, state, verdict, owner_view, deliver)
        VALUES (p_owner_sub, p_inlet_kind, p_inlet_id, p_inlet_revision, p_purpose, p_job_id, p_state,
                coalesce(p_verdict, '{}'::jsonb), p_owner_view, coalesce(p_deliver, '{}'::jsonb))
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.research_handbacks
           SET inlet_revision = p_inlet_revision, job_id = coalesce(p_job_id, job_id), state = p_state,
               verdict = coalesce(p_verdict, verdict), owner_view = p_owner_view, deliver = coalesce(p_deliver, deliver),
               owner_sub = p_owner_sub, updated_at = now()
         WHERE id = v_id;
    END IF;
    RETURN v_id;
END;
$$;

-- the drain (PD0b): pending rows of one purpose, oldest first, locked for this transaction
CREATE OR REPLACE FUNCTION public.handback_pending(p_purpose TEXT, p_limit INT DEFAULT 10)
RETURNS TABLE (id UUID, owner_sub TEXT, inlet_kind TEXT, inlet_id TEXT, inlet_revision INT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT h.id, h.owner_sub, h.inlet_kind, h.inlet_id, h.inlet_revision FROM public.research_handbacks h
     WHERE h.purpose = p_purpose AND h.state = 'pending'
     ORDER BY h.created_at LIMIT greatest(1, least(coalesce(p_limit, 10), 100))
     FOR UPDATE SKIP LOCKED;
$$;

-- the drain records a pending row's outcome: its derived job (queued), or refused / awaiting_owner
CREATE OR REPLACE FUNCTION public.handback_claim(p_id UUID, p_job_id UUID, p_state TEXT, p_verdict JSONB, p_owner_view JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_state NOT IN ('queued', 'refused', 'awaiting_owner') OR (p_state = 'queued') <> (p_job_id IS NOT NULL) THEN
        RAISE EXCEPTION 'handback_claim: queued names its derived job; refused / awaiting_owner name none' USING ERRCODE = '22023';
    END IF;
    IF p_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.research_jobs j WHERE j.id = p_job_id AND j.request_kind = 'derived') THEN
        RAISE EXCEPTION 'handback_claim: a hand-back names a derived job only' USING ERRCODE = '22023';
    END IF;
    UPDATE public.research_handbacks SET job_id = p_job_id, state = p_state, verdict = coalesce(p_verdict, verdict),
           owner_view = CASE WHEN p_state = 'awaiting_owner' THEN p_owner_view END, updated_at = now()
     WHERE id = p_id AND state = 'pending';
    RETURN FOUND;
END;
$$;

-- the delivering services (the refinery: ideas, brainstorm; the digest: article, gap): the finished derived jobs of
-- one purpose and where each goes - no owner, no inlet, no verdict
CREATE OR REPLACE FUNCTION public.handback_deliverables(p_purpose TEXT, p_limit INT DEFAULT 50)
RETURNS TABLE (id UUID, job_id UUID, job_status TEXT, deliver JSONB)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT h.id, h.job_id, j.status, h.deliver FROM public.research_handbacks h JOIN public.research_jobs j ON j.id = h.job_id
     WHERE h.purpose = p_purpose AND h.state = 'queued' AND j.status IN ('done', 'error', 'cancelled')
     ORDER BY j.finished_at NULLS LAST, h.created_at LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
$$;

CREATE OR REPLACE FUNCTION public.handback_delivered(p_id UUID, p_ok BOOLEAN DEFAULT true)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.research_handbacks SET state = CASE WHEN p_ok THEN 'delivered' ELSE 'failed' END,
           delivered_at = CASE WHEN p_ok THEN now() END, updated_at = now()
     WHERE id = p_id AND state = 'queued';
    RETURN FOUND;
END;
$$;

-- the owner's own rows (the workbench passes its signed-in subject, as every per-user read of this plane does)
CREATE OR REPLACE FUNCTION public.handback_owned(p_owner_sub TEXT, p_limit INT DEFAULT 100)
RETURNS TABLE (id UUID, inlet_kind TEXT, inlet_id TEXT, inlet_revision INT, purpose TEXT, job_id UUID, state TEXT,
               verdict JSONB, owner_view JSONB, deliver JSONB, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT h.id, h.inlet_kind, h.inlet_id, h.inlet_revision, h.purpose, h.job_id, h.state, h.verdict, h.owner_view, h.deliver,
           h.created_at, h.updated_at, h.delivered_at
      FROM public.research_handbacks h
     WHERE btrim(coalesce(p_owner_sub, '')) <> '' AND h.owner_sub = p_owner_sub
     ORDER BY h.created_at DESC LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- Round 2 (tester TF2): EXECUTE on the hand-back functions is ob_app_memory's alone (design 2.8: every app container
-- connects as it) - NOT service_role, which is PostgREST's anonymous role (init-grants.sql's default privileges give
-- every new function to service_role: taken back here), not anon / authenticated, not PUBLIC. The same for every other
-- function this file creates (the guards, the allow-list checks). ob_app_memory is created out of band; on a volume
-- where it does not exist yet, run this file again after creating it (idempotent) - until then the door fails closed.
DO $$
DECLARE
    f TEXT;
    r RECORD;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.handback_open(text,text,text,integer,text,uuid,text,jsonb,jsonb,jsonb)', 'public.handback_pending(text,integer)',
        'public.handback_claim(uuid,uuid,text,jsonb,jsonb)', 'public.handback_deliverables(text,integer)',
        'public.handback_delivered(uuid,boolean)', 'public.handback_owned(text,integer)',
        'public.trg_research_jobs_boundary()', 'public.trg_research_prompts_boundary()',
        'public.request_boundary_options_ok(jsonb,boolean)', 'public.request_boundary_stamp_ok(jsonb)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        FOR r IN SELECT DISTINCT ro.rolname FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE p.oid = to_regprocedure(f) AND NOT ro.rolsuper AND ro.oid <> p.proowner
        LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.rolname);
        END LOOP;
        IF f LIKE 'public.handback_%' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ob_app_memory', f);
        END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        RAISE NOTICE 'rw-boundary-core: ob_app_memory does not exist yet - the handback_* functions are executable by nobody until this file runs again after it is created';
    END IF;
END $$;

-- ── archive first: the definitions this file replaces ──────────────────
-- research_job_report_owner (slot 390) and trg_idea_revisions_inlet (slot 230) are saved as the database holds them
-- (pg_get_functiondef: body, settings, signature - whatever line endings the checkout that ran them had), once: a
-- second run keeps the first copy. revert-request-boundary.sql re-creates them from here, byte-identical.
CREATE TABLE IF NOT EXISTS public.research_request_boundary_saved (
    fn       TEXT PRIMARY KEY,
    def      TEXT NOT NULL,
    comment  TEXT,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_request_boundary_saved ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_request_boundary_saved FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.research_request_boundary_saved'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_request_boundary_saved FROM %I', r.grantee);
    END LOOP;
END $$;
INSERT INTO public.research_request_boundary_saved (fn, def, comment)
SELECT f, pg_get_functiondef(to_regprocedure(f)), obj_description(to_regprocedure(f), 'pg_proc')
  FROM unnest(ARRAY['public.research_job_report_owner(uuid)', 'public.trg_idea_revisions_inlet()']) f
 WHERE to_regprocedure(f) IS NOT NULL
ON CONFLICT (fn) DO NOTHING;

-- ── the idea-revision inlet stamp skips a derived job ──────────────────
-- slot 230's trigger copies the idea's id onto a job stamped on an idea revision (inlet_ref, refinery_id). After PD0b
-- the drain stamps a DERIVED job there (plan 09 2.5 P1): the idea id must stay in the hand-back, never on the shared
-- row - the guard above would refuse the stamp. The same function, with that one test added.
CREATE OR REPLACE FUNCTION public.trg_idea_revisions_inlet()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.research_job_id IS NOT NULL
       AND NEW.research_job_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND (TG_OP = 'INSERT' OR NEW.research_job_id IS DISTINCT FROM OLD.research_job_id) THEN
        UPDATE public.research_jobs j
           SET inlet_ref = COALESCE(NULLIF(j.inlet_ref, 'null'::jsonb), jsonb_build_object('kind', 'idea', 'id', NEW.idea_id::text)),
               refinery_id = COALESCE(j.refinery_id, NEW.idea_id)
         WHERE j.id = NEW.research_job_id::uuid
           AND j.request_kind <> 'derived'   -- rw-boundary-core: a derived job carries no inlet ...
           AND NOT EXISTS (SELECT 1 FROM public.research_jobs r WHERE r.id = j.root_job_id AND r.request_kind = 'derived');   -- ... nor a branch of one
    END IF;
    RETURN NEW;
END;
$$;

-- ── the report-owner rule: a derived root's report is shared ────────────
-- slot 390's research_job_report_owner, with ONE added test: when the job's root is a derived job, no row (plan 09
-- section 4 - after PD0b the drain stamps idea_revisions.research_job_id with a derived job's id; without this test
-- the revision branch below would class it an idea job and make its report private).
CREATE OR REPLACE FUNCTION public.research_job_report_owner(p_job UUID)
RETURNS TABLE (idea_id UUID, owner_sub TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_jobs   UUID[];
    v_hit    BOOLEAN;
    v_idea   UUID;
BEGIN
    IF p_job IS NULL THEN RETURN; END IF;
    -- rw-boundary-core (slot 420): a derived request's research is shared knowledge, whatever points at it
    IF EXISTS (SELECT 1 FROM public.research_jobs j JOIN public.research_jobs r ON r.id = coalesce(j.root_job_id, j.id)
                WHERE j.id = p_job AND r.request_kind = 'derived') THEN
        RETURN;
    END IF;
    -- the job and the root of its tree (a steer / gap branch of an idea's research is the idea's research)
    SELECT array_agg(x) INTO v_jobs FROM (
        SELECT j.id AS x FROM public.research_jobs j WHERE j.id = p_job
        UNION SELECT j.root_job_id FROM public.research_jobs j WHERE j.id = p_job AND j.root_job_id IS NOT NULL) s;
    IF v_jobs IS NULL THEN RETURN; END IF;
    SELECT bool_or(j.branch_kind = 'idea' OR j.refinery_id IS NOT NULL),
           (array_agg(j.refinery_id ORDER BY (j.id = p_job) DESC) FILTER (WHERE j.refinery_id IS NOT NULL))[1]
      INTO v_hit, v_idea
      FROM public.research_jobs j WHERE j.id = ANY(v_jobs);
    IF v_idea IS NULL THEN
        SELECT r.idea_id INTO v_idea FROM public.idea_revisions r
         WHERE lower(r.research_job_id) = ANY(SELECT x::text FROM unnest(v_jobs) x)
         ORDER BY r.created_at DESC LIMIT 1;
        v_hit := coalesce(v_hit, false) OR FOUND;
    END IF;
    IF NOT coalesce(v_hit, false) THEN RETURN; END IF;
    idea_id := v_idea;
    owner_sub := (SELECT NULLIF(i.owner_sub, '') FROM public.ideas i WHERE i.id = v_idea);
    RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.research_job_report_owner(UUID) IS
    'rw-report-isolation + rw-boundary-core: no row = not an idea job, or a derived request''s (its report is shared); a row = an idea job, its report private to owner_sub (NULL: to nobody)';

NOTIFY pgrst, 'reload schema';
COMMIT;
