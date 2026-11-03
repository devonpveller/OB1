-- Revert init-idea-privacy.sql (rw-idea-privacy, slot 380): the archived idea thoughts go back into the shared corpus
-- byte-identical, with their entity links, edges and extraction-queue rows, and the revisions that linked them link them
-- again (private_owner back to what it was). Then the archive is dropped. Idempotent: with no archive there is nothing
-- to restore. One transaction (the DO block): a failed check leaves everything as it was.
-- The thought rows are written with session_replication_role = replica (superuser, for that one statement), so no
-- trigger rewrites them: not the fingerprint, not the extraction queue (restored from the archive instead), and not
-- the intake authority check (it judges a NEW write; these rows were written by their own doors once already).
DO $$
DECLARE
    v_cols TEXT; n_archive INT; n_restored INT; n_same INT; n_links INT;
BEGIN
    IF to_regclass('public.idea_thought_archive') IS NULL THEN
        RAISE NOTICE 'idea privacy revert: no archive - nothing to restore';
        RETURN;
    END IF;
    SELECT count(*) INTO n_archive FROM public.idea_thought_archive;
    IF EXISTS (SELECT 1 FROM public.idea_thought_archive a JOIN public.thoughts t ON t.id = a.id) THEN
        RAISE EXCEPTION 'idea privacy revert: refused, nothing changed - a thought with an archived id exists again' USING ERRCODE = '55000';
    END IF;
    -- the thoughts' columns the archive holds, in the thoughts' order
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
      FROM pg_attribute a
     WHERE a.attrelid = 'public.thoughts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = 'public.idea_thought_archive'::regclass
                                                  AND b.attname = a.attname AND NOT b.attisdropped);
    PERFORM set_config('session_replication_role', 'replica', true);
    EXECUTE format('INSERT INTO public.thoughts (%s) SELECT %s FROM public.idea_thought_archive', v_cols, v_cols);
    GET DIAGNOSTICS n_restored = ROW_COUNT;
    PERFORM set_config('session_replication_role', 'origin', true);

    -- the revisions link their thought again
    UPDATE public.idea_revisions r
       SET thought_id = a.id, private_owner = x ->> 'private_owner'
      FROM public.idea_thought_archive a, jsonb_array_elements(a.archive_revisions) x
     WHERE r.idea_id = (x ->> 'idea_id')::uuid AND r.revision = (x ->> 'revision')::int AND r.thought_id IS NULL;
    GET DIAGNOSTICS n_links = ROW_COUNT;
    -- what the delete cascaded to (an entity or an edge's other end deleted since is not brought back)
    INSERT INTO public.thought_entities
    SELECT p.* FROM public.idea_thought_archive a, jsonb_populate_recordset(NULL::public.thought_entities, a.archive_entities) p
     WHERE EXISTS (SELECT 1 FROM public.entities e WHERE e.id = p.entity_id)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.thought_edges
    SELECT p.* FROM public.idea_thought_archive a, jsonb_populate_recordset(NULL::public.thought_edges, a.archive_edges) p
     WHERE EXISTS (SELECT 1 FROM public.thoughts t WHERE t.id = p.from_thought_id)
       AND EXISTS (SELECT 1 FROM public.thoughts t WHERE t.id = p.to_thought_id)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.entity_extraction_queue
    SELECT p.* FROM public.idea_thought_archive a, jsonb_populate_recordset(NULL::public.entity_extraction_queue, a.archive_queue) p
    ON CONFLICT DO NOTHING;

    -- byte-identical: every archived row equals its restored thought, column for column
    SELECT count(*) INTO n_same FROM public.idea_thought_archive a JOIN public.thoughts t ON t.id = a.id
     WHERE to_jsonb(t) = (SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(a)) AS j(k, v)
                           WHERE k IN (SELECT jsonb_object_keys(to_jsonb(t))));
    IF n_restored <> n_archive OR n_same <> n_archive THEN
        RAISE EXCEPTION 'idea privacy revert: refused, nothing changed - % archived, % restored, % identical', n_archive, n_restored, n_same
            USING ERRCODE = '55000';
    END IF;
    DROP TABLE public.idea_thought_archive;
    RAISE NOTICE 'idea privacy revert: % thought(s) restored to the shared corpus; % revision(s) link them again', n_restored, n_links;
END $$;

NOTIFY pgrst, 'reload schema';
