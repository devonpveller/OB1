-- ============================================================
-- Revert of slot 570 (init-private-report-claims.sql, research-workbench rw-private-report-claims).
--   * the two guards (wiki_pages, research_private_report_claims) go first;
--   * the claims the research curator filed private AFTER slot 570 (inlet_private_claims, batch
--     private_report_claims_filed_batch()) go back to the 390 model the revert returns to: a shared claim (the same id,
--     its edges into claim_sources) linked to the private report - or, where a shared claim with the same thread and
--     text exists by now, the link is re-pointed at it (find_or_create_claim's dedup, as before 570). Counted;
--   * every archived batch not yet restored comes back, the newest first, with ordinary triggers off
--     (session_replication_role = replica) so every row is byte-identical: the moved and withheld claims, their edges,
--     the shared claims that lost an edge (whole), the jobs' (result, metrics), the withheld wiki pages; the batch's
--     copies leave the owner stores (inlet_private_claims, inlet_private_claim_sources);
--   * the link's foreign key onto public.claims is put back from its archived definition (refused, nothing changed,
--     while a link names a claim that is in no table);
--   * the corroboration lines slot 570 made neutral get their text back (its guard on source_corroborations goes);
--   * the functions go; the archive and salt tables stay (restored rows carry restored_at).
-- Counts only (NOTICE). A second run has nothing to restore. Run it BEFORE the 480 / 470 / 440 / 390 reverts.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;

