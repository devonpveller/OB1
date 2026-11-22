-- lab-plant.sql - rw-withheld-text-rescan's lab plant (synthetic rows only; never point it at a live database).
--   psql -v ON_ERROR_STOP=1 -v mark=<random token> -v phase=pre440|legacy -v filler=<n> -f lab-plant.sql
-- phase=pre440: three unowned thoughts and their leaves (content/thought/<id>), so slot 440 (owner A) withholds the
--   leaves and keeps their text for the guard's text rule: P1 (48 words: every 8-word window kept), P2 (120 words:
--   every 8th window kept), P3 (5 words: matched whole).
-- phase=legacy: the rows written BEFORE the text rule existed (inserted with triggers off, as rows already stored were):
--   flagged (the rule answers true): a note of A's and a note of B's, two sources, two entities - each kind, both
--   identities' notes, every store shape (P1 with markup and case changed, P2 quoted whole, P3 exactly);
--   controls (the rule answers false): an ordinary note of A's and B's, an ordinary source and entity, a source holding
--   10 of P1's 48 words (3 of 41 windows: under half), an entity holding P3 inside a longer text (not whole);
--   and :filler ordinary rows (sources and entities), so a scan takes many chunks.
-- The planted slugs and what the lab expects of each are kept in public.lab_rescan_plant (this lab database only).
\set ON_ERROR_STOP on
\if :{?filler}
\else
\set filler 0
\endif
CREATE TABLE IF NOT EXISTS public.lab_rescan_plant (slug TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, flagged BOOLEAN NOT NULL, marker TEXT NOT NULL);
SELECT set_config('lab.mark', :'mark', false) AS m_set, set_config('lab.phase', :'phase', false) AS p_set,
       set_config('lab.filler', :'filler', false) AS f_set \gset
DO $$
DECLARE
    m   TEXT := current_setting('lab.mark');
    ph  TEXT := current_setting('lab.phase');
    nf  INT := current_setting('lab.filler')::int;
    dim INT := (SELECT atttypmod FROM pg_attribute WHERE attrelid = 'public.thoughts'::regclass AND attname = 'embedding');
    v   TEXT;
    p1  TEXT; p2 TEXT; p3 TEXT;
    t1 BIGINT; t2 BIGINT; t3 BIGINT;
    i   INT;
