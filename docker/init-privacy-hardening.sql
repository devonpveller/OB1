-- ============================================================
-- Privacy hardening: the follow-ups of slots 380, 390 and 400 (research-workbench rw-privacy-hardening). Slot 430.
-- A FORWARD migration: slots 380 and 390 are live and are not edited. This file replaces what they created (functions
-- only) and repairs what the 390 move did. Needs 380 and 390 applied (the chain order: 380, 390, 400, 430).
--
--   390-F1  the linkage relabel also relabelled a source whose label is the name (any case) of a thread OUTSIDE the move's
--           tie set - a notebook the move never touched. Repaired: such a source gets its own label back (the 390 archive
--           holds it).
--   390-F2  the relabel and its fail-closed check compared names with `=` and read only sources.notebook. The notebook
--           backfill reads sources.notebook AND thoughts.metadata.notebook case-insensitively, so a case variant of a tied
--           thread's old name would bring that name back as a new thread. Repaired: lower() on both sides, and the
--           thoughts' metadata.notebook as well (the same neutral label).
--   380     (a) the wiki guard matched `thought/<id>` case-sensitively and without decoding %2F: [[Thought/9]] and
--               thought%2F9 are links the viewer resolves, and the guard let them in. Now case-insensitive, %2F decoded.
--           (b) "withheld" was inferred from "the row is not in the answer". A later RLS policy on wiki_pages would hide
--               ordinary rows the same way, and the compiler would delete their files. Now the guards (380's and 390's) say
--               so themselves: every row they withhold bumps a counter that PostgREST returns as the response header
--               X-Wiki-Withheld (recipes/_shared/wiki-pages.mjs reads it); a missing row nobody withheld is "hidden", an
--               unsynced page whose file is KEPT.
--           (c) R3, the oracle: a note save refused for linking an idea said so ("this page links an idea"), and a note
--               citing a private report said that. Both guards now refuse a note with one message that names neither.
--           (d) R4, erasure: purging an idea (DELETE FROM ideas) removes its rows from idea_thought_archive (the archived
--               thought text, with the idea id and owner it already carries) and the archived wiki pages that linked those
--               thoughts, so nothing is withheld on the idea's behalf any more and the next compile writes those pages
--               again. Archived rows of an idea that is already gone are removed by this file (not restorable: erasure).
--   400-A4  is code (the workbench's settingsAdmin), not SQL.
--   390-F3  is the revert of 390 (revert-report-isolation.sql), not SQL here.
--
-- One transaction: a failed check leaves everything as it was. Re-run: nothing left to repair, the functions are replaced
-- by themselves. After any re-run of 380 or 390 (their CREATE OR REPLACE puts the old function bodies back), run this
-- file again. Revert: revert-privacy-hardening.sql, BEFORE the 390 and 380 reverts.
-- Fresh-volume slot 430 (an empty database: nothing to repair); live: psql -f after a fresh backup.
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = warning;
SET LOCAL lock_timeout = '10s';   -- as 380 and 390: a held table stops the run, nothing changed

DO $$
BEGIN
    IF to_regclass('public.idea_thought_archive') IS NULL OR to_regclass('public.research_report_isolation_archive') IS NULL THEN
        RAISE EXCEPTION 'privacy hardening: slots 380 and 390 must be applied first (idea_thought_archive / research_report_isolation_archive missing)'
            USING ERRCODE = '55000';
    END IF;
END $$;

-- what this file changed in data, as it was (the revert's source). Readable by no app role: it holds notebook labels.
CREATE TABLE IF NOT EXISTS public.privacy_hardening_archive (
    id          BIGSERIAL PRIMARY KEY,
    fix         TEXT NOT NULL,           -- 'f1' | 'f2-source' | 'f2-thought'
    tbl         TEXT NOT NULL,
    row_key     TEXT NOT NULL,           -- the changed row's id
    before_val  TEXT,                    -- the notebook label before this file
    after_val   TEXT,                    -- the label this file wrote
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at TIMESTAMPTZ
);
ALTER TABLE public.privacy_hardening_archive ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r RECORD;
BEGIN
    REVOKE ALL ON public.privacy_hardening_archive FROM PUBLIC;
    REVOKE ALL ON SEQUENCE public.privacy_hardening_archive_id_seq FROM PUBLIC;
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid IN ('public.privacy_hardening_archive'::regclass, 'public.privacy_hardening_archive_id_seq'::regclass)
                AND NOT ro.rolsuper AND ro.oid <> c.relowner LOOP
        EXECUTE format('REVOKE ALL ON public.privacy_hardening_archive FROM %I', r.grantee);
        EXECUTE format('REVOKE ALL ON SEQUENCE public.privacy_hardening_archive_id_seq FROM %I', r.grantee);
    END LOOP;
END $$;

-- ── 380: the link rule, case-insensitive with %2F decoded (and one place for it) ──────────────────────────────────
-- Every `thought/<digits>` link form in a page's slug, title, body and links, with the id ending there. [[Thought/9]],
-- (THOUGHT/9) and thought%2F9 are the same link to the viewer; `afterthought/9` and `thought/90` are not.
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

-- ── 380: "withheld by a guard" is said by the guard, not inferred from a missing row ───────────────────────────────
-- PostgREST returns whatever the request's transaction sets in the `response.headers` setting. Each withheld row adds
-- one to the count; the writer compares the count with the rows missing from its answer.
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

-- R3: a refused NOTE says only that it was refused - never which guard, never "an idea" or "a report".
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

CREATE OR REPLACE FUNCTION public.trg_report_isolation_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.report_isolation_page_shows_report(NEW.slug, NEW.body, NEW.links) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page cannot be saved' USING ERRCODE = '42501';
        END IF;
        PERFORM public.wiki_guard_mark_withheld();
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_report_isolation_wiki_guard() FROM PUBLIC;

-- ── 380-R4: purging an idea erases what withholds on its behalf ───────────────────────────────────────────────────
-- idea_thought_archive carries archive_idea_id and archive_owner_sub (slot 380). The archived pages that linked the
-- idea's thoughts go with them (they hold the idea's text); the live pages were withheld, so nothing else moves.
CREATE OR REPLACE FUNCTION public.trg_idea_privacy_forget_idea()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE ids TEXT[];
BEGIN
    IF to_regclass('public.idea_thought_archive') IS NULL THEN RETURN OLD; END IF;
    SELECT coalesce(array_agg(a.id::text), ARRAY[]::text[]) INTO ids FROM public.idea_thought_archive a WHERE a.archive_idea_id = OLD.id;
    IF cardinality(ids) = 0 THEN RETURN OLD; END IF;
    IF to_regclass('public.idea_wiki_archive') IS NOT NULL THEN
        DELETE FROM public.idea_wiki_archive w
         WHERE public.idea_privacy_linked_thought_ids(w.slug, w.title, w.body, w.links) && ids;
    END IF;
    DELETE FROM public.idea_thought_archive a WHERE a.archive_idea_id = OLD.id;
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_idea_privacy_forget_idea() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_idea_privacy_forget_idea ON public.ideas;
CREATE TRIGGER trg_idea_privacy_forget_idea AFTER DELETE ON public.ideas
    FOR EACH ROW EXECUTE FUNCTION public.trg_idea_privacy_forget_idea();

-- ── the data: 390-F1, 390-F2 and the archives of ideas that are already gone ───────────────────────────────────────
SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    n_orphans INT; n_f1 INT := 0; n_f2s INT := 0; n_f2t INT := 0; v_left INT; ids TEXT[];
BEGIN
    -- R4, ideas already purged: their archived rows go now (counts only)
    SELECT coalesce(array_agg(a.id::text), ARRAY[]::text[]), count(*) INTO ids, n_orphans
      FROM public.idea_thought_archive a
     WHERE a.archive_idea_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = a.archive_idea_id);
    IF n_orphans > 0 THEN
        DELETE FROM public.idea_wiki_archive w
         WHERE public.idea_privacy_linked_thought_ids(w.slug, w.title, w.body, w.links) && ids;
        DELETE FROM public.idea_thought_archive a
         WHERE a.archive_idea_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = a.archive_idea_id);
    END IF;

    -- the 390 tie set: every thread the move (a batch the revert has not restored) renamed
    CREATE TEMP TABLE _ph_tied ON COMMIT DROP AS
    SELECT DISTINCT t.id
      FROM public.research_report_isolation_archive a JOIN public.threads t ON t.id::text = a.row_data ->> 'id'
     WHERE a.action = 't' AND a.tbl = 'public.threads' AND a.restored_at IS NULL;

    -- F1: a source the move relabelled although its label is the name (any case) of a thread outside the tie set
    CREATE TEMP TABLE _ph_f1 ON COMMIT DROP AS
    SELECT s.id AS source_id, a.row_data ->> 'notebook' AS before_val, a.row_data ->> 'relabelled_to' AS after_val
      FROM public.research_report_isolation_archive a JOIN public.sources s ON s.id::text = a.row_data ->> 'id'
     WHERE a.action = 'b' AND a.restored_at IS NULL
       AND s.notebook IS NOT DISTINCT FROM a.row_data ->> 'relabelled_to'
       AND EXISTS (SELECT 1 FROM public.threads o
                    WHERE o.id NOT IN (SELECT id FROM _ph_tied) AND lower(o.name) = lower(a.row_data ->> 'notebook'));
    INSERT INTO public.privacy_hardening_archive (fix, tbl, row_key, before_val, after_val)
    SELECT 'f1', 'public.sources', source_id::text, after_val, before_val FROM _ph_f1;   -- (archive: the label BEFORE this file = the move's, the label it WROTE = the source's own)
    PERFORM set_config('session_replication_role', 'replica', true);   -- as 390: no touch trigger, no updated_at
    UPDATE public.sources s SET notebook = f.before_val FROM _ph_f1 f WHERE s.id = f.source_id;
    GET DIAGNOSTICS n_f1 = ROW_COUNT;
    PERFORM set_config('session_replication_role', 'origin', true);

    -- F2: every name a tied thread carried that the stack recorded (its name before the move, each tied job's curator
    -- answer), compared with lower(); sources.notebook and thoughts.metadata.notebook
    CREATE TEMP TABLE _ph_names ON COMMIT DROP AS
    SELECT DISTINCT x.thread_id, x.name FROM (
        SELECT (a.row_data ->> 'id')::uuid AS thread_id, a.row_data ->> 'name' AS name
          FROM public.research_report_isolation_archive a
         WHERE a.action = 't' AND a.tbl = 'public.threads' AND a.restored_at IS NULL
        UNION ALL
        SELECT t.id, j.result -> 'curator' ->> 'thread_name'
          FROM public.research_jobs j JOIN _ph_tied t ON t.id::text = j.result -> 'curator' ->> 'thread_id'
        UNION ALL
        SELECT t.id, j.result -> 'curator' ->> 'thread_name'
          FROM public.research_job_events e JOIN _ph_tied t ON t.id::text = e.payload ->> 'thread_id'
          JOIN public.research_jobs j ON j.id = e.job_id
         WHERE e.type = 'filed') x
     WHERE coalesce(x.name, '') <> '' AND EXISTS (SELECT 1 FROM public.threads th WHERE th.id = x.thread_id);
    -- the name of a thread outside the tie set is a real notebook: its label stays (F1's rule, applied here too)
    DELETE FROM _ph_names n
     WHERE EXISTS (SELECT 1 FROM public.threads o WHERE o.id NOT IN (SELECT id FROM _ph_tied) AND lower(o.name) = lower(n.name));
    CREATE TEMP TABLE _ph_f2s ON COMMIT DROP AS
    SELECT DISTINCT ON (s.id) s.id AS source_id, s.notebook AS before_val, 'Research thread ' || left(n.thread_id::text, 8) AS after_val
      FROM public.sources s JOIN _ph_names n ON lower(s.notebook) = lower(n.name)
     WHERE s.notebook IS DISTINCT FROM 'Research thread ' || left(n.thread_id::text, 8)
     ORDER BY s.id, n.thread_id;
    CREATE TEMP TABLE _ph_f2t ON COMMIT DROP AS
    SELECT DISTINCT ON (t.id) t.id AS thought_id, t.metadata ->> 'notebook' AS before_val, 'Research thread ' || left(n.thread_id::text, 8) AS after_val
      FROM public.thoughts t JOIN _ph_names n ON lower(t.metadata ->> 'notebook') = lower(n.name)
     WHERE t.metadata ->> 'notebook' IS DISTINCT FROM 'Research thread ' || left(n.thread_id::text, 8)
     ORDER BY t.id, n.thread_id;
    INSERT INTO public.privacy_hardening_archive (fix, tbl, row_key, before_val, after_val)
    SELECT 'f2-source', 'public.sources', source_id::text, before_val, after_val FROM _ph_f2s
    UNION ALL SELECT 'f2-thought', 'public.thoughts', thought_id::text, before_val, after_val FROM _ph_f2t;
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.sources s SET notebook = f.after_val FROM _ph_f2s f WHERE s.id = f.source_id;
    GET DIAGNOSTICS n_f2s = ROW_COUNT;
    UPDATE public.thoughts t SET metadata = jsonb_set(t.metadata, '{notebook}', to_jsonb(f.after_val::text)) FROM _ph_f2t f WHERE t.id = f.thought_id;
    GET DIAGNOSTICS n_f2t = ROW_COUNT;
    PERFORM set_config('session_replication_role', 'origin', true);

    -- fail closed: every F1 source has its own label back, and no source or thought still carries a tied thread's old
    -- name (any case) unless that name is also a thread outside the tie set's (those names were left out above)
    SELECT (SELECT count(*) FROM _ph_f1 f JOIN public.sources s ON s.id = f.source_id WHERE s.notebook IS DISTINCT FROM f.before_val)
         + (SELECT count(*) FROM public.sources s JOIN _ph_names n ON lower(s.notebook) = lower(n.name)
             WHERE s.notebook IS DISTINCT FROM 'Research thread ' || left(n.thread_id::text, 8))
         + (SELECT count(*) FROM public.thoughts t JOIN _ph_names n ON lower(t.metadata ->> 'notebook') = lower(n.name)
             WHERE t.metadata ->> 'notebook' IS DISTINCT FROM 'Research thread ' || left(n.thread_id::text, 8))
      INTO v_left;
    IF v_left <> 0 THEN
        RAISE EXCEPTION 'privacy hardening: refused, nothing changed - % label(s) still wrong after the repair', v_left USING ERRCODE = '55000';
    END IF;
    RAISE NOTICE 'privacy hardening: % source label(s) given back (a thread outside the move); % source(s) and % thought(s) relabelled by lower(); % archived row(s) of purged ideas removed',
        n_f1, n_f2s, n_f2t, n_orphans;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
