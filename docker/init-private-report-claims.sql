-- ============================================================
-- A claim drawn from a private report is private to the report's owner (research-workbench rw-private-report-claims).
-- Slot 570 (400-560 are taken or reserved).
-- Operator 2026-11-21: "any information generated from private data remains private since it could leak through a
-- generated series." This reverses slot 390's choice (init-report-isolation.sql: the claims of a private idea report
-- stayed SHARED, claims.synthesis_id NULL, linked back in research_private_report_claims). A claim's text is the
-- private report's own sentence, so the claim carries the report's words.
--
-- THE REPRESENTATION is PD1's (slot 440), reused, not a second one: a private claim lives in
-- public.inlet_private_claims (the claims table's own columns + inlet_owner_sub + inlet_batch), its edges in
-- public.inlet_private_claim_sources (owner_sub, the claim_sources row as it was). Nothing shared reads those stores
-- (forced RLS, no policy, no grant); every shared reader reads public.claims / public.claim_sources, so a claim that is
-- not there is excluded from contract/claims, search (text and vector), chunk context, timeline, quality, dependence,
-- references, neighbours, the wiki compile, the research service's reuse, the digest and MCP BY CONSTRUCTION - no
-- reader has to remember a filter. The owner reads them through their idea (private_report_claims_of_idea below) and
-- through slot 480's owner_private_claims (it reads inlet_private_claims by owner).
--
-- THE RULE keys on the REPORT being private, never on the job kind: a claim linked in research_private_report_claims
-- to any research_private_reports row (an idea job's today; any other private report a later slot files there, plan
-- 09's 'personal' runs included) is private, unless a SHARED synthesis also filed it (claims.synthesis_id set: the
-- same text in the same thread came out of a shared report too - shared knowledge, kept shared, counted as "mixed").
--   * one owner: the claim moves to that owner's store, with its own edges;
--   * no valid owner (the idea is gone: owner_sub NULL) or several owners (two users' private reports produced the same
--     text in the same thread): the claim leaves the shared table and is WITHHELD - archived only, read by nobody;
--   * every claim_sources edge of a moved claim, and every edge of a shared claim onto it (a 'contradicts' edge the
--     conflict detector drew, a parent edge), is archived, then deleted; every shared claim that loses an edge is
--     archived whole first (its confidence is recomputed when the edge goes);
--   * every research job result (result.claims / result.reuse_claims) that names a moved claim, on a job whose report
--     owner is not the claim's owner, loses that element (metrics.claims_reused follows); the (result, metrics) pair
--     is archived first;
--   * every wiki page whose text carries a private-report claim's text is archived and withheld, and a guard on
--     wiki_pages keeps such a page from being written back (the viewer's reconcile, a compile, an app role); a NOTE
--     is refused out loud with 430's one message;
--   * research_private_report_claims loses its foreign key onto public.claims (a link now names a private claim), and
--     a guard refuses linking a SHARED claim: a private report's claim is filed private, through
--     private_report_claim_file (the research curator's write).
--   * round 2 (tester attempt 1): the gap work of a shared tree that recalled a moved claim (a gap / inter-hub
--     branch's question, its steer, the gap event, the root's tree report and topic estimate) loses the claim's text
--     (archived first), and a guard keeps a new gap branch / steer / gap event from carrying it into a shared tree;
--     the wiki match is normalised on both sides (case, whitespace, citation markers, emphasis, link syntax); the
--     slot's functions are granted to service_role (ob_app_memory inherits it, whenever it is created) and gated in
--     the function to the services' login or a superuser session outside a PostgREST request; a live apply refuses
--     without ob_app_memory.
--   * fix item rw-private-report-claims-fix (operator decisions 2026-11-22; 570 was not applied live, so it is edited in
--     place):
--     A1 - the derived-question guard matches only the REQUESTER's own private claims (the hand-back's owner), never
--          another user's: whether some other user holds a claim with a given text changes nothing a requester sees.
--          It moved from research_jobs (which names no requester) to research_handbacks (which does: the boundary
--          writes the job and its hand-back in one transaction, and the hand-back names the job).
--     F2 - the gap guard rewrites only MACHINE-written gap work (gap / inter-hub branches, their steers, gap /
--          inter-hub events), matched by the private claim's ID only (a machine row that recalled a claim names it);
--          a human steer, its branch and its event are never rewritten, and no text a person typed is matched.
--     P2 - a SHARED synthesis (sources, research_synthesis) or a SHARED job report that restated a private-report claim
--          (it filed one - the old "mixed" class -, its text carries one's sentence, its reuse list names one, or a job
--          of that kind filed it) moves private to that claim's owner (a research_private_reports row, owner only); one
--          that restated claims of more than one owner, or of nobody, is WITHHELD (archived only, read by nobody). The
--          "mixed" claims follow the same rule (they move or are withheld like every other private-report claim). A
--          shared job's report text leaves the job (archived; the job keeps its non-text fields); it is copied to the
--          owner only when the job's question was not someone else's private prompt (a derived job, or the owner's own
--          prompt) - otherwise it is withheld. count-private-report-claim-reuse.sql counts them before and after.
--     PD0b's de-personalised idea question stays shared (operator-confirmed exception).
-- The archive (public.private_report_claims_archive) is readable by no app role. Counts only are printed (NOTICE),
-- never content. Re-runnable: a second run has nothing to move. Revert: revert-private-report-claims.sql (byte-
-- identical from the archive; it puts the claims the curator filed private after this slot back into the shared
-- table, the 390 model the revert returns to). Check: check-private-report-claims.sql.
-- Fresh-volume slot 570 (nothing to move). Live: psql -f AFTER 390 and 440 (it refuses without them), a fresh backup
-- first, the research curator and the wiki compile STOPPED, then the new research-curator and workbench images.
-- Revert order: 570 first, before 480 / 470 / 440 / 390.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = notice;

DO $$
BEGIN
    IF to_regclass('public.research_private_report_claims') IS NULL OR to_regclass('public.research_private_reports') IS NULL THEN
        RAISE EXCEPTION 'private report claims: refused, nothing changed - slot 390 (init-report-isolation.sql) must be applied first' USING ERRCODE = '55000';
    END IF;
    IF to_regclass('public.inlet_private_claims') IS NULL OR to_regclass('public.inlet_private_claim_sources') IS NULL THEN
        RAISE EXCEPTION 'private report claims: refused, nothing changed - slot 440 (init-inlet-owner.sql, round 5 or later) must be applied first' USING ERRCODE = '55000';
    END IF;
    -- round 2 (tester F2): the services' role. The slot's three functions are granted to service_role, which the
    -- services' login role ob_app_memory inherits (H1's scheme, scripts/checks/sql/init-app-role-memory.sql), so the
    -- grant reaches it whatever order the role and this slot are created in (a fresh volume runs this slot in initdb,
    -- before the operator creates the role); each function refuses any other caller itself
    -- (private_report_claims_caller_ok). A LIVE apply (the server listens: not initdb) refuses without the role; a role
    -- that does not inherit service_role is refused everywhere (the grant would not reach it).
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        RAISE EXCEPTION 'private report claims: refused, nothing changed - role service_role is missing' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        IF NOT pg_has_role('ob_app_memory', 'service_role', 'USAGE') THEN
            RAISE EXCEPTION 'private report claims: refused, nothing changed - ob_app_memory does not inherit service_role, so the workbench and the curator could not execute this slot''s functions' USING ERRCODE = '55000';
        END IF;
    ELSIF current_setting('listen_addresses') <> '' THEN
        RAISE EXCEPTION 'private report claims: refused, nothing changed - the services'' role ob_app_memory does not exist (create it first: scripts/checks/sql/init-app-role-memory.sql)' USING ERRCODE = '55000';
    ELSE
        RAISE NOTICE 'private report claims: fresh volume - ob_app_memory is created after initdb; it executes this slot''s functions through service_role once it exists';
    END IF;
END $$;
-- every table the run writes, at once, under the 10 s lock_timeout: SHARE ROW EXCLUSIVE blocks writers, lets readers through
LOCK TABLE public.claims, public.claim_sources, public.research_private_report_claims, public.research_private_reports,
           public.research_jobs, public.wiki_pages, public.inlet_private_claims, public.inlet_private_claim_sources,
           public.research_steers, public.research_job_events, public.sources
    IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
    -- fix item (A1): the derived-question guard sits on the hand-backs (slot 420); locked with the rest when present
    IF to_regclass('public.research_handbacks') IS NOT NULL THEN
        LOCK TABLE public.research_handbacks IN SHARE ROW EXCLUSIVE MODE;
    END IF;
END $$;

-- ── the archive ────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.private_report_claims_archive (
    id          BIGSERIAL PRIMARY KEY,
    batch       UUID NOT NULL,
    tbl         TEXT NOT NULL,           -- schema-qualified table the row is from
    action      TEXT NOT NULL,           -- k moved claim | x withheld claim | e claim_sources edge | m whole image of a
                                         -- shared claim that lost an edge | j a job's (result, metrics) | w wiki page |
                                         -- f the dropped foreign key's definition | g a shared tree row's gap-work
                                         -- text (research_jobs query/anchor/topic_estimate/tree_report, research_steers
                                         -- text/anchor/topic_estimate/gap, research_job_events payload)
                                         -- fix item (P2): s a shared synthesis (the sources row) moved or withheld |
                                         -- d a row that referenced it (row_data carries _col and _act, the foreign key's
                                         -- column and delete action) | p a shared job's (result, metrics) whose report
                                         -- left it | r a private copy this slot made (research_private_reports.id)
    ref         TEXT,                    -- the claim id (k x e m), the job id (j g p), the slug (w), the constraint name
                                         -- (f), the source id (s d), the private report id (r)
    row_data    JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_private_report_claims_archive_batch ON public.private_report_claims_archive (batch, restored_at);
DO $$
DECLARE r RECORD;
BEGIN
    ALTER TABLE public.private_report_claims_archive ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.private_report_claims_archive FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON public.private_report_claims_archive FROM PUBLIC;
    REVOKE ALL ON SEQUENCE public.private_report_claims_archive_id_seq FROM PUBLIC;
    -- the schema's default privileges hand every new table to the app roles: take those back too
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid IN ('public.private_report_claims_archive'::regclass, 'public.private_report_claims_archive_id_seq'::regclass)
                AND NOT ro.rolsuper AND ro.oid <> c.relowner LOOP
        EXECUTE format('REVOKE ALL ON public.private_report_claims_archive FROM %I', r.grantee);
        EXECUTE format('REVOKE ALL ON SEQUENCE public.private_report_claims_archive_id_seq FROM %I', r.grantee);
    END LOOP;
END $$;
COMMENT ON TABLE public.private_report_claims_archive IS
  'rw-private-report-claims (slot 570): every row init-private-report-claims.sql moved, deleted or changed, as it was. Readable by no app role; revert-private-report-claims.sql restores from it.';

-- ── the helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
-- a subject that may own a private row: slot 470's rule (inlet_subject_ok), restated so this slot does not need 470
CREATE OR REPLACE FUNCTION public.private_report_claim_subject_ok(p_subject TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT p_subject IS NOT NULL
       AND p_subject ~ '^[A-Za-z0-9][A-Za-z0-9._@|+=:/-]{0,254}$'
       AND p_subject !~* '^(service|system|anonymous):'
       AND lower(p_subject) <> 'operator'
$$;
REVOKE ALL ON FUNCTION public.private_report_claim_subject_ok(TEXT) FROM PUBLIC;
-- the batch the curator's private filings carry in the owner stores (a moved claim carries its migration batch)
CREATE OR REPLACE FUNCTION public.private_report_claims_filed_batch() RETURNS UUID
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT '00000000-0000-4570-8000-000000000570'::uuid $$;
REVOKE ALL ON FUNCTION public.private_report_claims_filed_batch() FROM PUBLIC;
-- the SKELETON a page match compares, on BOTH sides (the claim and the page). Final round (tester attempt 2, the
-- coordinator's stopping rule): no format list to keep up - HTML entities decoded; the text inside [[...]] and [..](..)
-- link labels kept; footnote / citation markers, <sup>/<ref> and every tag dropped; then LETTERS only (digits too go), lower
-- case, accents removed, so all spacing, punctuation and hyphenation is gone. A claim matches when its skeleton (24+
-- LETTERS) is a substring of the page's. check-private-report-claims.sql and count-private-report-claim-reuse.sql
-- repeat it verbatim. Residual (accepted): a claim-id-only link (ids, no text); a paraphrase or synonyms.
CREATE OR REPLACE FUNCTION public.private_report_claim_norm(p_text TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
    t TEXT := coalesce(p_text, '');
    m TEXT[];
    v INT;
    n INT := 0;
BEGIN
    -- 1. HTML entities: numeric (&#233; &#xE9;) decoded; a named letter entity (&eacute; &Ouml;) to its letter;
    --    &szlig; to ss; every other named one (&nbsp; &amp; ...) to a space
    LOOP
        m := regexp_match(t, '&#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7});');
        EXIT WHEN m IS NULL OR n > 500;
        n := n + 1;
        v := CASE WHEN lower(left(m[1], 1)) = 'x' THEN ('x' || lpad(substr(m[1], 2), 8, '0'))::bit(32)::int ELSE m[1]::int END;
        t := replace(t, '&#' || m[1] || ';', CASE WHEN v BETWEEN 1 AND 1114111 AND v NOT BETWEEN 55296 AND 57343 THEN chr(v) ELSE ' ' END);
    END LOOP;
    t := regexp_replace(t, '&([A-Za-z])(acute|grave|circ|uml|tilde|cedil|ring|slash|caron);', '\1', 'g');
    t := regexp_replace(t, '&szlig;', 'ss', 'g');
    t := regexp_replace(t, '&[A-Za-z][A-Za-z0-9]{1,31};', ' ', 'g');
    -- 2. links: the text a reader sees - [[target|label]] -> label, [[target]] -> target, [label](url) -> label
    t := regexp_replace(t, '\[\[(?:[^]|]*\|)?([^]]*)\]\]', '\1', 'g');
    t := regexp_replace(t, '\[([^]\[]*)\]\([^)]*\)', '\1', 'g');
    -- 3. markers and tags: footnotes ([^1] [^note-a], mid-word too), numeric / named citations ([3] [Source 2] [1, 2]),
    --    <sup>..</sup> and <ref>..</ref> with their content, every other tag (its content kept)
    t := regexp_replace(t, '\[\^[^]]*\]', '', 'g');
    t := regexp_replace(t, '\[\s*((source|src|ref|cite|citation|note)\s*)?[0-9]+([\s,;-]+[0-9]+)*\s*\]', '', 'gi');
    t := regexp_replace(t, '<sup([\s/][^>]*)?>.*?</sup\s*>', '', 'gi');
    t := regexp_replace(t, '<ref([\s/][^>]*)?>.*?</ref\s*>', '', 'gi');
    t := regexp_replace(t, '<[^>]*>', '', 'g');
    -- 4. the skeleton: NFKC (full-width / compatibility forms folded), lower case, accents removed (NFKD, the marks
    --    dropped), LETTERS ONLY - every digit, space, punctuation and hyphen gone (attempt 3: a citation number such as
    --    ^1^ or (1) mid-sentence, or a full-width digit, split the substring while digits were kept). A shared page that
    --    happens to carry a private claim's letters with other numbers is withheld too: conservative, accepted.
    t := lower(normalize(t, NFKC));
    t := replace(replace(replace(replace(t, 'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'), 'ø', 'o');
    t := translate(t, 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿāăąćĉčďđēĕėęěĝğġģĥĩīĭįıĵķĺļľłńņňōŏőŕŗřśŝşšţťũūŭůűųŵŷźżž',
                      'aaaaaaceeeeiiiinooooouuuuyyaaacccddeeeeegggghiiiiijkllllnnnooorrrssssttuuuuuuwyzzz');
    RETURN regexp_replace(normalize(t, NFKD), '[^[:alpha:]]+', '', 'g');
END;
$$;
REVOKE ALL ON FUNCTION public.private_report_claim_norm(TEXT) FROM PUBLIC;

-- who may call the slot's three functions (round 2, tester F2): they are granted to service_role so the services' role
-- reaches them in any creation order; this keeps everyone else out. A PostgREST request (it sets request.method /
-- request.path; service_role is its anon role) never; otherwise the services' own login (session_user ob_app_memory)
-- or a superuser session (the operator's psql, the migrations, the curator's e2e). session_user is the LOGIN role: a
-- SET ROLE cannot change it.
CREATE OR REPLACE FUNCTION public.private_report_claims_caller_ok() RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
    SELECT coalesce(nullif(current_setting('request.method', true), ''), nullif(current_setting('request.path', true), '')) IS NULL
       AND (session_user = 'ob_app_memory' OR coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), false))
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_caller_ok() FROM PUBLIC;
-- the owner READ also admits slot 480's workbench login ob_workbench (a member of ob_app_memory; final round, tester
-- attempt 2 F3): owner-scoped exactly as 480's own functions - the function answers only the subject the workbench
-- verified (p_sub), and only that subject's own claims. Never through PostgREST. The writes stay ob_app_memory's.
CREATE OR REPLACE FUNCTION public.private_report_claims_reader_ok() RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
    SELECT public.private_report_claims_caller_ok()
        OR (session_user = 'ob_workbench'
            AND coalesce(nullif(current_setting('request.method', true), ''), nullif(current_setting('request.path', true), '')) IS NULL)
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_reader_ok() FROM PUBLIC;

-- does this page text carry a private-report claim's text? (a claim in an owner store that a private report links, or
-- a withheld one this slot archived; texts under 24 characters are too short to name a claim and are not matched)
CREATE OR REPLACE FUNCTION public.private_report_claims_page_shows(p_title TEXT, p_body TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH page AS (SELECT public.private_report_claim_norm(coalesce(p_title, '') || ' ' || coalesce(p_body, '')) AS t),
    texts AS (
        SELECT public.private_report_claim_norm(c.text) AS n
          FROM public.inlet_private_claims c
         WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
        UNION ALL
        SELECT public.private_report_claim_norm(a.row_data ->> 'text')
          FROM public.private_report_claims_archive a
         WHERE a.action = 'x' AND a.restored_at IS NULL)
    SELECT EXISTS (SELECT 1 FROM texts, page WHERE length(texts.n) >= 24 AND position(texts.n IN page.t) > 0)
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_page_shows(TEXT, TEXT) FROM PUBLIC;

-- the wiki guard: a page carrying a private-report claim's text is withheld (marked, as 430's writer counts it); a
-- NOTE is refused with 430's one message (never which guard, never "a report")
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_wiki_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.private_report_claims_page_shows(NEW.title, NEW.body) THEN
        IF NEW.page_class = 'note' THEN
            RAISE EXCEPTION 'wiki_pages: this page cannot be saved' USING ERRCODE = '42501';
        END IF;
        PERFORM public.wiki_guard_mark_withheld();
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_wiki_guard() FROM PUBLIC;

-- the link guard: no service links a SHARED claim to a private report - its claims are filed private
-- (private_report_claim_file). A superuser session is let through: slot 390's own move links the claims of the reports
-- it moves (a 390 re-run after this slot) - run this slot again right after it, which moves them.
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_link_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- round 2: "a superuser session" excludes a PostgREST request - PostgREST connects as a superuser in this stack
    -- (PGRST_DB_URI) and its anon role service_role holds ALL on the link table
    IF EXISTS (SELECT 1 FROM public.claims c WHERE c.id = NEW.claim_id)
       AND NOT (coalesce((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user), false)
                AND coalesce(nullif(current_setting('request.method', true), ''), nullif(current_setting('request.path', true), '')) IS NULL) THEN
        RAISE EXCEPTION 'private report claims: a private report''s claim is filed private (private_report_claim_file); a shared claim cannot be linked'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_link_guard() FROM PUBLIC;

-- ── the gap work (round 2, tester P1) ──────────────────────────────────────────────────────────────────────────────
-- A recalled claim held below its kind's threshold is gap work (research-service harness.ts splitAtThreshold ->
-- tree.ts GapClaim, index.ts openTreeGaps): a 'gap' event naming it (payload.text), a gap branch asking
-- "Verify: <text>" (gap_ref claim:<id>), its steer (text, gap.text), and the root's tree report naming the branch by
-- it. After this slot the research service recalls no private claim (it reads public.claims), so it opens no such
-- branch; the guard below enforces it for every writer. On a tree that is not the claim owner's: no gap branch is
-- opened (the insert is skipped), a steer's or a gap event's text is replaced by a neutral stand-in.
-- the owner of a private-report claim: the store's owner; '' for a withheld one (nobody's); NULL = not a private claim
CREATE OR REPLACE FUNCTION public.private_report_claims_private_owner(p_claim UUID) RETURNS TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(
        (SELECT c.inlet_owner_sub FROM public.inlet_private_claims c
          WHERE c.id = p_claim AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id) LIMIT 1),
        (SELECT '' FROM public.private_report_claims_archive a
          WHERE a.action = 'x' AND a.restored_at IS NULL AND a.ref = p_claim::text LIMIT 1))
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_private_owner(UUID) FROM PUBLIC;
-- the owner of a research tree's report (slot 390's rule on the tree's root); NULL = a shared tree
CREATE OR REPLACE FUNCTION public.private_report_claims_tree_owner(p_job UUID) RETURNS TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT (SELECT o.owner_sub FROM public.research_job_report_owner(
               coalesce((SELECT j.root_job_id FROM public.research_jobs j WHERE j.id = p_job), p_job)) o LIMIT 1)
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_tree_owner(UUID) FROM PUBLIC;
-- Final round (tester attempt 2 F2): the guard does not depend on "nothing writes those"; it runs on INSERT AND UPDATE.
-- Fix item (F2, operator 2026-11-22): it guards only MACHINE-written gap work - a gap / inter-hub branch (research_jobs
-- branch_kind gap | interhub), its steer (steer_kind gap | interhub) and the gap / inter-hub events (and a branch_open
-- event of a machine branch) - and it matches a private-report claim by its ID only (its id anywhere in the row, braced
-- or not: a machine row that recalled a claim always names it - gap_ref claim:<id>, the gap's claim_id, a hub's label /
-- members). A human steer, its branch (branch_kind steer), its human_steer event, a root's question / tree report /
-- topic estimate and a topic event are never rewritten: what a person typed is never matched, so nothing a requester
-- sees depends on whether another user holds a claim with that text. A matched row of a tree that is not the claim's
-- owner's has the claim's text replaced by the neutral stand-in; a NEW gap or inter-hub branch naming one is not inserted.
-- (After this slot the research service recalls only public.claims, so in practice the guard is a backstop.)
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_gap_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_root  UUID;
    v_tree  TEXT;
    v_body  TEXT;
    v_hit   BOOLEAN := false;
    r       RECORD;
    c_n     CONSTANT TEXT := '(a private claim)';
BEGIN
    IF TG_TABLE_NAME = 'research_jobs' THEN
        IF NEW.branch_kind NOT IN ('gap', 'interhub') THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND NEW.query IS NOT DISTINCT FROM OLD.query AND NEW.anchor IS NOT DISTINCT FROM OLD.anchor
           AND NEW.topic_estimate IS NOT DISTINCT FROM OLD.topic_estimate AND NEW.tree_report IS NOT DISTINCT FROM OLD.tree_report
           AND NEW.gap_ref IS NOT DISTINCT FROM OLD.gap_ref THEN RETURN NEW; END IF;
        v_body := coalesce(NEW.query, '') || ' ' || coalesce(NEW.anchor, '') || ' ' || coalesce(NEW.topic_estimate, '') || ' '
                  || coalesce(NEW.tree_report::text, '') || ' ' || coalesce(NEW.gap_ref, '');
        v_root := coalesce(NEW.root_job_id, NEW.parent_job_id, NEW.id);
    ELSIF TG_TABLE_NAME = 'research_steers' THEN
        IF NEW.steer_kind NOT IN ('gap', 'interhub') THEN RETURN NEW; END IF;
        v_body := coalesce(NEW.text, '') || ' ' || coalesce(NEW.anchor, '') || ' ' || coalesce(NEW.topic_estimate, '') || ' ' || coalesce(NEW.gap::text, '');
        v_root := NEW.root_job_id;
    ELSE
        IF NOT (NEW.type IN ('gap', 'interhub_gap')
                OR (NEW.type = 'branch_open' AND coalesce(NEW.payload ->> 'steer_kind', '') IN ('gap', 'interhub'))) THEN RETURN NEW; END IF;
        v_body := coalesce(NEW.payload::text, '');
        v_root := NEW.root_job_id;
    END IF;
    v_tree := public.private_report_claims_tree_owner(v_root);
    FOR r IN
        SELECT x.id, x.text, substr(to_jsonb(x.text)::text, 2, length(to_jsonb(x.text)::text) - 2) AS jtext
          FROM (SELECT c.id, c.text, c.inlet_owner_sub AS owner FROM public.inlet_private_claims c
                 WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
                UNION ALL
                SELECT a.ref::uuid, a.row_data ->> 'text', NULL FROM public.private_report_claims_archive a
                 WHERE a.action = 'x' AND a.restored_at IS NULL) x
         WHERE (x.owner IS NULL OR x.owner IS DISTINCT FROM v_tree)
           AND position(x.id::text IN lower(v_body)) > 0
    LOOP
        v_hit := true;
        IF coalesce(btrim(r.text), '') = '' THEN CONTINUE; END IF;
        IF TG_TABLE_NAME = 'research_jobs' THEN
            NEW.query := replace(NEW.query, r.text, c_n);
            NEW.anchor := replace(NEW.anchor, r.text, c_n);
            NEW.topic_estimate := replace(NEW.topic_estimate, r.text, c_n);
            IF NEW.tree_report IS NOT NULL THEN NEW.tree_report := replace(NEW.tree_report::text, r.jtext, c_n)::jsonb; END IF;
        ELSIF TG_TABLE_NAME = 'research_steers' THEN
            NEW.text := replace(NEW.text, r.text, c_n);
            NEW.anchor := replace(NEW.anchor, r.text, c_n);
            NEW.topic_estimate := replace(NEW.topic_estimate, r.text, c_n);
            IF NEW.gap IS NOT NULL THEN NEW.gap := replace(NEW.gap::text, r.jtext, c_n)::jsonb; END IF;
        ELSE
            NEW.payload := replace(NEW.payload::text, r.jtext, c_n)::jsonb;
        END IF;
    END LOOP;
    IF NOT v_hit THEN RETURN NEW; END IF;
    -- (nested: a plpgsql expression resolves every NEW field it names, so each table's fields only in its own branch)
    IF TG_TABLE_NAME = 'research_jobs' THEN
        IF TG_OP = 'INSERT' THEN
            IF NEW.branch_kind IN ('gap', 'interhub') THEN RETURN NULL; END IF;
        END IF;
    ELSIF TG_TABLE_NAME = 'research_job_events' THEN
        -- a gap event naming the claim keeps the id (the per-tree dedup) but never its text; an inter-hub event's hub
        -- that names a private claim (its label or a member) loses its sample (a claim's text, tree.ts interHubGaps)
        IF NEW.payload ? 'text' THEN NEW.payload := NEW.payload || jsonb_build_object('text', c_n); END IF;
        IF NEW.type = 'interhub_gap' THEN
            FOR r IN SELECT k.key FROM (VALUES ('a'), ('b')) k(key)
                      WHERE jsonb_typeof(NEW.payload -> k.key) = 'object'
                        AND EXISTS (SELECT 1 FROM public.inlet_private_claims c
                                     WHERE (c.inlet_owner_sub IS DISTINCT FROM v_tree)
                                       AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
                                       AND position(c.id::text IN lower((NEW.payload -> k.key)::text)) > 0
                                    UNION ALL
                                    SELECT 1 FROM public.private_report_claims_archive a
                                     WHERE a.action = 'x' AND a.restored_at IS NULL
                                       AND position(a.ref IN lower((NEW.payload -> k.key)::text)) > 0) LOOP
                NEW.payload := jsonb_set(NEW.payload, ARRAY[r.key, 'sample'], to_jsonb(c_n));
            END LOOP;
        END IF;
    ELSE
        -- a machine steer only (a human steer returned at the top)
        NEW.text := c_n;
        IF NEW.gap ? 'text' THEN NEW.gap := NEW.gap || jsonb_build_object('text', c_n); END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_gap_guard() FROM PUBLIC;

-- ── the derived question (fix item A1, operator 2026-11-22) ─────────────────────────────────────────────────────────
-- A derived root (slot 420: its report is shared; the derived door, PD0b's drain and the owner's approval write it)
-- carrying one of the REQUESTER's OWN private-report claims is refused (23514): the requester would put their own
-- private sentence into a shared question. Another user's claim is never matched - the answer a requester gets must
-- not depend on whether someone else holds a claim with that text (the existence oracle of rwr-research-start-api's
-- review). The requester is the hand-back's owner: the boundary writes the job and then its hand-back (naming the job)
-- in one transaction, so the guard runs when a hand-back is given a derived job (INSERT, or an UPDATE that sets the job
-- or the owner). A derived job with no hand-back names no requester and matches nothing. Matched on the skeleton
-- (private_report_claim_norm), against the requester's own store only (the cost does not depend on other users' claims).
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_derived_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_q TEXT;
BEGIN
    IF NEW.job_id IS NULL THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.job_id IS NOT DISTINCT FROM OLD.job_id AND NEW.owner_sub IS NOT DISTINCT FROM OLD.owner_sub THEN
        RETURN NEW;
    END IF;
    SELECT public.private_report_claim_norm(coalesce(j.query, '') || ' ' || coalesce(j.anchor, '')) INTO v_q
      FROM public.research_jobs j WHERE j.id = NEW.job_id AND to_jsonb(j) ->> 'request_kind' = 'derived';
    IF v_q IS NULL THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM public.inlet_private_claims c
                WHERE c.inlet_owner_sub = NEW.owner_sub
                  AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
                  AND length(public.private_report_claim_norm(c.text)) >= 24
                  AND position(public.private_report_claim_norm(c.text) IN v_q) > 0) THEN
        RAISE EXCEPTION 'private report claims: a derived question carries a private report''s claim' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_derived_guard() FROM PUBLIC;

-- ── the move ───────────────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_batch   UUID := gen_random_uuid();
    v_def     TEXT;
    v_cols    TEXT;
    v_scols   TEXT;
    r         RECORD;
    v_n       BIGINT;
    n_own     BIGINT := 0;
    n_held    BIGINT := 0;
    n_mixed   BIGINT := 0;
    n_edges   BIGINT := 0;
    n_kept_e  BIGINT := 0;
    n_touched BIGINT := 0;
    n_jobs    BIGINT := 0;
    n_pages   BIGINT := 0;
    n_gap     BIGINT := 0;
    n_syn_own BIGINT := 0;
    n_syn_held BIGINT := 0;
    n_job_own BIGINT := 0;
    n_job_held BIGINT := 0;
    n_dep     BIGINT := 0;
    v_sids    UUID[];
    d         RECORD;
BEGIN
    -- the foreign key onto public.claims goes first (a link names a private claim from now on): its definition archived
    FOR r IN SELECT con.conname, pg_get_constraintdef(con.oid) AS def
               FROM pg_constraint con
              WHERE con.conrelid = 'public.research_private_report_claims'::regclass AND con.contype = 'f'
                AND con.confrelid = 'public.claims'::regclass LOOP
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        VALUES (v_batch, 'public.research_private_report_claims', 'f', r.conname, jsonb_build_object('name', r.conname, 'def', r.def));
        EXECUTE format('ALTER TABLE public.research_private_report_claims DROP CONSTRAINT %I', r.conname);
        RAISE NOTICE 'private report claims: the link''s foreign key onto public.claims dropped (archived)';
    END LOOP;

    -- the claims to move: linked to a private report, in the shared table. Fix item (P2): a claim a shared synthesis
    -- also filed ("mixed", synthesis_id set) follows the same rule - it moves (or is withheld) too, and that synthesis
    -- moves private with it (below).
    CREATE TEMP TABLE _prc ON COMMIT DROP AS
    SELECT c.id,
           (array_agg(DISTINCT p.owner_sub) FILTER (WHERE public.private_report_claim_subject_ok(p.owner_sub))) AS owners
      FROM public.claims c
      JOIN public.research_private_report_claims pc ON pc.claim_id = c.id
      JOIN public.research_private_reports p ON p.id = pc.report_id
     GROUP BY c.id;
    ALTER TABLE _prc ADD COLUMN owner TEXT;
    UPDATE _prc SET owner = owners[1] WHERE cardinality(owners) = 1;
    SELECT count(*) INTO n_mixed FROM public.claims c WHERE c.synthesis_id IS NOT NULL AND c.id IN (SELECT id FROM _prc);
    SELECT count(*) FILTER (WHERE owner IS NOT NULL), count(*) FILTER (WHERE owner IS NULL) INTO n_own, n_held FROM _prc;

    -- a dependent this move cannot archive stops it, nothing changed: any other foreign key onto claims with a row on a
    -- moved claim (claim_sources is archived below; the link's key is gone)
    FOR r IN SELECT con.conrelid::regclass::text AS tbl, a.attname AS col, cardinality(con.conkey) AS n_cols
               FROM pg_constraint con
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
              WHERE con.contype = 'f' AND con.confrelid = 'public.claims'::regclass
                AND con.conrelid NOT IN ('public.claim_sources'::regclass, 'public.research_private_report_claims'::regclass) LOOP
        IF r.n_cols <> 1 THEN
            RAISE EXCEPTION 'private report claims: refused, nothing changed - a multi-column foreign key onto claims (%), not archived by this move', r.tbl USING ERRCODE = '55000';
        END IF;
        EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I IN (SELECT id FROM _prc)', r.tbl, r.col) INTO v_n;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'private report claims: refused, nothing changed - % row(s) of % reference a claim to move', v_n, r.tbl USING ERRCODE = '55000';
        END IF;
    END LOOP;

    IF n_own + n_held > 0 THEN
        -- archive first: the claims, every edge of or onto them, every shared claim that loses an edge (whole)
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claims', CASE WHEN x.owner IS NULL THEN 'x' ELSE 'k' END, c.id::text, to_jsonb(c)
          FROM public.claims c JOIN _prc x ON x.id = c.id;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claim_sources', 'e', cs.claim_id::text, to_jsonb(cs)
          FROM public.claim_sources cs
         WHERE cs.claim_id IN (SELECT id FROM _prc) OR cs.parent_claim_id IN (SELECT id FROM _prc);
        GET DIAGNOSTICS n_edges = ROW_COUNT;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.claims', 'm', c.id::text, to_jsonb(c)
          FROM public.claims c
         WHERE c.id NOT IN (SELECT id FROM _prc)
           AND (c.id IN (SELECT cs.claim_id FROM public.claim_sources cs WHERE cs.parent_claim_id IN (SELECT id FROM _prc))
             OR c.id IN (SELECT cs.parent_claim_id FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _prc)));
        GET DIAGNOSTICS n_touched = ROW_COUNT;

        -- the owner's copy (PD1's store): the claim's own columns, the owner, this batch; its own edges, keyed by owner
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum), string_agg('s.' || quote_ident(attname), ', ' ORDER BY attnum)
          INTO v_cols, v_scols
          FROM pg_attribute WHERE attrelid = 'public.claims'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
        -- a column the shared table gained since slot 440 is carried too
        FOR r IN SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
                   FROM pg_attribute a
                  WHERE a.attrelid = 'public.claims'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                    AND NOT EXISTS (SELECT 1 FROM pg_attribute b WHERE b.attrelid = 'public.inlet_private_claims'::regclass AND b.attname = a.attname AND NOT b.attisdropped) LOOP
            EXECUTE format('ALTER TABLE public.inlet_private_claims ADD COLUMN %I %s', r.attname, r.typ);
        END LOOP;
        EXECUTE format('INSERT INTO public.inlet_private_claims (%s, inlet_owner_sub, inlet_batch) SELECT %s, x.owner, $1 FROM public.claims s JOIN _prc x ON x.id = s.id WHERE x.owner IS NOT NULL',
                       v_cols, v_scols) USING v_batch;
        INSERT INTO public.inlet_private_claim_sources (claim_id, edge_ref, owner_sub, batch, source_id, parent_claim_id, row_data)
        SELECT cs.claim_id, md5(to_jsonb(cs)::text), x.owner, v_batch, cs.source_id, cs.parent_claim_id, to_jsonb(cs)
          FROM public.claim_sources cs JOIN _prc x ON x.id = cs.claim_id
         WHERE x.owner IS NOT NULL;
        GET DIAGNOSTICS n_kept_e = ROW_COUNT;

        -- P2 (fix item, operator 2026-11-22): the SHARED outputs that restated one of these claims. Each claim's skeleton
        -- (private_report_claim_norm, 24+ letters, as the wiki match).
        CREATE TEMP TABLE _prc_n ON COMMIT DROP AS
        SELECT x.id, x.owner, public.private_report_claim_norm(c.text) AS n
          FROM _prc x JOIN public.claims c ON c.id = x.id
         WHERE length(public.private_report_claim_norm(c.text)) >= 24;
        -- a shared job report (no private report owns the job or its tree): its result names one (reuse_claims /
        -- claims) or any text of its result carries one's sentence. owners: the claims' owners; nobody: a withheld one
        CREATE TEMP TABLE _p2j ON COMMIT DROP AS
        WITH jb AS (
            SELECT j.id, j.result,
                   public.private_report_claim_norm((SELECT string_agg(v #>> '{}', ' ')
                                                       FROM jsonb_path_query(j.result - 'reuse_claims' - 'claims', 'strict $.**') v
                                                      WHERE jsonb_typeof(v) = 'string')) AS n
              FROM public.research_jobs j
             WHERE jsonb_typeof(j.result) = 'object'
               AND NOT EXISTS (SELECT 1 FROM public.research_job_report_owner(j.id))),
        hit AS (
            SELECT jb.id, x.owner FROM jb
              JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(jb.result -> 'claims') = 'array' THEN jb.result -> 'claims' ELSE '[]'::jsonb END
                                                || CASE WHEN jsonb_typeof(jb.result -> 'reuse_claims') = 'array' THEN jb.result -> 'reuse_claims' ELSE '[]'::jsonb END) e ON true
              JOIN _prc x ON x.id::text = (e ->> 'id')
            UNION ALL
            SELECT jb.id, t.owner FROM jb JOIN _prc_n t ON position(t.n IN jb.n) > 0)
        SELECT h.id, array_agg(DISTINCT h.owner) FILTER (WHERE h.owner IS NOT NULL) AS owners, bool_or(h.owner IS NULL) AS nobody
          FROM hit h GROUP BY h.id;
        ALTER TABLE _p2j ADD COLUMN owner TEXT, ADD COLUMN copy BOOLEAN NOT NULL DEFAULT false;
        UPDATE _p2j SET owner = owners[1] WHERE NOT nobody AND cardinality(owners) = 1;
        -- the owner gets the report only when its question was nobody's private prompt but theirs: a derived root (its
        -- question is public) or the owner's own prompt. Anyone else's prompt (or an ownerless job's, the default
        -- subject's) would leave with the report text: then it is withheld.
        UPDATE _p2j t SET copy = true
         WHERE t.owner IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.research_jobs j JOIN public.research_jobs rt ON rt.id = coalesce(j.root_job_id, j.id)
                        WHERE j.id = t.id
                          AND (to_jsonb(rt) ->> 'request_kind' = 'derived'
                               OR EXISTS (SELECT 1 FROM public.research_prompts rp WHERE rp.job_id = rt.id AND rp.owner_sub = t.owner)));
        -- a shared synthesis (sources, research_synthesis): it filed one (the "mixed" claims), its title / content carries
        -- one's sentence, or one of those jobs filed it (its curator answer, its typed 'filed' event)
        CREATE TEMP TABLE _p2s ON COMMIT DROP AS
        WITH sn AS (
            SELECT s.id, public.private_report_claim_norm(coalesce(s.title, '') || ' ' || coalesce(s.content, '')) AS n
              FROM public.sources s WHERE s.content_type = 'research_synthesis'),
        filed AS (
            SELECT t.id AS job_id, x.sid FROM _p2j t
              JOIN LATERAL (SELECT j.result -> 'curator' -> 'persist' ->> 'synthesis_id' AS sid FROM public.research_jobs j WHERE j.id = t.id
                            UNION SELECT e.payload ->> 'synthesis_id' FROM public.research_job_events e WHERE e.job_id = t.id AND e.type = 'filed') x ON true),
        hit AS (
            SELECT c.synthesis_id AS id, x.owner FROM _prc x JOIN public.claims c ON c.id = x.id WHERE c.synthesis_id IS NOT NULL
            UNION ALL
            SELECT sn.id, t.owner FROM sn JOIN _prc_n t ON position(t.n IN sn.n) > 0
            UNION ALL
            SELECT sn.id, o.owner FROM sn JOIN filed f ON f.sid = sn.id::text JOIN _p2j t ON t.id = f.job_id
              JOIN LATERAL (SELECT unnest(t.owners) AS owner UNION ALL SELECT NULL WHERE t.nobody) o ON true)
        SELECT h.id, array_agg(DISTINCT h.owner) FILTER (WHERE h.owner IS NOT NULL) AS owners, bool_or(h.owner IS NULL) AS nobody
          FROM hit h JOIN public.sources s ON s.id = h.id AND s.content_type = 'research_synthesis'
         GROUP BY h.id;
        ALTER TABLE _p2s ADD COLUMN owner TEXT;
        UPDATE _p2s SET owner = owners[1] WHERE NOT nobody AND cardinality(owners) = 1;
        SELECT count(*) FILTER (WHERE owner IS NOT NULL), count(*) FILTER (WHERE owner IS NULL) INTO n_syn_own, n_syn_held FROM _p2s;
        SELECT count(*) FILTER (WHERE copy), count(*) FILTER (WHERE NOT copy) INTO n_job_own, n_job_held FROM _p2j;

        -- the jobs: a result element naming a moved claim leaves every job whose report owner is not the claim's owner
        -- (the P2 jobs above are handled whole below, not here)
        CREATE TEMP TABLE _prc_jobs ON COMMIT DROP AS
        SELECT j.id, j.result, to_jsonb(j) -> 'metrics' AS metrics,
               (SELECT o.owner_sub FROM public.research_job_report_owner(j.id) o LIMIT 1) AS job_owner
          FROM public.research_jobs j
         WHERE jsonb_typeof(j.result) = 'object'
           AND j.id NOT IN (SELECT id FROM _p2j)
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'claims') = 'array' THEN j.result -> 'claims' ELSE '[]'::jsonb END
                                                          || CASE WHEN jsonb_typeof(j.result -> 'reuse_claims') = 'array' THEN j.result -> 'reuse_claims' ELSE '[]'::jsonb END) e
                        JOIN _prc x ON x.id::text = (e ->> 'id'));
        ALTER TABLE _prc_jobs ADD COLUMN new_result JSONB, ADD COLUMN new_metrics JSONB, ADD COLUMN cut_reuse INT;
        UPDATE _prc_jobs t SET new_result = t.result
              || CASE WHEN jsonb_typeof(t.result -> 'claims') = 'array' THEN jsonb_build_object('claims', coalesce((
                     SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(t.result -> 'claims') WITH ORDINALITY AS z(e, o)
                      WHERE NOT EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))), '[]'::jsonb)) ELSE '{}'::jsonb END
              || CASE WHEN jsonb_typeof(t.result -> 'reuse_claims') = 'array' THEN jsonb_build_object('reuse_claims', coalesce((
                     SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(t.result -> 'reuse_claims') WITH ORDINALITY AS z(e, o)
                      WHERE NOT EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))), '[]'::jsonb)) ELSE '{}'::jsonb END,
               cut_reuse = CASE WHEN jsonb_typeof(t.result -> 'reuse_claims') = 'array' THEN (
                     SELECT count(*) FROM jsonb_array_elements(t.result -> 'reuse_claims') z(e)
                      WHERE EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id') AND (x.owner IS NULL OR x.owner IS DISTINCT FROM t.job_owner))) ELSE 0 END;
        UPDATE _prc_jobs t SET new_metrics = CASE WHEN t.cut_reuse > 0 AND jsonb_typeof(t.metrics -> 'claims_reused') = 'number'
                                                  THEN t.metrics || jsonb_build_object('claims_reused', greatest((t.metrics ->> 'claims_reused')::numeric - t.cut_reuse, 0))
                                                  ELSE t.metrics END;
        DELETE FROM _prc_jobs t WHERE t.new_result IS NOT DISTINCT FROM t.result AND t.new_metrics IS NOT DISTINCT FROM t.metrics;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_jobs', 'j', t.id::text, jsonb_build_object('id', t.id, 'result', t.result, 'metrics', t.metrics)
          FROM _prc_jobs t;
        GET DIAGNOSTICS n_jobs = ROW_COUNT;

        -- the gap work of shared trees (round 2, tester P1): every tree that recalled a moved claim as gap work - a
        -- per-claim gap (a branch's gap_ref, a steer's or a gap event's claim_id) or an inter-hub gap (tree.ts
        -- interHubGaps: a hub's members are claim ids, its sample a claim's TEXT, in the event, the steer and the
        -- branch's question) - or whose branch / steer / event / tree report carries the claim's text, and that is not
        -- the claim owner's tree; in it every row that carries the claim's text (jobs: query, anchor, topic estimate,
        -- tree report; steers: text, anchor, topic estimate, gap; events: payload) is archived (action g), then the
        -- text is replaced by a neutral stand-in
        CREATE TEMP TABLE _prc_text ON COMMIT DROP AS
        SELECT x.id, x.owner, c.text, substr(to_jsonb(c.text)::text, 2, length(to_jsonb(c.text)::text) - 2) AS jtext
          FROM _prc x JOIN public.claims c ON c.id = x.id
         WHERE length(btrim(c.text)) >= 24;
        -- fix item (F2): only MACHINE rows are read and rewritten - gap / inter-hub branches (their question, anchor, topic
        -- estimate), the root's tree report and topic estimate (the service's own summaries, never the root's question),
        -- gap / inter-hub steers, gap / inter-hub / topic events and a machine branch's branch_open event. A human steer,
        -- its branch (branch_kind steer) and its human_steer event are never read for the match nor rewritten.
        CREATE TEMP TABLE _prc_trees ON COMMIT DROP AS
        SELECT DISTINCT q.root, t.id AS claim_id, t.text, t.jtext
          FROM _prc_text t
          JOIN LATERAL (
                SELECT coalesce(j.root_job_id, j.id) AS root FROM public.research_jobs j
                 WHERE j.gap_ref = 'claim:' || t.id::text
                    OR (j.branch_kind IN ('gap', 'interhub')
                        AND (position(t.id::text IN lower(coalesce(j.gap_ref, ''))) > 0 OR position(t.text IN j.query) > 0))
                UNION SELECT s.root_job_id FROM public.research_steers s
                 WHERE s.steer_kind IN ('gap', 'interhub')
                   AND (position(t.id::text IN coalesce(s.gap::text, '')) > 0 OR position(t.text IN s.text) > 0)
                UNION SELECT e.root_job_id FROM public.research_job_events e
                 WHERE e.type IN ('gap', 'interhub_gap')
                   AND (position(t.id::text IN e.payload::text) > 0 OR position(t.jtext IN e.payload::text) > 0)) q ON true
         WHERE t.owner IS NULL OR t.owner IS DISTINCT FROM (SELECT o.owner_sub FROM public.research_job_report_owner(q.root) o LIMIT 1);
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_jobs', 'g', j.id::text,
               jsonb_build_object('id', j.id, 'query', j.query, 'anchor', j.anchor, 'topic_estimate', j.topic_estimate, 'tree_report', j.tree_report)
          FROM public.research_jobs j
         WHERE EXISTS (SELECT 1 FROM _prc_trees t WHERE t.root = coalesce(j.root_job_id, j.id)
                        AND ((j.branch_kind IN ('gap', 'interhub')
                              AND (position(t.text IN coalesce(j.query, '')) > 0 OR position(t.text IN coalesce(j.anchor, '')) > 0
                                   OR position(t.text IN coalesce(j.topic_estimate, '')) > 0))
                             OR (j.branch_kind IN ('root', 'idea')
                                 AND (position(t.text IN coalesce(j.topic_estimate, '')) > 0 OR position(t.jtext IN coalesce(j.tree_report::text, '')) > 0))));
        GET DIAGNOSTICS v_n = ROW_COUNT; n_gap := n_gap + v_n;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_steers', 'g', s.id::text,
               jsonb_build_object('id', s.id, 'text', s.text, 'anchor', s.anchor, 'topic_estimate', s.topic_estimate, 'gap', s.gap)
          FROM public.research_steers s
         WHERE s.steer_kind IN ('gap', 'interhub')
           AND EXISTS (SELECT 1 FROM _prc_trees t WHERE t.root = s.root_job_id
                        AND (position(t.text IN s.text) > 0 OR position(t.text IN s.anchor) > 0 OR position(t.text IN s.topic_estimate) > 0
                             OR position(t.jtext IN coalesce(s.gap::text, '')) > 0));
        GET DIAGNOSTICS v_n = ROW_COUNT; n_gap := n_gap + v_n;
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_job_events', 'g', e.id::text, jsonb_build_object('id', e.id, 'payload', e.payload)
          FROM public.research_job_events e
         WHERE (e.type IN ('gap', 'interhub_gap', 'topic')
                OR (e.type = 'branch_open' AND coalesce(e.payload ->> 'steer_kind', '') IN ('gap', 'interhub')))
           AND EXISTS (SELECT 1 FROM _prc_trees t WHERE t.root = e.root_job_id AND position(t.jtext IN e.payload::text) > 0);
        GET DIAGNOSTICS v_n = ROW_COUNT; n_gap := n_gap + v_n;

        -- the shared rows go, with ordinary triggers off for the job rows (their touch timestamps do not move: the revert is
        -- byte-identical); the edge deletes recompute the shared claims archived whole above
        DELETE FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _prc) OR cs.parent_claim_id IN (SELECT id FROM _prc);
        DELETE FROM public.claims c WHERE c.id IN (SELECT id FROM _prc);
        PERFORM set_config('session_replication_role', 'replica', true);
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attname = 'metrics' AND NOT attisdropped) THEN
            UPDATE public.research_jobs j SET result = t.new_result, metrics = t.new_metrics FROM _prc_jobs t WHERE t.id = j.id;
        ELSE
            UPDATE public.research_jobs j SET result = t.new_result FROM _prc_jobs t WHERE t.id = j.id;
        END IF;
        FOR r IN SELECT * FROM _prc_trees LOOP
            -- (a root's question and anchor are the asker's: only its topic estimate and tree report are rewritten)
            UPDATE public.research_jobs j
               SET query = CASE WHEN j.branch_kind IN ('root', 'idea') THEN j.query ELSE replace(j.query, r.text, '(a private claim)') END,
                   anchor = CASE WHEN j.branch_kind IN ('root', 'idea') THEN j.anchor ELSE replace(j.anchor, r.text, '(a private claim)') END,
                   topic_estimate = replace(j.topic_estimate, r.text, '(a private claim)'),
                   tree_report = CASE WHEN j.tree_report IS NULL THEN NULL ELSE replace(j.tree_report::text, r.jtext, '(a private claim)')::jsonb END
             WHERE coalesce(j.root_job_id, j.id) = r.root
               AND j.id::text IN (SELECT a.ref FROM public.private_report_claims_archive a WHERE a.batch = v_batch AND a.action = 'g' AND a.tbl = 'public.research_jobs');
            UPDATE public.research_steers s
               SET text = replace(s.text, r.text, '(a private claim)'), anchor = replace(s.anchor, r.text, '(a private claim)'),
                   topic_estimate = replace(s.topic_estimate, r.text, '(a private claim)'),
                   gap = CASE WHEN s.gap IS NULL THEN NULL ELSE replace(s.gap::text, r.jtext, '(a private claim)')::jsonb END
             WHERE s.root_job_id = r.root
               AND s.id::text IN (SELECT a.ref FROM public.private_report_claims_archive a WHERE a.batch = v_batch AND a.action = 'g' AND a.tbl = 'public.research_steers');
            UPDATE public.research_job_events e
               SET payload = replace(e.payload::text, r.jtext, '(a private claim)')::jsonb
             WHERE e.root_job_id = r.root
               AND e.id::text IN (SELECT a.ref FROM public.private_report_claims_archive a WHERE a.batch = v_batch AND a.action = 'g' AND a.tbl = 'public.research_job_events');
        END LOOP;
        PERFORM set_config('session_replication_role', 'origin', true);
        IF EXISTS (SELECT 1 FROM _prc_trees t JOIN public.research_jobs j ON coalesce(j.root_job_id, j.id) = t.root
                    WHERE (j.branch_kind IN ('gap', 'interhub')
                           AND position(t.text IN coalesce(j.query, '') || ' ' || coalesce(j.anchor, '') || ' ' || coalesce(j.topic_estimate, '')) > 0)
                       OR (j.branch_kind IN ('root', 'idea')
                           AND (position(t.text IN coalesce(j.topic_estimate, '')) > 0 OR position(t.jtext IN coalesce(j.tree_report::text, '')) > 0)))
           OR EXISTS (SELECT 1 FROM _prc_trees t JOIN public.research_steers s ON s.root_job_id = t.root
                       WHERE s.steer_kind IN ('gap', 'interhub')
                         AND (position(t.text IN s.text || ' ' || s.anchor || ' ' || s.topic_estimate) > 0 OR position(t.jtext IN coalesce(s.gap::text, '')) > 0))
           OR EXISTS (SELECT 1 FROM _prc_trees t JOIN public.research_job_events e ON e.root_job_id = t.root
                       WHERE (e.type IN ('gap', 'interhub_gap', 'topic')
                              OR (e.type = 'branch_open' AND coalesce(e.payload ->> 'steer_kind', '') IN ('gap', 'interhub')))
                         AND position(t.jtext IN e.payload::text) > 0) THEN
            RAISE EXCEPTION 'private report claims: refused, nothing changed - a moved claim''s text is still in a shared tree''s gap work' USING ERRCODE = '55000';
        END IF;

        -- ── P2 (fix item): the shared job reports ──────────────────────────────────────────────────────────────────
        -- each one archived (p: result, metrics), then its result keeps only fields that carry no report text (outcome,
        -- report type, cited public sources, thread, ratios, run counters, the contract), an empty synthesis and its
        -- reuse / claims lists without the private-report claims (claims_reused follows), with ordinary triggers off;
        -- the owner's copy (r) when the question was public or the owner's own (see copy above)
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_jobs', 'p', j.id::text, jsonb_build_object('id', j.id, 'result', j.result, 'metrics', to_jsonb(j) -> 'metrics')
          FROM public.research_jobs j JOIN _p2j t ON t.id = j.id;
        WITH ins AS (
            INSERT INTO public.research_private_reports (research_key, owner_sub, idea_id, job_id, title, content, metadata)
            SELECT 'prc570-job:' || j.id::text, t.owner, NULL, j.id, 'A shared report that restated your private claim',
                   coalesce(CASE WHEN jsonb_typeof(j.result -> 'rendered') = 'string' THEN nullif(j.result ->> 'rendered', '') END, j.result ->> 'synthesis', ''),
                   jsonb_strip_nulls(jsonb_build_object('prose_synthesis', j.result ->> 'prose', 'report_type', j.result ->> 'report_type', 'moved_by', 'slot 570 P2'))
              FROM public.research_jobs j JOIN _p2j t ON t.id = j.id
             WHERE t.copy
            ON CONFLICT DO NOTHING
            RETURNING id, research_key)
        INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
        SELECT v_batch, 'public.research_private_reports', 'r', ins.id::text, jsonb_build_object('id', ins.id, 'research_key', ins.research_key) FROM ins;
        PERFORM set_config('session_replication_role', 'replica', true);
        UPDATE public.research_jobs j
           SET result = jsonb_strip_nulls(jsonb_build_object(
                            'outcome', j.result -> 'outcome', 'report_type', j.result -> 'report_type', 'cited_sources', j.result -> 'cited_sources',
                            'thread_id', j.result -> 'thread_id', 'reuse_ratio', j.result -> 'reuse_ratio', 'backstop', j.result -> 'backstop',
                            'fetch_stats', j.result -> 'fetch_stats', 'contract', j.result -> 'contract'))
                        || jsonb_build_object('synthesis', '')
                        || CASE WHEN jsonb_typeof(j.result -> 'claims') = 'array' THEN jsonb_build_object('claims', coalesce((
                               SELECT jsonb_agg(z.e ORDER BY z.o) FROM jsonb_array_elements(j.result -> 'claims') WITH ORDINALITY AS z(e, o)
                                WHERE NOT EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id'))), '[]'::jsonb)) ELSE '{}'::jsonb END
                        || CASE WHEN jsonb_typeof(j.result -> 'reuse_claims') = 'array' THEN jsonb_build_object('reuse_claims', coalesce((
                               SELECT jsonb_agg(z.e ORDER BY z.o) FROM jsonb_array_elements(j.result -> 'reuse_claims') WITH ORDINALITY AS z(e, o)
                                WHERE NOT EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id'))), '[]'::jsonb)) ELSE '{}'::jsonb END
          FROM _p2j t WHERE t.id = j.id;
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.research_jobs'::regclass AND attname = 'metrics' AND NOT attisdropped) THEN
            UPDATE public.research_jobs j
               SET metrics = j.metrics || jsonb_build_object('claims_reused', greatest((j.metrics ->> 'claims_reused')::numeric - (
                                 SELECT count(*) FROM public.private_report_claims_archive a, jsonb_array_elements(
                                        CASE WHEN jsonb_typeof(a.row_data -> 'result' -> 'reuse_claims') = 'array' THEN a.row_data -> 'result' -> 'reuse_claims' ELSE '[]'::jsonb END) z(e)
                                  WHERE a.batch = v_batch AND a.action = 'p' AND a.ref = j.id::text
                                    AND EXISTS (SELECT 1 FROM _prc x WHERE x.id::text = (z.e ->> 'id'))), 0))
              FROM _p2j t WHERE t.id = j.id AND jsonb_typeof(j.metrics -> 'claims_reused') = 'number';
        END IF;
        PERFORM set_config('session_replication_role', 'origin', true);

        -- ── P2 (fix item): the shared syntheses ────────────────────────────────────────────────────────────────────
        -- as slot 390 moves an idea's synthesis: the sources row archived (s), the owner's copy (r) - a synthesis the
        -- curator filed is already free of any prompt's words, so it is always copied to a single owner -, every row of
        -- every table whose foreign key references it archived (d; a cascade that would take an un-archived row with it
        -- stops the run), the set-NULL / set-default columns set by the move itself with triggers off (their rows' touch
        -- timestamps do not move), every shared claim that loses a grounding edge onto it archived whole (m), then the
        -- row deleted (the foreign keys cascade as declared). Withheld (several owners / nobody): archived only.
        SELECT array_agg(id) INTO v_sids FROM _p2s;
        IF v_sids IS NOT NULL THEN
            IF EXISTS (SELECT 1 FROM pg_constraint con WHERE con.contype = 'f' AND con.confrelid = 'public.sources'::regclass AND cardinality(con.conkey) <> 1) THEN
                RAISE EXCEPTION 'private report claims: refused, nothing changed - a multi-column foreign key references sources, not archived by this move' USING ERRCODE = '55000';
            END IF;
            INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
            SELECT v_batch, 'public.sources', 's', s.id::text, to_jsonb(s) FROM public.sources s WHERE s.id = ANY(v_sids);
            WITH ins AS (
                INSERT INTO public.research_private_reports
                    (research_key, owner_sub, idea_id, job_id, title, content, claim, research_query, run_kind, volatility,
                     revalidate_days, researched_on, metadata, created_at, updated_at)
                SELECT 'prc570-syn:' || s.id::text, t.owner, NULL, NULL, coalesce(s.title, ''), coalesce(s.content, ''), s.metadata ->> 'claim',
                       s.research_query, s.run_kind, s.volatility, s.revalidate_days, s.researched_on,
                       coalesce(s.metadata, '{}'::jsonb) || jsonb_build_object('moved_by', 'slot 570 P2'), s.created_at, now()
                  FROM public.sources s JOIN _p2s t ON t.id = s.id
                 WHERE t.owner IS NOT NULL
                ON CONFLICT DO NOTHING
                RETURNING id, research_key)
            INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
            SELECT v_batch, 'public.research_private_reports', 'r', ins.id::text, jsonb_build_object('id', ins.id, 'research_key', ins.research_key) FROM ins;
            FOR r IN
                SELECT con.conrelid::regclass::text AS tbl, a.attname AS col, con.confdeltype::text AS act
                  FROM pg_constraint con
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
                 WHERE con.contype = 'f' AND con.confrelid = 'public.sources'::regclass AND cardinality(con.conkey) = 1
            LOOP
                EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I = ANY($1)', r.tbl, r.col) INTO v_n USING v_sids;
                IF v_n = 0 THEN CONTINUE; END IF;
                IF r.act NOT IN ('c', 'n', 'd') THEN
                    RAISE EXCEPTION 'private report claims: refused, nothing changed - % row(s) of % reference a shared synthesis to move through a foreign key that would refuse the delete', v_n, r.tbl USING ERRCODE = '55000';
                END IF;
                IF r.act = 'c' THEN
                    FOR d IN
                        SELECT c2.conrelid::regclass::text AS tbl2,
                               (SELECT string_agg(format('t2.%I = t.%I', ca.attname, pa.attname), ' AND ')
                                  FROM unnest(c2.conkey, c2.confkey) k(c, p)
                                  JOIN pg_attribute ca ON ca.attrelid = c2.conrelid AND ca.attnum = k.c
                                  JOIN pg_attribute pa ON pa.attrelid = c2.confrelid AND pa.attnum = k.p) AS on_clause
                          FROM pg_constraint c2
                         WHERE c2.contype = 'f' AND c2.confrelid = r.tbl::regclass
                    LOOP
                        EXECUTE format('SELECT count(*) FROM %s t2 WHERE EXISTS (SELECT 1 FROM %s t WHERE t.%I = ANY($1) AND %s)',
                                       d.tbl2, r.tbl, r.col, d.on_clause) INTO v_n USING v_sids;
                        IF v_n > 0 THEN
                            RAISE EXCEPTION 'private report claims: refused, nothing changed - % row(s) of % hang off % rows the synthesis move would cascade', v_n, d.tbl2, r.tbl USING ERRCODE = '55000';
                        END IF;
                    END LOOP;
                END IF;
                EXECUTE format('INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
                                SELECT $1, %L, ''d'', t.%I::text, to_jsonb(t) || jsonb_build_object(''_col'', %L, ''_act'', %L) FROM %s t WHERE t.%I = ANY($2)',
                               r.tbl, r.col, r.col, r.act, r.tbl, r.col)
                    USING v_batch, v_sids;
                GET DIAGNOSTICS v_n = ROW_COUNT; n_dep := n_dep + v_n;
                IF r.act IN ('n', 'd') THEN
                    PERFORM set_config('session_replication_role', 'replica', true);
                    EXECUTE format('UPDATE %s t SET %I = %s WHERE t.%I = ANY($1)', r.tbl, r.col, CASE r.act WHEN 'n' THEN 'NULL' ELSE 'DEFAULT' END, r.col)
                        USING v_sids;
                    PERFORM set_config('session_replication_role', 'origin', true);
                END IF;
            END LOOP;
            INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
            SELECT v_batch, 'public.claims', 'm', c.id::text, to_jsonb(c)
              FROM public.claims c
             WHERE c.id IN (SELECT cs.claim_id FROM public.claim_sources cs WHERE cs.source_id = ANY(v_sids))
               AND NOT EXISTS (SELECT 1 FROM public.private_report_claims_archive a WHERE a.batch = v_batch AND a.action = 'm' AND a.ref = c.id::text);
            GET DIAGNOSTICS v_n = ROW_COUNT; n_touched := n_touched + v_n;
            DELETE FROM public.sources s WHERE s.id = ANY(v_sids);
        END IF;
        IF EXISTS (SELECT 1 FROM public.sources s WHERE s.id = ANY(coalesce(v_sids, '{}')))
           OR EXISTS (SELECT 1 FROM public.sources s, _prc_n t
                       WHERE s.content_type = 'research_synthesis'
                         AND position(t.n IN public.private_report_claim_norm(coalesce(s.title, '') || ' ' || coalesce(s.content, ''))) > 0)
           OR EXISTS (SELECT 1 FROM public.research_jobs j JOIN _p2j t ON t.id = j.id
                       WHERE coalesce(j.result ->> 'synthesis', '') <> '' OR j.result ? 'prose' OR j.result ? 'rendered') THEN
            RAISE EXCEPTION 'private report claims: refused, nothing changed - a shared synthesis or job report still restates a moved claim' USING ERRCODE = '55000';
        END IF;
    END IF;

    -- the wiki: every page carrying a private-report claim's text (the predicate reads the store and this batch's archive),
    -- archived and withheld - whatever this run moved, a later page included
    INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
    SELECT v_batch, 'public.wiki_pages', 'w', w.slug, to_jsonb(w)
      FROM public.wiki_pages w WHERE public.private_report_claims_page_shows(w.title, w.body);
    GET DIAGNOSTICS n_pages = ROW_COUNT;
    DELETE FROM public.wiki_pages w USING public.private_report_claims_archive a
     WHERE a.batch = v_batch AND a.action = 'w' AND a.ref = w.slug;

    -- fail closed: nothing of what moved is left on a shared surface
    IF EXISTS (SELECT 1 FROM public.claims c WHERE c.id IN (SELECT id FROM _prc))
       OR EXISTS (SELECT 1 FROM public.claim_sources cs WHERE cs.claim_id IN (SELECT id FROM _prc) OR cs.parent_claim_id IN (SELECT id FROM _prc))
       OR EXISTS (SELECT 1 FROM public.wiki_pages w WHERE public.private_report_claims_page_shows(w.title, w.body)) THEN
        RAISE EXCEPTION 'private report claims: refused, nothing changed - a moved claim is still on a shared surface after the move' USING ERRCODE = '55000';
    END IF;

    IF n_own + n_held + n_pages = 0 THEN
        RAISE NOTICE 'private report claims: nothing to move';
    ELSE
        RAISE NOTICE 'private report claims: % claim(s) moved to their owner''s store (% edge(s) kept for the owner), % withheld (no single owner); % of them a shared synthesis also filed (mixed, same rule)',
            n_own, n_kept_e, n_held, n_mixed;
        RAISE NOTICE 'private report claims: % edge(s) archived and deleted, % shared claim(s) that lost an edge archived whole, % job result(s) stripped, % wiki page(s) withheld, % gap-work row(s) of a shared tree made neutral',
            n_edges, n_touched, n_jobs, n_pages, n_gap;
        RAISE NOTICE 'private report claims (P2): % shared synthesis(es) moved private to their claim''s owner, % withheld (several owners or none); % shared job report(s) moved private to their claim''s owner, % withheld; % row(s) that referenced a moved synthesis archived',
            n_syn_own, n_syn_held, n_job_own, n_job_held, n_dep;
    END IF;
END $$;

-- ── the corroboration lines ────────────────────────────────────────────────────────────────────────────────────────
-- source_corroborations.claim_text is the synthesis LINE a corroboration was judged on - the text of the claim filed
-- from it - and the quality read (contract/sources/{id}/quality) and PostgREST serve it. A line of a private report's
-- run (the job, or its tree root, is a private report's: research_job_report_owner, or a research_private_reports row
-- names the job) is the private claim's text on a shared surface: it is replaced by a neutral, keyed stand-in
-- ('private-text:' + md5 of a per-database secret salt, the two sources and the line - stable, so the research
-- service's per-line ON CONFLICT still merges a re-run; not guessable, so a guessed sentence cannot be confirmed). The
-- amount, the pair and the verdict stay: the shared sources' credibility is unchanged. A guard does the same for every
-- new line, whoever writes it (the research service writes them during the run).
CREATE TABLE IF NOT EXISTS public.private_report_claims_salt (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    salt      TEXT NOT NULL
);
INSERT INTO public.private_report_claims_salt (singleton, salt)
SELECT true, md5(random()::text || clock_timestamp()::text) || md5(random()::text || pg_backend_pid()::text)
 WHERE NOT EXISTS (SELECT 1 FROM public.private_report_claims_salt);
DO $$
DECLARE r RECORD;
BEGIN
    ALTER TABLE public.private_report_claims_salt ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.private_report_claims_salt FORCE ROW LEVEL SECURITY;
    REVOKE ALL ON public.private_report_claims_salt FROM PUBLIC;
    FOR r IN SELECT DISTINCT ro.rolname AS grantee
               FROM pg_class c, aclexplode(c.relacl) a JOIN pg_roles ro ON ro.oid = a.grantee
              WHERE c.oid = 'public.private_report_claims_salt'::regclass AND NOT ro.rolsuper AND ro.oid <> c.relowner LOOP
        EXECUTE format('REVOKE ALL ON public.private_report_claims_salt FROM %I', r.grantee);
    END LOOP;
END $$;
-- is this job a private report's run? (the job or its tree root is an idea's - 390's rule - or a private report names it)
CREATE OR REPLACE FUNCTION public.private_report_claims_job_private(p_job UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_job IS NOT NULL
       AND (EXISTS (SELECT 1 FROM public.research_job_report_owner(p_job))
            OR EXISTS (SELECT 1 FROM public.research_private_reports p
                        WHERE p.job_id = p_job
                           OR p.job_id = (SELECT j.root_job_id FROM public.research_jobs j WHERE j.id = p_job))
            -- fix item (P2): a shared job whose report this slot made private or withheld
            OR EXISTS (SELECT 1 FROM public.private_report_claims_archive a
                        WHERE a.action = 'p' AND a.restored_at IS NULL AND a.ref = p_job::text))
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_job_private(UUID) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.private_report_claims_neutral_line(p_from UUID, p_to UUID, p_text TEXT) RETURNS TEXT
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT 'private-text:' || md5((SELECT s.salt FROM public.private_report_claims_salt s WHERE s.singleton)
                                  || '|' || p_from::text || '|' || p_to::text || '|' || coalesce(p_text, ''))
$$;
REVOKE ALL ON FUNCTION public.private_report_claims_neutral_line(UUID, UUID, TEXT) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.trg_private_report_claims_corroboration_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.claim_text NOT LIKE 'private-text:%' AND public.private_report_claims_job_private(NEW.job_id) THEN
        NEW.claim_text := public.private_report_claims_neutral_line(NEW.from_source_id, NEW.to_source_id, NEW.claim_text);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.trg_private_report_claims_corroboration_guard() FROM PUBLIC;
DO $$
DECLARE v_batch UUID := gen_random_uuid(); v_n BIGINT := 0;
BEGIN
    IF to_regclass('public.source_corroborations') IS NULL THEN RETURN; END IF;
    LOCK TABLE public.source_corroborations IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
    SELECT v_batch, 'public.source_corroborations', 'c', sc.id::text, to_jsonb(sc)
      FROM public.source_corroborations sc
     WHERE sc.claim_text NOT LIKE 'private-text:%' AND public.private_report_claims_job_private(sc.job_id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
        PERFORM set_config('session_replication_role', 'replica', true);
        UPDATE public.source_corroborations sc
           SET claim_text = public.private_report_claims_neutral_line(sc.from_source_id, sc.to_source_id, sc.claim_text)
          FROM public.private_report_claims_archive a
         WHERE a.batch = v_batch AND a.action = 'c' AND a.ref = sc.id::text;
        PERFORM set_config('session_replication_role', 'origin', true);
        RAISE NOTICE 'private report claims: % corroboration line(s) of a private report''s run made neutral', v_n;
    END IF;
    DROP TRIGGER IF EXISTS trg_private_report_claims_corroboration_guard ON public.source_corroborations;
    CREATE TRIGGER trg_private_report_claims_corroboration_guard BEFORE INSERT OR UPDATE OF claim_text, job_id ON public.source_corroborations
        FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_corroboration_guard();
END $$;

DROP TRIGGER IF EXISTS trg_private_report_claims_wiki_guard ON public.wiki_pages;
CREATE TRIGGER trg_private_report_claims_wiki_guard BEFORE INSERT OR UPDATE ON public.wiki_pages
    FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_wiki_guard();
DROP TRIGGER IF EXISTS trg_private_report_claims_gap_guard ON public.research_jobs;
CREATE TRIGGER trg_private_report_claims_gap_guard BEFORE INSERT OR UPDATE ON public.research_jobs
    FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_gap_guard();
DROP TRIGGER IF EXISTS trg_private_report_claims_gap_guard ON public.research_steers;
CREATE TRIGGER trg_private_report_claims_gap_guard BEFORE INSERT OR UPDATE ON public.research_steers
    FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_gap_guard();
DROP TRIGGER IF EXISTS trg_private_report_claims_gap_guard ON public.research_job_events;
CREATE TRIGGER trg_private_report_claims_gap_guard BEFORE INSERT OR UPDATE ON public.research_job_events
    FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_gap_guard();
DROP TRIGGER IF EXISTS trg_private_report_claims_link_guard ON public.research_private_report_claims;
CREATE TRIGGER trg_private_report_claims_link_guard BEFORE INSERT OR UPDATE OF claim_id ON public.research_private_report_claims
    FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_link_guard();
-- fix item (A1): the derived-question guard, on the hand-back that names the requester (slot 420's table)
DO $$
BEGIN
    IF to_regclass('public.research_handbacks') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_private_report_claims_derived_guard ON public.research_handbacks;
        CREATE TRIGGER trg_private_report_claims_derived_guard BEFORE INSERT OR UPDATE OF job_id, owner_sub ON public.research_handbacks
            FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_derived_guard();
    ELSE
        RAISE NOTICE 'private report claims: no research_handbacks (slot 420) - the derived-question guard is not installed';
    END IF;
END $$;

-- ── the writes and the owner's read ────────────────────────────────────────────────────────────────────────────────
-- The curator's write of one claim of a private report: the owner is the REPORT's (research_private_reports, by
-- research_key + job), never the caller's word. Deduplicated within the owner's own store (same thread, same text), never
-- against a shared claim and never into one. Links the claim to the report. Refused for a report with no valid owner
-- (nobody may read it: the claim is not filed) or for a key + job naming reports of two owners.
CREATE OR REPLACE FUNCTION public.private_report_claim_file(
    p_research_key    TEXT,
    p_job_id          UUID,
    p_text            TEXT,
    p_thread_id       UUID         DEFAULT NULL,
    p_epistemic_tag   TEXT         DEFAULT 'sourced',
    p_volatility      TEXT         DEFAULT NULL,
    p_revalidate_days INT          DEFAULT NULL,
    p_embedding       VECTOR(1024) DEFAULT NULL,
    p_metadata        JSONB        DEFAULT '{}'::jsonb
)
RETURNS TABLE (id UUID, was_duplicate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owners TEXT[];
    v_owner  TEXT;
    v_hash   TEXT := md5(lower(btrim(coalesce(p_text, ''))));
    v_tag    TEXT := CASE WHEN p_epistemic_tag IN ('sourced', 'inferred', 'uncertain') THEN p_epistemic_tag ELSE 'sourced' END;
    v_id     UUID;
BEGIN
    IF NOT public.private_report_claims_caller_ok() THEN
        RAISE EXCEPTION 'private report claims: not for this caller' USING ERRCODE = '42501';
    END IF;
    IF coalesce(btrim(p_text), '') = '' THEN
        RAISE EXCEPTION 'claim text required';
    END IF;
    SELECT array_agg(DISTINCT p.owner_sub) INTO v_owners
      FROM public.research_private_reports p WHERE p.research_key = p_research_key AND p.job_id = p_job_id;
    IF v_owners IS NULL THEN
        RAISE EXCEPTION 'private report claims: no private report for this key and job; nothing filed' USING ERRCODE = '23503';
    END IF;
    IF cardinality(v_owners) <> 1 OR NOT public.private_report_claim_subject_ok(v_owners[1]) THEN
        RAISE EXCEPTION 'private report claims: the report has no single owner who may read it; nothing filed' USING ERRCODE = '42501';
    END IF;
    v_owner := v_owners[1];
    SELECT c.id INTO v_id FROM public.inlet_private_claims c
     WHERE c.inlet_owner_sub = v_owner AND c.content_hash = v_hash AND c.thread_id IS NOT DISTINCT FROM p_thread_id
     ORDER BY c.created_at LIMIT 1;
    IF v_id IS NOT NULL THEN
        UPDATE public.inlet_private_claims c
           SET researched_on = CURRENT_DATE,
               volatility = coalesce(p_volatility, c.volatility),
               revalidate_days = coalesce(p_revalidate_days, c.revalidate_days),
               status = CASE WHEN c.status = 'retracted' THEN c.status ELSE 'active' END,
               updated_at = now()
         WHERE c.id = v_id;
        was_duplicate := TRUE;
    ELSE
        v_id := gen_random_uuid();
        INSERT INTO public.inlet_private_claims (id, text, thread_id, synthesis_id, epistemic_tag, status, confidence, contradicted,
                                                 volatility, revalidate_days, researched_on, content_hash, embedding, metadata,
                                                 created_at, updated_at, inlet_owner_sub, inlet_batch)
        VALUES (v_id, btrim(p_text), p_thread_id, NULL, v_tag, 'active', 0, FALSE, p_volatility, p_revalidate_days, CURRENT_DATE,
                v_hash, p_embedding, coalesce(p_metadata, '{}'::jsonb), now(), now(), v_owner, public.private_report_claims_filed_batch());
        was_duplicate := FALSE;
    END IF;
    INSERT INTO public.research_private_report_claims (report_id, claim_id)
    SELECT p.id, v_id FROM public.research_private_reports p WHERE p.research_key = p_research_key AND p.job_id = p_job_id
    ON CONFLICT DO NOTHING;
    id := v_id;
    RETURN NEXT;
END;
$$;

-- The curator's grounding edge of a private claim onto a source: kept in the owner's edge store, idempotent on
-- (claim, source, type) as link_claim_to_source is. Only a claim a private report links, only onto an existing source.
CREATE OR REPLACE FUNCTION public.private_report_claim_edge(p_claim_id UUID, p_source_id UUID, p_edge_type TEXT, p_weight REAL DEFAULT 1.0)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner TEXT;
    v_ref   TEXT;
BEGIN
    IF NOT public.private_report_claims_caller_ok() THEN
        RAISE EXCEPTION 'private report claims: not for this caller' USING ERRCODE = '42501';
    END IF;
    IF p_edge_type NOT IN ('states', 'inferred_from', 'corroborates', 'contradicts') THEN
        RAISE EXCEPTION 'private report claims: edge type % refused', p_edge_type USING ERRCODE = '23514';
    END IF;
    IF p_weight IS NULL OR NOT (p_weight = 0 OR (p_weight >= 1e-9 AND p_weight <= 1)) THEN
        RAISE EXCEPTION 'private report claims: edge weight is not 0 or in [1e-9, 1]' USING ERRCODE = '23514';
    END IF;
    SELECT c.inlet_owner_sub INTO v_owner FROM public.inlet_private_claims c
     WHERE c.id = p_claim_id AND EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'private report claims: no private report claim %', p_claim_id USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id = p_source_id) THEN
        RAISE EXCEPTION 'private report claims: no source %', p_source_id USING ERRCODE = '23503';
    END IF;
    v_ref := md5(p_claim_id::text || '|' || p_source_id::text || '|' || p_edge_type);
    INSERT INTO public.inlet_private_claim_sources (claim_id, edge_ref, owner_sub, batch, source_id, parent_claim_id, row_data)
    VALUES (p_claim_id, v_ref, v_owner, public.private_report_claims_filed_batch(), p_source_id, NULL,
            jsonb_build_object('claim_id', p_claim_id, 'source_id', p_source_id, 'parent_claim_id', NULL,
                               'edge_type', p_edge_type, 'weight', p_weight, 'created_at', now()))
    ON CONFLICT (claim_id, edge_ref, batch) DO UPDATE SET row_data = EXCLUDED.row_data;
END;
$$;

-- The owner's read of the claims drawn from their idea's private reports (the workbench's idea dossier): a row only when
-- the subject owns both the report and the claim; nothing for a blank, service, system or anonymous subject.
CREATE OR REPLACE FUNCTION public.private_report_claims_of_idea(p_idea_id UUID, p_sub TEXT)
RETURNS TABLE (id UUID, text TEXT, confidence REAL)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
    IF NOT public.private_report_claims_reader_ok() THEN
        RAISE EXCEPTION 'private report claims: not for this caller' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT DISTINCT c.id, c.text, c.confidence
      FROM public.inlet_private_claims c
      JOIN public.research_private_report_claims pc ON pc.claim_id = c.id
      JOIN public.research_private_reports p ON p.id = pc.report_id
     WHERE public.private_report_claim_subject_ok(p_sub)
       AND p.idea_id = p_idea_id AND p.owner_sub = p_sub AND c.inlet_owner_sub = p_sub;
END;
$$;

-- EXECUTE (round 2, tester F2): service_role, which the services' login role ob_app_memory inherits - so the grant reaches
-- it however late the role is created - and ob_app_memory itself where it exists; ob_workbench (slot 480's workbench
-- role) for the read where it exists. Each function refuses every caller but the services' login and a superuser
-- session outside a PostgREST request (private_report_claims_caller_ok): service_role is PostgREST's anon role, and an
-- rpc call is refused 42501. Never PUBLIC, never authenticated.
REVOKE ALL ON FUNCTION public.private_report_claim_file(TEXT, UUID, TEXT, UUID, TEXT, TEXT, INT, VECTOR, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.private_report_claim_edge(UUID, UUID, TEXT, REAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) FROM PUBLIC;
DO $$
DECLARE f TEXT; r RECORD;
BEGIN
    -- take back anything the default privileges handed out
    FOREACH f IN ARRAY ARRAY['public.private_report_claim_file(text,uuid,text,uuid,text,text,integer,vector,jsonb)',
                             'public.private_report_claim_edge(uuid,uuid,text,real)', 'public.private_report_claims_of_idea(uuid,text)',
                             'public.private_report_claims_page_shows(text,text)', 'public.private_report_claim_subject_ok(text)',
                             'public.private_report_claims_filed_batch()', 'public.private_report_claim_norm(text)',
                             'public.private_report_claims_job_private(uuid)', 'public.private_report_claims_neutral_line(uuid,uuid,text)',
                             'public.private_report_claims_caller_ok()', 'public.private_report_claims_reader_ok()', 'public.private_report_claims_private_owner(uuid)',
                             'public.private_report_claims_tree_owner(uuid)', 'public.trg_private_report_claims_gap_guard()',
                             'public.trg_private_report_claims_derived_guard()'] LOOP
        FOR r IN SELECT DISTINCT ro.rolname AS grantee
                   FROM pg_proc p, aclexplode(p.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
                  WHERE p.oid = f::regprocedure AND NOT ro.rolsuper AND ro.oid <> p.proowner LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f::regprocedure, r.grantee);
        END LOOP;
    END LOOP;
    GRANT EXECUTE ON FUNCTION public.private_report_claim_file(TEXT, UUID, TEXT, UUID, TEXT, TEXT, INT, VECTOR, JSONB) TO service_role;
    GRANT EXECUTE ON FUNCTION public.private_report_claim_edge(UUID, UUID, TEXT, REAL) TO service_role;
    GRANT EXECUTE ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) TO service_role;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
        GRANT EXECUTE ON FUNCTION public.private_report_claim_file(TEXT, UUID, TEXT, UUID, TEXT, TEXT, INT, VECTOR, JSONB) TO ob_app_memory;
        GRANT EXECUTE ON FUNCTION public.private_report_claim_edge(UUID, UUID, TEXT, REAL) TO ob_app_memory;
        GRANT EXECUTE ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) TO ob_app_memory;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_workbench') THEN
        GRANT EXECUTE ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) TO ob_workbench;
    END IF;
END $$;
COMMENT ON FUNCTION public.private_report_claim_file(TEXT, UUID, TEXT, UUID, TEXT, TEXT, INT, VECTOR, JSONB) IS
  'rw-private-report-claims (slot 570): the research curator files one claim of a private report into the report owner''s store (inlet_private_claims) and links it. Granted to service_role; callable by the ob_app_memory login or a superuser session only, never through PostgREST.';
COMMENT ON FUNCTION public.private_report_claims_of_idea(UUID, TEXT) IS
  'rw-private-report-claims (slot 570): the subject''s claims drawn from their idea''s private reports; nothing for any other subject. Granted to service_role; callable by the ob_app_memory login or a superuser session only, never through PostgREST.';

NOTIFY pgrst, 'reload schema';
COMMIT;
