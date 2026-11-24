-- prc-scope-plant.sql - the slot 575 lab's plant (run-private-report-claims-scope-lab.ps1), in the shape slot 390 left
-- the data (570 reverted: the link's foreign key on, no guards). psql -v a=<sub A> -v b=<sub B> -v r=<random> -f.
-- Never against a live database: it writes lab rows and the lab table public.lab_prc_scope.
SELECT set_config('lab.a', :'a', false) AS a, set_config('lab.b', :'b', false) AS b, set_config('lab.r', :'r', false) AS r;
CREATE TABLE IF NOT EXISTS public.lab_prc_scope (k TEXT PRIMARY KEY, v TEXT NOT NULL);
DO $$
DECLARE
    v_a TEXT := current_setting('lab.a');
    v_b TEXT := current_setting('lab.b');
    v_r TEXT := current_setting('lab.r');
    w   TEXT := 'prcb' || current_setting('lab.r');       -- B's word
    wm  TEXT := 'prcmulti' || current_setting('lab.r');   -- the two-owner claim's word
    t_b1 TEXT; t_b2 TEXT; t_m TEXT; t_f1 TEXT; t_f2 TEXT; t_fd TEXT; t_fc TEXT;
    th UUID; th2 UUID; s1 UUID; syn UUID; b_rep UUID; a_rep UUID; job UUID;
    b1 UUID; b2 UUID; m UUID; f1 UUID; f2 UUID; fd UUID; fc UUID;
    nb TEXT := 'prc-nb-' || current_setting('lab.r');
    nbc TEXT := 'prc-clean-' || current_setting('lab.r');
BEGIN
    t_b1 := 'The ' || w || ' alpha result reproduced in twelve trials across two labs.';
    t_b2 := 'The ' || w || ' beta result held for forty participants over six months.';
    t_m  := 'The ' || wm || ' delta result appeared in both private reports alike.';
    t_f1 := w || ' alpha result reproduced in twelve trials';              -- a FRAGMENT of b1 (inside it, not containing it)
    t_f2 := wm || ' delta result appeared in both private';               -- a fragment of the two-owner claim
    t_fd := 'A summary: ' || w || ' alpha result reproduced in twelve trials, says another source.'; -- carries f1's sentence
    t_fc := 'Zebra migration in the northern plains was observed by the shared run.';               -- the control
    INSERT INTO public.threads (name, description, status) VALUES ('Shared thread ' || v_r, 'a shared thread', 'active') RETURNING id INTO th;
    INSERT INTO public.threads (name, description, status) VALUES ('Other thread ' || v_r, 'another shared thread', 'active') RETURNING id INTO th2;
    INSERT INTO public.sources (title, content, content_type, url)
    VALUES ('Shared source one ' || v_r, repeat('shared page text ', 4), 'web_article', 'https://example.org/prc-scope-' || v_r || '/one') RETURNING id INTO s1;
    -- B's and A's private reports (no idea needed: slot 390's link model, the owner on the report)
    INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) VALUES ('rk-prcs-b-' || v_r, v_b, 'a private report', 'the private report body') RETURNING id INTO b_rep;
    INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) VALUES ('rk-prcs-a-' || v_r, v_a, 'a private report', 'the private report body') RETURNING id INTO a_rep;
    SELECT f.id INTO b1 FROM public.find_or_create_claim(t_b1, th, NULL) f;
    SELECT f.id INTO b2 FROM public.find_or_create_claim(t_b2, th, NULL) f;
    SELECT f.id INTO m FROM public.find_or_create_claim(t_m, th, NULL) f;
    PERFORM public.link_claim_to_source(b1, s1, 'states', 1.0);
    PERFORM public.link_claim_to_source(b2, s1, 'states', 1.0);
    PERFORM public.link_claim_to_source(m, s1, 'states', 1.0);
    INSERT INTO public.research_private_report_claims (report_id, claim_id) VALUES (b_rep, b1), (b_rep, b2), (b_rep, m), (a_rep, m);
    -- a SHARED synthesis restating b1 and the two-owner claim (570 withholds it: one owner and nobody), and the claims it
    -- filed: two fragments (f1 of b1, f2 of m) and a control sentence that is nobody's
    INSERT INTO public.sources (title, content, content_type, research_key)
    VALUES ('Shared report ' || v_r, 'A shared run. ' || t_b1 || ' Also: ' || t_m || ' And: ' || t_fc, 'research_synthesis', 'rk-prcs-shared-' || v_r) RETURNING id INTO syn;
    SELECT f.id INTO f1 FROM public.find_or_create_claim(t_f1, th, syn) f;
    SELECT f.id INTO f2 FROM public.find_or_create_claim(t_f2, th, syn) f;
    SELECT f.id INTO fc FROM public.find_or_create_claim(t_fc, th, syn) f;
    PERFORM public.link_claim_to_source(f1, s1, 'states', 1.0);
    PERFORM public.link_claim_to_source(f2, s1, 'states', 1.0);
    PERFORM public.link_claim_to_source(fc, s1, 'states', 1.0);
    -- a shared claim in another thread carrying f1's sentence (570's duplicate rule, applied to the fragment)
    SELECT f.id INTO fd FROM public.find_or_create_claim(t_fd, th2, NULL) f;
    PERFORM public.link_claim_to_source(fd, s1, 'states', 1.0);
    -- the conflict detector's contradicts edge between the fragment and the shared control
    PERFORM public.link_claim_to_claim(fc, f1, 'contradicts', 1.0);
    -- a SHARED job that reused the fragment and the control (its result names both; claims_reused 2)
    INSERT INTO public.research_jobs (status, origin, query, finished_at, result, metrics)
    VALUES ('done', 'manual', 'a shared question', now(),
            jsonb_build_object('outcome', 'answered', 'claims', '[]'::jsonb,
                               'reuse_claims', jsonb_build_array(jsonb_build_object('id', f1, 'text', t_f1), jsonb_build_object('id', fc, 'text', t_fc))),
            '{"claims_reused": 2, "gap_ratio": 0.5}'::jsonb) RETURNING id INTO job;
    -- R1: the notebook tree as production stores it (page_class 'note'): a hub carrying b1, the notebooks index carrying
    -- b2, a clean hub (control); a person's note carrying b1 (notes/..., author-only: kept); a compiled page carrying only
    -- the fragment f1 (570 keeps it: f1 is shared; 575 withholds it with f1)
    INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES
        ('content/notebooks/' || nb || '/' || nb, 'note', 'Notebook ' || v_r, 'Hub. ' || t_b1 || ' More of the hub.'),
        ('content/notebooks/index', 'note', 'Notebooks', 'Notebooks: ' || nb || ' - ' || t_b2),
        ('content/notebooks/' || nbc || '/' || nbc, 'note', 'Clean notebook ' || v_r, 'A hub with nothing private.'),
        ('notes/prc-scope-' || v_r, 'note', 'My note', 'Some notes. ' || t_b1 || ' More notes.'),
        ('content/topic/prc-frag-' || v_r, 'entity', 'Fragment topic ' || v_r, 'Compiled. ' || t_f1 || ', it says.');
    INSERT INTO public.lab_prc_scope (k, v) VALUES
        ('r', v_r), ('w', w), ('wm', wm), ('b1', b1), ('b2', b2), ('m', m), ('f1', f1), ('f2', f2), ('fd', fd), ('fc', fc),
        ('syn', syn), ('s1', s1), ('th', th), ('job', job), ('b_rep', b_rep), ('a_rep', a_rep),
        ('t_b1', t_b1), ('t_b2', t_b2), ('t_f1', t_f1),
        ('hub', 'content/notebooks/' || nb || '/' || nb), ('index', 'content/notebooks/index'),
        ('clean_hub', 'content/notebooks/' || nbc || '/' || nbc), ('note', 'notes/prc-scope-' || v_r), ('frag_page', 'content/topic/prc-frag-' || v_r),
        ('nb', nb)
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;
SELECT 'planted=' || (SELECT count(*) FROM public.lab_prc_scope)
       || ' links=' || (SELECT count(*) FROM public.research_private_report_claims)
       || ' pages=' || (SELECT count(*) FROM public.wiki_pages WHERE slug IN (SELECT v FROM public.lab_prc_scope WHERE k IN ('hub', 'index', 'clean_hub', 'note', 'frag_page')))
       || ' claims=' || (SELECT count(*) FROM public.claims WHERE id::text IN (SELECT v FROM public.lab_prc_scope WHERE k IN ('b1', 'b2', 'm', 'f1', 'f2', 'fd', 'fc'))) AS line;
