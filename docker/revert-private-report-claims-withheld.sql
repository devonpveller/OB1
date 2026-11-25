-- ============================================================
-- Revert of slot 660 (init-private-report-claims-withheld.sql, research-workbench rw-withheld-owner-view).
--   * slot 570's private_report_claims_own_text_shows comes back byte for byte (the subject's own store only: a claim 570
--     withheld is again nobody's own sentence) - while 570's wiki guard is installed; when 570 was reverted already (its
--     revert drops the function) it is not left behind;
--   * the helper private_report_claims_withheld_of goes.
-- No row is written and no table is locked (the forward moved nothing). A second run is the same. Revert ORDER: this file
-- FIRST, then (if ever) revert-private-report-claims-scope.sql, then revert-private-report-claims.sql (570's revert run
-- alone drops own_text_shows; only the helper is then left, harmless and granted to nobody, and this file drops it).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;
-- (when 570 was reverted first, its helpers are gone: the body below is not resolved now, and the function is dropped)
SET LOCAL check_function_bodies = off;

-- fix item round 2 (A1, tester attempt 1): does this text carry the private-report claim of ONE given subject? (the
-- subject's own store only; nothing for a blank subject)
CREATE OR REPLACE FUNCTION public.private_report_claims_own_text_shows(p_sub TEXT, p_title TEXT, p_body TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH page AS (SELECT public.private_report_claim_norm(coalesce(p_title, '') || ' ' || coalesce(p_body, '')) AS t)
    SELECT coalesce(btrim(p_sub), '') <> '' AND EXISTS (
        SELECT 1 FROM public.inlet_private_claims c, page
         WHERE c.inlet_owner_sub = p_sub
           AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
           AND length(public.private_report_claim_norm(c.text)) >= 24
           AND position(public.private_report_claim_norm(c.text) IN page.t) > 0)
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_own_text_shows(TEXT, TEXT, TEXT) FROM PUBLIC;
COMMENT ON FUNCTION public.private_report_claims_own_text_shows(TEXT, TEXT, TEXT) IS NULL;
-- (only while slot 570 is installed: when 570 was reverted first, its function is not left behind)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_private_report_claims_wiki_guard' AND NOT tgisinternal) THEN
        DROP FUNCTION IF EXISTS public.private_report_claims_own_text_shows(TEXT, TEXT, TEXT);
        RAISE NOTICE 'private report claims withheld revert: slot 570 is not installed - its own-sentence check is not put back';
    ELSE
        RAISE NOTICE 'private report claims withheld revert: slot 570''s own-sentence check is back (the subject''s store only)';
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.private_report_claims_withheld_of(TEXT);
COMMIT;