BEGIN
    -- the private texts: distinct words carrying the marker, so no window is shared with anything else
    SELECT string_agg('alpha' || m || 'w' || g, ' ' ORDER BY g) INTO p1 FROM generate_series(1, 48) g;
    SELECT string_agg('bravo' || m || 'w' || g, ' ' ORDER BY g) INTO p2 FROM generate_series(1, 120) g;
    p3 := 'charlie' || m || ' secret dinner at eight';
    IF ph = 'pre440' THEN
        v := '[' || array_to_string(array_fill('0.02'::text, ARRAY[greatest(dim, 1)]), ',') || ']';
        INSERT INTO public.thoughts (content, embedding, metadata, exposure) VALUES (p1, v::vector, '{"source":"mcp"}', 'ops') RETURNING id INTO t1;
        INSERT INTO public.thoughts (content, embedding, metadata, exposure) VALUES (p2, v::vector, '{"source":"mcp"}', 'ops') RETURNING id INTO t2;
        INSERT INTO public.thoughts (content, embedding, metadata, exposure) VALUES (p3, v::vector, '{"source":"mcp"}', 'ops') RETURNING id INTO t3;
        INSERT INTO public.wiki_pages (slug, page_class, title, body, links, frontmatter) VALUES
            ('content/thought/' || t1, 'thought', 'Thought ' || t1, p1, '[]', '{}'),
            ('content/thought/' || t2, 'thought', 'Thought ' || t2, p2, '[]', '{}'),
            ('content/thought/' || t3, 'thought', 'Thought ' || t3, p3, '[]', '{}');
        RETURN;
    END IF;
    IF ph <> 'legacy' THEN RAISE EXCEPTION 'lab plant: unknown phase %', ph; END IF;
    PERFORM set_config('session_replication_role', 'replica', true);   -- stored before the text rule: no guard ran
    INSERT INTO public.lab_rescan_plant (slug, kind, owner, flagged, marker) VALUES
        ('notes/lab-a/flag-' || m, 'note', 'A', true, m),
        ('notes/lab-b/flag-' || m, 'note', 'B', true, m),
        ('content/source/' || gen_random_uuid(), 'source', '-', true, m),
        ('content/source/' || gen_random_uuid(), 'source', '-', true, m),
        ('content/person/person-flag-' || m, 'entity', '-', true, m),
        ('content/concept/concept-flag-' || m, 'entity', '-', true, m),
        ('notes/lab-a/ctl-' || m, 'note', 'A', false, m),
        ('notes/lab-b/ctl-' || m, 'note', 'B', false, m),
        ('content/source/' || gen_random_uuid(), 'source', '-', false, m),
        ('content/source/' || gen_random_uuid(), 'source', '-', false, m),
        ('content/person/person-ctl-' || m, 'entity', '-', false, m),
        ('content/concept/concept-ctl-' || m, 'entity', '-', false, m);
    -- flagged: each with the text a different way (markup, case, punctuation do not count - 440's normalisation)
    INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links, frontmatter)
    SELECT p.slug, CASE p.kind WHEN 'note' THEN 'note' WHEN 'source' THEN 'source' ELSE 'entity' END,
           CASE WHEN p.kind = 'entity' THEN split_part(split_part(p.slug, '/', 2), '-', 1) END,
           'Lab page ' || row_number() OVER (ORDER BY p.slug),
           CASE row_number() OVER (ORDER BY p.slug) % 3
                WHEN 0 THEN '# My notes' || chr(10) || upper(replace(p1, ' ', ', ')) || chr(10) || 'and a closing line of my own.'
                WHEN 1 THEN '> ' || p2 || chr(10) || chr(10) || 'quoted in full.'
                ELSE p1 END,
           '[]', jsonb_build_object('lab', true)
      FROM public.lab_rescan_plant p WHERE p.flagged AND p.marker = m;
    -- the exact-whole short text, on one flagged source (replacing its body)
    UPDATE public.wiki_pages SET body = '**' || upper(p3) || '!**'
     WHERE slug = (SELECT min(slug) FROM public.lab_rescan_plant WHERE flagged AND kind = 'source' AND marker = m);
    -- controls: ordinary text; one near-miss source (10 of P1's words), one entity holding P3 inside more text
    INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links, frontmatter)
    SELECT p.slug, CASE p.kind WHEN 'note' THEN 'note' WHEN 'source' THEN 'source' ELSE 'entity' END,
           CASE WHEN p.kind = 'entity' THEN split_part(split_part(p.slug, '/', 2), '-', 1) END,
           'Lab control ' || row_number() OVER (ORDER BY p.slug),
           'an ordinary shared page ctl' || m || ' about the weather, the garden and a library book that is overdue again this week.',
           '[]', jsonb_build_object('lab', true)
      FROM public.lab_rescan_plant p WHERE NOT p.flagged AND p.marker = m;
    UPDATE public.wiki_pages
       SET body = 'ctl' || m || ' ' || (SELECT string_agg('alpha' || m || 'w' || g, ' ' ORDER BY g) FROM generate_series(1, 10) g) || ' then something else entirely'
     WHERE slug = (SELECT min(slug) FROM public.lab_rescan_plant WHERE NOT flagged AND kind = 'source' AND marker = m);
    UPDATE public.wiki_pages SET body = 'ctl' || m || ' a page that mentions ' || p3 || ' among other public things'
     WHERE slug = 'content/concept/concept-ctl-' || m;
    -- filler: ordinary rows of both shared kinds
    INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links, frontmatter)
    SELECT CASE WHEN g % 2 = 0 THEN 'content/source/' || gen_random_uuid() ELSE 'content/topic/topic-fill-' || m || '-' || g END,
           CASE WHEN g % 2 = 0 THEN 'source' ELSE 'entity' END, CASE WHEN g % 2 = 0 THEN NULL ELSE 'topic' END,
           'Filler ' || g,
           'filler page number ' || g || ' with plain shared words that repeat across many pages of the lab wiki, nothing private here at all.',
           '[]', '{}'
      FROM generate_series(1, nf) g;
    PERFORM set_config('session_replication_role', 'origin', true);
END $$;
