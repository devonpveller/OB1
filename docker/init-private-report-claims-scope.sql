-- ============================================================
-- Slot 575: the scope of slot 570's wiki guard, its fragment rule and its NULL kinds (research-workbench
-- rw-570-hub-note-scope; the follow-up of rw-private-report-claims-fix review r-rprc, R1 / R2 / R4).
-- A FORWARD migration on top of slot 570 (init-private-report-claims.sql): 570 is applied live before this slot, so
-- 570's files stay as they ran and this slot changes what 570 left. It runs after 570 on a fresh volume too (575 sorts
-- after 570 in initdb; 580 is independent of both).
--   * R1 - the notebook tree (content/notebooks/...) is stored as 'note' too (recipes/_shared/page-classes.mjs,
--     notebook-tree). Its REGENERABLE pages - the hub content/notebooks/<s>/<s> and the MOC content/notebooks/index,
--     the notebook synthesis's machine text - are not a person's note: they take the machine path of 570's guard (a page
--     carrying ANY private-report claim's text is withheld). A person's note is notes/... (the workbench's note tree)
--     and, round 2 (operator's second ruling 2026-11-24, R5), a structured note: content/notebooks/<nb>/<note> (the
--     workbench's writeStructuredNote, which names its writer as the row's author): judged by its AUTHOR's own claims
--     only (A1), so neither a refusal nor a page's absence tells anyone that another user holds a sentence. 570's guard sent every
--     'note' row to the author-only branch and its migration skipped them; this slot replaces the guard's function
--     (same name, same trigger: no trigger is dropped or created) and withholds the notebook-tree rows 570 skipped.
--     A person's note (notes/...) keeps 570's treatment exactly: refused only for its AUTHOR's own claims.
--   * R2 - a FRAGMENT: a SHARED claim that a synthesis 570 moved had filed (570's archive: the 's' row of the
--     synthesis, the 'd' row of the claim's synthesis_id it set NULL), whose skeleton (24+ letters) is INSIDE the
--     skeleton of a private-report claim that synthesis restated (its text carried it, or it filed it), moves to that
--     claim's owner (one owner) or is withheld (several, or a withheld claim) - 570's rule for every other private-report
--     claim, the direction reversed (570 matched only a claim CONTAINING a private sentence). A shared claim that
--     carries such a fragment's sentence follows it (570's duplicate rule, applied to the fragment). Their edges, the
--     shared claims that lose an edge, the job results naming them and the wiki pages carrying them are archived and
--     withheld as 570 does. Any other shared surface carrying a fragment's sentence (a shared synthesis or job report, a
--     thread, a notebook label, a curator answer, a shared tree's gap work) REFUSES the run, nothing changed: 570
--     cleared those for the private sentence itself, and a fragment there is a case for a person, not a rewrite.
--   * R4 - 570's gap guard short-circuits a row whose kind is not a machine kind; a NULL kind (NULL NOT IN (...) is NULL)
--     fell through to the claim-id match. coalesce(.., '') makes a NULL branch_kind / steer_kind / event type exactly a
--     non-matching kind (the columns are NOT NULL today; a legacy row or a dropped constraint is the case).
-- check-private-report-claims.sql and count-private-report-claim-reuse.sql judge the same: a person's note is notes/
-- only, and the same fragment rule (pg_temp.prc_frag). check-private-report-claims-scope.sql checks this slot.
-- The archive is 570's (public.private_report_claims_archive, readable by no app role), same action codes; each batch of
-- this slot carries one 'z' row (tbl 'slot 575'), so revert-private-report-claims-scope.sql restores exactly this slot's
-- batches - and 570's own revert, run alone, restores them too (newest first, the codes it knows).
-- LOCKS (no ACCESS EXCLUSIVE anywhere: no constraint, column or trigger is dropped or added): SHARE ROW EXCLUSIVE on the
-- tables it writes (wiki_pages, claims, claim_sources, the link table, the two owner stores, research_jobs) and SHARE on
-- the ones its refusals read (sources, threads, research_steers, research_job_events, research_private_reports) -
-- writers wait, readers go on - for the whole transaction. Live (68k pages, no fragment): the notebook-tree pass only
-- (~300 rows, twice), seconds. With a fragment: one more pass of every non-note page against the fragments' skeletons
-- and the refusal scans (minutes). Counts only (NOTICE), never content. Re-runnable: a second run has nothing to move.
-- Live: psql -f AFTER 570, the research curator and the wiki compile stopped (570's window), a fresh backup first.
-- RE-RUN IT AFTER ANY 570 RE-RUN (570 puts its own guard functions back). Revert: revert-private-report-claims-scope.sql
-- FIRST, then (if ever) revert-private-report-claims.sql.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;

DO $$
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL
       OR to_regprocedure('public.private_report_claims_page_shows(text,text)') IS NULL
       OR to_regprocedure('public.private_report_claims_own_text_shows(text,text,text)') IS NULL
       OR to_regprocedure('public.private_report_claim_norm(text)') IS NULL
       OR to_regprocedure('public.trg_private_report_claims_wiki_guard()') IS NULL
       OR to_regprocedure('public.trg_private_report_claims_gap_guard()') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_private_report_claims_wiki_guard' AND tgrelid = 'public.wiki_pages'::regclass) THEN
        RAISE EXCEPTION 'private report claims scope: refused, nothing changed - slot 570 (init-private-report-claims.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;
-- -- R6: the skeleton memo (rw-570-perf's pattern), BEFORE the locks -------------------------------------------------
-- Every text this run compares is normalised ONCE into a per-transaction memo keyed by SHA-256 of the exact text;
-- pg_temp.sc_n(t) returns the memo's skeleton, or private_report_claim_norm(t) for a text not memoised (one that
-- changed after the memo is simply normalised again), so sc_n(t) = private_report_claim_norm(t) for every t. Filled
-- here, before the locks (writers go on meanwhile): the private-report claim texts, the moved syntheses, the fragment
-- candidates, the class-'note' pages that are not a person's note; and only when a fragment candidate is found here,
-- every other text a fragment is compared with (every page, claim, synthesis, job report, thread, notebook label,
-- curator answer). The memo and its three functions go with the transaction.
CREATE OR REPLACE FUNCTION pg_temp.private_report_claims_person_note_pre(p_slug TEXT, p_class TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
    SELECT (coalesce(p_class, '') = 'note' AND (left(coalesce(p_slug, ''), 6) = 'notes/' OR (left(coalesce(p_slug, ''), 18) = 'content/notebooks/' AND split_part(p_slug, '/', 4) <> '' AND NOT (split_part(p_slug, '/', 5) = '' AND split_part(p_slug, '/', 4) = split_part(p_slug, '/', 3)))))
$$;
CREATE TEMP TABLE _sc_memo (h BYTEA PRIMARY KEY, n TEXT NOT NULL) ON COMMIT DROP;
CREATE OR REPLACE FUNCTION pg_temp.sc_n(p_text TEXT) RETURNS TEXT
LANGUAGE sql STABLE
AS $$
    SELECT coalesce((SELECT m.n FROM pg_temp._sc_memo m WHERE m.h = sha256(convert_to(coalesce(p_text, ''), 'UTF8'))),
                    public.private_report_claim_norm(p_text))
$$;
CREATE OR REPLACE FUNCTION pg_temp.sc_memo(p_texts TEXT[]) RETURNS BIGINT
LANGUAGE sql VOLATILE
AS $$
    WITH ins AS (
        INSERT INTO pg_temp._sc_memo (h, n)
        SELECT sha256(convert_to(x.t, 'UTF8')), public.private_report_claim_norm(x.t)
          FROM (SELECT DISTINCT coalesce(u, '') AS t FROM unnest(p_texts) u) x
        ON CONFLICT (h) DO NOTHING RETURNING 1)
    SELECT count(*) FROM ins
$$;
DO $$
DECLARE v_pre BOOLEAN;
BEGIN
    PERFORM pg_temp.sc_memo(ARRAY(SELECT c.text FROM public.inlet_private_claims c
                                   WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)));
    PERFORM pg_temp.sc_memo(ARRAY(SELECT a.row_data ->> 'text' FROM public.private_report_claims_archive a WHERE a.action = 'x' AND a.restored_at IS NULL));
    PERFORM pg_temp.sc_memo(ARRAY(SELECT coalesce(a.row_data ->> 'title', '') || ' ' || coalesce(a.row_data ->> 'content', '')
                                    FROM public.private_report_claims_archive a WHERE a.action = 's' AND a.tbl = 'public.sources' AND a.restored_at IS NULL));
    PERFORM pg_temp.sc_memo(ARRAY(SELECT c.text FROM public.private_report_claims_archive a JOIN public.claims c ON c.id::text = a.row_data ->> 'id'
                                   WHERE a.action = 'd' AND a.tbl IN ('public.claims', 'claims') AND a.row_data ->> '_col' = 'synthesis_id' AND a.restored_at IS NULL));
    PERFORM pg_temp.sc_memo(ARRAY(SELECT coalesce(w.slug, '') || ' ' || coalesce(w.title, '') || ' ' || coalesce(w.body, '') FROM public.wiki_pages w WHERE w.page_class = 'note' AND NOT pg_temp.private_report_claims_person_note_pre(w.slug, w.page_class)));
    -- is there a fragment candidate now? (a superset of the move's rule: a 'd' claim inside a private-report claim the
    -- synthesis restated or filed; the move decides exactly, under the locks)
    WITH p AS MATERIALIZED (
        SELECT x.id, x.n FROM (
            SELECT c.id, pg_temp.sc_n(c.text) AS n FROM public.inlet_private_claims c
             WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
            UNION ALL
            SELECT a.ref::uuid, pg_temp.sc_n(a.row_data ->> 'text') FROM public.private_report_claims_archive a WHERE a.action = 'x' AND a.restored_at IS NULL) x
         WHERE length(x.n) >= 24),
    s AS MATERIALIZED (
        SELECT a.ref AS sid, pg_temp.sc_n(coalesce(a.row_data ->> 'title', '') || ' ' || coalesce(a.row_data ->> 'content', '')) AS n
          FROM public.private_report_claims_archive a WHERE a.action = 's' AND a.tbl = 'public.sources' AND a.restored_at IS NULL),
    cn AS MATERIALIZED (
        SELECT a.ref AS sid, pg_temp.sc_n(c.text) AS n
          FROM public.private_report_claims_archive a JOIN public.claims c ON c.id::text = a.row_data ->> 'id'
         WHERE a.action = 'd' AND a.tbl IN ('public.claims', 'claims') AND a.row_data ->> '_col' = 'synthesis_id' AND a.restored_at IS NULL)
    SELECT EXISTS (SELECT 1 FROM cn JOIN s ON s.sid = cn.sid, p
                    WHERE length(cn.n) >= 24 AND position(cn.n IN p.n) > 0
                      AND (position(p.n IN s.n) > 0
                           OR EXISTS (SELECT 1 FROM public.private_report_claims_archive k
                                       WHERE k.action IN ('k', 'x') AND k.restored_at IS NULL AND k.ref = p.id::text AND k.row_data ->> 'synthesis_id' = cn.sid)))
      INTO v_pre;
    IF v_pre THEN
        PERFORM pg_temp.sc_memo(ARRAY(SELECT c.text FROM public.claims c));
        PERFORM pg_temp.sc_memo(ARRAY(SELECT coalesce(w.slug, '') || ' ' || coalesce(w.title, '') || ' ' || coalesce(w.body, '') FROM public.wiki_pages w WHERE NOT pg_temp.private_report_claims_person_note_pre(w.slug, w.page_class)));
        PERFORM pg_temp.sc_memo(ARRAY(SELECT coalesce(s.title, '') || ' ' || coalesce(s.content, '') FROM public.sources s WHERE s.content_type = 'research_synthesis'));
        PERFORM pg_temp.sc_memo(ARRAY(SELECT (SELECT string_agg(v #>> '{}', ' ') FROM jsonb_path_query(j.result - 'reuse_claims' - 'claims', 'strict $.**') v WHERE jsonb_typeof(v) = 'string') FROM public.research_jobs j WHERE jsonb_typeof(j.result) = 'object'));
        PERFORM pg_temp.sc_memo(ARRAY(SELECT coalesce(th.name, '') || ' ' || coalesce(th.description, '') || ' ' || coalesce(th.slug, '') FROM public.threads th));
        PERFORM pg_temp.sc_memo(ARRAY(SELECT s.notebook FROM public.sources s WHERE coalesce(s.notebook, '') <> ''));
        PERFORM pg_temp.sc_memo(ARRAY(SELECT coalesce(j.result -> 'curator' ->> 'thread_name', '') || ' ' || coalesce((SELECT string_agg(x ->> 'name', ' ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'curator' -> 'shortlist') = 'array' THEN j.result -> 'curator' -> 'shortlist' ELSE '[]'::jsonb END) x), '') FROM public.research_jobs j WHERE jsonb_typeof(j.result -> 'curator') = 'object'));
    END IF;
    RAISE NOTICE 'private report claims scope: % text skeleton(s) memoised before the locks (a fragment candidate: %)', (SELECT count(*) FROM pg_temp._sc_memo), v_pre;
END $$;
LOCK TABLE public.wiki_pages, public.claims, public.claim_sources, public.research_private_report_claims,
           public.inlet_private_claims, public.inlet_private_claim_sources, public.research_jobs
    IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.sources, public.threads, public.research_steers, public.research_job_events, public.research_private_reports
    IN SHARE MODE;

-- ── R1: who is a person's note ─────────────────────────────────────────────────────────────────────────────────────
-- the workbench's note tree only (repositories/notes.ts notesRel: notes/<path>); every other row, whatever its class, is
-- machine text for the guard. check-private-report-claims.sql, count-private-report-claim-reuse.sql and
-- check-private-report-claims-scope.sql repeat this rule verbatim.
CREATE OR REPLACE FUNCTION public.private_report_claims_person_note(p_slug TEXT, p_class TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT (coalesce(p_class, '') = 'note' AND (left(coalesce(p_slug, ''), 6) = 'notes/' OR (left(coalesce(p_slug, ''), 18) = 'content/notebooks/' AND split_part(p_slug, '/', 4) <> '' AND NOT (split_part(p_slug, '/', 5) = '' AND split_part(p_slug, '/', 4) = split_part(p_slug, '/', 3)))))
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_person_note(TEXT, TEXT) FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    -- the schema's default privileges hand new functions to the app roles: take those back (570's rule)
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE p.oid = 'public.private_report_claims_person_note(text,text)'::regprocedure AND NOT ro.rolsuper AND ro.oid <> p.proowner LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.private_report_claims_person_note(text,text) FROM %I', r.grantee);
    END LOOP;
END $$;

-- the wiki guard, 570's with the person-note rule above (slot 575). A machine-written page (a compile, the viewer's
-- reconcile, the notebook synthesis's hub and MOC, an AI note) carrying ANY private-report claim's text is withheld
-- (marked, as 430's writer counts it): no user chose that text. A person's NOTE (notes/...) follows A1: refused with 430's
-- one message ONLY for its AUTHOR's own private claims (ob.page_author, set by the workbench's note write); a note
-- written with no author named matches nothing.
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.private_report_claims_person_note(NEW.slug, NEW.page_class) THEN
        IF public.private_report_claims_own_text_shows(nullif(current_setting('ob.page_author', true), ''), coalesce(NEW.slug, '') || ' ' || coalesce(NEW.title, ''), NEW.body) THEN
            RAISE EXCEPTION 'wiki_pages: this page cannot be saved' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    IF public.private_report_claims_page_shows(coalesce(NEW.slug, '') || ' ' || coalesce(NEW.title, ''), NEW.body) THEN
        PERFORM public.wiki_guard_mark_withheld();
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

-- -- R5 (operator decision 2026-11-24): the structured-note check -------------------------------------------------
-- The workbench's structured / AI-note hand-off (POST /workbench/notes, writeStructuredNote) writes into the SHARED
-- wiki (content/notebooks/..., class 'note', no author). It asks this BEFORE it writes anything - the vault file or the
-- row - and refuses the note (422) when the answer is true: the wiki guard's own decision for the row it would store
-- (a person's note: its author's own claims, as the guard; any other row: any private-report claim's text, the
-- writer's own included). Note: a refusal tells the writer that SOME private report holds the sentence (the operator's
-- choice; the guard withheld such a row silently before). Callable by the workbench's login (ob_workbench), the
-- services' login (ob_app_memory) or a superuser session, never through PostgREST (570's reader gate).
CREATE OR REPLACE FUNCTION public.private_report_claims_note_refused(p_author TEXT, p_slug TEXT, p_title TEXT, p_body TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.private_report_claims_reader_ok() THEN
        RAISE EXCEPTION 'private report claims: not for this caller' USING ERRCODE = '42501';
    END IF;
    -- the guard's branch for this row: a person's / structured note is judged by its AUTHOR's own claims only (the
    -- workbench names the same author on the row's write: ob.page_author), any other row by every claim
    IF public.private_report_claims_person_note(p_slug, 'note') THEN
        RETURN public.private_report_claims_own_text_shows(nullif(btrim(coalesce(p_author, '')), ''), coalesce(p_slug, '') || ' ' || coalesce(p_title, ''), p_body);
    END IF;
    RETURN public.private_report_claims_page_shows(coalesce(p_slug, '') || ' ' || coalesce(p_title, ''), p_body);
END;
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_note_refused(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE p.oid = 'public.private_report_claims_note_refused(text,text,text,text)'::regprocedure AND NOT ro.rolsuper AND ro.oid <> p.proowner LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.private_report_claims_note_refused(text,text,text,text) FROM %I', r.grantee);
    END LOOP;
    GRANT EXECUTE ON FUNCTION public.private_report_claims_note_refused(TEXT, TEXT, TEXT, TEXT) TO service_role;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        GRANT EXECUTE ON FUNCTION public.private_report_claims_note_refused(TEXT, TEXT, TEXT, TEXT) TO ob_app_memory;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        GRANT EXECUTE ON FUNCTION public.private_report_claims_note_refused(TEXT, TEXT, TEXT, TEXT) TO ob_workbench;
    END IF;
END $$;

-- ── R4: the gap guard, 570's with a NULL kind treated as a non-matching kind (slot 575) ─────────────────────────────
-- (byte for byte 570's function but for the three coalesce(.., '') tests at the top)
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_gap_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_root  UUID;
    v_tree  TEXT;
    v_body  TEXT;
    v_hit   BOOLEAN := false;
    r       RECORD;
    c_n     CONSTANT TEXT := '(a private claim)';
BEGIN
    IF TG_TABLE_NAME = 'research_jobs' THEN
        IF coalesce(NEW.branch_kind, '') NOT IN ('gap', 'interhub') THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND NEW.query IS NOT DISTINCT FROM OLD.query AND NEW.anchor IS NOT DISTINCT FROM OLD.anchor
           AND NEW.topic_estimate IS NOT DISTINCT FROM OLD.topic_estimate AND NEW.tree_report IS NOT DISTINCT FROM OLD.tree_report
           AND NEW.gap_ref IS NOT DISTINCT FROM OLD.gap_ref THEN RETURN NEW; END IF;
        v_body := coalesce(NEW.query, '') || ' ' || coalesce(NEW.anchor, '') || ' ' || coalesce(NEW.topic_estimate, '') || ' '
                  || coalesce(NEW.tree_report::text, '') || ' ' || coalesce(NEW.gap_ref, '');
        v_root := coalesce(NEW.root_job_id, NEW.parent_job_id, NEW.id);
    ELSIF TG_TABLE_NAME = 'research_steers' THEN
        IF coalesce(NEW.steer_kind, '') NOT IN ('gap', 'interhub') THEN RETURN NEW; END IF;
        v_body := coalesce(NEW.text, '') || ' ' || coalesce(NEW.anchor, '') || ' ' || coalesce(NEW.topic_estimate, '') || ' ' || coalesce(NEW.gap::text, '');
        v_root := NEW.root_job_id;
    ELSE
        IF NOT (coalesce(NEW.type, '') IN ('gap', 'interhub_gap')
                OR (NEW.type = 'branch_open' AND coalesce(NEW.payload ->> 'steer_kind', '') IN ('gap', 'interhub'))) THEN RETURN NEW; END IF;
        v_body := coalesce(NEW.payload::text, '');
        v_root := NEW.root_job_id;
    END IF;
    v_tree := public.private_report_claims_tree_owner(v_root);
    FOR r IN
        SELECT x.id, x.text, substr(to_jsonb(x.text)::text, 2, length(to_jsonb(x.text)::text) - 2) AS jtext
          FROM (SELECT c.id, c.text, c.inlet_owner_sub AS owner FROM public.inlet_private_claims c
                 WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
                UNION ALL
                SELECT a.ref::uuid, a.row_data ->> 'text', NULL FROM public.private_report_claims_archive a
                 WHERE a.action = 'x' AND a.restored_at IS NULL) x
         WHERE (x.owner IS NULL OR x.owner IS DISTINCT FROM v_tree)
           AND position(x.id::text IN lower(v_body)) > 0
    LOOP
        v_hit := true;
        IF coalesce(btrim(r.text), '') = '' THEN CONTINUE; END IF;
        IF TG_TABLE_NAME = 'research_jobs' THEN
            NEW.query := replace(NEW.query, r.text, c_n);
            NEW.anchor := replace(NEW.anchor, r.text, c_n);
            NEW.topic_estimate := replace(NEW.topic_estimate, r.text, c_n);
            IF NEW.tree_report IS NOT NULL THEN NEW.tree_report := replace(NEW.tree_report::text, r.jtext, c_n)::jsonb; END IF;
        ELSIF TG_TABLE_NAME = 'research_steers' THEN
            NEW.text := replace(NEW.text, r.text, c_n);
            NEW.anchor := replace(NEW.anchor, r.text, c_n);
            NEW.topic_estimate := replace(NEW.topic_estimate, r.text, c_n);
            IF NEW.gap IS NOT NULL THEN NEW.gap := replace(NEW.gap::text, r.jtext, c_n)::jsonb; END IF;
        ELSE
            NEW.payload := replace(NEW.payload::text, r.jtext, c_n)::jsonb;
        END IF;
    END LOOP;
    IF NOT v_hit THEN RETURN NEW; END IF;
    -- (nested: a plpgsql expression resolves every NEW field it names, so each table's fields only in its own branch)
    IF TG_TABLE_NAME = 'research_jobs' THEN
        IF TG_OP = 'INSERT' THEN
            IF NEW.branch_kind IN ('gap', 'interhub') THEN RETURN NULL; END IF;
        END IF;
    ELSIF TG_TABLE_NAME = 'research_job_events' THEN
        -- a gap event naming the claim keeps the id (the per-tree dedup) but never its text; an inter-hub event's hub
        -- that names a private claim (its label or a member) loses its sample (a claim's text, tree.ts interHubGaps)
        IF NEW.payload ? 'text' THEN NEW.payload := NEW.payload || jsonb_build_object('text', c_n); END IF;
        IF NEW.type = 'interhub_gap' THEN
            FOR r IN SELECT k.key FROM (VALUES ('a'), ('b')) k(key)
                      WHERE jsonb_typeof(NEW.payload -> k.key) = 'object'
                        AND EXISTS (SELECT 1 FROM public.inlet_private_claims c
                                     WHERE (c.inlet_owner_sub IS DISTINCT FROM v_tree)
                                       AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
                                       AND position(c.id::text IN lower((NEW.payload -> k.key)::text)) > 0
                                    UNION ALL
                                    SELECT 1 FROM public.private_report_claims_archive a
                                     WHERE a.action = 'x' AND a.restored_at IS NULL
                                       AND position(a.ref IN lower((NEW.payload -> k.key)::text)) > 0) LOOP
                NEW.payload := jsonb_set(NEW.payload, ARRAY[r.key, 'sample'], to_jsonb(c_n));
            END LOOP;
        END IF;
    ELSE
        -- a machine steer only (a human steer returned at the top)
        NEW.text := c_n;
        IF NEW.gap ? 'text' THEN NEW.gap := NEW.gap || jsonb_build_object('text', c_n); END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_gap_guard() FROM PUBLIC;

-- ── the move ───────────────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_batch    UUID := gen_random_uuid();
    v_cols     TEXT;
    v_scols    TEXT;
    r          RECORD;
    v_n        BIGINT;
    n_frag     BIGINT := 0;
    n_fdup     BIGINT := 0;
    n_own      BIGINT := 0;
    n_held     BIGINT := 0;
    n_edges    BIGINT := 0;
    n_kept_e   BIGINT := 0;
    n_touched  BIGINT := 0;
    n_jobs     BIGINT := 0;
    n_link     BIGINT := 0;
    n_hub      BIGINT := 0;
    n_fpages   BIGINT := 0;
    v_surface  TEXT;
BEGIN
    -- ── R2: the fragments ──────────────────────────────────────────────────────────────────────────────────────────
    -- the private-report claims (an owner store row a private report links; a claim 570 withheld: nobody's), skeletons
    CREATE TEMP TABLE _sc_p ON COMMIT DROP AS
    SELECT x.id, x.owner, x.n FROM (
        SELECT c.id, c.inlet_owner_sub AS owner, pg_temp.sc_n(c.text) AS n
          FROM public.inlet_private_claims c
         WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
        UNION ALL
        SELECT a.ref::uuid, NULL, pg_temp.sc_n(a.row_data ->> 'text')
          FROM public.private_report_claims_archive a WHERE a.action = 'x' AND a.restored_at IS NULL) x
     WHERE length(x.n) >= 24;
    -- the syntheses 570 moved or withheld (its 's' rows), skeletons of their title + content
    CREATE TEMP TABLE _sc_s ON COMMIT DROP AS
    SELECT DISTINCT ON (a.ref) a.ref AS sid,
           pg_temp.sc_n(coalesce(a.row_data ->> 'title', '') || ' ' || coalesce(a.row_data ->> 'content', '')) AS n
      FROM public.private_report_claims_archive a
     WHERE a.action = 's' AND a.tbl = 'public.sources' AND a.restored_at IS NULL
     ORDER BY a.ref, a.id DESC;
    -- the private-report claims each of them restated: its text carried the claim, or it filed it (570's k / x row names it)
    CREATE TEMP TABLE _sc_sp ON COMMIT DROP AS
    SELECT s.sid, p.id AS pid, p.owner, p.n FROM _sc_s s JOIN _sc_p p ON position(p.n IN s.n) > 0
    UNION
    SELECT a.row_data ->> 'synthesis_id', p.id, p.owner, p.n
      FROM public.private_report_claims_archive a JOIN _sc_p p ON p.id::text = a.ref
     WHERE a.action IN ('k', 'x') AND a.restored_at IS NULL AND a.row_data ->> 'synthesis_id' IN (SELECT sid FROM _sc_s);
    -- the fragments: a SHARED claim one of those syntheses filed (570 set its synthesis_id NULL: the 'd' row), not a
    -- private report's own, whose skeleton (24+ letters) is inside the skeleton of a claim that synthesis restated
    CREATE TEMP TABLE _sc_f ON COMMIT DROP AS
    WITH cn AS (
        SELECT DISTINCT c.id, a.ref AS sid, pg_temp.sc_n(c.text) AS n
          FROM public.private_report_claims_archive a JOIN public.claims c ON c.id::text = a.row_data ->> 'id'
         WHERE a.action = 'd' AND a.tbl IN ('public.claims', 'claims') AND a.row_data ->> '_col' = 'synthesis_id' AND a.restored_at IS NULL
           AND a.ref IN (SELECT sid FROM _sc_s)
           AND NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id))
    SELECT cn.id, array_agg(DISTINCT sp.owner) FILTER (WHERE sp.owner IS NOT NULL) AS owners, bool_or(sp.owner IS NULL) AS nobody,
           array_agg(DISTINCT sp.pid) AS restates
      FROM cn JOIN _sc_sp sp ON sp.sid = cn.sid
     WHERE length(cn.n) >= 24 AND position(cn.n IN sp.n) > 0
     GROUP BY cn.id;
    SELECT count(*) INTO n_frag FROM _sc_f;
    CREATE TEMP TABLE _sc_fn (id UUID, n TEXT, text TEXT, jtext TEXT) ON COMMIT DROP;
    IF n_frag > 0 THEN
        INSERT INTO _sc_fn SELECT f.id, pg_temp.sc_n(c.text), c.text, substr(to_jsonb(c.text)::text, 2, length(to_jsonb(c.text)::text) - 2)
          FROM _sc_f f JOIN public.claims c ON c.id = f.id;
        -- a SHARED claim carrying a fragment's sentence follows it (570's duplicate rule, applied to the fragment): its
        -- owners are the fragments' owners, withheld when one of them is
        CREATE TEMP TABLE _sc_dhit ON COMMIT DROP AS
        WITH cn AS MATERIALIZED (
            SELECT c.id, pg_temp.sc_n(c.text) AS n FROM public.claims c
             WHERE c.id NOT IN (SELECT id FROM _sc_f)
               AND NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id))
        SELECT cn.id, f.id AS fid FROM cn JOIN _sc_fn f ON position(f.n IN cn.n) > 0;
        INSERT INTO _sc_f (id, owners, nobody, restates)
        SELECT h.id, array_agg(DISTINCT o.v) FILTER (WHERE o.v IS NOT NULL), bool_or(f.nobody), array_agg(DISTINCT rs.v) FILTER (WHERE rs.v IS NOT NULL)
          FROM _sc_dhit h JOIN _sc_f f ON f.id = h.fid
          LEFT JOIN LATERAL unnest(f.owners) o(v) ON true
          LEFT JOIN LATERAL unnest(f.restates) rs(v) ON true
         GROUP BY h.id;
        GET DIAGNOSTICS n_fdup = ROW_COUNT;
        INSERT INTO _sc_fn SELECT f.id, pg_temp.sc_n(c.text), c.text, substr(to_jsonb(c.text)::text, 2, length(to_jsonb(c.text)::text) - 2)
          FROM _sc_f f JOIN public.claims c ON c.id = f.id WHERE f.id NOT IN (SELECT id FROM _sc_fn);
    END IF;
    ALTER TABLE _sc_f ADD COLUMN owner TEXT;
    UPDATE _sc_f SET owner = owners[1] WHERE NOT nobody AND cardinality(owners) = 1;
    SELECT count(*) FILTER (WHERE owner IS NOT NULL), count(*) FILTER (WHERE owner IS NULL) INTO n_own, n_held FROM _sc_f;

    IF n_own + n_held > 0 THEN
        -- refusals first, nothing changed: a dependent this move cannot archive (570's rule), a column the owner store
        -- lacks, and every other shared surface carrying a fragment's sentence
        FOR r IN SELECT con.conrelid::regclass::text AS tbl, a.attname AS col, cardinality(con.conkey) AS n_cols
                   FROM pg_constraint con
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
                  WHERE con.contype = 'f' AND con.confrelid = 'public.claims'::regclass
                    AND con.conrelid NOT IN ('public.claim_sources'::regclass) LOOP
            IF r.n_cols <> 1 THEN
                RAISE EXCEPTION 'private report claims scope: refused, nothing changed - a multi-column foreign key onto claims (%), not archived by this move', r.tbl USING ERRCODE = '55000';
            END IF;
            EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I IN (SELECT id FROM _sc_f)', r.tbl, r.col) INTO v_n;
            IF v_n > 0 THEN
                RAISE EXCEPTION 'private report claims scope: refused, nothing changed - % row(s) of % reference a fragment claim to move', v_n, r.tbl USING ERRCODE = '55000';
            END IF;
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = 'public.claims'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                      AND NOT EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = 'public.inlet_private_claims'::regclass AND b.attname = a.attname AND NOT b.attisdropped)) THEN
            RAISE EXCEPTION 'private report claims scope: refused, nothing changed - public.claims has a column the owner store lacks (re-run slot 570 first)' USING ERRCODE = '55000';
        END IF;
        v_surface := CASE
            WHEN EXISTS (WITH rw AS MATERIALIZED (SELECT pg_temp.sc_n(coalesce(s.title, '') || ' ' || coalesce(s.content, '')) AS n
                                                   FROM public.sources s WHERE s.content_type = 'research_synthesis')
                         SELECT 1 FROM rw, _sc_fn t WHERE position(t.n IN rw.n) > 0)
                THEN 'a shared synthesis'
            WHEN EXISTS (WITH rw AS MATERIALIZED (SELECT pg_temp.sc_n((SELECT string_agg(v #>> '{}', ' ') FROM jsonb_path_query(j.result - 'reuse_claims' - 'claims', 'strict $.**') v WHERE jsonb_typeof(v) = 'string')) AS n
                                                   FROM public.research_jobs j
                                                  WHERE jsonb_typeof(j.result) = 'object' AND NOT EXISTS (SELECT 1 FROM public.research_job_report_owner(j.id)))
                         SELECT 1 FROM rw, _sc_fn t WHERE position(t.n IN rw.n) > 0)
                THEN 'a shared job report'
            WHEN EXISTS (WITH rw AS MATERIALIZED (SELECT pg_temp.sc_n(coalesce(th.name, '') || ' ' || coalesce(th.description, '') || ' ' || coalesce(th.slug, '')) AS n
                                                   FROM public.threads th)
                         SELECT 1 FROM rw, _sc_fn t WHERE position(t.n IN rw.n) > 0)
                THEN 'a thread'
            WHEN EXISTS (WITH rw AS MATERIALIZED (SELECT pg_temp.sc_n(s.notebook) AS n FROM public.sources s WHERE coalesce(s.notebook, '') <> '')
                         SELECT 1 FROM rw, _sc_fn t WHERE position(t.n IN rw.n) > 0)
                THEN 'a notebook label'
            WHEN EXISTS (WITH rw AS MATERIALIZED (SELECT pg_temp.sc_n(coalesce(j.result -> 'curator' ->> 'thread_name', '') || ' ' || coalesce((SELECT string_agg(x ->> 'name', ' ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'curator' -> 'shortlist') = 'array' THEN j.result -> 'curator' -> 'shortlist' ELSE '[]'::jsonb END) x), '')) AS n
                                                   FROM public.research_jobs j WHERE jsonb_typeof(j.result -> 'curator') = 'object')
                         SELECT 1 FROM rw, _sc_fn t WHERE position(t.n IN rw.n) > 0)
                THEN 'a curator answer'
            WHEN EXISTS (SELECT 1 FROM public.research_jobs j JOIN _sc_fn t
                            ON (j.branch_kind IN ('gap', 'interhub') AND position(t.text IN coalesce(j.query, '')) > 0)
                            OR (j.branch_kind IN ('root', 'idea') AND position(t.jtext IN coalesce(j.tree_report::text, '')) > 0))
              OR EXISTS (SELECT 1 FROM public.research_steers s JOIN _sc_fn t ON position(t.text IN s.text) > 0 OR position(t.jtext IN coalesce(s.gap::text, '')) > 0
                          WHERE s.steer_kind IN ('gap', 'interhub'))
              OR EXISTS (SELECT 1 FROM public.research_job_events e JOIN _sc_fn t ON position(t.jtext IN e.payload::text) > 0
                          WHERE e.type IN ('gap', 'interhub_gap', 'topic')
                             OR (e.type = 'branch_open' AND coalesce(e.payload ->> 'steer_kind', '') IN ('gap', 'interhub')))
                THEN 'a research tree''s gap work' END;
        IF v_surface IS NOT NULL THEN
            RAISE EXCEPTION 'private report claims scope: refused, nothing changed - % carries the sentence of a fragment claim to move (a case for a person: archive or rewrite it, then run this again)', v_surface USING ERRCODE = '55000';
        END IF;

        -- archive first: the claims, every edge of or onto them, every shared claim that loses an edge (whole)
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claims', CASE WHEN x.owner IS NULL THEN 'x' ELSE 'k' END, c.id::text, to_jsonb(c)
          FROM public.claims c JOIN _sc_f x ON x.id = c.id;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claim_sources', 'e', cs.claim_id::text, to_jsonb(cs)
          FROM public.claim_sources cs
         WHERE cs.claim_id IN (SELECT id FROM _sc_f) OR cs.parent_claim_id IN (SELECT id FROM _sc_f);
        GET DIAGNOSTICS n_edges = ROW_COUNT;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claims', 'm', c.id::text, to_jsonb(c)
          FROM public.claims c
         WHERE c.id NOT IN (SELECT id FROM _sc_f)
           AND (c.id IN (SELECT cs.claim_id FROM public.claim_sources cs WHERE cs.parent_claim_id IN (SELECT id FROM _sc_f))
             OR c.id IN (SELECT cs.parent_claim_id FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _sc_f)));
        GET DIAGNOSTICS n_touched = ROW_COUNT;

        -- the owner's copy (PD1's store): the claim's own columns, the owner, this batch; its own edges, keyed by owner
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum), string_agg('s.' || quote_ident(attname), ', ' ORDER BY attnum)
          INTO v_cols, v_scols
          FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
        EXECUTE format('INSERT INTO public.inlet_private_claims (%s, inlet_owner_sub, inlet_batch) SELECT %s, x.owner, $1 FROM public.claims s JOIN _sc_f x ON x.id = s.id WHERE x.owner IS NOT NULL',
                       v_cols, v_scols) USING v_batch;
        INSERT INTO public.inlet_private_claim_sources (claim_id, edge_ref, owner_sub, batch, source_id, parent_claim_id, row_data)
        SELECT cs.claim_id, md5(to_jsonb(cs)::text), x.owner, v_batch, cs.source_id, cs.parent_claim_id, to_jsonb(cs)
          FROM public.claim_sources cs JOIN _sc_f x ON x.id = cs.claim_id
         WHERE x.owner IS NOT NULL;
        GET DIAGNOSTICS n_kept_e = ROW_COUNT;

        -- the jobs (570's rule): a result element naming a moved claim leaves every job whose report owner is not the
        -- claim's owner (metrics.claims_reused follows); the (result, metrics) pair archived (j)
        CREATE TEMP TABLE _sc_jobs ON COMMIT DROP AS
        SELECT j.id, j.result, to_jsonb(j) -> 'metrics' AS metrics,
               (SELECT o.owner_sub FROM public.research_job_report_owner(j.id) o LIMIT 1) AS job_owner
          FROM public.research_jobs j
         WHERE jsonb_typeof(j.result) = 'object'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'claims') = 'array' THEN j.result -> 'claims' ELSE '[]'::jsonb END
                                                          || CASE WHEN jsonb_typeof(j.result -> 'reuse_claims') = 'array' THEN j.result -> 'reuse_claims' ELSE '[]'::jsonb END) e
                        JOIN _sc_f x ON x.id::text = (e ->> 'id'));
        ALTER TABLE _sc_jobs ADD COLUMN new_result JSONB, ADD COLUMN new_metrics JSONB, ADD COLUMN cut_reuse INT;
        UPDATE _sc_jobs t SET new_result = t.result
              || CASE WHEN jsonb_typeof(t.result -> 'claims') = 'array' THEN jsonb_build_object('claims', coalesce((
                     SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(t.result -> 'claims') WITH ORDINALITY AS z(e, o)
                      WHERE NOT EXISTS (SELECT 1 FROM _sc_f x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))), '[]'::jsonb)) ELSE '{}'::jsonb END
              || CASE WHEN jsonb_typeof(t.result -> 'reuse_claims') = 'array' THEN jsonb_build_object('reuse_claims', coalesce((
                     SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(t.result -> 'reuse_claims') WITH ORDINALITY AS z(e, o)
                      WHERE NOT EXISTS (SELECT 1 FROM _sc_f x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))), '[]'::jsonb)) ELSE '{}'::jsonb END,
               cut_reuse = CASE WHEN jsonb_typeof(t.result -> 'reuse_claims') = 'array' THEN (
                     SELECT count(*) FROM jsonb_array_elements(t.result -> 'reuse_claims') z(e)
                      WHERE EXISTS (SELECT 1 FROM _sc_f x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))) ELSE 0 END;
        UPDATE _sc_jobs t SET new_metrics = CASE WHEN t.cut_reuse > 0 AND jsonb_typeof(t.metrics -> 'claims_reused') = 'number'
                                                 THEN t.metrics || jsonb_build_object('claims_reused', greatest((t.metrics ->> 'claims_reused')::numeric - t.cut_reuse, 0))
                                                 ELSE t.metrics END;
        DELETE FROM _sc_jobs t WHERE t.new_result IS NOT DISTINCT FROM t.result AND t.new_metrics IS NOT DISTINCT FROM t.metrics;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_jobs', 'j', t.id::text, jsonb_build_object('id', t.id, 'result', t.result, 'metrics', t.metrics)
          FROM _sc_jobs t;
        GET DIAGNOSTICS n_jobs = ROW_COUNT;

        -- the shared rows go (the edge deletes recompute the shared claims archived whole above); a moved claim is linked
        -- to its owner's reports that link the claims it restates (archived l: the revert removes them)
        DELETE FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _sc_f) OR cs.parent_claim_id IN (SELECT id FROM _sc_f);
        DELETE FROM public.claims c WHERE c.id IN (SELECT id FROM _sc_f);
        CREATE TEMP TABLE _sc_links ON COMMIT DROP AS
        SELECT DISTINCT f.id AS claim_id, pc.report_id
          FROM _sc_f f
          JOIN public.research_private_report_claims pc ON pc.claim_id = ANY(f.restates)
          JOIN public.research_private_reports p ON p.id = pc.report_id AND p.owner_sub = f.owner
         WHERE f.owner IS NOT NULL;
        IF EXISTS (SELECT 1 FROM _sc_f f WHERE f.owner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _sc_links l WHERE l.claim_id = f.id)) THEN
            RAISE EXCEPTION 'private report claims scope: refused, nothing changed - a fragment claim would move to an owner with no report of theirs to link it to' USING ERRCODE = '55000';
        END IF;
        INSERT INTO public.research_private_report_claims (report_id, claim_id)
        SELECT l.report_id, l.claim_id FROM _sc_links l ON CONFLICT DO NOTHING;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_private_report_claims', 'l', l.claim_id::text, jsonb_build_object('report_id', l.report_id, 'claim_id', l.claim_id)
          FROM _sc_links l;
        GET DIAGNOSTICS n_link = ROW_COUNT;
        -- the job results, with ordinary triggers off (their touch timestamps do not move: the revert is byte-identical)
        PERFORM set_config('session_replication_role', 'replica', true);
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attname = 'metrics' AND NOT attisdropped) THEN
            UPDATE public.research_jobs j SET result = t.new_result, metrics = t.new_metrics FROM _sc_jobs t WHERE t.id = j.id;
        ELSE
            UPDATE public.research_jobs j SET result = t.new_result FROM _sc_jobs t WHERE t.id = j.id;
        END IF;
        PERFORM set_config('session_replication_role', 'origin', true);
    END IF;

    -- ── R1: the notebook-tree rows 570 skipped (class 'note', not a person's note) ─────────────────────────────────
    -- judged by 570's own predicate (it reads the owner stores and every withheld claim - this batch's included), archived
    -- and withheld
    -- (R6: the text set private_report_claims_page_shows reads at this point - every owner-store claim a private report
    --  links and every withheld one, this batch's included - each skeleton once; each page's skeleton once, through the
    --  memo: the same page set as calling page_shows(slug || ' ' || title, body) on each page)
    CREATE TEMP TABLE _sc_txt ON COMMIT DROP AS
    SELECT DISTINCT x.n FROM (
        SELECT pg_temp.sc_n(c.text) AS n FROM public.inlet_private_claims c
         WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
        UNION ALL
        SELECT pg_temp.sc_n(a.row_data ->> 'text') FROM public.private_report_claims_archive a WHERE a.action = 'x' AND a.restored_at IS NULL) x
     WHERE length(x.n) >= 24;
    CREATE TEMP TABLE _sc_hub ON COMMIT DROP AS
    WITH pn AS MATERIALIZED (
        SELECT w.slug, pg_temp.sc_n(coalesce(w.slug, '') || ' ' || coalesce(w.title, '') || ' ' || coalesce(w.body, '')) AS n FROM public.wiki_pages w
         WHERE w.page_class = 'note' AND NOT public.private_report_claims_person_note(w.slug, w.page_class))
    SELECT pn.slug FROM pn WHERE EXISTS (SELECT 1 FROM _sc_txt t WHERE position(t.n IN pn.n) > 0);
    -- (archived in the table's own order, ctid: deterministic archive ids - rw-570-perf attempt 2)
    INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
    SELECT v_batch, 'public.wiki_pages', 'w', w.slug, to_jsonb(w) FROM public.wiki_pages w
     WHERE EXISTS (SELECT 1 FROM _sc_hub h WHERE h.slug = w.slug) ORDER BY w.ctid;
    GET DIAGNOSTICS n_hub = ROW_COUNT;
    -- R2: every other page 570 judged (not a person's note) that carries a moved fragment's sentence - only when one moved
    CREATE TEMP TABLE _sc_fpage (slug TEXT) ON COMMIT DROP;
    IF n_own + n_held > 0 THEN
        INSERT INTO _sc_fpage
        WITH pn AS MATERIALIZED (
            SELECT w.slug, pg_temp.sc_n(coalesce(w.slug, '') || ' ' || coalesce(w.title, '') || ' ' || coalesce(w.body, '')) AS n FROM public.wiki_pages w
             WHERE w.slug NOT IN (SELECT slug FROM _sc_hub)
               AND NOT public.private_report_claims_person_note(w.slug, w.page_class))
        SELECT pn.slug FROM pn WHERE EXISTS (SELECT 1 FROM _sc_fn t WHERE position(t.n IN pn.n) > 0);
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.wiki_pages', 'w', w.slug, to_jsonb(w) FROM public.wiki_pages w
         WHERE EXISTS (SELECT 1 FROM _sc_fpage h WHERE h.slug = w.slug) ORDER BY w.ctid;
        GET DIAGNOSTICS n_fpages = ROW_COUNT;
    END IF;
    DELETE FROM public.wiki_pages w USING public.private_report_claims_archive a
     WHERE a.batch = v_batch AND a.action = 'w' AND a.ref = w.slug;

    -- fail closed: nothing of what moved is left on a shared surface
    IF EXISTS (SELECT 1 FROM public.claims c WHERE c.id IN (SELECT id FROM _sc_f))
       OR EXISTS (SELECT 1 FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _sc_f) OR cs.parent_claim_id IN (SELECT id FROM _sc_f))
       OR EXISTS (SELECT 1 FROM public.wiki_pages w WHERE w.slug IN (SELECT slug FROM _sc_fpage))
       OR EXISTS (WITH tx AS MATERIALIZED (SELECT DISTINCT x.n FROM (
        SELECT pg_temp.sc_n(c.text) AS n FROM public.inlet_private_claims c
         WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
        UNION ALL
        SELECT pg_temp.sc_n(a.row_data ->> 'text') FROM public.private_report_claims_archive a WHERE a.action = 'x' AND a.restored_at IS NULL) x
     WHERE length(x.n) >= 24),
                  pn AS MATERIALIZED (
                      SELECT pg_temp.sc_n(coalesce(w.slug, '') || ' ' || coalesce(w.title, '') || ' ' || coalesce(w.body, '')) AS n FROM public.wiki_pages w
                       WHERE w.page_class = 'note' AND NOT public.private_report_claims_person_note(w.slug, w.page_class))
                  SELECT 1 FROM pn, tx WHERE position(tx.n IN pn.n) > 0) THEN
        RAISE EXCEPTION 'private report claims scope: refused, nothing changed - a moved claim is still on a shared surface after the move' USING ERRCODE = '55000';
    END IF;

    IF n_own + n_held + n_hub + n_fpages = 0 THEN
        RAISE NOTICE 'private report claims scope: nothing to move';
    ELSE
        -- this slot's batch marker: revert-private-report-claims-scope.sql restores the batches that carry one
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        VALUES (v_batch, 'slot 575', 'z', '575', jsonb_build_object('slot', 575));
        RAISE NOTICE 'private report claims scope: % fragment claim(s) and % claim(s) carrying a fragment''s sentence - % moved to their owner''s store (% edge(s) kept for the owner, % link(s) added), % withheld',
            n_frag, n_fdup, n_own, n_kept_e, n_link, n_held;
        RAISE NOTICE 'private report claims scope: % edge(s) archived and deleted, % shared claim(s) that lost an edge archived whole, % job result(s) stripped; % notebook hub / index / AI-note page(s) withheld, % other page(s) carrying a fragment withheld',
            n_edges, n_touched, n_jobs, n_hub, n_fpages;
    END IF;
END $$;

DROP FUNCTION pg_temp.sc_n(TEXT);
DROP FUNCTION pg_temp.sc_memo(TEXT[]);
DROP FUNCTION pg_temp.private_report_claims_person_note_pre(TEXT, TEXT);

NOTIFY pgrst, 'reload schema';
COMMIT;
