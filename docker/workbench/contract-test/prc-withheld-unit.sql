-- prc-withheld-unit.sql - slot 660's unit probes (run-private-report-claims-withheld-unit.ps1), on the runner's STUB
-- schema (the tables 570's own-sentence check reads, 570's / 575's functions copied verbatim from their files) in a
-- throw-away --network none container. Never against a real database. Prints "key=value" lines: states only, never text.
-- The plant: subjects A, B, C (valid), the report owners NULL and 'operator' (not valid subjects);
--   s  - withheld, two owners: A's and B's private reports both link it (570's several-owners case)
--   n  - withheld, no valid owner: linked by a report with owner NULL and one owned by 'operator'
--   d  - withheld, linked by no report (570's duplicate rule / 575's fragment: nobody party)
--   r  - withheld for A and B, then restored (restored_at set): nobody's any more
--   k  - one owner: in A's store, linked to A's report (570's move; unchanged behaviour)
CREATE TABLE IF NOT EXISTS public.lab_prcw (k TEXT PRIMARY KEY, v TEXT NOT NULL);
DO $$
DECLARE
    v_a TEXT := 'prcw-ay-' || substr(md5(random()::text), 1, 8);
    v_b TEXT := 'prcw-bee-' || substr(md5(random()::text), 1, 8);
    v_c TEXT := 'prcw-cee-' || substr(md5(random()::text), 1, 8);
    w   TEXT := 'prcw' || substr(md5(random()::text), 1, 6);
    ra UUID; rb UUID; rn UUID; ro UUID;
    s UUID := gen_random_uuid(); n UUID := gen_random_uuid(); d UUID := gen_random_uuid(); r UUID := gen_random_uuid(); kk UUID := gen_random_uuid();
    t_s TEXT; t_n TEXT; t_d TEXT; t_r TEXT; t_k TEXT;
    bt UUID := gen_random_uuid();
BEGIN
    IF EXISTS (SELECT 1 FROM public.lab_prcw) THEN RETURN; END IF;   -- planted once per run; every probe reads the same plant
    t_s := 'The ' || w || ' delta result appeared in both private reports alike.';
    t_n := 'The ' || w || ' ownerless result came from an idea that is gone now.';
    t_d := 'The ' || w || ' restated result was carried by a shared synthesis.';
    t_r := 'The ' || w || ' restored result went back to the shared table later.';
    t_k := 'The ' || w || ' alpha result reproduced in twelve trials across two labs.';
    INSERT INTO public.research_private_reports (owner_sub) VALUES (v_a) RETURNING id INTO ra;
    INSERT INTO public.research_private_reports (owner_sub) VALUES (v_b) RETURNING id INTO rb;
    INSERT INTO public.research_private_reports (owner_sub) VALUES (NULL) RETURNING id INTO rn;
    INSERT INTO public.research_private_reports (owner_sub) VALUES ('operator') RETURNING id INTO ro;
    INSERT INTO public.research_private_report_claims (report_id, claim_id) VALUES (ra, s), (rb, s), (rn, n), (ro, n), (ra, r), (rb, r), (ra, kk);
    INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data, restored_at) VALUES
        (bt, 'public.claims', 'x', s::text, jsonb_build_object('id', s, 'text', t_s), NULL),
        (bt, 'public.claims', 'x', n::text, jsonb_build_object('id', n, 'text', t_n), NULL),
        (bt, 'public.claims', 'x', d::text, jsonb_build_object('id', d, 'text', t_d), NULL),
        (bt, 'public.claims', 'x', r::text, jsonb_build_object('id', r, 'text', t_r), now()),
        (bt, 'public.claim_sources', 'e', s::text, jsonb_build_object('claim_id', s, 'source_id', gen_random_uuid()), NULL);
    INSERT INTO public.inlet_private_claims (id, text, inlet_owner_sub) VALUES (kk, t_k, v_a);
    INSERT INTO public.lab_prcw (k, v) VALUES ('a', v_a), ('b', v_b), ('c', v_c), ('t_s', t_s), ('t_n', t_n), ('t_d', t_d), ('t_r', t_r), ('t_k', t_k);
END $$;

BEGIN;
CREATE FUNCTION pg_temp.v(p_k TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT v FROM public.lab_prcw WHERE k = p_k $$;
-- the structured-note door (575's private_report_claims_note_refused, what POST /workbench/notes asks): refused | saves
CREATE FUNCTION pg_temp.sn(p_who TEXT, p_title TEXT, p_body TEXT) RETURNS TEXT LANGUAGE sql AS $$
    SELECT CASE public.private_report_claims_note_refused(p_who, 'content/notebooks/prcw-nb/prcw-note', p_title, p_body)
           WHEN true THEN 'refused' WHEN false THEN 'saves' ELSE 'null' END
$$;
-- the shared note row (notes/..., the wiki guard with ob.page_author): refused (42501) | saved; rolled back
CREATE FUNCTION pg_temp.wn(p_who TEXT, p_body TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE n INT := -1;
BEGIN
    PERFORM set_config('ob.page_author', coalesce(p_who, ''), true);
    BEGIN
        WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ('notes/prcw-' || md5(random()::text), 'note', 'probe', p_body) RETURNING 1)
        SELECT count(*) INTO n FROM w;
        RAISE EXCEPTION 'probe rollback' USING ERRCODE = 'P0001';
    EXCEPTION
        WHEN SQLSTATE '42501' THEN PERFORM set_config('ob.page_author', '', true); RETURN 'refused';
        WHEN SQLSTATE 'P0001' THEN PERFORM set_config('ob.page_author', '', true); RETURN CASE WHEN n = 1 THEN 'saved' ELSE 'withheld' END;
    END;
END $$;
-- the helper's rows for a subject (dynamic: before 660 it does not exist - 'none')
CREATE FUNCTION pg_temp.of_n(p_sub TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE n BIGINT;
BEGIN
    IF to_regprocedure('public.private_report_claims_withheld_of(text)') IS NULL THEN RETURN 'none'; END IF;
    EXECUTE 'SELECT count(*) FROM public.private_report_claims_withheld_of($1)' INTO n USING p_sub;
    RETURN n::text;
END $$;
SELECT line FROM (
    -- the two owners of the withheld sentence s: refused on both doors
              SELECT 1 AS o, 'sn_a_s=' || pg_temp.sn(pg_temp.v('a'), 'My view', 'I think ' || pg_temp.v('t_s')) AS line
    UNION ALL SELECT 2, 'sn_b_s=' || pg_temp.sn(pg_temp.v('b'), 'My view', 'I think ' || pg_temp.v('t_s'))
    UNION ALL SELECT 3, 'wn_a_s=' || pg_temp.wn(pg_temp.v('a'), 'Notes. ' || pg_temp.v('t_s'))
    UNION ALL SELECT 4, 'wn_b_s=' || pg_temp.wn(pg_temp.v('b'), 'Notes. ' || pg_temp.v('t_s'))
    -- formatted (570's skeleton: case, spacing, emphasis), and split across title and body
    UNION ALL SELECT 5, 'sn_a_s_formatted=' || pg_temp.sn(pg_temp.v('a'), 'x', upper(replace(pg_temp.v('t_s'), ' ', '  **')))
    UNION ALL SELECT 6, 'sn_b_s_split=' || pg_temp.sn(pg_temp.v('b'), left(pg_temp.v('t_s'), 20), substr(pg_temp.v('t_s'), 21))
    -- the third user C: saves, exactly as a sentence nobody holds
    UNION ALL SELECT 7, 'sn_c_s=' || pg_temp.sn(pg_temp.v('c'), 'My view', 'I think ' || pg_temp.v('t_s'))
    UNION ALL SELECT 8, 'wn_c_s=' || pg_temp.wn(pg_temp.v('c'), 'Notes. ' || pg_temp.v('t_s'))
    UNION ALL SELECT 9, 'sn_c_nobody=' || pg_temp.sn(pg_temp.v('c'), 'My view', 'I think the ' || md5(random()::text) || ' sentence nobody holds anywhere.')
    UNION ALL SELECT 10, 'wn_c_nobody=' || pg_temp.wn(pg_temp.v('c'), 'Notes. A sentence nobody holds anywhere at all, ' || md5(random()::text))
    -- no author / blank author: nothing matched
    UNION ALL SELECT 11, 'sn_blank_s=' || pg_temp.sn('  ', 'My view', pg_temp.v('t_s'))
    UNION ALL SELECT 12, 'wn_none_s=' || pg_temp.wn(NULL, 'Notes. ' || pg_temp.v('t_s'))
    -- withheld for another reason: no valid owner (refused for no user, 'operator' and the NULL-owner report included)
    UNION ALL SELECT 13, 'sn_a_n=' || pg_temp.sn(pg_temp.v('a'), 'v', pg_temp.v('t_n'))
    UNION ALL SELECT 14, 'sn_c_n=' || pg_temp.sn(pg_temp.v('c'), 'v', pg_temp.v('t_n'))
    UNION ALL SELECT 15, 'sn_operator_n=' || pg_temp.sn('operator', 'v', pg_temp.v('t_n'))
    -- withheld, linked by no report (nobody party)
    UNION ALL SELECT 16, 'sn_a_d=' || pg_temp.sn(pg_temp.v('a'), 'v', pg_temp.v('t_d'))
    UNION ALL SELECT 17, 'sn_b_d=' || pg_temp.sn(pg_temp.v('b'), 'v', pg_temp.v('t_d'))
    -- withheld then restored: nobody's withheld claim any more
    UNION ALL SELECT 18, 'sn_a_r=' || pg_temp.sn(pg_temp.v('a'), 'v', pg_temp.v('t_r'))
    -- one owner (A's store): as before - A refused, B and C save
    UNION ALL SELECT 19, 'sn_a_k=' || pg_temp.sn(pg_temp.v('a'), 'v', pg_temp.v('t_k'))
    UNION ALL SELECT 20, 'sn_b_k=' || pg_temp.sn(pg_temp.v('b'), 'v', pg_temp.v('t_k'))
    UNION ALL SELECT 21, 'sn_c_k=' || pg_temp.sn(pg_temp.v('c'), 'v', pg_temp.v('t_k'))
    UNION ALL SELECT 22, 'wn_a_k=' || pg_temp.wn(pg_temp.v('a'), 'Notes. ' || pg_temp.v('t_k'))
    -- a fragment under 24 letters of s is not a claim's text (570's floor)
    UNION ALL SELECT 23, 'sn_a_s_short=' || pg_temp.sn(pg_temp.v('a'), 'v', split_part(pg_temp.v('t_s'), ' ', 3) || ' result')
    -- the helper itself: one row for A (s), one for B (s), none for C / 'operator' / a blank subject
    UNION ALL SELECT 24, 'of_a=' || pg_temp.of_n(pg_temp.v('a'))
    UNION ALL SELECT 25, 'of_b=' || pg_temp.of_n(pg_temp.v('b'))
    UNION ALL SELECT 26, 'of_c=' || pg_temp.of_n(pg_temp.v('c'))
    UNION ALL SELECT 27, 'of_operator=' || pg_temp.of_n('operator')
    UNION ALL SELECT 28, 'of_blank=' || pg_temp.of_n('')
    -- the helper and the check are granted to nobody (PUBLIC included)
    UNION ALL SELECT 29, 'grants=' || (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a
                                       WHERE p.proname IN ('private_report_claims_withheld_of', 'private_report_claims_own_text_shows') AND a.grantee <> p.proowner)
    UNION ALL SELECT 30, 'app_role_can_read_helper=' || coalesce((SELECT has_function_privilege('prcw_app', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = to_regprocedure('public.private_report_claims_withheld_of(text)'))::text, 'none')
) x ORDER BY o;
ROLLBACK;
