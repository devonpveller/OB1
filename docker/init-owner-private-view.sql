-- ============================================================
-- The owner's private view (research-workbench rw-owner-private-view, plan 08 PD-PV). Slot 480, after rw-inlet-owner's
-- 440 (the owner-private stores it reads) and rw-inlet-stamp's 470 (independent of it).
--
-- What it adds (it writes and moves NO row, so it keeps no archive):
--   1. ob_workbench: the workbench's OWN login role (LOGIN INHERIT NOSUPERUSER NOBYPASSRLS, no password here). It is a
--      member of ob_app_memory, so it keeps every table grant, policy and service_role path the workbench had. Ten
--      services log in as ob_app_memory; the identity seam exists only in the workbench, so an owner-argument function
--      executable by ob_app_memory is executable, with any subject, by the research service, openbrain-mcp, the curator
--      and the workers. The functions below are executable by ob_workbench ALONE (decision D1, coordinator 2026-11-05).
--      The password is set out of band from OB_WORKBENCH_DB_PASSWORD (the ob_app_memory / ob_pantry way):
--        docker exec -it openbrain-db psql -U postgres -d openbrain -c "\password ob_workbench"   (it prompts; never echoed)
--      A role created outside the chain (ob_app_memory, after a rebuilt volume) gets the membership on the next run of
--      this file.
--   2. PD1's two owner reads, inlet_private_source(uuid,text) and inlet_private_job(uuid,text): EXECUTE moves from
--      ob_app_memory to ob_workbench (their only callers are the workbench's). A 440 re-run grants them back to
--      ob_app_memory: RE-RUN THIS FILE AFTER ANY 440 RE-RUN. The drift is reported here (a NOTICE naming each
--      signature, before it is fixed) and by the deploy pre-check (check-owner-private-view.sql, read-only).
--   3. The owner-scoped reads (SECURITY DEFINER, STABLE, search_path public, pg_temp), each taking the subject the
--      workbench's identity seam resolved and answering NOTHING unless that subject is usable (the 470 rule:
--      a subject's shape, never service: / system: / anonymous:, never the literal 'operator'). Every row is filtered on
--      ITS OWN owner column, never on the inlet_owner singleton, so a second owner's rows are apart from the start.
--      Limits are clamped inside. No count, no total.
--        owner_private_claims(p_sub, p_id, p_q, p_kind, p_source, p_before, p_before_id, p_limit)
--            the owner's private claims (inlet_private_claims, their own edges in inlet_private_claim_sources) and the
--            shared claims that carry one of the owner's private links (inlet_private_claim_links: kind 'mixed'),
--            with the private sources, the private parents and, for a mixed claim, its shared grounding beside them
--        owner_private_source_text(p_sub, p_q, p_kind, p_limit)   text search over the owner's moved sources
--        owner_private_source_knn(p_sub, p_vec, p_kind, p_limit)  exact KNN over the moved chunks' kept embeddings
--                                                                 (no index, no shared table)
--        owner_private_has_sources(p_sub)                         whether there is anything to search (before an
--                                                                 embedding is asked for)
--        owner_private_jobs(p_sub, p_before, p_before_id, p_limit) the owner's seeded jobs, their question read
--                                                                 through PD1's inlet_private_job
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f init-owner-private-view.sql
-- Refused (nothing changed) unless 440 (round 5 or later: inlet_private_claim_sources) is applied. Idempotent: a second
-- run has nothing to do. One transaction, lock_timeout 10s. Fresh volume: slot 480 (an empty database: the role and the
-- functions; the membership when ob_app_memory exists). Live: psql -f after 440 / 470, BEFORE the workbench image that
-- logs in as ob_workbench (the running one keeps working; its two PD1 reads fail closed to the neutral answer until it
-- is recreated). Revert: revert-owner-private-view.sql. Slot 450's door: no door role reads anything here (no map line).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = warning;
DO $$
BEGIN
    IF to_regprocedure('public.inlet_private_source(uuid,text)') IS NULL
       OR to_regprocedure('public.inlet_private_job(uuid,text)') IS NULL
       OR to_regclass('public.inlet_private_claim_sources') IS NULL THEN
        RAISE EXCEPTION 'owner private view: slot 440 (init-inlet-owner.sql, round 5 or later) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;

-- ── 1. the workbench's own login role ──────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        CREATE ROLE ob_workbench LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    ELSE
        -- the shape, again (a revert that found sessions left it NOLOGIN)
        ALTER ROLE ob_workbench LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        IF NOT pg_has_role('ob_workbench', 'ob_app_memory', 'MEMBER') THEN
            GRANT ob_app_memory TO ob_workbench;
        END IF;
    ELSE
        RAISE WARNING 'owner private view: ob_app_memory does not exist (yet): ob_workbench has no table grants until it does - create it and run this file again';
    END IF;
END $$;
COMMENT ON ROLE ob_workbench IS
  'rw-owner-private-view (slot 480): the workbench''s own login role (a member of ob_app_memory); the only role that may run the owner-scoped private reads. Password set out of band (OB_WORKBENCH_DB_PASSWORD).';

-- ── 2. the drift a 440 re-run leaves (PD1's grants back on ob_app_memory), said before it is fixed ──────────────────
SET LOCAL client_min_messages = notice;
DO $$
DECLARE f TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN RETURN; END IF;
    FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND (p.proname LIKE 'inlet\_private\_%' OR p.proname LIKE 'owner\_private\_%')
                AND has_function_privilege('ob_app_memory', p.oid, 'EXECUTE')
              ORDER BY 1 LOOP
        RAISE NOTICE 'owner private view: drift - % is executable by ob_app_memory (a 440 re-run?): moved to ob_workbench', f;
    END LOOP;
END $$;
SET LOCAL client_min_messages = warning;

-- ── 3. the owner-scoped reads ──────────────────────────────────────────────────────────────────────────────────────
-- the subject rule (slot 470's inlet_subject_ok, inline: this file does not need 470). Executable by nobody: only the
-- functions below (SECURITY DEFINER, run as their owner) call it.
CREATE OR REPLACE FUNCTION public.owner_private_subject_ok(p_subject TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT p_subject IS NOT NULL
       AND p_subject ~ '^[A-Za-z0-9][A-Za-z0-9._@|+=:/-]{0,254}$'
       AND p_subject !~* '^(service|system|anonymous):'
       AND lower(p_subject) <> 'operator'
$$;

-- what a moved source is, for the owner's eyes ('email' | 'podcast' | 'other'), from its own row (440's predicate)
CREATE OR REPLACE FUNCTION public.owner_private_source_kind(p_url TEXT, p_content_type TEXT, p_meta JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT CASE WHEN coalesce(p_url, '') ~* 'mail\.google\.com' THEN 'email'
                WHEN p_meta ->> 'source' = 'daily-digest-podcast' OR p_content_type = 'podcast_transcript' THEN 'podcast'
                ELSE 'other' END
$$;

CREATE OR REPLACE FUNCTION public.owner_private_claims(
    p_sub TEXT, p_id UUID DEFAULT NULL, p_q TEXT DEFAULT NULL, p_kind TEXT DEFAULT 'all', p_source UUID DEFAULT NULL,
    p_before TIMESTAMPTZ DEFAULT NULL, p_before_id UUID DEFAULT NULL, p_limit INT DEFAULT 50)
RETURNS TABLE (id UUID, kind TEXT, text TEXT, status TEXT, epistemic_tag TEXT, confidence REAL, contradicted BOOLEAN,
               created_at TIMESTAMPTZ, private_sources JSONB, private_parents JSONB, shared_sources JSONB)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH ok AS (SELECT public.owner_private_subject_ok(p_sub) AS yes),
    priv AS (
        SELECT c.id, 'private'::text AS kind, c.text, c.status, c.epistemic_tag, c.confidence, c.contradicted, c.created_at
          FROM public.inlet_private_claims c, ok
         WHERE ok.yes AND c.inlet_owner_sub = p_sub AND coalesce(p_kind, 'all') IN ('all', 'private')
    ),
    mixed AS (
        SELECT c.id, 'mixed'::text AS kind, c.text, c.status, c.epistemic_tag, c.confidence, c.contradicted, c.created_at
          FROM public.claims c, ok
         WHERE ok.yes AND coalesce(p_kind, 'all') IN ('all', 'mixed')
           AND EXISTS (SELECT 1 FROM public.inlet_private_claim_links l WHERE l.claim_id = c.id AND l.owner_sub = p_sub)
           AND NOT EXISTS (SELECT 1 FROM public.inlet_private_claims pc WHERE pc.id = c.id AND pc.inlet_owner_sub = p_sub)
    ),
    base AS (SELECT * FROM priv UNION ALL SELECT * FROM mixed),
    picked AS (
        SELECT b.* FROM base b
         WHERE (p_id IS NULL OR b.id = p_id)
           AND (coalesce(btrim(p_q), '') = '' OR b.text ILIKE '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%')
           AND (p_before IS NULL OR (b.created_at, b.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
           AND (p_source IS NULL
                OR EXISTS (SELECT 1 FROM public.inlet_private_claim_sources e WHERE e.claim_id = b.id AND e.owner_sub = p_sub AND e.source_id = p_source)
                OR EXISTS (SELECT 1 FROM public.inlet_private_claim_links l WHERE l.claim_id = b.id AND l.owner_sub = p_sub AND l.source_id = p_source))
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
    )
    SELECT p.id, p.kind, p.text, p.status, p.epistemic_tag, p.confidence, p.contradicted, p.created_at,
           -- the owner's private sources of this claim: a private claim's own source edges, a mixed claim's private links
           coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', s.id, 'title', coalesce(s.title, ''),
                                     'kind', public.owner_private_source_kind(s.url, s.content_type, s.metadata), 'created_at', s.created_at))
                       FROM public.inlet_private_sources s
                      WHERE s.inlet_owner_sub = p_sub
                        AND s.id IN (SELECT e.source_id FROM public.inlet_private_claim_sources e WHERE e.claim_id = p.id AND e.owner_sub = p_sub AND e.source_id IS NOT NULL
                                     UNION SELECT l.source_id FROM public.inlet_private_claim_links l WHERE l.claim_id = p.id AND l.owner_sub = p_sub)),
                    '[]'::jsonb),
           -- a private claim's private parents (the chain rule: a claim grounded on a private claim is private too)
           coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', pc.id, 'text', pc.text))
                       FROM public.inlet_private_claims pc
                      WHERE pc.inlet_owner_sub = p_sub
                        AND pc.id IN (SELECT e.parent_claim_id FROM public.inlet_private_claim_sources e WHERE e.claim_id = p.id AND e.owner_sub = p_sub AND e.parent_claim_id IS NOT NULL)),
                    '[]'::jsonb),
           -- a mixed claim's shared grounding, as any user sees it (a live shared source: not retracted, not purged)
           CASE WHEN p.kind = 'mixed' THEN
               coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', s.id, 'title', coalesce(s.title, ''), 'url', coalesce(s.url, '')))
                           FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
                          WHERE cs.claim_id = p.id AND s.retracted_at IS NULL AND NOT coalesce((s.metadata ->> 'purged')::boolean, false)),
                        '[]'::jsonb)
           ELSE '[]'::jsonb END
      FROM picked p
     ORDER BY p.created_at DESC, p.id DESC
