-- prc-withheld-probe.sql - the slot 660 lab's probes (run-private-report-claims-withheld-lab.ps1). One transaction, ROLLED
-- BACK: it changes nothing. psql -X -A -t -q -f. Prints "key=value" lines: states only, never a claim's text.
BEGIN;
CREATE FUNCTION pg_temp.v(p_k TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT v FROM public.lab_prcw WHERE k = p_k $$;
-- the structured-note door (575's private_report_claims_note_refused, what POST /workbench/notes asks): refused | saves
CREATE FUNCTION pg_temp.sn(p_who TEXT, p_title TEXT, p_body TEXT) RETURNS TEXT LANGUAGE sql AS $$
    SELECT CASE public.private_report_claims_note_refused(p_who, 'content/notebooks/prcw-nb/prcw-note', p_title, p_body)
           WHEN true THEN 'refused' WHEN false THEN 'saves' ELSE 'null' END
$$;
-- a page row as a person (the wiki guard with ob.page_author): refused (42501) | saved | withheld; rolled back
CREATE FUNCTION pg_temp.wn(p_slug TEXT, p_who TEXT, p_body TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE n INT := -1;
BEGIN
    PERFORM set_config('ob.page_author', coalesce(p_who, ''), true);
    BEGIN
        WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES (p_slug, 'note', 'probe', p_body) RETURNING 1)
        SELECT count(*) INTO n FROM w;
        RAISE EXCEPTION 'probe rollback' USING ERRCODE = 'P0001';
    EXCEPTION
        WHEN SQLSTATE '42501' THEN PERFORM set_config('ob.page_author', '', true); RETURN 'refused';
        WHEN SQLSTATE 'P0001' THEN PERFORM set_config('ob.page_author', '', true); RETURN CASE WHEN n = 1 THEN 'saved' ELSE 'withheld' END;
    END;
END $$;
-- where a claim is: shared | store:<a|b|other> | withheld | gone
CREATE FUNCTION pg_temp.where_claim(p_k TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN EXISTS (SELECT 1 FROM public.claims c WHERE c.id::text = pg_temp.v(p_k)) THEN 'shared'
        WHEN EXISTS (SELECT 1 FROM public.inlet_private_claims c WHERE c.id::text = pg_temp.v(p_k) AND c.inlet_owner_sub = pg_temp.v('a')) THEN 'store-a'
        WHEN EXISTS (SELECT 1 FROM public.inlet_private_claims c WHERE c.id::text = pg_temp.v(p_k)) THEN 'store-other'
        WHEN to_regclass('public.private_report_claims_archive') IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.private_report_claims_archive a WHERE a.action = 'x' AND a.restored_at IS NULL AND a.ref = pg_temp.v(p_k)) THEN 'withheld'
        ELSE 'gone' END
$$;
SELECT line FROM (
              SELECT 1 AS o, 'claim_s=' || pg_temp.where_claim('s') AS line
    UNION ALL SELECT 2, 'claim_n=' || pg_temp.where_claim('n')
    UNION ALL SELECT 3, 'claim_k=' || pg_temp.where_claim('k')
    UNION ALL SELECT 4, 'claim_q=' || pg_temp.where_claim('q')
    UNION ALL SELECT 5, 'links_s=' || (SELECT count(*) FROM public.research_private_report_claims WHERE claim_id::text = pg_temp.v('s'))
    -- the withheld two-owner sentence s: structured note (note_refused), shared note row (notes/...), structured note row
    UNION ALL SELECT 10, 'sn_a_s=' || pg_temp.sn(pg_temp.v('a'), 'My view', 'I think ' || pg_temp.v('t_s'))
    UNION ALL SELECT 11, 'sn_b_s=' || pg_temp.sn(pg_temp.v('b'), 'My view', 'I think ' || pg_temp.v('t_s'))
    UNION ALL SELECT 12, 'sn_c_s=' || pg_temp.sn(pg_temp.v('c'), 'My view', 'I think ' || pg_temp.v('t_s'))
    UNION ALL SELECT 13, 'sn_c_nobody=' || pg_temp.sn(pg_temp.v('c'), 'My view', 'I think the prcwnobody zeta finding is in no private report anywhere.')
    UNION ALL SELECT 14, 'wn_a_s=' || pg_temp.wn('notes/prcw-a-' || pg_temp.v('r'), pg_temp.v('a'), 'Notes. ' || pg_temp.v('t_s'))
    UNION ALL SELECT 15, 'wn_b_s=' || pg_temp.wn('notes/prcw-b-' || pg_temp.v('r'), pg_temp.v('b'), 'Notes. ' || pg_temp.v('t_s'))
    UNION ALL SELECT 16, 'wn_c_s=' || pg_temp.wn('notes/prcw-c-' || pg_temp.v('r'), pg_temp.v('c'), 'Notes. ' || pg_temp.v('t_s'))
    UNION ALL SELECT 17, 'wn_c_nobody=' || pg_temp.wn('notes/prcw-cn-' || pg_temp.v('r'), pg_temp.v('c'), 'Notes. The prcwnobody zeta finding is in no private report anywhere.')
    UNION ALL SELECT 18, 'ws_a_s=' || pg_temp.wn('content/notebooks/prcw-nb/prcw-a-' || pg_temp.v('r'), pg_temp.v('a'), 'AI note. ' || pg_temp.v('t_s'))
    UNION ALL SELECT 19, 'ws_c_s=' || pg_temp.wn('content/notebooks/prcw-nb/prcw-c-' || pg_temp.v('r'), pg_temp.v('c'), 'AI note. ' || pg_temp.v('t_s'))
    UNION ALL SELECT 20, 'wn_none_s=' || pg_temp.wn('notes/prcw-none-' || pg_temp.v('r'), NULL, 'Notes. ' || pg_temp.v('t_s'))
    -- no valid owner: refused for no user
    UNION ALL SELECT 30, 'sn_a_n=' || pg_temp.sn(pg_temp.v('a'), 'v', pg_temp.v('t_n'))
    UNION ALL SELECT 31, 'sn_c_n=' || pg_temp.sn(pg_temp.v('c'), 'v', pg_temp.v('t_n'))
    UNION ALL SELECT 32, 'sn_operator_n=' || pg_temp.sn('operator', 'v', pg_temp.v('t_n'))
    -- one owner (A's store): as before
    UNION ALL SELECT 40, 'sn_a_k=' || pg_temp.sn(pg_temp.v('a'), 'v', pg_temp.v('t_k'))
    UNION ALL SELECT 41, 'sn_b_k=' || pg_temp.sn(pg_temp.v('b'), 'v', pg_temp.v('t_k'))
    UNION ALL SELECT 42, 'sn_c_k=' || pg_temp.sn(pg_temp.v('c'), 'v', pg_temp.v('t_k'))
    UNION ALL SELECT 43, 'wn_a_k=' || pg_temp.wn('notes/prcw-ak-' || pg_temp.v('r'), pg_temp.v('a'), 'Notes. ' || pg_temp.v('t_k'))
    -- the shared control: nobody's
    UNION ALL SELECT 50, 'sn_a_q=' || pg_temp.sn(pg_temp.v('a'), 'v', pg_temp.v('t_q'))
) x ORDER BY o;
ROLLBACK;
