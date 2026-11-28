-- rwr-research-sources: the timed probe (run-research-sources-perf.ps1). The same file runs on every tree it compares
-- (base d8c8c8b6 has no slot 750: the classifier lines are skipped there). A DISPOSABLE database only: it writes
-- :n claims, each grounded in three sources (community and credible hosts mixed), then times the claim formulas.
\set ON_ERROR_STOP 1
SELECT set_config('perf.n', :'n', false);

DO $$
DECLARE
    n INT := current_setting('perf.n')::int; i INT; c UUID; s UUID; t0 TIMESTAMPTZ := clock_timestamp();
    hosts TEXT[] := ARRAY['https://www.reddit.com/r/s%s/comments/1/', 'https://stackoverflow.com/questions/%s',
                          'https://www.energy.gov/p%s', 'https://www.nature.com/articles/a%s',
                          'https://blog.example.com/p%s', 'https://forums.ex%s.com/t/a/1'];
    k INT;
BEGIN
    FOR i IN 1..n LOOP
        c := gen_random_uuid();
        INSERT INTO public.claims (id, text, metadata, volatility) VALUES (c, 'perf claim ' || i, '{"claim_kind":"practical"}', 'slow');
        FOR k IN 0..2 LOOP
            s := gen_random_uuid();
            INSERT INTO public.sources (id, url, title, content, domain)
            VALUES (s, format(hosts[((i + k) % 6) + 1], i), 'perf', 'c', 'perf.example');
            PERFORM public.link_claim_to_source(c, s, CASE WHEN k = 0 THEN 'states' ELSE 'corroborates' END, 1.0);
        END LOOP;
    END LOOP;
    RAISE NOTICE 'PERF fixture claims=% sources=% ms=%', n, 3 * n, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
END $$;

DO $$
DECLARE t0 TIMESTAMPTZ; v DOUBLE PRECISION; n BIGINT;
BEGIN
    t0 := clock_timestamp();
    SELECT sum(public.claim_confidence(id)), count(*) INTO v, n FROM public.claims WHERE text LIKE 'perf claim %';
    RAISE NOTICE 'PERF legacy_claim_confidence claims=% ms=%', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
    t0 := clock_timestamp();
    SELECT sum(public.claim_confidence_d15(id)), count(*) INTO v, n FROM public.claims WHERE text LIKE 'perf claim %';
    RAISE NOTICE 'PERF claim_confidence_d15 claims=% ms=%', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
    t0 := clock_timestamp();
    SELECT count(*) INTO n FROM public.credibility_before_after;
    RAISE NOTICE 'PERF credibility_before_after rows=% ms=%', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000);
    IF to_regprocedure('public.source_class_of(text,text)') IS NOT NULL THEN
        t0 := clock_timestamp();
        SELECT count(public.source_class_of(url, domain)) INTO n FROM public.sources;
        RAISE NOTICE 'PERF source_class_of calls=% ms=%', (SELECT count(*) FROM public.sources), round(extract(epoch FROM clock_timestamp() - t0) * 1000);
    END IF;
    IF to_regprocedure('public.source_community_drift()') IS NOT NULL THEN
        RAISE NOTICE 'PERF drift rows=%', public.source_community_drift();
    END IF;
END $$;
