-- ============================================================
-- The ideas' old shared copies leave the shared corpus (research-workbench rw-idea-privacy). Slot 380.
-- Operator 2026-11-02: "Ideas are completely user isolated. The shared knowledge are the sources and claims."
-- Slot 370 (rw-p8a4-ideas) stopped every idea door writing a corpus thought: a revision is private
-- (idea_revisions.private_owner, policy idea_revisions_owner_private). Every revision written BEFORE it still has an
-- `ops` thought carrying the idea's text, which search / fetch / search_thoughts / list_thoughts (the generic MCP lane)
-- return to everyone. This file moves those thoughts out, for every idea:
--   1. the idea thoughts: a thought a revision links (idea_revisions.thought_id - capture_idea / update_idea /
--      migrate-ideas-backfill.py, whatever its metadata), or one whose metadata names an idea (type or kind 'idea',
--      any case; an idea_id key);
--   2. each must belong to an idea that keeps its text privately: the revision that links it, or - for an unlinked
--      thought naming an idea - a revision of that idea holding the same text. A thought with no such home (a generic
--      capture typed 'idea', with no idea row) STOPS the migration (nothing changed): it is the operator's call, not
--      this file's. So does a thought an agent memory points at;
--   3. archive: the whole row, column for column, into public.idea_thought_archive (no app role may read it; the
--      owner reads the same text through the private revision), with what the delete cascades to (its entity links,
--      edges and extraction-queue row) and the revisions it was linked from;
--   4. the linking revisions become private (private_owner = the idea's owner, thought_id NULL);
--   5. delete ONLY the thoughts whose archived row equals the live row, and refuse unless every idea thought is gone and
--      the archive holds exactly the rows removed.
--   6. the wiki's copies (round 2): every wiki_pages row that shows an archived idea's text (its thought leaf, a page
--      citing that leaf, a page quoting the text - normalised, any run of 8 words, title or body; round 3) is archived
--      into public.idea_wiki_archive and withheld, and a guard on
--      wiki_pages keeps such a page from being written back (the viewer's reconcile, a compile). The pages' vault FILES
--      are moved out of the vault by hand right after this file runs (the deploy step; the guard covers the gap).
-- One transaction (the whole file): a failed check leaves everything as it was. Re-run: nothing left to move.
-- The delete bumps the cited entities' updated_at (trg_touch_entities_on_thought_delete), so the entity wiki
-- recompiles their pages. Revert: revert-idea-privacy.sql restores the thoughts byte-identical from the archive.
-- Fresh-volume slot 380 (an empty database: nothing to move); live: psql -f after a fresh backup.
-- ============================================================

-- ONE transaction for the whole file: a refusal below leaves nothing behind, not even the archive table
BEGIN;
SET LOCAL client_min_messages = warning;   -- the re-run's "already exists, skipping" notices

-- the archive: the thoughts' own columns (LIKE: same names and types, so a restore is byte-identical) + what the move
-- recorded, under archive_* names
CREATE TABLE IF NOT EXISTS public.idea_thought_archive (LIKE public.thoughts);
ALTER TABLE public.idea_thought_archive ADD COLUMN IF NOT EXISTS archive_owner_sub TEXT;
ALTER TABLE public.idea_thought_archive ADD COLUMN IF NOT EXISTS archive_idea_id UUID;
ALTER TABLE public.idea_thought_archive ADD COLUMN IF NOT EXISTS archive_revisions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.idea_thought_archive ADD COLUMN IF NOT EXISTS archive_entities JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.idea_thought_archive ADD COLUMN IF NOT EXISTS archive_edges JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.idea_thought_archive ADD COLUMN IF NOT EXISTS archive_queue JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.idea_thought_archive ADD COLUMN IF NOT EXISTS archive_at TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$
DECLARE
    c RECORD;
BEGIN
    -- a column thoughts gained after the archive was made is archived too
    FOR c IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
               FROM pg_attribute a
              WHERE a.attrelid = 'public.thoughts'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                AND NOT EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = 'public.idea_thought_archive'::regclass
                                                             AND b.attname = a.attname AND NOT b.attisdropped) LOOP
        EXECUTE format('ALTER TABLE public.idea_thought_archive ADD COLUMN %I %s', c.attname, c.typ);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.idea_thought_archive'::regclass AND contype = 'p') THEN
        ALTER TABLE public.idea_thought_archive ADD PRIMARY KEY (id);
    END IF;
END $$;
-- nobody but the table owner (the migration's role): RLS on and forced, no policy, and no grant - the default
-- privileges (slot 050) would otherwise hand the app roles everything
ALTER TABLE public.idea_thought_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idea_thought_archive FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
    r TEXT;
BEGIN
    REVOKE ALL ON public.idea_thought_archive FROM PUBLIC;
    FOR r IN SELECT rolname FROM pg_roles
              WHERE NOT rolsuper AND rolname NOT LIKE 'pg\_%'
                AND has_table_privilege(oid, 'public.idea_thought_archive', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                AND oid <> (SELECT relowner FROM pg_class WHERE oid = 'public.idea_thought_archive'::regclass) LOOP
        EXECUTE format('REVOKE ALL ON public.idea_thought_archive FROM %I', r);
    END LOOP;
END $$;
COMMENT ON TABLE public.idea_thought_archive IS
  'rw-idea-privacy (operator 2026-11-02, ideas are completely user isolated): the shared-corpus thoughts that carried '
  'an idea''s text before slot 370, moved out by init-idea-privacy.sql (slot 380). Readable by no app role; the owner '
  'reads the same text through the idea''s private revisions. revert-idea-privacy.sql restores them.';

-- the move
SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    n_scope INT; n_homeless INT; n_memories INT; n_ambiguous INT; n_archived_before INT; n_archived INT; n_private INT;
    n_deleted INT; n_left INT; v_cols TEXT; v_tcols TEXT;
BEGIN
    CREATE TEMP TABLE _idea_thoughts ON COMMIT DROP AS
    SELECT t.id,
           (SELECT array_agg(DISTINCT r.idea_id) FROM public.idea_revisions r WHERE r.thought_id = t.id) AS linked,
           CASE WHEN t.metadata ->> 'idea_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (t.metadata ->> 'idea_id')::uuid END AS named,
           md5(lower(btrim(coalesce(t.content, '')))) AS hash
      FROM public.thoughts t
     WHERE EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.thought_id = t.id)
        OR lower(btrim(coalesce(t.metadata ->> 'type', ''))) = 'idea'
        OR lower(btrim(coalesce(t.metadata ->> 'kind', ''))) = 'idea'
        OR t.metadata ? 'idea_id';
    SELECT count(*) INTO n_scope FROM _idea_thoughts;
    IF n_scope = 0 THEN
        RAISE NOTICE 'idea privacy: no idea thought in the shared corpus - nothing to move';
        RETURN;
    END IF;

    -- each thought's idea: the one that links it, else the one it names when that idea holds the same text privately
    ALTER TABLE _idea_thoughts ADD COLUMN idea_id UUID;
    UPDATE _idea_thoughts x SET idea_id = x.linked[1] WHERE cardinality(x.linked) = 1;
    UPDATE _idea_thoughts x SET idea_id = x.named
     WHERE x.linked IS NULL AND x.named IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = x.named AND r.content_hash = x.hash);
    SELECT count(*) FILTER (WHERE cardinality(linked) > 1), count(*) FILTER (WHERE idea_id IS NULL AND linked IS NULL)
      INTO n_ambiguous, n_homeless FROM _idea_thoughts;
    SELECT count(*) INTO n_memories FROM public.agent_memories m JOIN _idea_thoughts x ON x.id = m.thought_id;
    IF n_ambiguous > 0 OR n_homeless > 0 OR n_memories > 0 THEN
        RAISE EXCEPTION 'idea privacy: refused, nothing changed - % idea thought(s) with no idea that keeps their text, % linked from more than one idea, % pointed at by an agent memory (the operator decides these first: migrate-ideas-backfill.py makes an unlinked one an idea)',
            n_homeless, n_ambiguous, n_memories USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM _idea_thoughts x JOIN public.ideas i ON i.id = x.idea_id WHERE coalesce(btrim(i.owner_sub), '') = '') THEN
        RAISE EXCEPTION 'idea privacy: refused, nothing changed - an idea with no owner cannot keep a private revision' USING ERRCODE = '55000';
    END IF;

    -- archive: the row as it is, with what the delete cascades to and the revisions that linked it
    SELECT count(*) INTO n_archived_before FROM public.idea_thought_archive;
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum), string_agg('t.' || quote_ident(attname), ', ' ORDER BY attnum)
      INTO v_cols, v_tcols
      FROM pg_attribute WHERE attrelid = 'public.thoughts'::regclass AND attnum > 0 AND NOT attisdropped;
    -- [archive-step]
    EXECUTE format(
      'INSERT INTO public.idea_thought_archive (%s, archive_owner_sub, archive_idea_id, archive_revisions, archive_entities, archive_edges, archive_queue)
       SELECT %s, i.owner_sub, x.idea_id,
              coalesce((SELECT jsonb_agg(jsonb_build_object(''idea_id'', r.idea_id, ''revision'', r.revision, ''private_owner'', r.private_owner))
                          FROM public.idea_revisions r WHERE r.thought_id = t.id), ''[]''::jsonb),
              coalesce((SELECT jsonb_agg(to_jsonb(te)) FROM public.thought_entities te WHERE te.thought_id = t.id), ''[]''::jsonb),
              coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM public.thought_edges e WHERE e.from_thought_id = t.id OR e.to_thought_id = t.id), ''[]''::jsonb),
              coalesce((SELECT jsonb_agg(to_jsonb(q)) FROM public.entity_extraction_queue q WHERE q.thought_id = t.id), ''[]''::jsonb)
         FROM public.thoughts t JOIN _idea_thoughts x ON x.id = t.id JOIN public.ideas i ON i.id = x.idea_id', v_cols, v_tcols);
    -- [/archive-step]
    SELECT count(*) - n_archived_before INTO n_archived FROM public.idea_thought_archive;

    -- the idea keeps its text privately: the linking revisions name their owner's plane (the slot-370 policy)
    UPDATE public.idea_revisions r
       SET private_owner = i.owner_sub, thought_id = NULL
      FROM _idea_thoughts x, public.ideas i
     WHERE r.thought_id = x.id AND i.id = r.idea_id;
    GET DIAGNOSTICS n_private = ROW_COUNT;

    -- delete only what the archive holds, column for column as it is now
    WITH gone AS (
        DELETE FROM public.thoughts t
         USING public.idea_thought_archive a, _idea_thoughts x
         WHERE x.id = t.id AND a.id = t.id
           AND to_jsonb(t) = (SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(a)) AS j(k, v)
                               WHERE k IN (SELECT jsonb_object_keys(to_jsonb(t))))
        RETURNING t.id)
    SELECT count(*) INTO n_deleted FROM gone;

    SELECT count(*) INTO n_left FROM public.thoughts t
     WHERE EXISTS (SELECT 1 FROM _idea_thoughts x WHERE x.id = t.id)
        OR EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.thought_id = t.id)
        OR lower(btrim(coalesce(t.metadata ->> 'type', ''))) = 'idea'
        OR lower(btrim(coalesce(t.metadata ->> 'kind', ''))) = 'idea'
        OR t.metadata ? 'idea_id';
    IF n_left <> 0 OR n_deleted <> n_scope OR n_archived <> n_deleted THEN
        RAISE EXCEPTION 'idea privacy: refused, nothing changed - % idea thoughts, % archived, % removed, % left (every one must be archived, then removed)',
            n_scope, n_archived, n_deleted, n_left USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'idea privacy: % idea thought(s) archived and removed from the shared corpus; % revision(s) now private',
        n_deleted, n_private;
