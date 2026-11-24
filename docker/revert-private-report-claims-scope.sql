-- ============================================================
-- Revert of slot 575 (init-private-report-claims-scope.sql, research-workbench rw-570-hub-note-scope).
--   * every batch of slot 575 not yet restored (the batches of 570's archive that carry a 'z' row), the newest first,
--     with ordinary triggers off (session_replication_role = replica) so every row is byte-identical to the state 570
--     left: the fragment claims it moved or withheld (k / x), their edges (e), the shared claims that lost an edge
--     (m, whole), the job results it stripped (j), the notebook-tree and fragment pages it withheld (w); the links it
--     added (l) go, and so do its copies in the owner stores (inlet_private_claims, inlet_private_claim_sources);
--   * slot 570's two guard functions come back byte for byte (trg_private_report_claims_wiki_guard: every 'note' row is
--     a person's note; trg_private_report_claims_gap_guard: the NOT IN without coalesce) - while 570's wiki guard is
--     installed; when 570 was reverted already they are not left behind;
--   * the person-note helper (private_report_claims_person_note) and the structured-note check
--     (private_report_claims_note_refused, R5) go.
-- DEPLOY (RV3): put the previous workbench image back FIRST - the new image's POST /workbench/notes asks 575's
-- private_report_claims_note_refused, which this revert drops, and fails closed (503, nothing written) without it.
-- Counts only (NOTICE). A second run has nothing to restore. Revert ORDER: this file FIRST, then (if ever)
-- revert-private-report-claims.sql (570's revert run alone restores this slot's batches too, the newest first, and
-- drops the two guard functions; only the helper is then left, harmless, and this file drops it).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;

DO $$
DECLARE
    v_batch UUID;
    v_cols  TEXT;
    v_rcols TEXT;
    v_wcols TEXT;
    v_wrcols TEXT;
    v_ecols TEXT;
    v_ercols TEXT;
    v_n     BIGINT;
    n_b     BIGINT := 0;
    n_k     BIGINT := 0;
    n_e     BIGINT := 0;
    n_m     BIGINT := 0;
    n_j     BIGINT := 0;
    n_w     BIGINT := 0;
    n_l     BIGINT := 0;
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL THEN
        RAISE NOTICE 'private report claims scope revert: slot 570 was never applied - nothing to restore';
        RETURN;
    END IF;
    LOCK TABLE public.wiki_pages, public.claims, public.claim_sources, public.research_private_report_claims,
               public.inlet_private_claims, public.inlet_private_claim_sources, public.research_jobs
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum), string_agg('r.' || quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols, v_rcols
      FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum), string_agg('r.' || quote_ident(attname), ', ' ORDER BY attnum) INTO v_wcols, v_wrcols
      FROM pg_attribute WHERE attrelid = 'public.wiki_pages'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum), string_agg('r.' || quote_ident(attname), ', ' ORDER BY attnum) INTO v_ecols, v_ercols
      FROM pg_attribute WHERE attrelid = 'public.claim_sources'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

    PERFORM set_config('session_replication_role', 'replica', true);
    FOR v_batch IN SELECT a.batch FROM public.private_report_claims_archive a
                    WHERE a.restored_at IS NULL
                      AND EXISTS (SELECT 1 FROM public.private_report_claims_archive z WHERE z.batch = a.batch AND z.action = 'z' AND z.tbl = 'slot 575' AND z.restored_at IS NULL)
                    GROUP BY a.batch ORDER BY max(a.id) DESC LOOP
        -- a moved claim's thread and text taken meanwhile by a shared claim stops the revert, nothing changed (570's rule)
        SELECT count(*) INTO v_n FROM public.private_report_claims_archive a JOIN public.claims c
            ON c.content_hash = a.row_data ->> 'content_hash' AND c.thread_id IS NOT DISTINCT FROM (a.row_data ->> 'thread_id')::uuid
         WHERE a.batch = v_batch AND a.action IN ('k', 'x') AND a.restored_at IS NULL AND c.id::text <> a.ref;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'private report claims scope revert: refused, nothing changed - % shared claim(s) filed since carry a moved claim''s thread and text', v_n USING ERRCODE = '55000';
        END IF;
        EXECUTE format('INSERT INTO public.claims (%s) SELECT %s FROM public.private_report_claims_archive a, jsonb_populate_record(NULL::public.claims, a.row_data) r
                         WHERE a.batch = $1 AND a.action IN (''k'', ''x'') AND a.restored_at IS NULL', v_cols, v_rcols)
            USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT; n_k := n_k + v_n;
        EXECUTE format('INSERT INTO public.claim_sources (%s) SELECT %s FROM public.private_report_claims_archive a, jsonb_populate_record(NULL::public.claim_sources, a.row_data) r
                         WHERE a.batch = $1 AND a.action = ''e'' AND a.restored_at IS NULL', v_ecols, v_ercols)
            USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT; n_e := n_e + v_n;
        EXECUTE format('UPDATE public.claims c SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::public.claims, a.row_data) r)
                          FROM public.private_report_claims_archive a
                         WHERE a.batch = $1 AND a.action = ''m'' AND a.restored_at IS NULL AND c.id::text = a.ref', v_cols, v_rcols)
            USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT; n_m := n_m + v_n;
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attname = 'metrics' AND NOT attisdropped) THEN
            UPDATE public.research_jobs j SET result = a.row_data -> 'result', metrics = a.row_data -> 'metrics'
              FROM public.private_report_claims_archive a
             WHERE a.batch = v_batch AND a.action = 'j' AND a.restored_at IS NULL AND j.id::text = a.ref;
        ELSE
            UPDATE public.research_jobs j SET result = a.row_data -> 'result'
              FROM public.private_report_claims_archive a
             WHERE a.batch = v_batch AND a.action = 'j' AND a.restored_at IS NULL AND j.id::text = a.ref;
        END IF;
        GET DIAGNOSTICS v_n = ROW_COUNT; n_j := n_j + v_n;
        EXECUTE format('INSERT INTO public.wiki_pages (%s) SELECT %s FROM public.private_report_claims_archive a, jsonb_populate_record(NULL::public.wiki_pages, a.row_data) r
                         WHERE a.batch = $1 AND a.action = ''w'' AND a.restored_at IS NULL
                           AND NOT EXISTS (SELECT 1 FROM public.wiki_pages w WHERE w.slug = a.ref)', v_wcols, v_wrcols)
            USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT; n_w := n_w + v_n;
        DELETE FROM public.research_private_report_claims pc USING public.private_report_claims_archive a
         WHERE a.batch = v_batch AND a.action = 'l' AND a.restored_at IS NULL
           AND pc.claim_id::text = a.row_data ->> 'claim_id' AND pc.report_id::text = a.row_data ->> 'report_id';
        GET DIAGNOSTICS v_n = ROW_COUNT; n_l := n_l + v_n;
        DELETE FROM public.inlet_private_claim_sources WHERE batch = v_batch;
        DELETE FROM public.inlet_private_claims WHERE inlet_batch = v_batch;
        UPDATE public.private_report_claims_archive SET restored_at = now() WHERE batch = v_batch AND restored_at IS NULL;
        n_b := n_b + 1;
    END LOOP;
    PERFORM set_config('session_replication_role', 'origin', true);

    IF n_b = 0 THEN
        RAISE NOTICE 'private report claims scope revert: nothing to restore';
    ELSE
        RAISE NOTICE 'private report claims scope revert: % batch(es): % claim(s) restored (% edge(s), % shared claim image(s)), % job result(s), % wiki page(s), % added link(s) removed',
            n_b, n_k, n_e, n_m, n_j, n_w, n_l;
    END IF;
END $$;

-- ── slot 570's two guard functions, byte for byte ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.page_class = 'note' THEN
        IF public.private_report_claims_own_text_shows(nullif(current_setting('ob.page_author', true), ''), coalesce(NEW.slug, '') || ' ' || coalesce(NEW.title, ''), NEW.body) THEN
            RAISE EXCEPTION 'wiki_pages: this page cannot be saved' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    -- (round 3: the slug is part of the page's text - a hub page's path is its thread's slug)
    IF public.private_report_claims_page_shows(coalesce(NEW.slug, '') || ' ' || coalesce(NEW.title, ''), NEW.body) THEN
        PERFORM public.wiki_guard_mark_withheld();
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_wiki_guard() FROM PUBLIC;

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
        IF NEW.branch_kind NOT IN ('gap', 'interhub') THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND NEW.query IS NOT DISTINCT FROM OLD.query AND NEW.anchor IS NOT DISTINCT FROM OLD.anchor
           AND NEW.topic_estimate IS NOT DISTINCT FROM OLD.topic_estimate AND NEW.tree_report IS NOT DISTINCT FROM OLD.tree_report
           AND NEW.gap_ref IS NOT DISTINCT FROM OLD.gap_ref THEN RETURN NEW; END IF;
        v_body := coalesce(NEW.query, '') || ' ' || coalesce(NEW.anchor, '') || ' ' || coalesce(NEW.topic_estimate, '') || ' '
                  || coalesce(NEW.tree_report::text, '') || ' ' || coalesce(NEW.gap_ref, '');
        v_root := coalesce(NEW.root_job_id, NEW.parent_job_id, NEW.id);
    ELSIF TG_TABLE_NAME = 'research_steers' THEN
        IF NEW.steer_kind NOT IN ('gap', 'interhub') THEN RETURN NEW; END IF;
        v_body := coalesce(NEW.text, '') || ' ' || coalesce(NEW.anchor, '') || ' ' || coalesce(NEW.topic_estimate, '') || ' ' || coalesce(NEW.gap::text, '');
        v_root := NEW.root_job_id;
    ELSE
        IF NOT (NEW.type IN ('gap', 'interhub_gap')
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
-- (only while slot 570 is installed: when 570 was reverted first, the functions are not left behind)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_private_report_claims_wiki_guard' AND NOT tgisinternal) THEN
        DROP FUNCTION IF EXISTS public.trg_private_report_claims_wiki_guard();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_private_report_claims_gap_guard' AND NOT tgisinternal) THEN
        DROP FUNCTION IF EXISTS public.trg_private_report_claims_gap_guard();
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.private_report_claims_note_refused(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.private_report_claims_person_note(TEXT, TEXT);

NOTIFY pgrst, 'reload schema';
COMMIT;