DO $$
DECLARE
    v_batch UUID;
    v_cols  TEXT;
    v_wcols TEXT;
    v_ecols TEXT;
    r       RECORD;
    v_id    UUID;
    v_n     BIGINT;
    n_filed BIGINT := 0;
    n_point BIGINT := 0;
    n_k     BIGINT := 0;
    n_e     BIGINT := 0;
    n_m     BIGINT := 0;
    n_j     BIGINT := 0;
    n_w     BIGINT := 0;
    n_fk    BIGINT := 0;
    n_c     BIGINT := 0;
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL THEN
        RAISE NOTICE 'private report claims revert: slot 570 was never applied - nothing to restore';
        RETURN;
    END IF;
    LOCK TABLE public.claims, public.claim_sources, public.research_private_report_claims, public.research_jobs, public.wiki_pages,
               public.inlet_private_claims, public.inlet_private_claim_sources IN SHARE ROW EXCLUSIVE MODE;
    DROP TRIGGER IF EXISTS trg_private_report_claims_wiki_guard ON public.wiki_pages;
    DROP TRIGGER IF EXISTS trg_private_report_claims_link_guard ON public.research_private_report_claims;
    IF to_regclass('public.source_corroborations') IS NOT NULL THEN
        LOCK TABLE public.source_corroborations IN SHARE ROW EXCLUSIVE MODE;
        DROP TRIGGER IF EXISTS trg_private_report_claims_corroboration_guard ON public.source_corroborations;
    END IF;

    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
      FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_wcols
      FROM pg_attribute WHERE attrelid = 'public.wiki_pages'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_ecols
      FROM pg_attribute WHERE attrelid = 'public.claim_sources'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

    -- 1. the curator's private filings since 570: back to shared claims (the 390 model)
    IF to_regprocedure('public.private_report_claims_filed_batch()') IS NOT NULL THEN
        FOR r IN SELECT c.id, c.thread_id, c.content_hash FROM public.inlet_private_claims c
                  WHERE c.inlet_batch = public.private_report_claims_filed_batch() ORDER BY c.created_at LOOP
            SELECT s.id INTO v_id FROM public.claims s
             WHERE s.content_hash = r.content_hash AND s.thread_id IS NOT DISTINCT FROM r.thread_id ORDER BY s.created_at LIMIT 1;
            IF v_id IS NOT NULL THEN
                INSERT INTO public.research_private_report_claims (report_id, claim_id)
                SELECT pc.report_id, v_id FROM public.research_private_report_claims pc WHERE pc.claim_id = r.id ON CONFLICT DO NOTHING;
                DELETE FROM public.research_private_report_claims WHERE claim_id = r.id;
                n_point := n_point + 1;
            ELSE
                EXECUTE format('INSERT INTO public.claims (%s) SELECT %s FROM public.inlet_private_claims WHERE id = $1', v_cols, v_cols) USING r.id;
                v_id := r.id;
                n_filed := n_filed + 1;
            END IF;
            INSERT INTO public.claim_sources (claim_id, source_id, parent_claim_id, edge_type, weight, created_at)
            SELECT v_id, e.source_id, NULL, e.row_data ->> 'edge_type', (e.row_data ->> 'weight')::real,
                   coalesce((e.row_data ->> 'created_at')::timestamptz, now())
              FROM public.inlet_private_claim_sources e
             WHERE e.claim_id = r.id AND e.batch = public.private_report_claims_filed_batch()
               AND EXISTS (SELECT 1 FROM public.sources s WHERE s.id = e.source_id)
            ON CONFLICT DO NOTHING;
            DELETE FROM public.inlet_private_claim_sources WHERE claim_id = r.id AND batch = public.private_report_claims_filed_batch();
            DELETE FROM public.inlet_private_claims WHERE id = r.id;
        END LOOP;
    END IF;

    -- 2. every archived batch not yet restored, the newest first, triggers off
    PERFORM set_config('session_replication_role', 'replica', true);
    FOR v_batch IN SELECT a.batch FROM public.private_report_claims_archive a WHERE a.restored_at IS NULL
                    GROUP BY a.batch ORDER BY max(a.id) DESC LOOP
        -- a moved claim's id taken meanwhile by a shared claim of the same thread and text stops the revert, nothing changed
        SELECT count(*) INTO v_n FROM public.private_report_claims_archive a JOIN public.claims c
            ON c.content_hash = a.row_data ->> 'content_hash' AND c.thread_id IS NOT DISTINCT FROM (a.row_data ->> 'thread_id')::uuid
         WHERE a.batch = v_batch AND a.action IN ('k', 'x') AND a.restored_at IS NULL AND c.id::text <> a.ref;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'private report claims revert: refused, nothing changed - % shared claim(s) filed since carry a moved claim''s thread and text', v_n USING ERRCODE = '55000';
        END IF;
        EXECUTE format('INSERT INTO public.claims (%s) SELECT %s FROM public.private_report_claims_archive a, jsonb_populate_record(NULL::public.claims, a.row_data) r
                         WHERE a.batch = $1 AND a.action IN (''k'', ''x'') AND a.restored_at IS NULL', v_cols,
                       (SELECT string_agg('r.' || quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''))
            USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT; n_k := n_k + v_n;
        EXECUTE format('INSERT INTO public.claim_sources (%s) SELECT %s FROM public.private_report_claims_archive a, jsonb_populate_record(NULL::public.claim_sources, a.row_data) r
                         WHERE a.batch = $1 AND a.action = ''e'' AND a.restored_at IS NULL', v_ecols,
                       (SELECT string_agg('r.' || quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.claim_sources'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''))
            USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT; n_e := n_e + v_n;
        EXECUTE format('UPDATE public.claims c SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::public.claims, a.row_data) r)
                          FROM public.private_report_claims_archive a
                         WHERE a.batch = $1 AND a.action = ''m'' AND a.restored_at IS NULL AND c.id::text = a.ref', v_cols,
                       (SELECT string_agg('r.' || quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''))
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
                           AND NOT EXISTS (SELECT 1 FROM public.wiki_pages w WHERE w.slug = a.ref)', v_wcols,
                       (SELECT string_agg('r.' || quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.wiki_pages'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''))
            USING v_batch;
        GET DIAGNOSTICS v_n = ROW_COUNT; n_w := n_w + v_n;
        IF to_regclass('public.source_corroborations') IS NOT NULL THEN
            UPDATE public.source_corroborations sc SET claim_text = a.row_data ->> 'claim_text'
              FROM public.private_report_claims_archive a
             WHERE a.batch = v_batch AND a.action = 'c' AND a.restored_at IS NULL AND sc.id::text = a.ref;
            GET DIAGNOSTICS v_n = ROW_COUNT; n_c := n_c + v_n;
        END IF;
        DELETE FROM public.inlet_private_claim_sources WHERE batch = v_batch;
        DELETE FROM public.inlet_private_claims WHERE inlet_batch = v_batch;
        UPDATE public.private_report_claims_archive SET restored_at = now()
         WHERE batch = v_batch AND restored_at IS NULL AND action <> 'f';
    END LOOP;
    PERFORM set_config('session_replication_role', 'origin', true);

    -- 3. the link's foreign key, from its archived definition (the newest)
    FOR r IN SELECT a.id, a.row_data ->> 'name' AS name, a.row_data ->> 'def' AS def
               FROM public.private_report_claims_archive a WHERE a.action = 'f' AND a.restored_at IS NULL ORDER BY a.id DESC LIMIT 1 LOOP
        SELECT count(*) INTO v_n FROM public.research_private_report_claims pc
         WHERE NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.id = pc.claim_id);
        IF v_n > 0 THEN
            RAISE EXCEPTION 'private report claims revert: refused, nothing changed - % link(s) name a claim that is in no table', v_n USING ERRCODE = '55000';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.research_private_report_claims'::regclass AND conname = r.name) THEN
            EXECUTE format('ALTER TABLE public.research_private_report_claims ADD CONSTRAINT %I %s', r.name, r.def);
            n_fk := 1;
        END IF;
        UPDATE public.private_report_claims_archive SET restored_at = now() WHERE action = 'f' AND restored_at IS NULL;
    END LOOP;

    IF n_filed + n_point + n_k + n_e + n_m + n_j + n_w + n_fk + n_c = 0 THEN
        RAISE NOTICE 'private report claims revert: nothing to restore';
    ELSE
        RAISE NOTICE 'private report claims revert: % claim(s) restored (% edge(s), % shared claim image(s)), % job result(s), % wiki page(s), % corroboration line(s), foreign key %; % curator filing(s) made shared again, % re-pointed at a shared claim',
            n_k, n_e, n_m, n_j, n_w, n_c, CASE WHEN n_fk = 1 THEN 'restored' ELSE 'already there' END, n_filed, n_point;
    END IF;
END $$;

DROP FUNCTION IF EXISTS public.private_report_claim_file(TEXT, UUID, TEXT, UUID, TEXT, TEXT, INT, VECTOR, JSONB);
DROP FUNCTION IF EXISTS public.private_report_claim_edge(UUID, UUID, TEXT, REAL);
DROP FUNCTION IF EXISTS public.private_report_claims_of_idea(UUID, TEXT);
DROP FUNCTION IF EXISTS public.trg_private_report_claims_wiki_guard();
DROP FUNCTION IF EXISTS public.trg_private_report_claims_link_guard();
DROP FUNCTION IF EXISTS public.private_report_claims_page_shows(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.private_report_claim_norm(TEXT);
DROP FUNCTION IF EXISTS public.private_report_claims_filed_batch();
DROP FUNCTION IF EXISTS public.private_report_claim_subject_ok(TEXT);
DROP FUNCTION IF EXISTS public.trg_private_report_claims_corroboration_guard();
DROP FUNCTION IF EXISTS public.private_report_claims_neutral_line(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.private_report_claims_job_private(UUID);

NOTIFY pgrst, 'reload schema';
COMMIT;
