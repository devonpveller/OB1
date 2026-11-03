-- Revert init-idea-privacy.sql (rw-idea-privacy, slot 380): the archived idea thoughts go back into the shared corpus
-- byte-identical, with their entity links, edges and extraction-queue rows, and the revisions that linked them link them
-- again (private_owner back to what it was). Then the archive is dropped. Idempotent: with no archive there is nothing
-- to restore. One transaction (the whole file): a failed check leaves everything as it was. Round 2: the withheld wiki
-- pages come back too (the guard dropped first), and the archive goes.
-- The thought rows are written with session_replication_role = replica (superuser, for that one statement), so no
-- trigger rewrites them: not the fingerprint, not the extraction queue (restored from the archive instead), and not
-- the intake authority check (it judges a NEW write; these rows were written by their own doors once already).
BEGIN;
SET LOCAL client_min_messages = warning;   -- a re-run's "does not exist, skipping" notices

-- round 2: the wiki's copies. The guard goes first (it would refuse the pages coming back), then every withheld page
-- whose slug is free again is restored column for column (a page the compiler has since regenerated clean under the same
-- slug is newer than the archived copy and is kept: counted, not overwritten), then the archive is dropped.
DROP TRIGGER IF EXISTS trg_idea_privacy_wiki_guard ON public.wiki_pages;
DROP FUNCTION IF EXISTS public.trg_idea_privacy_wiki_guard();
DROP FUNCTION IF EXISTS public.idea_privacy_page_shows_idea(TEXT, TEXT, JSONB);
-- round 3: the normalised-text predicate, its window tables and the trigger that teaches it each new revision
DROP FUNCTION IF EXISTS public.idea_privacy_page_shows_idea(TEXT, TEXT, TEXT, JSONB);
DROP TRIGGER IF EXISTS trg_idea_privacy_learn ON public.idea_revisions;
DROP FUNCTION IF EXISTS public.trg_idea_privacy_learn();
DROP FUNCTION IF EXISTS public.idea_privacy_learn(TEXT);
DROP FUNCTION IF EXISTS public.idea_privacy_windows(TEXT);
DROP FUNCTION IF EXISTS public.idea_privacy_norm(TEXT);
DROP TABLE IF EXISTS public.idea_privacy_shingles;
DROP TABLE IF EXISTS public.idea_privacy_whole;
SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    v_cols TEXT; n_archive INT; n_restored INT; n_kept INT; n_same INT;
BEGIN
    IF to_regclass('public.idea_wiki_archive') IS NULL THEN
        RAISE NOTICE 'idea privacy revert: no wiki archive - no page to restore';
        RETURN;
    END IF;
    SELECT count(*) INTO n_archive FROM public.idea_wiki_archive;
    SELECT count(*) INTO n_kept FROM public.idea_wiki_archive a JOIN public.wiki_pages w ON w.slug = a.slug;
    -- the generated column (search_tsv) is computed again from the same text
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
      FROM pg_attribute a
     WHERE a.attrelid = 'public.wiki_pages'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
       AND EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = 'public.idea_wiki_archive'::regclass
                                                  AND b.attname = a.attname AND NOT b.attisdropped);
    EXECUTE format('INSERT INTO public.wiki_pages (%s) SELECT %s FROM public.idea_wiki_archive a
                     WHERE NOT EXISTS (SELECT 1 FROM public.wiki_pages w WHERE w.slug = a.slug)', v_cols, v_cols);
    GET DIAGNOSTICS n_restored = ROW_COUNT;
    SELECT count(*) INTO n_same FROM public.idea_wiki_archive a JOIN public.wiki_pages w ON w.slug = a.slug
     WHERE to_jsonb(w) = (SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(a)) AS j(k, v)
                           WHERE k IN (SELECT jsonb_object_keys(to_jsonb(w))));
    IF n_restored + n_kept <> n_archive OR n_same < n_restored THEN
        RAISE EXCEPTION 'idea privacy revert: refused, nothing changed - % wiki page(s) archived, % restored, % kept newer, % identical',
            n_archive, n_restored, n_kept, n_same USING ERRCODE = '55000';
    END IF;
    DROP TABLE public.idea_wiki_archive;
    RAISE NOTICE 'idea privacy revert: % wiki page(s) restored (% kept: regenerated since); move their vault files back', n_restored, n_kept;
END $$;

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
COMMIT;
