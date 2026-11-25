-- prc-withheld-plant.sql - the slot 660 lab's plant (run-private-report-claims-withheld-lab.ps1), in the shape slot 390
-- left the data (570 reverted: the link's foreign key on, no guards). psql -v a=<sub A> -v b=<sub B> -v c=<sub C> -v r=<random> -f.
-- Never against a live database: it writes lab rows and the lab table public.lab_prcw.
--   s - two owners: A's and B's private reports both link it (570 withholds it: several owners)
--   n - no valid owner: linked by a report whose owner is gone (owner_sub NULL) and one owned by 'operator' (570 withholds it)
--   k - one owner: A's report alone links it (570 moves it to A's store)
--   q - a SHARED claim nobody's report links (the control: stays shared)
-- C has no private report.
SELECT set_config('lab.a', :'a', false) AS a, set_config('lab.b', :'b', false) AS b, set_config('lab.c', :'c', false) AS c, set_config('lab.r', :'r', false) AS r;
CREATE TABLE IF NOT EXISTS public.lab_prcw (k TEXT PRIMARY KEY, v TEXT NOT NULL);
DO $$
DECLARE
    v_a TEXT := current_setting('lab.a');
    v_b TEXT := current_setting('lab.b');
    v_c TEXT := current_setting('lab.c');
    v_r TEXT := current_setting('lab.r');
    w   TEXT := 'prcw' || current_setting('lab.r');
    t_s TEXT; t_n TEXT; t_k TEXT; t_q TEXT;
    th UUID; s1 UUID; a_rep UUID; b_rep UUID; n_rep UUID; o_rep UUID;
    s UUID; n UUID; kk UUID; q UUID;
BEGIN
    t_s := 'The ' || w || ' delta result appeared in both private reports alike.';
    t_n := 'The ' || w || ' ownerless result came from an idea that is gone now.';
    t_k := 'The ' || w || ' alpha result reproduced in twelve trials across two labs.';
    t_q := 'Zebra migration in the northern plains was observed by the shared run.';
    INSERT INTO public.threads (name, description, status) VALUES ('Shared thread ' || v_r, 'a shared thread', 'active') RETURNING id INTO th;
    INSERT INTO public.sources (title, content, content_type, url)
    VALUES ('Shared source ' || v_r, repeat('shared page text ', 4), 'web_article', 'https://example.org/prc-withheld-' || v_r) RETURNING id INTO s1;
    INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) VALUES ('rk-prcw-a-' || v_r, v_a, 'a private report', 'the private report body') RETURNING id INTO a_rep;
    INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) VALUES ('rk-prcw-b-' || v_r, v_b, 'a private report', 'the private report body') RETURNING id INTO b_rep;
    INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) VALUES ('rk-prcw-n-' || v_r, NULL, 'a private report', 'the private report body') RETURNING id INTO n_rep;
    INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) VALUES ('rk-prcw-o-' || v_r, 'operator', 'a private report', 'the private report body') RETURNING id INTO o_rep;
    SELECT f.id INTO s FROM public.find_or_create_claim(t_s, th, NULL) f;
    SELECT f.id INTO n FROM public.find_or_create_claim(t_n, th, NULL) f;
    SELECT f.id INTO kk FROM public.find_or_create_claim(t_k, th, NULL) f;
    SELECT f.id INTO q FROM public.find_or_create_claim(t_q, th, NULL) f;
    PERFORM public.link_claim_to_source(s, s1, 'states', 1.0);
    PERFORM public.link_claim_to_source(n, s1, 'states', 1.0);
    PERFORM public.link_claim_to_source(kk, s1, 'states', 1.0);
    PERFORM public.link_claim_to_source(q, s1, 'states', 1.0);
    INSERT INTO public.research_private_report_claims (report_id, claim_id) VALUES (a_rep, s), (b_rep, s), (n_rep, n), (o_rep, n), (a_rep, kk);
    INSERT INTO public.lab_prcw (k, v) VALUES
        ('r', v_r), ('a', v_a), ('b', v_b), ('c', v_c), ('s', s), ('n', n), ('k', kk), ('q', q),
        ('t_s', t_s), ('t_n', t_n), ('t_k', t_k), ('t_q', t_q), ('a_rep', a_rep), ('b_rep', b_rep)
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;
SELECT 'planted=' || (SELECT count(*) FROM public.lab_prcw)
       || ' links=' || (SELECT count(*) FROM public.research_private_report_claims)
       || ' claims=' || (SELECT count(*) FROM public.claims WHERE id::text IN (SELECT v FROM public.lab_prcw WHERE k IN ('s', 'n', 'k', 'q'))) AS line;
