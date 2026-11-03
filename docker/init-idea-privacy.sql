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
--      citing that leaf, a page quoting the text) is archived into public.idea_wiki_archive and withheld, and a guard on
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
-- for the move below and for the guard after it, against the archived idea thoughts:
--   * the page IS an archived idea thought's leaf;
--   * it links that leaf (links, or a [[content/thought/<id>]] in its body);
--   * its body holds an archived idea thought's whole text (24 characters or more: a shorter text matches by chance).
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

CREATE OR REPLACE FUNCTION public.idea_privacy_page_shows_idea(p_slug TEXT, p_body TEXT, p_links JSONB)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.idea_thought_archive a
         WHERE p_slug = 'content/thought/' || a.id::text
            OR (jsonb_typeof(p_links) = 'array' AND p_links ? ('content/thought/' || a.id::text))
            OR (position('content/thought/' IN coalesce(p_body, '')) > 0
                AND coalesce(p_body, '') ~ ('content/thought/' || a.id::text || '([^0-9]|$)'))
            OR (length(btrim(coalesce(a.content, ''))) >= 24 AND position(btrim(a.content) IN coalesce(p_body, '')) > 0));
$$;
REVOKE ALL ON FUNCTION public.idea_privacy_page_shows_idea(TEXT, TEXT, JSONB) FROM PUBLIC;

-- the guard: a page that would show an idea's text is not written back - not by the viewer's reconcile repairing a
-- row from its vault file, not by a compile, not by an app role. A compiled or reconciled page is skipped silently
-- (RETURN NULL: one bad row must not fail the compile's whole batch; the reconcile then reports the slug as drift); a
-- NOTE is a person's own writing saved through the workbench, so it is refused out loud instead
CREATE OR REPLACE FUNCTION public.trg_idea_privacy_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.idea_privacy_page_shows_idea(NEW.slug, NEW.body, NEW.links) THEN
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
CREATE TRIGGER trg_idea_privacy_wiki_guard BEFORE INSERT OR UPDATE ON public.wiki_pages
    FOR EACH ROW EXECUTE FUNCTION public.trg_idea_privacy_wiki_guard();

SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    n_scope INT; n_before INT; n_archived INT; n_deleted INT; n_left INT; v_cols TEXT;
BEGIN
    CREATE TEMP TABLE _idea_pages ON COMMIT DROP AS
    SELECT w.slug FROM public.wiki_pages w WHERE public.idea_privacy_page_shows_idea(w.slug, w.body, w.links);
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
    SELECT count(*) INTO n_left FROM public.wiki_pages w WHERE public.idea_privacy_page_shows_idea(w.slug, w.body, w.links);
    IF n_left <> 0 OR n_deleted <> n_scope OR n_archived <> n_deleted THEN
        RAISE EXCEPTION 'idea privacy: refused, nothing changed - % wiki page(s) show an idea''s text, % archived, % withheld, % left',
            n_scope, n_archived, n_deleted, n_left USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'idea privacy: % wiki page(s) that showed an idea''s text archived and withheld (move their vault files out: the deploy step)',
        n_deleted;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
