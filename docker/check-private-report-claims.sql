-- check-private-report-claims.sql - rw-private-report-claims (slot 570): is any private-report claim still on a
-- shared surface? Read-only; prints counts and names only, never a claim's text or id.
--   psql -X -A -t -q -f check-private-report-claims.sql
-- Lines: "check: <what>=<count>" for each surface, then "check: OK" or "check: FAIL". A FAIL names the surface.
-- Surfaces: a claim a private report links that is in the SHARED table with no shared synthesis (the move's target set);
-- a shared edge of or onto such a claim; a private-report claim that is NOT in its report owner's store (or in someone
-- else's); a research job result naming one on a job its owner does not own; a wiki page carrying one's text; the two
-- guards and the dropped foreign key; who may execute the slot's functions (ob_app_memory / ob_workbench only).
WITH
slot AS (SELECT to_regclass('public.private_report_claims_archive') IS NOT NULL AS applied),
priv AS (
    SELECT c.id, c.inlet_owner_sub AS owner FROM public.inlet_private_claims c
     WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)),
shared_linked AS (
    SELECT c.id FROM public.claims c
     WHERE c.synthesis_id IS NULL AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)),
wrong_owner AS (
    SELECT p.id FROM priv p
     WHERE NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc JOIN public.research_private_reports r ON r.id = pc.report_id
                        WHERE pc.claim_id = p.id AND r.owner_sub = p.owner)),
all_priv AS (SELECT id FROM priv UNION SELECT id FROM shared_linked),
edges AS (
    SELECT cs.id FROM public.claim_sources cs
     WHERE cs.claim_id IN (SELECT id FROM all_priv) OR cs.parent_claim_id IN (SELECT id FROM all_priv)),
jobs AS (
    SELECT DISTINCT j.id FROM public.research_jobs j
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'claims') = 'array' THEN j.result -> 'claims' ELSE '[]'::jsonb END
                                              || CASE WHEN jsonb_typeof(j.result -> 'reuse_claims') = 'array' THEN j.result -> 'reuse_claims' ELSE '[]'::jsonb END) e
      JOIN priv p ON p.id::text = e ->> 'id'
     WHERE jsonb_typeof(j.result) = 'object'
       AND (SELECT o.owner_sub FROM public.research_job_report_owner(j.id) o LIMIT 1) IS DISTINCT FROM p.owner),
pages AS (
    SELECT w.slug FROM public.wiki_pages w, priv p JOIN public.inlet_private_claims c ON c.id = p.id
     WHERE length(lower(regexp_replace(btrim(c.text), '\s+', ' ', 'g'))) >= 24
       AND position(lower(regexp_replace(btrim(c.text), '\s+', ' ', 'g')) IN lower(regexp_replace(coalesce(w.title, '') || ' ' || coalesce(w.body, ''), '\s+', ' ', 'g'))) > 0),
corr AS (
    SELECT sc.id FROM public.source_corroborations sc
     WHERE sc.claim_text NOT LIKE 'private-text:%'
       AND (EXISTS (SELECT 1 FROM public.research_job_report_owner(sc.job_id))
            OR EXISTS (SELECT 1 FROM public.research_private_reports p WHERE p.job_id = sc.job_id))),
fk AS (
    SELECT count(*) AS n FROM pg_constraint con
     WHERE con.conrelid = 'public.research_private_report_claims'::regclass AND con.contype = 'f' AND con.confrelid = 'public.claims'::regclass),
guards AS (
    SELECT count(*) AS n FROM pg_trigger
     WHERE tgname IN ('trg_private_report_claims_wiki_guard', 'trg_private_report_claims_link_guard', 'trg_private_report_claims_corroboration_guard')
       AND NOT tgisinternal AND tgenabled <> 'D'),
grants AS (
    SELECT p.proname || '(' || r.rolname || ')' AS g
      FROM pg_proc p JOIN pg_roles r ON has_function_privilege(r.oid, p.oid, 'EXECUTE')
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('private_report_claim_file', 'private_report_claim_edge', 'private_report_claims_of_idea')
       AND NOT r.rolsuper AND r.rolname !~ '^pg_'
       AND NOT (r.rolname = 'ob_app_memory' OR (r.rolname = 'ob_workbench' AND p.proname = 'private_report_claims_of_idea'))),
counts AS (
    SELECT (SELECT count(*) FROM shared_linked) AS shared_linked,
           (SELECT count(*) FROM edges) AS shared_edges,
           (SELECT count(*) FROM wrong_owner) AS wrong_owner,
           (SELECT count(*) FROM jobs) AS job_results,
           (SELECT count(DISTINCT slug) FROM pages) AS wiki_pages,
           (SELECT count(*) FROM corr) AS corr_lines,
           (SELECT n FROM fk) AS link_fk,
           (SELECT n FROM guards) AS guards,
           (SELECT count(*) FROM grants) AS stray_grants,
           (SELECT count(*) FROM priv) AS private_store)
SELECT line FROM (
    SELECT 1 AS o, 'check: slot 570 applied=' || (SELECT applied FROM slot) AS line
    UNION ALL SELECT 2, 'check: private-report claims in their owner''s store=' || private_store FROM counts
    UNION ALL SELECT 3, 'check: private-report claims in the shared table=' || shared_linked FROM counts
    UNION ALL SELECT 4, 'check: shared edges of or onto them=' || shared_edges FROM counts
    UNION ALL SELECT 5, 'check: in a store not their report owner''s=' || wrong_owner FROM counts
    UNION ALL SELECT 6, 'check: job results naming one for someone else=' || job_results FROM counts
    UNION ALL SELECT 7, 'check: wiki pages carrying one''s text=' || wiki_pages FROM counts
    UNION ALL SELECT 7, 'check: corroboration lines of a private report''s run in the clear=' || corr_lines FROM counts
    UNION ALL SELECT 8, 'check: the link''s foreign key onto claims=' || link_fk || ' (0 once applied)' FROM counts
    UNION ALL SELECT 9, 'check: guards on=' || guards || ' (3 once applied)' FROM counts
    UNION ALL SELECT 10, 'check: stray EXECUTE grants=' || stray_grants FROM counts
    UNION ALL SELECT 11, 'check: stray grant ' || g FROM grants
    UNION ALL SELECT 12, CASE WHEN shared_linked = 0 AND shared_edges = 0 AND wrong_owner = 0 AND job_results = 0 AND wiki_pages = 0 AND corr_lines = 0
                               AND link_fk = 0 AND guards = 3 AND stray_grants = 0 AND (SELECT applied FROM slot)
                              THEN 'check: OK' ELSE 'check: FAIL' END FROM counts
) x ORDER BY o;
