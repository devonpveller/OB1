-- ============================================================
-- The digest through the request boundary (research-workbench rw-boundary-digest, plan 09 PD0c). Slot 460.
-- Operator 2026-11-04 ("PD0: approved", defaults D1-D12). On slot 420 (rw-boundary-core).
--
--   * request_boundary_options_ok (slot 420's allow-list on a derived job's options): a derived ROOT may also carry
--     the engine's RUN knobs the digest needs - mode 'article', gap_research 'none' | 'preliminary', dry_run (a
--     boolean) and deadline_at (the one stored ISO shape). Fixed values, a flag and a time: nothing a caller wrote.
--     Everything else stays refused (420's TF8 allow-list, unchanged for every other key and for branches).
--   * podcast_episodes.transcript: the daily episode's script, on the OWNER's private episode row (owner_sub, shared
--     false) - plan 09 2.5 P6: the transcript stops being a shared sources row (podcast_transcript).
--   * handback_deliver(job, caller, ok, note): the delivering caller records that it used a derived job, on the
--     PRIVATE hand-back: state delivered / failed, and at most the episode it fed and the thread it resolved to
--     ({episode_id, thread_id}, uuids). Only the caller that opened the hand-back (deliver.caller, stamped by the
--     research service's door), only a queued row. EXECUTE for ob_app_memory only (420's TF2 rule).
-- Fresh-volume slot 460; live: psql -f AFTER 420, BEFORE the new research image and before the digest code moves (the
-- OB1 gitlink: openbrain-podcast bind-mounts the recipe), a fresh backup first. 420's grant re-run (DN-3) replaces
-- request_boundary_options_ok with 420's body: re-run THIS file after it. Revert: revert-boundary-digest.sql
-- (archives the transcripts first; restores 420's allow-list from the copy saved here).
-- One transaction, the whole file; the lock wait is bounded (as slots 380/390/420).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── the replaced definition, saved first (once: a second run keeps the first copy) ───────────────
CREATE TABLE IF NOT EXISTS public.research_boundary_digest_saved (
    fn       TEXT PRIMARY KEY,
    def      TEXT NOT NULL,
    comment  TEXT,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.research_boundary_digest_saved ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_boundary_digest_saved FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.research_boundary_digest_saved'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner
    LOOP
        EXECUTE format('REVOKE ALL ON public.research_boundary_digest_saved FROM %I', r.grantee);
    END LOOP;
END $$;
INSERT INTO public.research_boundary_digest_saved (fn, def, comment)
SELECT f, pg_get_functiondef(to_regprocedure(f)), obj_description(to_regprocedure(f), 'pg_proc')
  FROM unnest(ARRAY['public.request_boundary_options_ok(jsonb,boolean)']) f
 WHERE to_regprocedure(f) IS NOT NULL
ON CONFLICT (fn) DO NOTHING;

-- ── the allow-list: 420's, plus a ROOT's run knobs ───────────────────────────────────────────────
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
             -- rw-boundary-digest (slot 460): how a derived ROOT runs - never what it is about
             WHEN e.k = 'mode' AND p_root THEN e.v = '"article"'::jsonb
             WHEN e.k = 'gap_research' AND p_root THEN e.v IN ('"none"'::jsonb, '"preliminary"'::jsonb)
             WHEN e.k = 'dry_run' AND p_root THEN jsonb_typeof(e.v) = 'boolean'
             WHEN e.k = 'deadline_at' AND p_root THEN jsonb_typeof(e.v) = 'string'
                  AND (e.v #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
             ELSE false END));
$$;
COMMENT ON FUNCTION public.request_boundary_options_ok(jsonb, boolean) IS
    'rw-boundary-core TF8 + rw-boundary-digest (slot 460): a derived job''s options allow-list - root: public_links, queue_origin, model_down_requeues, mode (article), gap_research (none|preliminary), dry_run (boolean), deadline_at (ISO); branch: lane, queue_origin, model_down_requeues';

-- ── the owner's private transcript ─────────────────────────────────────────────────────────────
-- ADD COLUMN with no default is catalogue-only (no rewrite, no row trigger). podcast_episodes is already the owner's:
-- the workbench lists a row to its owner_sub, or to everyone only when shared (the digest writes shared = false).
ALTER TABLE public.podcast_episodes ADD COLUMN IF NOT EXISTS transcript TEXT;
COMMENT ON COLUMN public.podcast_episodes.transcript IS
    'rw-boundary-digest (plan 09 2.5 P6): the episode''s script, private to owner_sub (the daily digest''s loop-close writes it here instead of a shared podcast_transcript source)';

-- ── the delivery record on the hand-back ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handback_deliver(p_job_id UUID, p_caller TEXT, p_ok BOOLEAN, p_note JSONB DEFAULT '{}'::jsonb)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_note JSONB := '{}'::jsonb;
    k TEXT;
BEGIN
    IF p_note IS NOT NULL AND jsonb_typeof(p_note) <> 'object' THEN
        RAISE EXCEPTION 'handback_deliver: the note is an object' USING ERRCODE = '22023';
    END IF;
    FOR k IN SELECT jsonb_object_keys(coalesce(p_note, '{}'::jsonb)) LOOP
        IF k NOT IN ('episode_id', 'thread_id') THEN
            RAISE EXCEPTION 'handback_deliver: the note carries only episode_id and thread_id' USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(p_note -> k) <> 'string'
           OR (p_note ->> k) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'handback_deliver: % is a uuid', k USING ERRCODE = '22023';
        END IF;
        v_note := v_note || jsonb_build_object(k, p_note ->> k);
    END LOOP;
    UPDATE public.research_handbacks
       SET state = CASE WHEN p_ok THEN 'delivered' ELSE 'failed' END,
           delivered_at = CASE WHEN p_ok THEN now() END,
           deliver = deliver || v_note,
           updated_at = now()
     WHERE job_id = p_job_id AND state = 'queued'
       AND btrim(coalesce(p_caller, '')) <> '' AND deliver ->> 'caller' = p_caller;
    RETURN FOUND;
END;
$$;
COMMENT ON FUNCTION public.handback_deliver(uuid, text, boolean, jsonb) IS
    'rw-boundary-digest (slot 460): the delivering caller (the one that opened the hand-back) records a derived job delivered / failed, with at most {episode_id, thread_id}';

-- 420's TF2 rule: EXECUTE for ob_app_memory only - not PUBLIC, not service_role (PostgREST's anonymous role: init-grants'
-- default privileges hand every new function to it), not anon / authenticated. The replaced allow-list keeps 420's
-- revoke (CREATE OR REPLACE keeps the ACL); revoked again here, whatever the order.
DO $$
DECLARE
    f TEXT;
    r RECORD;
BEGIN
    FOREACH f IN ARRAY ARRAY['public.handback_deliver(uuid,text,boolean,jsonb)', 'public.request_boundary_options_ok(jsonb,boolean)'] LOOP
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
END $$;

COMMIT;
