-- ============================================================
-- A claim drawn from a private report is private to the report's owner (research-workbench rw-private-report-claims).
-- Slot 570 (400-560 are taken or reserved).
-- Operator 2026-11-21: "any information generated from private data remains private since it could leak through a
-- generated series." This reverses slot 390's choice (init-report-isolation.sql: the claims of a private idea report
-- stayed SHARED, claims.synthesis_id NULL, linked back in research_private_report_claims). A claim's text is the
-- private report's own sentence, so the claim carries the report's words.
--
-- THE REPRESENTATION is PD1's (slot 440), reused, not a second one: a private claim lives in
-- public.inlet_private_claims (the claims table's own columns + inlet_owner_sub + inlet_batch), its edges in
-- public.inlet_private_claim_sources (owner_sub, the claim_sources row as it was). Nothing shared reads those stores
-- (forced RLS, no policy, no grant); every shared reader reads public.claims / public.claim_sources, so a claim that is
-- not there is excluded from contract/claims, search (text and vector), chunk context, timeline, quality, dependence,
-- references, neighbours, the wiki compile, the research service's reuse, the digest and MCP BY CONSTRUCTION - no
-- reader has to remember a filter. The owner reads them through their idea (private_report_claims_of_idea below) and
-- through slot 480's owner_private_claims (it reads inlet_private_claims by owner).
--
-- THE RULE keys on the REPORT being private, never on the job kind: a claim linked in research_private_report_claims
-- to any research_private_reports row (an idea job's today; any other private report a later slot files there, plan
-- 09's 'personal' runs included) is private, unless a SHARED synthesis also filed it (claims.synthesis_id set: the
-- same text in the same thread came out of a shared report too - shared knowledge, kept shared, counted as "mixed").
--   * one owner: the claim moves to that owner's store, with its own edges;
--   * no valid owner (the idea is gone: owner_sub NULL) or several owners (two users' private reports produced the same
--     text in the same thread): the claim leaves the shared table and is WITHHELD - archived only, read by nobody;
--   * every claim_sources edge of a moved claim, and every edge of a shared claim onto it (a 'contradicts' edge the
--     conflict detector drew, a parent edge), is archived, then deleted; every shared claim that loses an edge is
--     archived whole first (its confidence is recomputed when the edge goes);
--   * every research job result (result.claims / result.reuse_claims) that names a moved claim, on a job whose report
--     owner is not the claim's owner, loses that element (metrics.claims_reused follows); the (result, metrics) pair
--     is archived first;
--   * every wiki page whose text carries a private-report claim's text is archived and withheld, and a guard on
--     wiki_pages keeps such a page from being written back (the viewer's reconcile, a compile, an app role); a NOTE
--     is refused out loud with 430's one message;
--   * research_private_report_claims loses its foreign key onto public.claims (a link now names a private claim), and
--     a guard refuses linking a SHARED claim: a private report's claim is filed private, through
--     private_report_claim_file (the research curator's write).
-- The archive (public.private_report_claims_archive) is readable by no app role. Counts only are printed (NOTICE),
-- never content. Re-runnable: a second run has nothing to move. Revert: revert-private-report-claims.sql (byte-
-- identical from the archive; it puts the claims the curator filed private after this slot back into the shared
-- table, the 390 model the revert returns to). Check: check-private-report-claims.sql.
-- Fresh-volume slot 570 (nothing to move). Live: psql -f AFTER 390 and 440 (it refuses without them), a fresh backup
-- first, the research curator and the wiki compile STOPPED, then the new research-curator and workbench images.
-- Revert order: 570 first, before 480 / 470 / 440 / 390.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;

DO $$
BEGIN
    IF to_regclass('public.research_private_report_claims') IS NULL OR to_regclass('public.research_private_reports') IS NULL THEN
        RAISE EXCEPTION 'private report claims: refused, nothing changed - slot 390 (init-report-isolation.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
    IF to_regclass('public.inlet_private_claims') IS NULL OR to_regclass('public.inlet_private_claim_sources') IS NULL THEN
        RAISE EXCEPTION 'private report claims: refused, nothing changed - slot 440 (init-inlet-owner.sql, round 5 or later) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;
-- every table the run writes, at once, under the 10 s lock_timeout: SHARE ROW EXCLUSIVE blocks writers, lets readers through
LOCK TABLE public.claims, public.claim_sources, public.research_private_report_claims, public.research_private_reports,
           public.research_jobs, public.wiki_pages, public.inlet_private_claims, public.inlet_private_claim_sources
    IN SHARE ROW EXCLUSIVE MODE;

-- ── the archive ────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.private_report_claims_archive (
    id          BIGSERIAL PRIMARY KEY,
    batch       UUID NOT NULL,
    tbl         TEXT NOT NULL,           -- schema-qualified table the row is from
    action      TEXT NOT NULL,           -- k moved claim | x withheld claim | e claim_sources edge | m whole image of a
                                         -- shared claim that lost an edge | j a job's (result, metrics) | w wiki page |
                                         -- f the dropped foreign key's definition
    ref         TEXT,                    -- the claim id (k x e m), the job id (j), the slug (w), the constraint name (f)
    row_data    JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_private_report_claims_archive_batch ON public.private_report_claims_archive (batch, restored_at);
DO $$
DECLARE r RECORD;
BEGIN
    ALTER TABLE public.private_report_claims_archive ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.private_report_claims_archive FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON public.private_report_claims_archive FROM PUBLIC;
    REVOKE ALL ON SEQUENCE public.private_report_claims_archive_id_seq FROM PUBLIC;
    -- the schema's default privileges hand every new table to the app roles: take those back too
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid IN ('public.private_report_claims_archive'::regclass, 'public.private_report_claims_archive_id_seq'::regclass)
                AND NOT ro.rolsuper AND ro.oid <> c.relowner LOOP
        EXECUTE format('REVOKE ALL ON public.private_report_claims_archive FROM %I', r.grantee);
        EXECUTE format('REVOKE ALL ON SEQUENCE public.private_report_claims_archive_id_seq FROM %I', r.grantee);
    END LOOP;
END $$;
COMMENT ON TABLE public.private_report_claims_archive IS
  'rw-private-report-claims (slot 570): every row init-private-report-claims.sql moved, deleted or changed, as it was. Readable by no app role; revert-private-report-claims.sql restores from it.';

-- ── the helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
-- a subject that may own a private row: slot 470's rule (inlet_subject_ok), restated so this slot does not need 470
CREATE OR REPLACE FUNCTION public.private_report_claim_subject_ok(p_subject TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT p_subject IS NOT NULL
       AND p_subject ~ '^[A-Za-z0-9][A-Za-z0-9._@|+=:/-]{0,254}$'
       AND p_subject !~* '^(service|system|anonymous):'
       AND lower(p_subject) <> 'operator'
$$;
REVOKE ALL ON FUNCTION public.private_report_claim_subject_ok(TEXT) FROM PUBLIC;
-- the batch the curator's private filings carry in the owner stores (a moved claim carries its migration batch)
CREATE OR REPLACE FUNCTION public.private_report_claims_filed_batch() RETURNS UUID
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT '00000000-0000-4570-8000-000000000570'::uuid $$;
REVOKE ALL ON FUNCTION public.private_report_claims_filed_batch() FROM PUBLIC;
-- the text a page match compares: lower case, whitespace collapsed
CREATE OR REPLACE FUNCTION public.private_report_claim_norm(p_text TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT lower(regexp_replace(btrim(coalesce(p_text, '')), '\s+', ' ', 'g')) $$;
REVOKE ALL ON FUNCTION public.private_report_claim_norm(TEXT) FROM PUBLIC;

-- does this page text carry a private-report claim's text? (a claim in an owner store that a private report links, or
-- a withheld one this slot archived; texts under 24 characters are too short to name a claim and are not matched)
CREATE OR REPLACE FUNCTION public.private_report_claims_page_shows(p_title TEXT, p_body TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH page AS (SELECT public.private_report_claim_norm(coalesce(p_title, '') || ' ' || coalesce(p_body, '')) AS t),
    texts AS (
        SELECT public.private_report_claim_norm(c.text) AS n
          FROM public.inlet_private_claims c
         WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
        UNION ALL
        SELECT public.private_report_claim_norm(a.row_data ->> 'text')
          FROM public.private_report_claims_archive a
         WHERE a.action = 'x' AND a.restored_at IS NULL)
    SELECT EXISTS (SELECT 1 FROM texts, page WHERE length(texts.n) >= 24 AND position(texts.n IN page.t) > 0)
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_page_shows(TEXT, TEXT) FROM PUBLIC;

-- the wiki guard: a page carrying a private-report claim's text is withheld (marked, as 430's writer counts it); a
-- NOTE is refused with 430's one message (never which guard, never "a report")
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.private_report_claims_page_shows(NEW.title, NEW.body) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page cannot be saved' USING ERRCODE = '42501';
        END IF;
        PERFORM public.wiki_guard_mark_withheld();
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_wiki_guard() FROM PUBLIC;

-- the link guard: no service links a SHARED claim to a private report - its claims are filed private
-- (private_report_claim_file). A superuser session is let through: slot 390's own move links the claims of the reports
-- it moves (a 390 re-run after this slot) - run this slot again right after it, which moves them.
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_link_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.claims c WHERE c.id = NEW.claim_id)
       AND NOT coalesce((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user), false) THEN
        RAISE EXCEPTION 'private report claims: a private report''s claim is filed private (private_report_claim_file); a shared claim cannot be linked'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_link_guard() FROM PUBLIC;

-- ── the move ───────────────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_batch   UUID := gen_random_uuid();
    v_def     TEXT;
    v_cols    TEXT;
    v_scols   TEXT;
    r         RECORD;
    v_n       BIGINT;
    n_own     BIGINT := 0;
    n_held    BIGINT := 0;
    n_mixed   BIGINT := 0;
    n_edges   BIGINT := 0;
    n_kept_e  BIGINT := 0;
    n_touched BIGINT := 0;
    n_jobs    BIGINT := 0;
    n_pages   BIGINT := 0;
BEGIN
    -- the foreign key onto public.claims goes first (a link names a private claim from now on): its definition archived
    FOR r IN SELECT con.conname, pg_get_constraintdef(con.oid) AS def
               FROM pg_constraint con
              WHERE con.conrelid = 'public.research_private_report_claims'::regclass AND con.contype = 'f'
                AND con.confrelid = 'public.claims'::regclass LOOP
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        VALUES (v_batch, 'public.research_private_report_claims', 'f', r.conname, jsonb_build_object('name', r.conname, 'def', r.def));
        EXECUTE format('ALTER TABLE public.research_private_report_claims DROP CONSTRAINT %I', r.conname);
        RAISE NOTICE 'private report claims: the link''s foreign key onto public.claims dropped (archived)';
    END LOOP;

    -- the claims to move: linked to a private report, in the shared table, filed by no shared synthesis
    CREATE TEMP TABLE _prc ON COMMIT DROP AS
    SELECT c.id,
           (array_agg(DISTINCT p.owner_sub) FILTER (WHERE public.private_report_claim_subject_ok(p.owner_sub))) AS owners
      FROM public.claims c
      JOIN public.research_private_report_claims pc ON pc.claim_id = c.id
      JOIN public.research_private_reports p ON p.id = pc.report_id
     WHERE c.synthesis_id IS NULL
     GROUP BY c.id;
    ALTER TABLE _prc ADD COLUMN owner TEXT;
    UPDATE _prc SET owner = owners[1] WHERE cardinality(owners) = 1;
    SELECT count(*) INTO n_mixed FROM public.claims c
     WHERE c.synthesis_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id);
    SELECT count(*) FILTER (WHERE owner IS NOT NULL), count(*) FILTER (WHERE owner IS NULL) INTO n_own, n_held FROM _prc;

    -- a dependent this move cannot archive stops it, nothing changed: any other foreign key onto claims with a row on a
    -- moved claim (claim_sources is archived below; the link's key is gone)
    FOR r IN SELECT con.conrelid::regclass::text AS tbl, a.attname AS col, cardinality(con.conkey) AS n_cols
               FROM pg_constraint con
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
              WHERE con.contype = 'f' AND con.confrelid = 'public.claims'::regclass
                AND con.conrelid NOT IN ('public.claim_sources'::regclass, 'public.research_private_report_claims'::regclass) LOOP
        IF r.n_cols <> 1 THEN
            RAISE EXCEPTION 'private report claims: refused, nothing changed - a multi-column foreign key onto claims (%), not archived by this move', r.tbl USING ERRCODE = '55000';
        END IF;
        EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I IN (SELECT id FROM _prc)', r.tbl, r.col) INTO v_n;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'private report claims: refused, nothing changed - % row(s) of % reference a claim to move', v_n, r.tbl USING ERRCODE = '55000';
        END IF;
    END LOOP;

    IF n_own + n_held > 0 THEN
        -- archive first: the claims, every edge of or onto them, every shared claim that loses an edge (whole)
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claims', CASE WHEN x.owner IS NULL THEN 'x' ELSE 'k' END, c.id::text, to_jsonb(c)
          FROM public.claims c JOIN _prc x ON x.id = c.id;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claim_sources', 'e', cs.claim_id::text, to_jsonb(cs)
          FROM public.claim_sources cs
         WHERE cs.claim_id IN (SELECT id FROM _prc) OR cs.parent_claim_id IN (SELECT id FROM _prc);
        GET DIAGNOSTICS n_edges = ROW_COUNT;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claims', 'm', c.id::text, to_jsonb(c)
          FROM public.claims c
         WHERE c.id NOT IN (SELECT id FROM _prc)
           AND (c.id IN (SELECT cs.claim_id FROM public.claim_sources cs WHERE cs.parent_claim_id IN (SELECT id FROM _prc))
             OR c.id IN (SELECT cs.parent_claim_id FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _prc)));
        GET DIAGNOSTICS n_touched = ROW_COUNT;

        -- the owner's copy (PD1's store): the claim's own columns, the owner, this batch; its own edges, keyed by owner
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum), string_agg('s.' || quote_ident(attname), ', ' ORDER BY attnum)
          INTO v_cols, v_scols
          FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
        -- a column the shared table gained since slot 440 is carried too
        FOR r IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
                   FROM pg_attribute a
                  WHERE a.attrelid = 'public.claims'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                    AND NOT EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = 'public.inlet_private_claims'::regclass AND b.attname = a.attname AND NOT b.attisdropped) LOOP
            EXECUTE format('ALTER TABLE public.inlet_private_claims ADD COLUMN %I %s', r.attname, r.typ);
        END LOOP;
        EXECUTE format('INSERT INTO public.inlet_private_claims (%s, inlet_owner_sub, inlet_batch) SELECT %s, x.owner, $1 FROM public.claims s JOIN _prc x ON x.id = s.id WHERE x.owner IS NOT NULL',
                       v_cols, v_scols) USING v_batch;
        INSERT INTO public.inlet_private_claim_sources (claim_id, edge_ref, owner_sub, batch, source_id, parent_claim_id, row_data)
        SELECT cs.claim_id, md5(to_jsonb(cs)::text), x.owner, v_batch, cs.source_id, cs.parent_claim_id, to_jsonb(cs)
          FROM public.claim_sources cs JOIN _prc x ON x.id = cs.claim_id
         WHERE x.owner IS NOT NULL;
        GET DIAGNOSTICS n_kept_e = ROW_COUNT;

        -- the jobs: a result element naming a moved claim leaves every job whose report owner is not the claim's owner
        CREATE TEMP TABLE _prc_jobs ON COMMIT DROP AS
        SELECT j.id, j.result, to_jsonb(j) -> 'metrics' AS metrics,
               (SELECT o.owner_sub FROM public.research_job_report_owner(j.id) o LIMIT 1) AS job_owner
          FROM public.research_jobs j
         WHERE jsonb_typeof(j.result) = 'object'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'claims') = 'array' THEN j.result -> 'claims' ELSE '[]'::jsonb END
                                                          || CASE WHEN jsonb_typeof(j.result -> 'reuse_claims') = 'array' THEN j.result -> 'reuse_claims' ELSE '[]'::jsonb END) e
                        JOIN _prc x ON x.id::text = (e ->> 'id'));
        ALTER TABLE _prc_jobs ADD COLUMN new_result JSONB, ADD COLUMN new_metrics JSONB, ADD COLUMN cut_reuse INT;
        UPDATE _prc_jobs t SET new_result = t.result
              || CASE WHEN jsonb_typeof(t.result -> 'claims') = 'array' THEN jsonb_build_object('claims', coalesce((
                     SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(t.result -> 'claims') WITH ORDINALITY AS z(e, o)
                      WHERE NOT EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))), '[]'::jsonb)) ELSE '{}'::jsonb END
              || CASE WHEN jsonb_typeof(t.result -> 'reuse_claims') = 'array' THEN jsonb_build_object('reuse_claims', coalesce((
                     SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(t.result -> 'reuse_claims') WITH ORDINALITY AS z(e, o)
                      WHERE NOT EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))), '[]'::jsonb)) ELSE '{}'::jsonb END,
               cut_reuse = CASE WHEN jsonb_typeof(t.result -> 'reuse_claims') = 'array' THEN (
                     SELECT count(*) FROM jsonb_array_elements(t.result -> 'reuse_claims') z(e)
                      WHERE EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))) ELSE 0 END;
        UPDATE _prc_jobs t SET new_metrics = CASE WHEN t.cut_reuse > 0 AND jsonb_typeof(t.metrics -> 'claims_reused') = 'number'
                                                  THEN t.metrics || jsonb_build_object('claims_reused', greatest((t.metrics ->> 'claims_reused')::numeric - t.cut_reuse, 0))
                                                  ELSE t.metrics END;
        DELETE FROM _prc_jobs t WHERE t.new_result IS NOT DISTINCT FROM t.result AND t.new_metrics IS NOT DISTINCT FROM t.metrics;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_jobs', 'j', t.id::text, jsonb_build_object('id', t.id, 'result', t.result, 'metrics', t.metrics)
          FROM _prc_jobs t;
        GET DIAGNOSTICS n_jobs = ROW_COUNT;

        -- the shared rows go, with ordinary triggers off for the job rows (their touch timestamps do not move: the revert is
        -- byte-identical); the edge deletes recompute the shared claims archived whole above
        DELETE FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _prc) OR cs.parent_claim_id IN (SELECT id FROM _prc);
        DELETE FROM public.claims c WHERE c.id IN (SELECT id FROM _prc);
        PERFORM set_config('session_replication_role', 'replica', true);
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attname = 'metrics' AND NOT attisdropped) THEN
            UPDATE public.research_jobs j SET result = t.new_result, metrics = t.new_metrics FROM _prc_jobs t WHERE t.id = j.id;
        ELSE
            UPDATE public.research_jobs j SET result = t.new_result FROM _prc_jobs t WHERE t.id = j.id;
        END IF;
        PERFORM set_config('session_replication_role', 'origin', true);
    END IF;

    -- the wiki: every page carrying a private-report claim's text (the predicate reads the store and this batch's archive),
    -- archived and withheld - whatever this run moved, a later page included
    INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
    SELECT v_batch, 'public.wiki_pages', 'w', w.slug, to_jsonb(w)
      FROM public.wiki_pages w WHERE public.private_report_claims_page_shows(w.title, w.body);
    GET DIAGNOSTICS n_pages = ROW_COUNT;
    DELETE FROM public.wiki_pages w USING public.private_report_claims_archive a
     WHERE a.batch = v_batch AND a.action = 'w' AND a.ref = w.slug;

    -- fail closed: nothing of what moved is left on a shared surface
    IF EXISTS (SELECT 1 FROM public.claims c WHERE c.id IN (SELECT id FROM _prc))
       OR EXISTS (SELECT 1 FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _prc) OR cs.parent_claim_id IN (SELECT id FROM _prc))
       OR EXISTS (SELECT 1 FROM public.wiki_pages w WHERE public.private_report_claims_page_shows(w.title, w.body)) THEN
        RAISE EXCEPTION 'private report claims: refused, nothing changed - a moved claim is still on a shared surface after the move' USING ERRCODE = '55000';
    END IF;

    IF n_own + n_held + n_pages = 0 THEN
        RAISE NOTICE 'private report claims: nothing to move (% claim(s) a shared synthesis also filed stay shared)', n_mixed;
    ELSE
        RAISE NOTICE 'private report claims: % claim(s) moved to their owner''s store (% edge(s) kept for the owner), % withheld (no single owner), % claim(s) a shared synthesis also filed stay shared',
            n_own, n_kept_e, n_held, n_mixed;
        RAISE NOTICE 'private report claims: % edge(s) archived and deleted, % shared claim(s) that lost an edge archived whole, % job result(s) stripped, % wiki page(s) withheld',
            n_edges, n_touched, n_jobs, n_pages;
    END IF;
