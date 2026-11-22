-- ============================================================
-- Starting research from the workbench (research-workbench redesign, rwr-research-start-api). Slot 540.
-- On slot 420 (rw-boundary-core) and 460 (rw-boundary-digest).
--
--   * research_handbacks.purpose: 'user-start' joins the four purposes. A run the signed-in user starts (attached to
--     nothing, a document or an idea) is formed by the request boundary like every personal path; its private
--     hand-back says which purpose opened it. (A CHECK on the column: the old one is dropped and re-added widened.)
--   * request_boundary_options_ok (420's allow-list, widened by 460): a derived job's options may also carry
--     `contract` = {"budget": {rounds, max_fetch, wall_ms}} - the depth preset (quick | standard | deep) the research
--     service resolved INSIDE the admin ceilings (depth.ts: min(preset, MAX_ROUNDS / MAX_FETCH / MAX_WALL_MS)).
--     Numbers only (1 to 9 digits), no other key under `contract`, no source list, no red line. On a root AND on a
--     branch: a gap branch of a derived root inherits its parent's narrowed contract (tree.ts inheritOptions), and
--     narrowContract of a budget-only parent is budget-only. Everything else stays refused, 420's and 460's rules
--     unchanged.
-- Fresh-volume slot 540; live: psql -f AFTER 420 and 460 and BEFORE the new research and workbench images, a fresh
-- backup first (a gated deploy, never a side effect of a merge). 420's grant re-run (DN-3) and 460's file replace
-- request_boundary_options_ok with their bodies: re-run THIS file after either. Revert: revert-research-start.sql
-- (archives the 'user-start' hand-backs first; restores the definition from the copy saved here).
-- One transaction, the whole file; the lock wait is bounded (as slots 380/390/420/460).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── the replaced definition, saved first (once: a second run keeps the first copy) ───────────────
CREATE TABLE IF NOT EXISTS public.research_start_saved (
    fn       TEXT PRIMARY KEY,
    def      TEXT NOT NULL,
    comment  TEXT,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_start_saved ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_start_saved FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.research_start_saved'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_start_saved FROM %I', r.grantee);
    END LOOP;
END $$;
INSERT INTO public.research_start_saved (fn, def, comment)
SELECT f, pg_get_functiondef(to_regprocedure(f)), obj_description(to_regprocedure(f), 'pg_proc')
  FROM unnest(ARRAY['public.request_boundary_options_ok(jsonb,boolean)']) f
 WHERE to_regprocedure(f) IS NOT NULL
ON CONFLICT (fn) DO NOTHING;

-- ── the purpose CHECK, widened ────────────────────────────────────────────────────────────────
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'public.research_handbacks'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%purpose%' AND pg_get_constraintdef(oid) LIKE '%brainstorm-gap%'
    LOOP
        EXECUTE format('ALTER TABLE public.research_handbacks DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;
ALTER TABLE public.research_handbacks ADD CONSTRAINT research_handbacks_purpose_check
    CHECK (purpose IN ('idea-research', 'digest-article', 'digest-gap', 'brainstorm-gap', 'user-start'));

-- ── the allow-list: 420's and 460's, plus a depth budget ──────────────────────────────────────────
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
             WHEN e.k = 'mode' AND p_root THEN e.v = '"article"'::jsonb
             WHEN e.k = 'gap_research' AND p_root THEN e.v IN ('"none"'::jsonb, '"preliminary"'::jsonb)
             WHEN e.k = 'dry_run' AND p_root THEN jsonb_typeof(e.v) = 'boolean'
             WHEN e.k = 'deadline_at' AND p_root THEN jsonb_typeof(e.v) = 'string'
                  AND (e.v #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
             -- rwr-research-start-api (slot 540): how big a run may be - numbers the research service chose, never what it is about
             WHEN e.k = 'contract' THEN jsonb_typeof(e.v) = 'object'
                  AND (SELECT count(*) FROM jsonb_object_keys(e.v)) = 1 AND e.v ? 'budget' AND jsonb_typeof(e.v -> 'budget') = 'object'
                  AND NOT EXISTS (SELECT 1 FROM jsonb_each(e.v -> 'budget') b(k, v)
                                   WHERE NOT (b.k IN ('rounds', 'max_fetch', 'wall_ms') AND jsonb_typeof(b.v) = 'number' AND (b.v #>> '{}') ~ '^[1-9][0-9]{0,8}$'))
             ELSE false END));
$$;
COMMENT ON FUNCTION public.request_boundary_options_ok(jsonb, boolean) IS
    'rw-boundary-core TF8 + rw-boundary-digest (slot 460) + rwr-research-start-api (slot 540): a derived job''s options allow-list - root: public_links, queue_origin, model_down_requeues, mode (article), gap_research (none|preliminary), dry_run (boolean), deadline_at (ISO), contract {budget: {rounds, max_fetch, wall_ms}}; branch: lane, queue_origin, model_down_requeues, contract {budget}';

-- 420's TF2 rule: EXECUTE for ob_app_memory only (CREATE OR REPLACE keeps the ACL; revoked again, whatever the order)
DO $$
DECLARE
    f TEXT := 'public.request_boundary_options_ok(jsonb,boolean)';
    r RECORD;
BEGIN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT DISTINCT ro.rolname FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE p.oid = to_regprocedure(f) AND NOT ro.rolsuper AND ro.oid <> p.proowner
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.rolname);
    END LOOP;
END $$;

COMMIT;
