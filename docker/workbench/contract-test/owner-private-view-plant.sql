-- owner-private-view-plant.sql - the [5s] lab's plant for rw-owner-private-view (slot 480). LAB ONLY (superuser, a
-- disposable database). Runs AFTER [5r] (slot 440 moved user A's planted mail, transcript, claims and seeded job into
-- the owner-private stores). It adds, by copying the shape of A's own moved rows (the stores are LIKE the shared tables,
-- without their defaults):
--   * for A: one more moved email-body source whose chunk carries the vector the [5s] stub embedder gives "nearest probe"
--     (so A's semantic search has a known nearest row), marker :ma;
--   * for B (another real-shaped subject), marker :mb in every field: a moved source with the SAME nearest vector (an
--     owner filter that is missing shows it to A), a private claim with its own edge to it, a private link of B's on a
--     shared fixture claim (a mixed claim of B's), and a seeded research job with its own text (an archive 'j' row, as
--     440 writes one, so PD1's inlet_private_job answers it).
-- The ids go to public.lab_owner_private_view_plant (k, v jsonb) for the test.
--   psql -v ON_ERROR_STOP=1 -v a=<A> -v b=<B> -v ma=<marker> -v mb=<marker> -f owner-private-view-plant.sql
BEGIN;
SELECT set_config('pv.a', :'a', true), set_config('pv.b', :'b', true), set_config('pv.ma', :'ma', true), set_config('pv.mb', :'mb', true);
CREATE TABLE IF NOT EXISTS public.lab_owner_private_view_plant (k TEXT PRIMARY KEY, v JSONB NOT NULL);
DO $$
DECLARE
    a TEXT := current_setting('pv.a'); b TEXT := current_setting('pv.b');
    ma TEXT := current_setting('pv.ma'); mb TEXT := current_setting('pv.mb');
    near TEXT := '[' || array_to_string(array(SELECT CASE WHEN i = 8 THEN 1 ELSE 0 END FROM generate_series(1, 1024) i), ',') || ']';
    s_a UUID := gen_random_uuid(); s_b UUID := gen_random_uuid(); c_b UUID := gen_random_uuid();
    j_b UUID; batch_b UUID := gen_random_uuid(); mixed UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.inlet_private_sources WHERE inlet_owner_sub = a) THEN
        RAISE EXCEPTION 'pv plant: A has no moved source (run [5r] first)';
    END IF;
    -- A's probe source and chunk
    INSERT INTO public.inlet_private_sources
    SELECT (jsonb_populate_record(NULL::public.inlet_private_sources, to_jsonb(s) || jsonb_build_object(
              'id', s_a, 'url', 'https://mail.google.com/mail/u/0/#inbox/pva' || ma, 'title', 'Probe mail ' || ma,
              'content', 'Probe body ' || ma, 'content_hash', md5('pva' || ma)))).*
      FROM public.inlet_private_sources s WHERE s.inlet_owner_sub = a ORDER BY s.id LIMIT 1;
    INSERT INTO public.inlet_private_source_chunks
    SELECT (jsonb_populate_record(NULL::public.inlet_private_source_chunks, to_jsonb(ch) || jsonb_build_object(
              'source_id', s_a, 'idx', 0, 'content', 'nearest probe chunk ' || ma, 'embedding', near))).*
      FROM public.inlet_private_source_chunks ch WHERE ch.inlet_owner_sub = a ORDER BY ch.source_id, ch.idx LIMIT 1;
    -- B's source, chunk (the same nearest vector), private claim and its edge
    INSERT INTO public.inlet_private_sources
    SELECT (jsonb_populate_record(NULL::public.inlet_private_sources, to_jsonb(s) || jsonb_build_object(
              'id', s_b, 'url', 'https://mail.google.com/mail/u/0/#inbox/pvb' || mb, 'title', 'B mail ' || mb,
              'content', 'B body ' || mb, 'content_hash', md5('pvb' || mb), 'metadata', jsonb_build_object('note', mb),
              'inlet_owner_sub', b, 'inlet_batch', batch_b))).*
      FROM public.inlet_private_sources s WHERE s.inlet_owner_sub = a ORDER BY s.id LIMIT 1;
    INSERT INTO public.inlet_private_source_chunks
    SELECT (jsonb_populate_record(NULL::public.inlet_private_source_chunks, to_jsonb(ch) || jsonb_build_object(
              'source_id', s_b, 'idx', 0, 'content', 'nearest probe chunk ' || mb, 'embedding', near,
              'inlet_owner_sub', b, 'inlet_batch', batch_b))).*
      FROM public.inlet_private_source_chunks ch WHERE ch.inlet_owner_sub = a ORDER BY ch.source_id, ch.idx LIMIT 1;
    INSERT INTO public.inlet_private_claims
    SELECT (jsonb_populate_record(NULL::public.inlet_private_claims, to_jsonb(c) || jsonb_build_object(
              'id', c_b, 'text', 'B private claim ' || mb, 'text_hash', md5('pvc' || mb), 'inlet_owner_sub', b, 'inlet_batch', batch_b))).*
      FROM public.inlet_private_claims c WHERE c.inlet_owner_sub = a ORDER BY c.id LIMIT 1;
    INSERT INTO public.inlet_private_claim_sources (claim_id, edge_ref, owner_sub, batch, source_id, parent_claim_id, row_data)
    VALUES (c_b, md5('pve' || mb), b, batch_b, s_b, NULL, jsonb_build_object('claim_id', c_b, 'source_id', s_b, 'edge_type', 'states', 'note', mb));
    -- B's private link on a shared claim
    SELECT id INTO mixed FROM public.claims WHERE status = 'active' ORDER BY (id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') DESC, id LIMIT 1;
    INSERT INTO public.inlet_private_claim_links (claim_id, source_id, owner_sub, batch, row_data)
    VALUES (mixed, s_b, b, batch_b, jsonb_build_object('claim_id', mixed, 'source_id', s_b, 'edge_type', 'states', 'note', mb));
    -- B's seeded job: the shared row neutral, its own text in the owner store (and the archive row PD1's read joins)
    INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'A research question (neutral)') RETURNING id INTO j_b;
    INSERT INTO public.inlet_owner_archive (batch, tbl, col, action, ref, row_data)
    VALUES (batch_b, 'public.research_jobs', 'query,result,progress,error', 'j', j_b::text, jsonb_build_object('id', j_b, 'query', 'B question ' || mb));
    INSERT INTO public.inlet_private_jobs (job_id, batch, owner_sub, row_data)
    VALUES (j_b, batch_b, b, jsonb_build_object('id', j_b, 'query', 'B question ' || mb, 'result', jsonb_build_object('synthesis', 'B synthesis ' || mb),
                                                'progress', jsonb_build_object('phase', 'done', 'message', 'B progress ' || mb), 'error', 'B error ' || mb));
    INSERT INTO public.lab_owner_private_view_plant (k, v)
    VALUES ('plant', jsonb_build_object('a_source', s_a, 'b_source', s_b, 'b_claim', c_b, 'b_mixed', mixed, 'b_job', j_b, 'b_batch', batch_b))
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
END $$;
COMMIT;
