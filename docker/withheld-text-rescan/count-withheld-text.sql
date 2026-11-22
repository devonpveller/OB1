-- The size of the withheld-text rescan (research-workbench rw-withheld-text-rescan), READ ONLY: how many stored
-- wiki_pages rows 440's text rule (public.inlet_owner_text_withheld, unchanged) answers true for, per page class, with
-- the slugs' md5 prefixes. Counts and hashes only - never a title, body or slug. Writes nothing (BEGIN READ ONLY; a
-- write anywhere in it would be refused by the server).
--   psql -X -U postgres -d openbrain -f count-withheld-text.sql
-- Cost: the rule over every row (live 2026-11-21: 67,864 rows, ~250 MB of body, 20 min 48 s); it holds one
-- snapshot for that long and takes no lock a writer waits on.
\set ON_ERROR_STOP on
\pset footer off
BEGIN READ ONLY;
SELECT current_setting('transaction_read_only') AS read_only,
       (SELECT count(*) FROM public.inlet_owner_withheld_pages) AS withheld_pages_in_store,
       to_regclass('public.inlet_owner_rescan_runs') IS NOT NULL AS rescan_ran_before;
WITH r AS (
    SELECT w.page_class, w.slug, public.inlet_owner_text_withheld(w.body) AS flagged FROM public.wiki_pages w
)
SELECT coalesce(page_class, '(all)') AS page_class, count(*) AS rows_total, count(*) FILTER (WHERE flagged) AS rows_flagged,
       coalesce(string_agg(left(md5(slug), 12), ' ' ORDER BY md5(slug)) FILTER (WHERE flagged), '') AS flagged_slug_md5
  FROM r GROUP BY ROLLUP (page_class) ORDER BY grouping(page_class), page_class;
ROLLBACK;
