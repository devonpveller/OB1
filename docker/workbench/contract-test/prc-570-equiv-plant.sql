-- prc-570-equiv-plant.sql (rw-570-perf, tester attempt 1): the run-private-report-claims-lab.ps1 -EquivDir extra plant.
-- On the 390-model plant (570 reverted, no guards), MORE of every row kind 570 archives, inserted in an order unrelated
-- to their keys, so an archive insert whose order follows a hash or a key instead of 912b3f1's scan order shows up in
-- the archive ids (the equivalence compares ids, not only the set):
--   14 wiki pages carrying a private-report claim's text (plain, marked up, spaced) among 4 clean ones  -> w
--   4 shared syntheses restating one, each with a chunk and a thread link                               -> s, d, r
--   5 sources whose notebook label carries one                                                          -> b
--   4 shared claims with a claim's exact text, 2 edges each onto those sources                          -> k / x, e, l
--   4 shared jobs whose reuse list names one (no prompt: withheld)                                      -> p
--   2 entities named by each of 2 of those syntheses                                                    -> u
-- Counts only are printed.
DO $$
DECLARE
    t     TEXT[];
    ids   UUID[];
    n     INT;
    k     INT;
    v_syn UUID;
    v_th  UUID;
    v_c   UUID;
    v_e   BIGINT;
    srcs  UUID[] := '{}';
    v_s   UUID;
BEGIN
    SELECT array_agg(c.text ORDER BY c.id), array_agg(c.id ORDER BY c.id) INTO t, ids
      FROM public.claims c
     WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id) AND length(c.text) >= 30;
    n := coalesce(cardinality(t), 0);
    IF n = 0 THEN RAISE EXCEPTION 'equiv plant: no private-report claim in the shared table (run it on the 390-model plant)'; END IF;
    FOREACH k IN ARRAY ARRAY[11, 3, 14, 7, 1, 9, 12, 5, 2, 13, 8, 4, 10, 6] LOOP
        INSERT INTO public.wiki_pages (slug, page_class, title, body)
        VALUES ('content/topic/prc-eq-' || md5(k::text), 'entity', 'Eq ' || k,
                'Intro. ' || CASE k % 3 WHEN 0 THEN t[1 + k % n]
                                        WHEN 1 THEN '<b>' || upper(t[1 + k % n]) || '</b> [2]'
                                        ELSE replace(t[1 + k % n], ' ', '  ') END || ' Outro.');
        IF k % 4 = 0 THEN
            INSERT INTO public.wiki_pages (slug, page_class, title, body)
            VALUES ('content/topic/prc-eq-clean-' || md5(k::text), 'entity', 'Clean ' || k, 'nothing private on this page ' || k);
        END IF;
    END LOOP;
    INSERT INTO public.threads (name, description, status) VALUES ('Eq thread ' || md5(now()::text), 'an equivalence thread', 'active')
    RETURNING id INTO v_th;
    FOREACH k IN ARRAY ARRAY[3, 1, 4, 2] LOOP
        INSERT INTO public.sources (title, content, content_type, research_key)
        VALUES ('Eq synthesis ' || k, 'Report. ' || t[1 + (k * 2) % n] || ' End.', 'research_synthesis', 'prc-eq-syn-' || k || '-' || md5(k::text))
        RETURNING id INTO v_syn;
        INSERT INTO public.source_chunks (source_id, idx, content) VALUES (v_syn, 0, 'eq chunk ' || k);
        INSERT INTO public.thread_sources (thread_id, source_id) VALUES (v_th, v_syn);
        IF k <= 2 AND to_regclass('public.entities') IS NOT NULL AND to_regclass('public.source_entities') IS NOT NULL THEN
            INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('topic', 'Eq entity ' || k, 'eq entity ' || k)
            RETURNING id INTO v_e;
            INSERT INTO public.source_entities (source_id, entity_id, mention_role) VALUES (v_syn, v_e, 'about');
        END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY[5, 2, 4, 1, 3] LOOP
        INSERT INTO public.sources (title, content, content_type, url, notebook)
        VALUES ('Eq web ' || k, 'public page text ' || k, 'web_article', 'https://eq.invalid/' || md5(k::text), t[1 + k % n])
        RETURNING id INTO v_s;
        srcs := srcs || v_s;
    END LOOP;
    FOREACH k IN ARRAY ARRAY[4, 2, 3, 1] LOOP
        INSERT INTO public.claims (text, status) VALUES (t[1 + k % n], 'active') RETURNING id INTO v_c;
        INSERT INTO public.claim_sources (claim_id, source_id, edge_type, weight) VALUES (v_c, srcs[1 + k % 5], 'states', 1.0);
        INSERT INTO public.claim_sources (claim_id, source_id, edge_type, weight) VALUES (v_c, srcs[1 + (k + 2) % 5], 'corroborates', 0.5);
    END LOOP;
    FOREACH k IN ARRAY ARRAY[2, 4, 1, 3] LOOP
        INSERT INTO public.research_jobs (status, origin, query, finished_at, result)
        VALUES ('done', 'manual', 'eq shared question ' || k, now(),
                jsonb_build_object('synthesis', 'a shared answer ' || k, 'reuse_claims', jsonb_build_array(jsonb_build_object('id', ids[1 + k % n]))));
    END LOOP;
END $$;
SELECT 'equiv plant: pages=' || (SELECT count(*) FROM public.wiki_pages WHERE slug LIKE 'content/topic/prc-eq-%')
    || ' syntheses=' || (SELECT count(*) FROM public.sources WHERE research_key LIKE 'prc-eq-syn-%')
    || ' labels=' || (SELECT count(*) FROM public.sources WHERE title LIKE 'Eq web %')
    || ' jobs=' || (SELECT count(*) FROM public.research_jobs WHERE query LIKE 'eq shared question %');
