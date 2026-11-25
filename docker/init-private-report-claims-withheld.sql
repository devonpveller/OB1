-- ============================================================
-- Slot 660: a claim slot 570 WITHHELD because two users' private reports both hold it stays its owners' own sentence for
-- the author-only note check (research-workbench rw-withheld-owner-view; continues rw-570-hub-note-scope, its F2).
-- A FORWARD migration on top of slot 570 (init-private-report-claims.sql) and independent of 575: 570's and 575's files
-- stay as they ran; this slot replaces one 570 function and adds one helper.
--   * THE GAP. 570's private_report_claims_own_text_shows(sub, title, body) - the author-only predicate the wiki guard
--     asks for a person's note (notes/...) and a structured note (content/notebooks/<nb>/<note>, slot 575), and that
--     575's private_report_claims_note_refused asks for the workbench's POST /workbench/notes (422) - read only the
--     subject's OWN STORE (inlet_private_claims rows of that subject a private report links). A claim 570 withheld
--     (several owners: two users' private reports produced the same text; the archive's 'x' row, read by nobody) is in
--     nobody's store, so neither of its owners was refused for quoting it, while a one-owner claim refuses its owner.
--   * WHO IS PARTY. 570 keeps a withheld claim's links: research_private_report_claims(report_id, claim_id) is not
--     deleted (570 drops only the link's foreign key onto public.claims), and research_private_reports.owner_sub names
--     each report's owner. So a subject is party to a withheld claim exactly when one of THAT SUBJECT's private reports
--     links it and the subject may own a private row (570's private_report_claim_subject_ok: the rule 570 used to count
--     the claim's owners). The archive's 'e' rows are the claim's claim_sources edges (source / parent claim): they name
--     no report and no owner, and are not read. A withheld claim with no valid owner (its reports' owner_sub NULL or not
--     a valid subject) has nobody party; a claim 570 or 575 withheld that a private report never linked (570's
--     "duplicate" rule, 575's fragments: a shared claim carrying, or inside, a private sentence) has nobody party either.
--   * THE CHANGE. private_report_claims_withheld_of(sub): the texts of the withheld claims (an 'x' row not restored) the
--     subject is party to; nothing for anyone else, nothing for a blank or invalid subject. own_text_shows reads the
--     subject's store (570's branch, unchanged) UNION those texts, with 570's match (the skeleton, 24+ letters). Its two
--     callers (570's / 575's wiki guard, 575's note_refused) change nothing: the same name, signature, owner and ACL.
--   * THE RULE IT KEEPS (A1, the existence-oracle rule; the operator's second ruling 2026-11-24): only the WRITER's own
--     sentences refuse a note. A third user quoting the withheld sentence is not party: their note saves exactly as a
--     sentence nobody holds would. Nothing is moved or restored into any store; the archive stays readable by no app role
--     (the helper is not SECURITY DEFINER and is granted to nobody: only the definer functions above reach it).
-- LOCKS: none on any public table - no row is written, no table, column, constraint, index or trigger is created, altered
-- or dropped; CREATE OR REPLACE FUNCTION locks only the function's catalog row. Re-runnable (a second run is the same).
-- Fresh volume: initdb runs it after 570 / 575 / 600 (660 sorts after them, and after the in-flight 580 / 610 / 620 / 630 /
-- 640 / 650, none of which defines a function this slot replaces or reads). Live: psql -f AFTER 570 (and 575), no window
-- needed (no data moves); RE-RUN IT AFTER ANY 570 RE-RUN (570 puts its own own_text_shows back - the check says so).
-- Revert: revert-private-report-claims-withheld.sql FIRST, then (if ever) 575's, then 570's. Check:
-- check-private-report-claims-withheld.sql.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;

DO $$
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL
       OR to_regclass('public.research_private_report_claims') IS NULL
       OR to_regclass('public.research_private_reports') IS NULL
       OR to_regclass('public.inlet_private_claims') IS NULL
       OR to_regprocedure('public.private_report_claims_own_text_shows(text,text,text)') IS NULL
       OR to_regprocedure('public.private_report_claim_norm(text)') IS NULL
       OR to_regprocedure('public.private_report_claim_subject_ok(text)') IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_private_report_claims_wiki_guard' AND tgrelid = to_regclass('public.wiki_pages')) THEN
        RAISE EXCEPTION 'private report claims withheld: refused, nothing changed - slot 570 (init-private-report-claims.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
END $$;

-- the withheld claims a subject is party to: an 'x' row of 570's archive (or 575's: same code) not restored, whose claim
-- one of the subject's own private reports links; the subject a valid owner (570's rule). Its caller's privileges (the
-- definer function below); granted to nobody.
CREATE OR REPLACE FUNCTION public.private_report_claims_withheld_of(p_sub TEXT) RETURNS TABLE (claim_id UUID, text TEXT)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT DISTINCT pc.claim_id, a.row_data ->> 'text'
      FROM public.research_private_reports p
      JOIN public.research_private_report_claims pc ON pc.report_id = p.id
      JOIN public.private_report_claims_archive a ON a.action = 'x' AND a.restored_at IS NULL AND a.ref = pc.claim_id::text
     WHERE p.owner_sub = p_sub
       AND public.private_report_claim_subject_ok(p_sub)
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_withheld_of(TEXT) FROM PUBLIC;

-- slot 660: does this text carry the private-report claim of ONE given subject? The subject's own store (570's branch)
-- and the withheld claims the subject is party to (private_report_claims_withheld_of); nothing for a blank subject.
CREATE OR REPLACE FUNCTION public.private_report_claims_own_text_shows(p_sub TEXT, p_title TEXT, p_body TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH page AS (SELECT public.private_report_claim_norm(coalesce(p_title, '') || ' ' || coalesce(p_body, '')) AS t),
    own AS (
        SELECT c.text FROM public.inlet_private_claims c
         WHERE c.inlet_owner_sub = p_sub
           AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
        UNION ALL
        SELECT w.text FROM public.private_report_claims_withheld_of(p_sub) w)
    SELECT coalesce(btrim(p_sub), '') <> '' AND EXISTS (
        SELECT 1 FROM own o, page
         WHERE length(public.private_report_claim_norm(o.text)) >= 24
           AND position(public.private_report_claim_norm(o.text) IN page.t) > 0)
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_own_text_shows(TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$
DECLARE f TEXT; r RECORD;
BEGIN
    -- the schema's default privileges hand new functions to the app roles: take those back (570's rule)
    FOREACH f IN ARRAY ARRAY['public.private_report_claims_withheld_of(text)', 'public.private_report_claims_own_text_shows(text,text,text)'] LOOP
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE p.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> p.proowner LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f::regprocedure, r.grantee);
        END LOOP;
    END LOOP;
    -- counts only, never a text or an id
    RAISE NOTICE 'private report claims withheld: % withheld claim(s) with an owner party to them (% owner-claim pair(s)); % with nobody party',
        (SELECT count(DISTINCT a.ref) FROM public.private_report_claims_archive a
          WHERE a.action = 'x' AND a.restored_at IS NULL
            AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc JOIN public.research_private_reports p ON p.id = pc.report_id
                         WHERE pc.claim_id::text = a.ref AND public.private_report_claim_subject_ok(p.owner_sub))),
        (SELECT count(*) FROM (SELECT DISTINCT a.ref, p.owner_sub FROM public.private_report_claims_archive a
                                 JOIN public.research_private_report_claims pc ON pc.claim_id::text = a.ref
                                 JOIN public.research_private_reports p ON p.id = pc.report_id
                                WHERE a.action = 'x' AND a.restored_at IS NULL AND public.private_report_claim_subject_ok(p.owner_sub)) z),
        (SELECT count(DISTINCT a.ref) FROM public.private_report_claims_archive a
          WHERE a.action = 'x' AND a.restored_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc JOIN public.research_private_reports p ON p.id = pc.report_id
                             WHERE pc.claim_id::text = a.ref AND public.private_report_claim_subject_ok(p.owner_sub)));
END $$;
COMMENT ON FUNCTION public.private_report_claims_own_text_shows(TEXT, TEXT, TEXT) IS
  'rw-withheld-owner-view (slot 660): does the text carry a private-report claim of this ONE subject - their own store, or a claim slot 570 withheld that one of their own private reports links. Nothing for any other subject. Called by the wiki guard and private_report_claims_note_refused only.';
COMMENT ON FUNCTION public.private_report_claims_withheld_of(TEXT) IS
  'rw-withheld-owner-view (slot 660): the withheld claims (private_report_claims_archive x rows, not restored) one of this subject''s private reports links. Granted to nobody; read by private_report_claims_own_text_shows.';
COMMIT;
