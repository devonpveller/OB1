-- check-private-report-claims-withheld.sql - slot 660 (init-private-report-claims-withheld.sql, research-workbench
-- rw-withheld-owner-view): is slot 660 in place, and does the own-sentence check refuse exactly the owners party to a
-- withheld claim? Read-only on the data (it calls the STABLE check and creates one pg_temp helper, gone with the session);
-- counts only, never a text, an id or a subject.
--   psql -X -A -t -q -f check-private-report-claims-withheld.sql
-- Lines "withheld: <what>=<value>", then "withheld: OK" or "withheld: FAIL". OK = slot 570 applied, slot 660 applied and
-- in place (a 570 re-run puts 570's own_text_shows back: re-run 660), neither function granted to anyone, every owner
-- party to a withheld claim refused for its sentence, and a subject party to nothing refused for none.
-- (before slot 570 the functions it calls do not exist: the query runs only once they do)
CREATE OR REPLACE FUNCTION pg_temp.prcw_lines() RETURNS SETOF TEXT
LANGUAGE plpgsql VOLATILE
AS $f$
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL
       OR to_regprocedure('public.private_report_claims_own_text_shows(text,text,text)') IS NULL
       OR to_regprocedure('public.private_report_claim_subject_ok(text)') IS NULL
       OR to_regprocedure('public.private_report_claim_norm(text)') IS NULL THEN
        RETURN NEXT 'withheld: slot 570 applied=false';
        RETURN NEXT 'withheld: slot 660 applied=' || (to_regprocedure('public.private_report_claims_withheld_of(text)') IS NOT NULL);
        RETURN NEXT 'withheld: FAIL';
        RETURN;
    END IF;
    RETURN QUERY EXECUTE $q$
WITH
s570 AS (SELECT to_regclass('public.private_report_claims_archive') IS NOT NULL
                AND to_regprocedure('public.private_report_claims_own_text_shows(text,text,text)') IS NOT NULL AS applied),
s660 AS (
    SELECT to_regprocedure('public.private_report_claims_withheld_of(text)') IS NOT NULL AS applied,
           coalesce((SELECT p.prosrc LIKE '%private_report_claims_withheld_of(p_sub)%' FROM pg_proc p
                      WHERE p.oid = to_regprocedure('public.private_report_claims_own_text_shows(text,text,text)')), false) AS in_place),
-- a grant to anyone but the owner and superusers (PUBLIC included) on either function
grants AS (
    SELECT count(*) AS n FROM pg_proc p, aclexplode(p.proacl) a LEFT JOIN pg_roles ro ON ro.oid = a.grantee
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('private_report_claims_withheld_of', 'private_report_claims_own_text_shows')
       AND a.grantee <> p.proowner AND (a.grantee = 0 OR NOT ro.rolsuper)),
-- the (withheld claim, owner) pairs 570's data names: an x row not restored, linked to a valid owner's private report
pairs AS MATERIALIZED (
    SELECT DISTINCT a.ref, p.owner_sub, a.row_data ->> 'text' AS text
      FROM public.private_report_claims_archive a
      JOIN public.research_private_report_claims pc ON pc.claim_id::text = a.ref
      JOIN public.research_private_reports p ON p.id = pc.report_id
     WHERE (SELECT applied FROM s570) AND a.action = 'x' AND a.restored_at IS NULL
       AND public.private_report_claim_subject_ok(p.owner_sub)
       AND length(public.private_report_claim_norm(a.row_data ->> 'text')) >= 24),
withheld AS MATERIALIZED (
    SELECT DISTINCT a.ref, a.row_data ->> 'text' AS text FROM public.private_report_claims_archive a
     WHERE (SELECT applied FROM s570) AND a.action = 'x' AND a.restored_at IS NULL
       AND length(public.private_report_claim_norm(a.row_data ->> 'text')) >= 24),
counts AS (
    SELECT (SELECT applied FROM s570) AS s570, (SELECT applied FROM s660) AS s660, (SELECT in_place FROM s660) AS in_place,
           (SELECT n FROM grants) AS grants,
           (SELECT count(*) FROM withheld) AS withheld,
           (SELECT count(DISTINCT ref) FROM pairs) AS with_party,
           (SELECT count(*) FROM pairs) AS pairs,
           (SELECT count(DISTINCT owner_sub) FROM pairs) AS owners,
           -- a withheld claim one valid owner alone is party to: 570 would have moved it (shown, not a FAIL: a report removed since)
           (SELECT count(*) FROM (SELECT ref FROM pairs GROUP BY ref HAVING count(DISTINCT owner_sub) = 1) z) AS one_party,
           (SELECT count(*) FROM pairs pr WHERE (SELECT in_place FROM s660)
               AND NOT public.private_report_claims_own_text_shows(pr.owner_sub, '', pr.text)) AS party_not_refused,
           -- a subject party to nothing: a fresh random subject (valid in shape, so the check judges it; no report and no
           -- store row names it) - the third user, who must be refused for no withheld claim
           (SELECT count(*) FROM withheld w WHERE (SELECT applied FROM s570)
               AND public.private_report_claims_own_text_shows('withheld-check-' || md5(random()::text), '', w.text)) AS stranger_refused)
SELECT line FROM (
    SELECT 1 AS o, 'withheld: slot 570 applied=' || s570 AS line FROM counts
    UNION ALL SELECT 2, 'withheld: slot 660 applied=' || s660 || ' (the own-sentence check reads private_report_claims_withheld_of(p_sub)=' || in_place
                        || CASE WHEN s660 AND NOT in_place THEN ': a 570 re-run put 570''s own_text_shows back - re-run 660' ELSE '' END || ')' FROM counts
    UNION ALL SELECT 3, 'withheld: grants on the two functions to anyone but their owner=' || grants FROM counts
    UNION ALL SELECT 4, 'withheld: withheld claims (24+ letters)=' || withheld || ', with an owner party to them=' || with_party
                        || ' (owner-claim pairs=' || pairs || ', owners=' || owners || ', one owner alone=' || one_party || ')' FROM counts
    UNION ALL SELECT 5, 'withheld: owner-claim pairs the own-sentence check does not refuse=' || party_not_refused FROM counts
    UNION ALL SELECT 6, 'withheld: withheld claims refused for a subject party to nothing=' || stranger_refused FROM counts
    UNION ALL SELECT 9, CASE WHEN s570 AND s660 AND in_place AND grants = 0 AND party_not_refused = 0 AND stranger_refused = 0
                             THEN 'withheld: OK' ELSE 'withheld: FAIL' END FROM counts
) x ORDER BY o
$q$;
END;
$f$;
SELECT l FROM pg_temp.prcw_lines() l;