END $$;

-- ── the corroboration lines ────────────────────────────────────────────────────────────────────────────────────────
-- source_corroborations.claim_text is the synthesis LINE a corroboration was judged on - the text of the claim filed
-- from it - and the quality read (contract/sources/{id}/quality) and PostgREST serve it. A line of a private report's
-- run (the job, or its tree root, is a private report's: research_job_report_owner, or a research_private_reports row
-- names the job) is the private claim's text on a shared surface: it is replaced by a neutral, keyed stand-in
-- ('private-text:' + md5 of a per-database secret salt, the two sources and the line - stable, so the research
-- service's per-line ON CONFLICT still merges a re-run; not guessable, so a guessed sentence cannot be confirmed). The
-- amount, the pair and the verdict stay: the shared sources' credibility is unchanged. A guard does the same for every
-- new line, whoever writes it (the research service writes them during the run).
CREATE TABLE IF NOT EXISTS public.private_report_claims_salt (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    salt      TEXT NOT NULL
);
INSERT INTO public.private_report_claims_salt (singleton, salt)
SELECT true, md5(random()::text || clock_timestamp()::text) || md5(random()::text || pg_backend_pid()::text)
 WHERE NOT EXISTS (SELECT 1 FROM public.private_report_claims_salt);
DO $$
DECLARE r RECORD;
BEGIN
    ALTER TABLE public.private_report_claims_salt ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.private_report_claims_salt FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON public.private_report_claims_salt FROM PUBLIC;
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.private_report_claims_salt'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner LOOP
        EXECUTE format('REVOKE ALL ON public.private_report_claims_salt FROM %I', r.grantee);
    END LOOP;
END $$;
-- is this job a private report's run? (the job or its tree root is an idea's - 390's rule - or a private report names it)
CREATE OR REPLACE FUNCTION public.private_report_claims_job_private(p_job UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_job IS NOT NULL
       AND (EXISTS (SELECT 1 FROM public.research_job_report_owner(p_job))
            OR EXISTS (SELECT 1 FROM public.research_private_reports p
                        WHERE p.job_id = p_job
                           OR p.job_id = (SELECT j.root_job_id FROM public.research_jobs j WHERE j.id = p_job)))
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_job_private(UUID) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.private_report_claims_neutral_line(p_from UUID, p_to UUID, p_text TEXT) RETURNS TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT 'private-text:' || md5((SELECT s.salt FROM public.private_report_claims_salt s WHERE s.singleton)
                                  || '|' || p_from::text || '|' || p_to::text || '|' || coalesce(p_text, ''))
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_neutral_line(UUID, UUID, TEXT) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_corroboration_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.claim_text NOT LIKE 'private-text:%' AND public.private_report_claims_job_private(NEW.job_id) THEN
        NEW.claim_text := public.private_report_claims_neutral_line(NEW.from_source_id, NEW.to_source_id, NEW.claim_text);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_corroboration_guard() FROM PUBLIC;
DO $$
DECLARE v_batch UUID := gen_random_uuid(); v_n BIGINT := 0;
BEGIN
    IF to_regclass('public.source_corroborations') IS NULL THEN RETURN; END IF;
    LOCK TABLE public.source_corroborations IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
    SELECT v_batch, 'public.source_corroborations', 'c', sc.id::text, to_jsonb(sc)
      FROM public.source_corroborations sc
     WHERE sc.claim_text NOT LIKE 'private-text:%' AND public.private_report_claims_job_private(sc.job_id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
        PERFORM set_config('session_replication_role', 'replica', true);
        UPDATE public.source_corroborations sc
           SET claim_text = public.private_report_claims_neutral_line(sc.from_source_id, sc.to_source_id, sc.claim_text)
          FROM public.private_report_claims_archive a
         WHERE a.batch = v_batch AND a.action = 'c' AND a.ref = sc.id::text;
        PERFORM set_config('session_replication_role', 'origin', true);
        RAISE NOTICE 'private report claims: % corroboration line(s) of a private report''s run made neutral', v_n;
    END IF;
    DROP TRIGGER IF EXISTS trg_private_report_claims_corroboration_guard ON public.source_corroborations;
    CREATE TRIGGER trg_private_report_claims_corroboration_guard BEFORE INSERT OR UPDATE OF claim_text, job_id ON public.source_corroborations
        FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_corroboration_guard();
END $$;

DROP TRIGGER IF EXISTS trg_private_report_claims_wiki_guard ON public.wiki_pages;
CREATE TRIGGER trg_private_report_claims_wiki_guard BEFORE INSERT OR UPDATE ON public.wiki_pages
    FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_wiki_guard();
DROP TRIGGER IF EXISTS trg_private_report_claims_link_guard ON public.research_private_report_claims;
CREATE TRIGGER trg_private_report_claims_link_guard BEFORE INSERT OR UPDATE OF claim_id ON public.research_private_report_claims
    FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_link_guard();

-- ── the writes and the owner's read ────────────────────────────────────────────────────────────────────────────────
-- The curator's write of one claim of a private report: the owner is the REPORT's (research_private_reports, by
-- research_key + job), never the caller's word. Deduplicated within the owner's own store (same thread, same text), never
-- against a shared claim and never into one. Links the claim to the report. Refused for a report with no valid owner
-- (nobody may read it: the claim is not filed) or for a key + job naming reports of two owners.
CREATE OR REPLACE FUNCTION public.private_report_claim_file(
    p_research_key    TEXT,
    p_job_id          UUID,
    p_text            TEXT,
    p_thread_id       UUID         DEFAULT NULL,
    p_epistemic_tag   TEXT         DEFAULT 'sourced',
    p_volatility      TEXT         DEFAULT NULL,
    p_revalidate_days INT          DEFAULT NULL,
    p_embedding       VECTOR(1024) DEFAULT NULL,
    p_metadata        JSONB        DEFAULT '{}'::jsonb
)
RETURNS TABLE (id UUID, was_duplicate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owners TEXT[];
    v_owner  TEXT;
    v_hash   TEXT := md5(lower(btrim(coalesce(p_text, ''))));
    v_tag    TEXT := CASE WHEN p_epistemic_tag IN ('sourced', 'inferred', 'uncertain') THEN p_epistemic_tag ELSE 'sourced' END;
    v_id     UUID;
BEGIN
    IF coalesce(btrim(p_text), '') = '' THEN
        RAISE EXCEPTION 'claim text required';
    END IF;
    SELECT array_agg(DISTINCT p.owner_sub) INTO v_owners
      FROM public.research_private_reports p WHERE p.research_key = p_research_key AND p.job_id = p_job_id;
    IF v_owners IS NULL THEN
        RAISE EXCEPTION 'private report claims: no private report for this key and job; nothing filed' USING ERRCODE = '23503';
    END IF;
    IF cardinality(v_owners) <> 1 OR NOT public.private_report_claim_subject_ok(v_owners[1]) THEN
        RAISE EXCEPTION 'private report claims: the report has no single owner who may read it; nothing filed' USING ERRCODE = '42501';
    END IF;
    v_owner := v_owners[1];
    SELECT c.id INTO v_id FROM public.inlet_private_claims c
     WHERE c.inlet_owner_sub = v_owner AND c.content_hash = v_hash AND c.thread_id IS NOT DISTINCT FROM p_thread_id
     ORDER BY c.created_at LIMIT 1;
    IF v_id IS NOT NULL THEN
        UPDATE public.inlet_private_claims c
           SET researched_on = CURRENT_DATE,
               volatility = coalesce(p_volatility, c.volatility),
               revalidate_days = coalesce(p_revalidate_days, c.revalidate_days),
               status = CASE WHEN c.status = 'retracted' THEN c.status ELSE 'active' END,
               updated_at = now()
         WHERE c.id = v_id;
        was_duplicate := TRUE;
    ELSE
        v_id := gen_random_uuid();
        INSERT INTO public.inlet_private_claims (id, text, thread_id, synthesis_id, epistemic_tag, status, confidence, contradicted,
                                                 volatility, revalidate_days, researched_on, content_hash, embedding, metadata,
                                                 created_at, updated_at, inlet_owner_sub, inlet_batch)
        VALUES (v_id, btrim(p_text), p_thread_id, NULL, v_tag, 'active', 0, FALSE, p_volatility, p_revalidate_days, CURRENT_DATE,
                v_hash, p_embedding, coalesce(p_metadata, '{}'::jsonb), now(), now(), v_owner, public.private_report_claims_filed_batch());
        was_duplicate := FALSE;
    END IF;
    INSERT INTO public.research_private_report_claims (report_id, claim_id)
    SELECT p.id, v_id FROM public.research_private_reports p WHERE p.research_key = p_research_key AND p.job_id = p_job_id
    ON CONFLICT DO NOTHING;
    id := v_id;
    RETURN NEXT;
END;
$$;

-- The curator's grounding edge of a private claim onto a source: kept in the owner's edge store, idempotent on
-- (claim, source, type) as link_claim_to_source is. Only a claim a private report links, only onto an existing source.
CREATE OR REPLACE FUNCTION public.private_report_claim_edge(p_claim_id UUID, p_source_id UUID, p_edge_type TEXT, p_weight REAL DEFAULT 1.0)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner TEXT;
    v_ref   TEXT;
BEGIN
    IF p_edge_type NOT IN ('states', 'inferred_from', 'corroborates', 'contradicts') THEN
        RAISE EXCEPTION 'private report claims: edge type % refused', p_edge_type USING ERRCODE = '23514';
    END IF;
    IF p_weight IS NULL OR NOT (p_weight = 0 OR (p_weight >= 1e-9 AND p_weight <= 1)) THEN
        RAISE EXCEPTION 'private report claims: edge weight is not 0 or in [1e-9, 1]' USING ERRCODE = '23514';
    END IF;
    SELECT c.inlet_owner_sub INTO v_owner FROM public.inlet_private_claims c
     WHERE c.id = p_claim_id AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'private report claims: no private report claim %', p_claim_id USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id = p_source_id) THEN
        RAISE EXCEPTION 'private report claims: no source %', p_source_id USING ERRCODE = '23503';
    END IF;
    v_ref := md5(p_claim_id::text || '|' || p_source_id::text || '|' || p_edge_type);
    INSERT INTO public.inlet_private_claim_sources (claim_id, edge_ref, owner_sub, batch, source_id, parent_claim_id, row_data)
    VALUES (p_claim_id, v_ref, v_owner, public.private_report_claims_filed_batch(), p_source_id, NULL,
            jsonb_build_object('claim_id', p_claim_id, 'source_id', p_source_id, 'parent_claim_id', NULL,
                               'edge_type', p_edge_type, 'weight', p_weight, 'created_at', now()))
    ON CONFLICT (claim_id, edge_ref, batch) DO UPDATE SET row_data = EXCLUDED.row_data;
END;
$$;

-- The owner's read of the claims drawn from their idea's private reports (the workbench's idea dossier): a row only when
-- the subject owns both the report and the claim; nothing for a blank, service, system or anonymous subject.
CREATE OR REPLACE FUNCTION public.private_report_claims_of_idea(p_idea_id UUID, p_sub TEXT)
RETURNS TABLE (id UUID, text TEXT, confidence REAL)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT DISTINCT c.id, c.text, c.confidence
      FROM public.inlet_private_claims c
      JOIN public.research_private_report_claims pc ON pc.claim_id = c.id
      JOIN public.research_private_reports p ON p.id = pc.report_id
     WHERE public.private_report_claim_subject_ok(p_sub)
       AND p.idea_id = p_idea_id AND p.owner_sub = p_sub AND c.inlet_owner_sub = p_sub
$$;

-- EXECUTE: the services' own login role only (the curator files, the workbench reads), and ob_workbench (slot 480's
-- workbench role) for the read where it exists. Never PUBLIC, never service_role (PostgREST's anon role), never authenticated.
REVOKE ALL ON FUNCTION public.private_report_claim_file(TEXT, UUID, TEXT, UUID, TEXT, TEXT, INT, VECTOR, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.private_report_claim_edge(UUID, UUID, TEXT, REAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) FROM PUBLIC;
DO $$
DECLARE f TEXT; r RECORD;
BEGIN
    -- take back anything the default privileges handed out
    FOREACH f IN ARRAY ARRAY['public.private_report_claim_file(text,uuid,text,uuid,text,text,integer,vector,jsonb)',
                             'public.private_report_claim_edge(uuid,uuid,text,real)', 'public.private_report_claims_of_idea(uuid,text)',
                             'public.private_report_claims_page_shows(text,text)', 'public.private_report_claim_subject_ok(text)',
                             'public.private_report_claims_filed_batch()', 'public.private_report_claim_norm(text)',
                             'public.private_report_claims_job_private(uuid)', 'public.private_report_claims_neutral_line(uuid,uuid,text)'] LOOP
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE p.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> p.proowner LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f::regprocedure, r.grantee);
        END LOOP;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        GRANT EXECUTE ON FUNCTION public.private_report_claim_file(TEXT, UUID, TEXT, UUID, TEXT, TEXT, INT, VECTOR, JSONB) TO ob_app_memory;
        GRANT EXECUTE ON FUNCTION public.private_report_claim_edge(UUID, UUID, TEXT, REAL) TO ob_app_memory;
        GRANT EXECUTE ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) TO ob_app_memory;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        GRANT EXECUTE ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) TO ob_workbench;
    END IF;
END $$;
COMMENT ON FUNCTION public.private_report_claim_file(TEXT, UUID, TEXT, UUID, TEXT, TEXT, INT, VECTOR, JSONB) IS
  'rw-private-report-claims (slot 570): the research curator files one claim of a private report into the report owner''s store (inlet_private_claims) and links it. ob_app_memory only.';
COMMENT ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) IS
  'rw-private-report-claims (slot 570): the subject''s claims drawn from their idea''s private reports; nothing for any other subject. ob_app_memory / ob_workbench only.';

NOTIFY pgrst, 'reload schema';
COMMIT;