END $$;

-- ── the wiki's copies (round 2, tester F1) ─────────────────────────────────────────────────────────────
-- The entity wiki compiled the idea thoughts into wiki_pages, which the contract search's `page` kind, the viewer and
-- every other page reader serve to everyone: a thought leaf (content/thought/<id>) holding the idea's text, and pages
-- citing that leaf or quoting the text (entity, source, note). ONE predicate decides "this page shows an idea's text",
-- for the move below and for the guard after it (round 3: normalised text, 8-word runs, the title, every link form -
-- see "what shows an idea's text means" below):
--   * the page IS an archived idea thought's leaf, or references one in any link form;
--   * its normalised title or body holds a run of 8 or more words of an idea text (or a short idea's whole text).
-- A page that also holds shared content (an entity page citing an idea thought among others) is WITHHELD, not edited:
-- the text was written around the citation and a textual cut cannot be proven complete. The delete trigger on thoughts
-- already bumped those entities, so the next compile regenerates the page from what is still shared, and the guard
-- lets that clean page back in.
SET LOCAL client_min_messages = warning;
CREATE TABLE IF NOT EXISTS public.idea_wiki_archive (LIKE public.wiki_pages);
ALTER TABLE public.idea_wiki_archive ADD COLUMN IF NOT EXISTS archive_at TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$
DECLARE
    c RECORD; r TEXT;
BEGIN
    FOR c IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
               FROM pg_attribute a
              WHERE a.attrelid = 'public.wiki_pages'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                AND NOT EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = 'public.idea_wiki_archive'::regclass
                                                             AND b.attname = a.attname AND NOT b.attisdropped) LOOP
        EXECUTE format('ALTER TABLE public.idea_wiki_archive ADD COLUMN %I %s', c.attname, c.typ);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.idea_wiki_archive'::regclass AND contype = 'p') THEN
        ALTER TABLE public.idea_wiki_archive ADD PRIMARY KEY (slug);
    END IF;
    REVOKE ALL ON public.idea_wiki_archive FROM PUBLIC;
    FOR r IN SELECT rolname FROM pg_roles
              WHERE NOT rolsuper AND rolname NOT LIKE 'pg\_%'
                AND has_table_privilege(oid, 'public.idea_wiki_archive', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                AND oid <> (SELECT relowner FROM pg_class WHERE oid = 'public.idea_wiki_archive'::regclass) LOOP
        EXECUTE format('REVOKE ALL ON public.idea_wiki_archive FROM %I', r);
    END LOOP;
END $$;
ALTER TABLE public.idea_wiki_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idea_wiki_archive FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE public.idea_wiki_archive IS
  'rw-idea-privacy: the wiki_pages rows that showed an idea''s text (its thought leaf, pages citing or quoting it), '
  'withheld by init-idea-privacy.sql (slot 380). Readable by no app role. revert-idea-privacy.sql restores them.';

-- ── what "shows an idea's text" means (round 3, tester attempt 2; the bar frozen by the coordinator) ─────────
-- Every idea text is NORMALISED before it is compared, and so is the page: lower case, and every run of characters
-- that is not a letter or a digit becomes ONE space. That one rule removes case, every kind of whitespace (newlines,
-- doubled spaces), markdown emphasis, blockquote and heading marks, and link syntax.
-- A page shows an idea's text when its normalised TITLE or BODY holds:
--   * any run of 8 or more consecutive words of an idea text (kept as md5 hashes of every 8-word window, in
--     idea_privacy_shingles); or, for an idea text of fewer than 8 words, that whole text (idea_privacy_whole, matched
--     on word boundaries);
--   * or a reference to an archived idea thought in any form - content/thought/<id>, thought/<id>, [[...]], (...),
--     the slug itself or an entry of links - with the id ending there (<id>0 is another thought).
-- The idea texts: every archived idea thought's content, and every idea revision's summary (every user's: an idea is
-- private to its owner, so no idea text may be readable by anyone else). A new revision adds its windows as it is
-- written (trg_idea_privacy_learn on idea_revisions), so the guard knows it from then on.
-- Out of reach by construction, and named in the findings: a paraphrase or summary that shares no run of 8 words.
CREATE TABLE IF NOT EXISTS public.idea_privacy_shingles (h TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.idea_privacy_whole (t TEXT PRIMARY KEY);
DO $$
DECLARE
    tb TEXT; r TEXT;
BEGIN
    FOREACH tb IN ARRAY ARRAY['public.idea_privacy_shingles', 'public.idea_privacy_whole'] LOOP
        EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', tb);
        FOR r IN SELECT rolname FROM pg_roles
                  WHERE NOT rolsuper AND rolname NOT LIKE 'pg\_%'
                    AND has_table_privilege(oid, tb, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                    AND oid <> (SELECT relowner FROM pg_class WHERE oid = tb::regclass) LOOP
            EXECUTE format('REVOKE ALL ON %s FROM %I', tb, r);
        END LOOP;
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tb);
        EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tb);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.idea_privacy_norm(p TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT btrim(regexp_replace(lower(coalesce(p, '')), '[^[:alnum:]]+', ' ', 'g'));
$$;

-- the md5 of every 8-word window of a text's normalised words (none for a text of fewer than 8 words). plpgsql, into
-- a local array: a SQL set-returning function that slices a large array re-reads (detoasts) the whole array on every
-- slice, which made this quadratic (measured: 210 ms for one 3 000-character page; this is about 1 ms)
DROP FUNCTION IF EXISTS public.idea_privacy_windows(TEXT);
CREATE FUNCTION public.idea_privacy_windows(p TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
DECLARE
    a TEXT[] := string_to_array(public.idea_privacy_norm(p), ' ');
    n INT := coalesce(cardinality(a), 0);
    r TEXT[] := '{}';
BEGIN
    IF n < 8 THEN RETURN r; END IF;
    FOR i IN 1 .. n - 7 LOOP
        r := r || md5(array_to_string(a[i:i + 7], ' '));
    END LOOP;
    RETURN r;
END;
$$;

-- learn one idea text: its windows, or (fewer than 8 words) its whole normalised text
CREATE OR REPLACE FUNCTION public.idea_privacy_learn(p TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_norm TEXT := public.idea_privacy_norm(p);
BEGIN
    IF v_norm = '' THEN RETURN; END IF;
    IF coalesce(cardinality(string_to_array(v_norm, ' ')), 0) < 8 THEN
        INSERT INTO public.idea_privacy_whole (t) VALUES (v_norm) ON CONFLICT DO NOTHING;
    ELSE
        INSERT INTO public.idea_privacy_shingles (h) SELECT DISTINCT w FROM unnest(public.idea_privacy_windows(p)) AS w ON CONFLICT DO NOTHING;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_idea_privacy_learn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.idea_privacy_learn(NEW.summary);
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_idea_privacy_learn ON public.idea_revisions;
CREATE TRIGGER trg_idea_privacy_learn AFTER INSERT ON public.idea_revisions
    FOR EACH ROW EXECUTE FUNCTION public.trg_idea_privacy_learn();

-- every idea text there is now: the archived idea thoughts (this run's and earlier runs') and every revision
DO $$
DECLARE
    v TEXT;
BEGIN
    FOR v IN SELECT content FROM public.idea_thought_archive UNION SELECT summary FROM public.idea_revisions LOOP
        PERFORM public.idea_privacy_learn(v);
    END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.idea_privacy_page_shows_idea(TEXT, TEXT, JSONB);   -- round 2's (slug, body, links)
CREATE OR REPLACE FUNCTION public.idea_privacy_page_shows_idea(p_slug TEXT, p_title TEXT, p_body TEXT, p_links JSONB)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        EXISTS (SELECT 1 FROM public.idea_thought_archive a
                 WHERE a.id::text IN (
                     SELECT m[1] FROM regexp_matches(
                         coalesce(p_slug, '') || ' ' || coalesce(p_title, '') || ' ' || coalesce(p_body, '') || ' ' || coalesce(p_links::text, ''),
                         '(?:^|[^[:alnum:]])thought/([0-9]+)(?![0-9])', 'g') AS m))
     OR EXISTS (SELECT 1 FROM public.idea_privacy_shingles x WHERE x.h = ANY (public.idea_privacy_windows(p_title)))
     OR EXISTS (SELECT 1 FROM public.idea_privacy_shingles x WHERE x.h = ANY (public.idea_privacy_windows(p_body)))
     OR EXISTS (SELECT 1 FROM public.idea_privacy_whole w
                 WHERE position(' ' || w.t || ' ' IN ' ' || public.idea_privacy_norm(p_title) || ' ') > 0
                    OR position(' ' || w.t || ' ' IN ' ' || public.idea_privacy_norm(p_body) || ' ') > 0);
$$;
REVOKE ALL ON FUNCTION public.idea_privacy_page_shows_idea(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.idea_privacy_learn(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_idea_privacy_learn() FROM PUBLIC;

-- the guard: a page that would show an idea's text is not written - on INSERT and on any UPDATE of its slug, title,
-- body or links, by any role (the viewer's reconcile repairing a row from its vault file, a compile, an app role's
-- UPDATE or PostgREST PATCH). A compiled or reconciled page is skipped silently (RETURN NULL: one bad row must not
-- fail the compile's whole batch; the reconcile then reports the slug as drift; an UPDATE leaves the row as it was);
-- a NOTE is a person's own writing saved through the workbench, so it is refused out loud instead
CREATE OR REPLACE FUNCTION public.trg_idea_privacy_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.idea_privacy_page_shows_idea(NEW.slug, NEW.title, NEW.body, NEW.links) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page quotes an idea''s text, and an idea is private to its owner' USING ERRCODE = '42501';
        END IF;
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_idea_privacy_wiki_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_idea_privacy_wiki_guard ON public.wiki_pages;
CREATE TRIGGER trg_idea_privacy_wiki_guard BEFORE INSERT OR UPDATE OF slug, title, body, links ON public.wiki_pages
    FOR EACH ROW EXECUTE FUNCTION public.trg_idea_privacy_wiki_guard();

SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    n_scope INT; n_before INT; n_archived INT; n_deleted INT; n_left INT; v_cols TEXT;
BEGIN
    CREATE TEMP TABLE _idea_pages ON COMMIT DROP AS
    SELECT w.slug FROM public.wiki_pages w WHERE public.idea_privacy_page_shows_idea(w.slug, w.title, w.body, w.links);
    SELECT count(*) INTO n_scope FROM _idea_pages;
    IF n_scope = 0 THEN
        RAISE NOTICE 'idea privacy: no wiki page shows an idea''s text - nothing to withhold';
        RETURN;
    END IF;
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO v_cols
      FROM pg_attribute WHERE attrelid = 'public.wiki_pages'::regclass AND attnum > 0 AND NOT attisdropped;
    SELECT count(*) INTO n_before FROM public.idea_wiki_archive;
    -- [wiki-archive-step]
    EXECUTE format('INSERT INTO public.idea_wiki_archive (%s) SELECT %s FROM public.wiki_pages w JOIN _idea_pages p USING (slug)',
                   v_cols, v_cols);
    -- [/wiki-archive-step]
    SELECT count(*) - n_before INTO n_archived FROM public.idea_wiki_archive;
    WITH gone AS (
        DELETE FROM public.wiki_pages w
         USING public.idea_wiki_archive a, _idea_pages p
         WHERE p.slug = w.slug AND a.slug = w.slug
           AND to_jsonb(w) = (SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(a)) AS j(k, v)
                               WHERE k IN (SELECT jsonb_object_keys(to_jsonb(w))))
        RETURNING w.slug)
    SELECT count(*) INTO n_deleted FROM gone;
    SELECT count(*) INTO n_left FROM public.wiki_pages w WHERE public.idea_privacy_page_shows_idea(w.slug, w.title, w.body, w.links);
    IF n_left <> 0 OR n_deleted <> n_scope OR n_archived <> n_deleted THEN
        RAISE EXCEPTION 'idea privacy: refused, nothing changed - % wiki page(s) show an idea''s text, % archived, % withheld, % left',
            n_scope, n_archived, n_deleted, n_left USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'idea privacy: % wiki page(s) that showed an idea''s text archived and withheld (move their vault files out: the deploy step)',
        n_deleted;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