$$;

CREATE OR REPLACE FUNCTION public.owner_private_source_text(p_sub TEXT, p_q TEXT, p_kind TEXT DEFAULT 'all', p_limit INT DEFAULT 20)
RETURNS TABLE (source_id UUID, title TEXT, kind TEXT, created_at TIMESTAMPTZ, idx INT, snippet TEXT, rank REAL)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH q AS (SELECT websearch_to_tsquery('simple', coalesce(p_q, '')) AS tq
                WHERE public.owner_private_subject_ok(p_sub) AND length(btrim(coalesce(p_q, ''))) >= 2),
    src AS (
        SELECT s.id, coalesce(s.title, '') AS title, public.owner_private_source_kind(s.url, s.content_type, s.metadata) AS kind,
               s.created_at, s.content
          FROM public.inlet_private_sources s
         WHERE s.inlet_owner_sub = p_sub AND public.owner_private_subject_ok(p_sub)
    ),
    hits AS (
        -- a chunk of a moved source (its text, or its source's title)
        SELECT src.id, src.title, src.kind, src.created_at, ch.idx,
               ts_headline('simple', ch.content, q.tq, 'StartSel=<<HL>>, StopSel=<</HL>>, MaxWords=30, MinWords=12, ShortWord=3, MaxFragments=1, FragmentDelimiter=" ... "') AS snippet,
               ts_rank(to_tsvector('simple', src.title || ' ' || ch.content), q.tq) AS rank
          FROM src CROSS JOIN q
          JOIN public.inlet_private_source_chunks ch ON ch.source_id = src.id AND ch.inlet_owner_sub = p_sub
         WHERE to_tsvector('simple', src.title || ' ' || ch.content) @@ q.tq
        UNION ALL
        -- a moved source with no chunk: its own body
        SELECT src.id, src.title, src.kind, src.created_at, -1,
               ts_headline('simple', coalesce(src.content, ''), q.tq, 'StartSel=<<HL>>, StopSel=<</HL>>, MaxWords=30, MinWords=12, ShortWord=3, MaxFragments=1, FragmentDelimiter=" ... "'),
               ts_rank(to_tsvector('simple', src.title || ' ' || coalesce(src.content, '')), q.tq)
          FROM src CROSS JOIN q
         WHERE NOT EXISTS (SELECT 1 FROM public.inlet_private_source_chunks ch WHERE ch.source_id = src.id AND ch.inlet_owner_sub = p_sub)
           AND to_tsvector('simple', src.title || ' ' || coalesce(src.content, '')) @@ q.tq
    )
    SELECT h.id, h.title, h.kind, h.created_at, h.idx, h.snippet, h.rank::real
      FROM hits h
     WHERE coalesce(p_kind, 'all') IN ('all', h.kind)
     ORDER BY h.rank DESC, h.created_at DESC, h.id, h.idx
     LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

CREATE OR REPLACE FUNCTION public.owner_private_source_knn(p_sub TEXT, p_vec vector, p_kind TEXT DEFAULT 'all', p_limit INT DEFAULT 20)
RETURNS TABLE (source_id UUID, title TEXT, kind TEXT, created_at TIMESTAMPTZ, idx INT, snippet TEXT, distance REAL)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.id, coalesce(s.title, ''), public.owner_private_source_kind(s.url, s.content_type, s.metadata), s.created_at, ch.idx,
           left(ch.content, 300), (ch.embedding <=> p_vec)::real
      FROM public.inlet_private_source_chunks ch
      JOIN public.inlet_private_sources s ON s.id = ch.source_id AND s.inlet_owner_sub = p_sub
     WHERE public.owner_private_subject_ok(p_sub) AND p_vec IS NOT NULL
       AND ch.inlet_owner_sub = p_sub AND ch.embedding IS NOT NULL
       AND coalesce(p_kind, 'all') IN ('all', public.owner_private_source_kind(s.url, s.content_type, s.metadata))
     ORDER BY ch.embedding <=> p_vec, s.id, ch.idx
     LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

CREATE OR REPLACE FUNCTION public.owner_private_has_sources(p_sub TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.owner_private_subject_ok(p_sub)
       AND EXISTS (SELECT 1 FROM public.inlet_private_source_chunks ch WHERE ch.inlet_owner_sub = p_sub AND ch.embedding IS NOT NULL)
$$;

CREATE OR REPLACE FUNCTION public.owner_private_jobs(p_sub TEXT, p_before TIMESTAMPTZ DEFAULT NULL, p_before_id UUID DEFAULT NULL, p_limit INT DEFAULT 50)
RETURNS TABLE (job_id UUID, root_job_id UUID, created_at TIMESTAMPTZ, state TEXT, query TEXT)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT j.id, j.root_job_id, j.created_at, j.status, t.query
      FROM (SELECT DISTINCT p.job_id FROM public.inlet_private_jobs p
             WHERE public.owner_private_subject_ok(p_sub) AND p.owner_sub = p_sub) o
      JOIN public.research_jobs j ON j.id = o.job_id
      -- the text through PD1's own read (the oldest live copy, owner-checked again there)
      CROSS JOIN LATERAL public.inlet_private_job(o.job_id, p_sub) t
     WHERE p_before IS NULL OR (j.created_at, j.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- ── 4. who may run them: ob_workbench alone (and PD1's two reads move to it) ─────────────────────────────────────────
DO $$
DECLARE f TEXT; r RECORD;
BEGIN
    FOREACH f IN ARRAY ARRAY['public.owner_private_subject_ok(text)', 'public.owner_private_source_kind(text,text,jsonb)',
                             'public.owner_private_claims(text,uuid,text,text,uuid,timestamptz,uuid,integer)',
                             'public.owner_private_source_text(text,text,text,integer)', 'public.owner_private_source_knn(text,vector,text,integer)',
                             'public.owner_private_has_sources(text)', 'public.owner_private_jobs(text,timestamptz,uuid,integer)',
                             'public.inlet_private_source(uuid,text)', 'public.inlet_private_job(uuid,text)'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_proc pr, aclexplode(pr.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE pr.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> pr.proowner AND ro.rolname <> 'ob_workbench' LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.grantee);
        END LOOP;
    END LOOP;
    GRANT EXECUTE ON FUNCTION public.owner_private_claims(TEXT, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, UUID, INT) TO ob_workbench;
    GRANT EXECUTE ON FUNCTION public.owner_private_source_text(TEXT, TEXT, TEXT, INT) TO ob_workbench;
    GRANT EXECUTE ON FUNCTION public.owner_private_source_knn(TEXT, vector, TEXT, INT) TO ob_workbench;
    GRANT EXECUTE ON FUNCTION public.owner_private_has_sources(TEXT) TO ob_workbench;
    GRANT EXECUTE ON FUNCTION public.owner_private_jobs(TEXT, TIMESTAMPTZ, UUID, INT) TO ob_workbench;
    GRANT EXECUTE ON FUNCTION public.inlet_private_source(UUID, TEXT) TO ob_workbench;
    GRANT EXECUTE ON FUNCTION public.inlet_private_job(UUID, TEXT) TO ob_workbench;
END $$;
COMMENT ON FUNCTION public.owner_private_claims(TEXT, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, UUID, INT) IS
  'rw-owner-private-view (slot 480): the subject''s private claims and the shared claims carrying their private link; nothing for any other subject. ob_workbench only.';

SET LOCAL client_min_messages = notice;
DO $$ BEGIN RAISE NOTICE 'owner private view: ob_workbench and the owner-scoped reads are in place (ob_workbench alone executes them and PD1''s two reads)'; END $$;
COMMIT;
