-- Revert init-privacy-hardening.sql (rw-privacy-hardening, slot 430).
--   psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -f revert-privacy-hardening.sql
-- Run it BEFORE revert-report-isolation.sql and revert-idea-privacy.sql (their reverts drop the objects this file
-- replaced). It puts back:
--   * the three functions this file replaced (idea_privacy_page_links_idea, trg_idea_privacy_wiki_guard,
--     trg_report_isolation_wiki_guard) with the bodies slots 380 and 390 created;
--   * every notebook label this file changed, to what it was (sources.notebook, thoughts.metadata.notebook) - only where
--     the row still carries the label this file wrote; a row changed since is kept (counted);
-- and drops the new helper functions, the purge trigger on ideas and the archive table.
-- NOT restored: archived rows of an idea that was purged (that is erasure; the idea's text is not kept anywhere).
-- Runs twice cleanly (a second run finds nothing to do).
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL client_min_messages = warning;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS trg_idea_privacy_forget_idea ON public.ideas;
DROP FUNCTION IF EXISTS public.trg_idea_privacy_forget_idea();

-- the bodies slots 380 and 390 created (init-idea-privacy.sql, init-report-isolation.sql), only where the objects exist
DO $$
BEGIN
    IF to_regclass('public.idea_thought_archive') IS NOT NULL THEN
        EXECUTE $f$
CREATE OR REPLACE FUNCTION public.idea_privacy_page_links_idea(p_slug TEXT, p_title TEXT, p_body TEXT, p_links JSONB)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $g$
    SELECT EXISTS (
        SELECT 1 FROM public.idea_thought_archive a
         WHERE a.id::text IN (
             SELECT m[1] FROM regexp_matches(
                 coalesce(p_slug, '') || ' ' || coalesce(p_title, '') || ' ' || coalesce(p_body, '') || ' ' || coalesce(p_links::text, ''),
                 '(?:^|[^[:alnum:]])thought/([0-9]+)(?![0-9])', 'g') AS m));
$g$ $f$;
        EXECUTE $f$
CREATE OR REPLACE FUNCTION public.trg_idea_privacy_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $g$
BEGIN
    IF public.idea_privacy_page_links_idea(NEW.slug, NEW.title, NEW.body, NEW.links) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page links an idea, and an idea is private to its owner' USING ERRCODE = '42501';
        END IF;
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$g$ $f$;
    END IF;
    IF to_regprocedure('public.report_isolation_page_shows_report(text,text,jsonb)') IS NOT NULL THEN
        EXECUTE $f$
CREATE OR REPLACE FUNCTION public.trg_report_isolation_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $g$
BEGIN
    IF public.report_isolation_page_shows_report(NEW.slug, NEW.body, NEW.links) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page cites an idea''s private research report' USING ERRCODE = '42501';
        END IF;
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$g$ $f$;
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.idea_privacy_linked_thought_ids(TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.wiki_guard_mark_withheld();

SET LOCAL client_min_messages = notice;
DO $$
DECLARE
    n_src INT := 0; n_th INT := 0; n_kept INT := 0; n_all INT;
BEGIN
    IF to_regclass('public.privacy_hardening_archive') IS NULL THEN
        RAISE NOTICE 'privacy hardening revert: no archive (slot 430 never ran) - no label to restore';
        RETURN;
    END IF;
    SELECT count(*) INTO n_all FROM public.privacy_hardening_archive WHERE restored_at IS NULL;
    PERFORM set_config('session_replication_role', 'replica', true);
    UPDATE public.sources s SET notebook = a.before_val
      FROM public.privacy_hardening_archive a
     WHERE a.restored_at IS NULL AND a.tbl = 'public.sources' AND a.row_key = s.id::text
       AND s.notebook IS NOT DISTINCT FROM a.after_val;
    GET DIAGNOSTICS n_src = ROW_COUNT;
    UPDATE public.thoughts t SET metadata = CASE WHEN a.before_val IS NULL THEN t.metadata - 'notebook'
                                                 ELSE jsonb_set(t.metadata, '{notebook}', to_jsonb(a.before_val)) END
      FROM public.privacy_hardening_archive a
     WHERE a.restored_at IS NULL AND a.tbl = 'public.thoughts' AND a.row_key = t.id::text
       AND t.metadata ->> 'notebook' IS NOT DISTINCT FROM a.after_val;
    GET DIAGNOSTICS n_th = ROW_COUNT;
    PERFORM set_config('session_replication_role', 'origin', true);
    n_kept := n_all - n_src - n_th;
    DROP TABLE public.privacy_hardening_archive;
    RAISE NOTICE 'privacy hardening revert: % source label(s) and % thought label(s) restored, % kept (changed since)', n_src, n_th, n_kept;
END $$;
COMMIT;
NOTIFY pgrst, 'reload schema';
