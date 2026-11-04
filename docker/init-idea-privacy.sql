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
--   6. the wiki's copies (round 2; the rule since round 4 is the idea's PRESENTATION, never shared wording): every
--      wiki_pages row that is an archived idea thought's leaf or links one in any form is archived into
--      public.idea_wiki_archive and withheld, and a guard on wiki_pages refuses the leaf and the link being written
--      back (the viewer's reconcile, a compile, an app role). A linking page that is otherwise general comes back
--      rebuilt by the next compile, without the idea. The pages' vault FILES are moved out of the vault by hand right
--      after this file runs (the deploy step; the guard covers the gap). Run it with the wiki compile paused.
-- One transaction (the whole file): a failed check leaves everything as it was. Re-run: nothing left to move.
-- The delete bumps the cited entities' updated_at (trg_touch_entities_on_thought_delete), so the entity wiki
-- recompiles their pages. Revert: revert-idea-privacy.sql restores the thoughts byte-identical from the archive.
-- Fresh-volume slot 380 (an empty database: nothing to move); live: psql -f after a fresh backup.
-- ============================================================

-- ONE transaction for the whole file: a refusal below leaves nothing behind, not even the archive table
BEGIN;
SET LOCAL client_min_messages = warning;   -- the re-run's "already exists, skipping" notices
-- round 4 (review R5): the run takes write locks on wiki_pages and idea_revisions (its triggers) for its whole length
-- (~15 minutes on live: two scans of every page). Never queue behind a writer and stall everyone queued behind THIS:
-- a lock not granted within 10 s stops the run, nothing changed (pause the wiki compile, then run it again)
SET LOCAL lock_timeout = '10s';

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

-- ── the wiki's copies (round 2, tester F1; the rule since round 4: the idea's presentation, by link and leaf) ──────
-- The entity wiki compiled the idea thoughts into wiki_pages, which the contract search's `page` kind, the viewer and
-- every other page reader serve to everyone: a thought leaf (content/thought/<id>) holding the idea's text, and pages
-- citing that leaf. ONE predicate (idea_privacy_page_links_idea, below) decides which page is the idea's presentation,
-- for the move and for the guard: the leaf, and any page that links it. Such a page is archived and withheld; a
-- linking page that is otherwise general comes back rebuilt by the next compile, without the idea (see below).
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
    -- round 4 (review R6): a page may be archived more than once - withheld, regenerated clean, then matched again by a
    -- newer idea text. Each archiving is its own row (archive_id); the slug is not a key. A round-2/3 archive keyed by
    -- slug is re-keyed in place (no row is dropped).
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.idea_wiki_archive'::regclass AND attname = 'archive_id' AND NOT attisdropped) THEN
        ALTER TABLE public.idea_wiki_archive ADD COLUMN archive_id BIGINT GENERATED BY DEFAULT AS IDENTITY;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conrelid = 'public.idea_wiki_archive'::regclass AND pc.contype = 'p'
                AND pc.conkey <> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.idea_wiki_archive'::regclass AND attname = 'archive_id')]) THEN
        EXECUTE format('ALTER TABLE public.idea_wiki_archive DROP CONSTRAINT %I',
                       (SELECT conname FROM pg_constraint WHERE conrelid = 'public.idea_wiki_archive'::regclass AND contype = 'p'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.idea_wiki_archive'::regclass AND contype = 'p') THEN
        ALTER TABLE public.idea_wiki_archive ADD PRIMARY KEY (archive_id);
    END IF;
    CREATE INDEX IF NOT EXISTS idx_idea_wiki_archive_slug ON public.idea_wiki_archive (slug, archive_id DESC);
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
  'rw-idea-privacy: the wiki_pages rows that presented an idea (its thought leaf, pages linking it), '
  'withheld by init-idea-privacy.sql (slot 380). Readable by no app role. revert-idea-privacy.sql restores them.';

-- ── what a page withheld for an idea is (round 4: the operator's bar, 2026-11-03) ─────────────────────────────
-- Operator: "isolate the original user idea and presentation of the idea but the associated/generated/supporting
-- research results are general knowledge." So the wiki rule is about the idea's PRESENTATION, never about shared
-- wording: a page is withheld when it IS an archived idea thought's leaf or LINKS one - content/thought/<id>,
-- thought/<id>, [[...]], (...), an entry of links, the slug itself, anywhere in the slug, title, body or links - with
-- the id ending there (<id>0 is another thought; afterthought/<id> is no link). Nothing else: a general page that
-- shares wording with an idea is general knowledge and stays.
-- A linking page that is otherwise general (an entity page citing the idea among other material) is withheld here
-- and REBUILT by the next entity-wiki compile from shared material only: the compile reads an entity's evidence live
-- (thought_entities joined to thoughts), the idea thoughts are gone from both, and the delete above bumped exactly
-- those entities (trg_touch_entities_on_thought_delete), so they are in the compile's dirty set. A page whose ONLY
-- evidence was the idea (an entity cited by idea thoughts alone) is not rebuilt (below the compile's minimum) and stays
-- withheld. Private revisions never reach the thoughts the compile reads.
-- Rounds 3-4's text matching is gone with this rule: the 8-word windows (idea_privacy_shingles), the short-text table
-- (idea_privacy_whole), the normalisation and the trigger that taught every new revision's text.
DROP TRIGGER IF EXISTS trg_idea_privacy_learn ON public.idea_revisions;
DROP FUNCTION IF EXISTS public.trg_idea_privacy_learn();
DROP FUNCTION IF EXISTS public.idea_privacy_learn(TEXT);
DROP FUNCTION IF EXISTS public.idea_privacy_page_shows_idea(TEXT, TEXT, JSONB);         -- round 2's (slug, body, links)
DROP FUNCTION IF EXISTS public.idea_privacy_page_shows_idea(TEXT, TEXT, TEXT, JSONB);   -- rounds 3-4's text matcher
DROP FUNCTION IF EXISTS public.idea_privacy_windows(TEXT);
DROP FUNCTION IF EXISTS public.idea_privacy_norm(TEXT);
DROP TABLE IF EXISTS public.idea_privacy_shingles;
DROP TABLE IF EXISTS public.idea_privacy_whole;

-- rw-privacy-hardening (slot 430): the rule below is the one slot 430 installs on a database that ran this file before it
-- (case-insensitive, %2F decoded; a withheld row says so in a response header; a refused note names neither guard).
-- Kept identical here so that a fresh volume, and a re-run of this file after 430, do not put the older bodies back.
CREATE OR REPLACE FUNCTION public.idea_privacy_linked_thought_ids(p_slug TEXT, p_title TEXT, p_body TEXT, p_links JSONB)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(array_agg(DISTINCT m[1]), ARRAY[]::text[])
      FROM regexp_matches(
               regexp_replace(
                   coalesce(p_slug, '') || ' ' || coalesce(p_title, '') || ' ' || coalesce(p_body, '') || ' ' || coalesce(p_links::text, ''),
                   '%2[fF]', '/', 'g'),
               '(?:^|[^[:alnum:]])thought/([0-9]+)(?![0-9])', 'gi') AS m;
$$;
REVOKE ALL ON FUNCTION public.idea_privacy_linked_thought_ids(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.idea_privacy_page_links_idea(p_slug TEXT, p_title TEXT, p_body TEXT, p_links JSONB)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.idea_thought_archive a
         WHERE a.id::text = ANY (public.idea_privacy_linked_thought_ids(p_slug, p_title, p_body, p_links)));
$$;
REVOKE ALL ON FUNCTION public.idea_privacy_page_links_idea(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;

-- the guard: the idea's leaf or a link to it is not written back - on INSERT and on any UPDATE of a page's slug, title,
-- body or links, by any role (the viewer's reconcile repairing a row from its vault file, a compile, an app role's
-- UPDATE or PostgREST PATCH). It refuses the leaf and the link, not the page: a rebuilt page with no link to the idea
-- goes through. A compiled or reconciled page is skipped silently (RETURN NULL: one bad row must not fail the compile's
-- whole batch; the wiki writer learns it was withheld - recipes/_shared/wiki-pages.mjs - and leaves its file out; an
-- UPDATE leaves the row as it was); a NOTE is a person's own writing saved through the workbench, so it is refused out
-- loud instead
CREATE OR REPLACE FUNCTION public.wiki_guard_mark_withheld()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE n INT;
BEGIN
    n := coalesce(nullif(current_setting('ob.wiki_withheld', true), ''), '0')::int + 1;
    PERFORM set_config('ob.wiki_withheld', n::text, true);
    PERFORM set_config('response.headers', json_build_array(json_build_object('X-Wiki-Withheld', n::text))::text, true);
END;
$$;
REVOKE ALL ON FUNCTION public.wiki_guard_mark_withheld() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.trg_idea_privacy_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.idea_privacy_page_links_idea(NEW.slug, NEW.title, NEW.body, NEW.links) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page cannot be saved' USING ERRCODE = '42501';
        END IF;
        PERFORM public.wiki_guard_mark_withheld();
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
    SELECT w.slug FROM public.wiki_pages w WHERE public.idea_privacy_page_links_idea(w.slug, w.title, w.body, w.links);
    SELECT count(*) INTO n_scope FROM _idea_pages;
    IF n_scope = 0 THEN
        RAISE NOTICE 'idea privacy: no wiki page presents an idea - nothing to withhold';
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
    SELECT count(*) INTO n_left FROM public.wiki_pages w WHERE public.idea_privacy_page_links_idea(w.slug, w.title, w.body, w.links);
    IF n_left <> 0 OR n_deleted <> n_scope OR n_archived <> n_deleted THEN
        RAISE EXCEPTION 'idea privacy: refused, nothing changed - % wiki page(s) present an idea, % archived, % withheld, % left',
            n_scope, n_archived, n_deleted, n_left USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'idea privacy: % wiki page(s) that presented an idea (its leaf, or linking it) archived and withheld (move their vault files out: the deploy step; the next compile rebuilds the general ones)',
        n_deleted;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
