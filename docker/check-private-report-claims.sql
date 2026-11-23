-- check-private-report-claims.sql - rw-private-report-claims (slot 570): is any private-report claim still on a
-- shared surface? Read-only on the data (it creates two pg_temp helpers, gone with the session); prints counts and
-- names only, never a claim's text or id.
--   psql -X -A -t -q -f check-private-report-claims.sql
-- Lines: "check: <what>=<count>" for each surface, then "check: OK" or "check: FAIL". A FAIL names the surface.
-- Round 2 (tester F4/F2): it judges every claim a private report links WHEREVER it is (the owner's store after 570, the
-- shared table before it or after a revert), so it is not blind before 570; the page match uses 570's normalisation
-- (citation markers, emphasis, whitespace, case); it reports the gap work of shared trees; and it reports a MISSING
-- grant (the services' role ob_app_memory cannot execute the slot's functions), not only a stray one.
-- Surfaces: a claim a private report links that is in the SHARED table with no shared synthesis (the move's target set);
-- a shared edge of or onto such a claim; a private-report claim that is NOT in its report owner's store (or in someone
-- else's); a research job result naming one on a job its owner does not own; a wiki page carrying one's text; a gap
-- branch / steer / gap event / tree report of a shared tree carrying one's text; a private run's corroboration line in
-- the clear; the guards and the dropped foreign key; who may execute the slot's functions.
-- Fix item rw-private-report-claims-fix (2026-11-22): a claim a shared synthesis also filed ("mixed") is judged like
-- every other (it moves too); the gap work counted is MACHINE rows only (a human steer, its branch and event are never
-- rewritten, F2); P2 - a SHARED synthesis or a SHARED job report carrying a private-report claim's sentence is a surface;
-- the derived-question guard sits on research_handbacks (A1).
CREATE OR REPLACE FUNCTION pg_temp.prc_norm(p_text TEXT) RETURNS TEXT
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
-- the texts slot 570 withheld (no single owner): in its archive only, which may not exist yet
CREATE OR REPLACE FUNCTION pg_temp.prc_withheld() RETURNS TABLE (text TEXT)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL THEN RETURN; END IF;
    RETURN QUERY EXECUTE $q$SELECT a.row_data ->> 'text' FROM public.private_report_claims_archive a
                             WHERE a.action = 'x' AND a.restored_at IS NULL$q$;
END;
$$;
WITH
slot AS (SELECT to_regclass('public.private_report_claims_archive') IS NOT NULL AS applied),
-- every claim a private report links, with its single report owner (NULL: none, or several)
linked AS (
    SELECT pc.claim_id AS id, CASE WHEN count(DISTINCT p.owner_sub) = 1 THEN min(p.owner_sub) END AS owner
      FROM public.research_private_report_claims pc JOIN public.research_private_reports p ON p.id = pc.report_id
     GROUP BY pc.claim_id),
priv AS (
    SELECT c.id, c.inlet_owner_sub AS owner, c.text FROM public.inlet_private_claims c
     WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)),
shared_linked AS (
    SELECT c.id, l.owner, c.text FROM public.claims c JOIN linked l ON l.id = c.id),
-- a private-report claim wherever it is (the store after 570, the shared table before it)
all_priv AS (SELECT id, owner, text FROM priv UNION ALL SELECT id, owner, text FROM shared_linked),
texts AS (
    SELECT a.id, a.owner, a.text, pg_temp.prc_norm(a.text) AS n,
           substr(to_jsonb(a.text)::text, 2, length(to_jsonb(a.text)::text) - 2) AS jtext
      FROM all_priv a WHERE length(pg_temp.prc_norm(a.text)) >= 24),
wrong_owner AS (
    SELECT p.id FROM priv p
     WHERE NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc JOIN public.research_private_reports r ON r.id = pc.report_id
                        WHERE pc.claim_id = p.id AND r.owner_sub = p.owner)),
edges AS (
    SELECT cs.id FROM public.claim_sources cs
     WHERE cs.claim_id IN (SELECT id FROM all_priv) OR cs.parent_claim_id IN (SELECT id FROM all_priv)),
jobs AS (
    SELECT DISTINCT j.id FROM public.research_jobs j
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'claims') = 'array' THEN j.result -> 'claims' ELSE '[]'::jsonb END
                                              || CASE WHEN jsonb_typeof(j.result -> 'reuse_claims') = 'array' THEN j.result -> 'reuse_claims' ELSE '[]'::jsonb END) e
      JOIN all_priv p ON p.id::text = e ->> 'id'
     WHERE jsonb_typeof(j.result) = 'object'
       AND (p.owner IS NULL OR (SELECT o.owner_sub FROM public.research_job_report_owner(j.id) o LIMIT 1) IS DISTINCT FROM p.owner)),
page_texts AS (SELECT n FROM texts UNION SELECT pg_temp.prc_norm(w.text) FROM pg_temp.prc_withheld() w WHERE length(pg_temp.prc_norm(w.text)) >= 24),
pages AS (
    SELECT DISTINCT w.slug FROM public.wiki_pages w, page_texts t
     WHERE w.page_class IS DISTINCT FROM 'note'   -- A1: a person's note is judged by its author only (the guard)
       AND position(t.n IN pg_temp.prc_norm(coalesce(w.slug, '') || ' ' || coalesce(w.title, '') || ' ' || coalesce(w.body, ''))) > 0),
-- the gap work of a tree that is not the claim owner's: a branch's question, a gap / inter-hub steer, a gap / inter-hub
-- / branch / topic event, the root's tree report
gap_rows AS (
    SELECT 'job:' || j.id::text AS k FROM public.research_jobs j JOIN texts t
        ON (j.branch_kind IN ('gap', 'interhub') AND position(t.text IN coalesce(j.query, '')) > 0)
        OR (j.branch_kind IN ('root', 'idea') AND position(t.jtext IN coalesce(j.tree_report::text, '')) > 0)
     WHERE t.owner IS NULL OR (SELECT o.owner_sub FROM public.research_job_report_owner(coalesce(j.root_job_id, j.id)) o LIMIT 1) IS DISTINCT FROM t.owner
    UNION
    SELECT 'steer:' || s.id::text FROM public.research_steers s JOIN texts t
        ON position(t.text IN s.text) > 0 OR position(t.jtext IN coalesce(s.gap::text, '')) > 0
     WHERE s.steer_kind IN ('gap', 'interhub')
       AND (t.owner IS NULL OR (SELECT o.owner_sub FROM public.research_job_report_owner(s.root_job_id) o LIMIT 1) IS DISTINCT FROM t.owner)
    UNION
    SELECT 'event:' || e.id::text FROM public.research_job_events e JOIN texts t ON position(t.jtext IN e.payload::text) > 0
     WHERE (e.type IN ('gap', 'interhub_gap', 'topic')
            OR (e.type = 'branch_open' AND coalesce(e.payload ->> 'steer_kind', '') IN ('gap', 'interhub')))
       AND (t.owner IS NULL OR (SELECT o.owner_sub FROM public.research_job_report_owner(e.root_job_id) o LIMIT 1) IS DISTINCT FROM t.owner)),
-- P2: a SHARED synthesis, or a SHARED job report (no private report owns the job's tree), carrying one's sentence
p2_texts AS (SELECT n FROM page_texts),
p2_syn AS (
    SELECT DISTINCT s.id FROM public.sources s, p2_texts t
     WHERE s.content_type = 'research_synthesis'
       AND position(t.n IN pg_temp.prc_norm(coalesce(s.title, '') || ' ' || coalesce(s.content, ''))) > 0),
p2_jobs AS (
    SELECT DISTINCT j.id FROM public.research_jobs j, p2_texts t
     WHERE jsonb_typeof(j.result) = 'object'
       AND NOT EXISTS (SELECT 1 FROM public.research_job_report_owner(j.id))
       AND position(t.n IN pg_temp.prc_norm((SELECT string_agg(v #>> '{}', ' ') FROM jsonb_path_query(j.result - 'reuse_claims' - 'claims', 'strict $.**') v
                                              WHERE jsonb_typeof(v) = 'string'))) > 0),
-- fix item round 2 (tester attempt 1): a THREAD whose name / description carries one's sentence (the curator mints and
-- refreshes descriptions from reports; threads are shared), and a SHARED claim that is not a private report's own but
-- carries one's sentence (a synthesis filed it into another thread)
p2_threads AS (
    SELECT DISTINCT th.id FROM public.threads th, p2_texts t
     WHERE position(t.n IN pg_temp.prc_norm(coalesce(th.name, '') || ' ' || coalesce(th.description, '') || ' ' || coalesce(th.slug, ''))) > 0),
-- round 3: a shared source's notebook label (a thread's name; the notebook backfill mints threads from labels), and the
-- thread names a curator answer keeps in a job's result
p2_notebooks AS (
    SELECT DISTINCT s.id FROM public.sources s, p2_texts t
     WHERE coalesce(s.notebook, '') <> '' AND position(t.n IN pg_temp.prc_norm(s.notebook)) > 0),
p2_curator AS (
    SELECT DISTINCT j.id FROM public.research_jobs j, p2_texts t
     WHERE jsonb_typeof(j.result -> 'curator') = 'object'
       AND position(t.n IN pg_temp.prc_norm(coalesce(j.result -> 'curator' ->> 'thread_name', '') || ' ' || coalesce((
               SELECT string_agg(x ->> 'name', ' ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'curator' -> 'shortlist') = 'array'
                                                                                  THEN j.result -> 'curator' -> 'shortlist' ELSE '[]'::jsonb END) x), ''))) > 0),
p2_claims AS (
    SELECT DISTINCT c.id FROM public.claims c, p2_texts t
     WHERE c.id NOT IN (SELECT id FROM linked) AND position(t.n IN pg_temp.prc_norm(c.text)) > 0),
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
     WHERE tgname IN ('trg_private_report_claims_wiki_guard', 'trg_private_report_claims_link_guard', 'trg_private_report_claims_corroboration_guard',
                      'trg_private_report_claims_gap_guard', 'trg_private_report_claims_derived_guard')
       AND NOT tgisinternal AND tgenabled <> 'D'),
-- the guards a full apply installs: 6, and the derived-question guard where research_handbacks (slot 420) exists
want_guards AS (SELECT 6 + CASE WHEN to_regclass('public.research_handbacks') IS NOT NULL THEN 1 ELSE 0 END AS n),
fns AS (
    SELECT p.oid, p.proname, p.proacl, p.proowner, p.prosrc FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('private_report_claim_file', 'private_report_claim_edge', 'private_report_claims_of_idea')),
-- the services' role must reach all three (a MISSING grant is a FAIL: the dossier and the curator would be refused)
app AS (
    SELECT (SELECT count(*) FROM pg_roles r WHERE r.rolname = 'ob_app_memory') AS role_n,
           (SELECT count(*) FROM fns f, pg_roles r WHERE r.rolname = 'ob_app_memory' AND has_function_privilege(r.oid, f.oid, 'EXECUTE')) AS exec_n),
gated AS (SELECT count(*) AS n FROM fns f WHERE f.prosrc LIKE '%private_report_claims_caller_ok()%' OR f.prosrc LIKE '%private_report_claims_reader_ok()%'),
-- a direct grant to anyone but service_role (the in-function gate keeps PostgREST out), ob_app_memory and ob_workbench
grants AS (
    SELECT f.proname || '(' || ro.rolname || ')' AS g
      FROM fns f, aclexplode(f.proacl) a JOIN pg_roles ro ON ro.oid = a.grantee
     WHERE NOT ro.rolsuper AND ro.oid <> f.proowner
       AND ro.rolname NOT IN ('service_role', 'ob_app_memory')
       AND NOT (ro.rolname = 'ob_workbench' AND f.proname = 'private_report_claims_of_idea')
    UNION ALL
    SELECT f.proname || '(PUBLIC)' FROM fns f, aclexplode(f.proacl) a WHERE a.grantee = 0),
counts AS (
    SELECT (SELECT count(*) FROM shared_linked) AS shared_linked,
           (SELECT count(*) FROM edges) AS shared_edges,
           (SELECT count(*) FROM wrong_owner) AS wrong_owner,
           (SELECT count(*) FROM jobs) AS job_results,
           (SELECT count(*) FROM pages) AS wiki_pages,
           (SELECT count(*) FROM gap_rows) AS gap_rows,
           (SELECT count(*) FROM corr) AS corr_lines,
           (SELECT count(*) FROM p2_syn) AS p2_syn,
           (SELECT count(*) FROM p2_jobs) AS p2_jobs,
           (SELECT count(*) FROM p2_threads) AS p2_threads,
           (SELECT count(*) FROM p2_claims) AS p2_claims,
           (SELECT count(*) FROM p2_notebooks) AS p2_notebooks,
           (SELECT count(*) FROM p2_curator) AS p2_curator,
           (SELECT n FROM want_guards) AS want_guards,
           (SELECT n FROM fk) AS link_fk,
           (SELECT n FROM guards) AS guards,
           (SELECT exec_n FROM app) AS app_exec,
           (SELECT role_n FROM app) AS app_role,
           (SELECT n FROM gated) AS gated,
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
    UNION ALL SELECT 7, 'check: gap-work rows of a shared tree carrying one''s text=' || gap_rows FROM counts
    UNION ALL SELECT 7, 'check: corroboration lines of a private report''s run in the clear=' || corr_lines FROM counts
    UNION ALL SELECT 7, 'check: shared syntheses carrying one''s text=' || p2_syn FROM counts
    UNION ALL SELECT 7, 'check: shared job reports carrying one''s text=' || p2_jobs FROM counts
    UNION ALL SELECT 7, 'check: threads whose name, description or slug carries one''s text=' || p2_threads FROM counts
    UNION ALL SELECT 7, 'check: other shared claims carrying one''s text=' || p2_claims FROM counts
    UNION ALL SELECT 7, 'check: shared sources whose notebook label carries one''s text=' || p2_notebooks FROM counts
    UNION ALL SELECT 7, 'check: job curator answers naming a thread by one''s text=' || p2_curator FROM counts
    UNION ALL SELECT 8, 'check: the link''s foreign key onto claims=' || link_fk || ' (0 once applied)' FROM counts
    UNION ALL SELECT 9, 'check: guards on=' || guards || ' (' || want_guards || ' once applied)' FROM counts
    UNION ALL SELECT 10, 'check: ob_app_memory may execute the slot''s functions=' || app_exec || ' of 3 (role present=' || (app_role > 0) || ')' FROM counts
    UNION ALL SELECT 10, 'check: functions with the caller gate=' || gated || ' of 3' FROM counts
    UNION ALL SELECT 10, 'check: stray EXECUTE grants=' || stray_grants FROM counts
    UNION ALL SELECT 11, 'check: stray grant ' || g FROM grants
    UNION ALL SELECT 12, CASE WHEN shared_linked = 0 AND shared_edges = 0 AND wrong_owner = 0 AND job_results = 0 AND wiki_pages = 0 AND gap_rows = 0
                               AND corr_lines = 0 AND p2_syn = 0 AND p2_jobs = 0 AND p2_threads = 0 AND p2_claims = 0 AND p2_notebooks = 0 AND p2_curator = 0
                               AND link_fk = 0 AND guards = want_guards AND app_exec = 3 AND gated = 3 AND stray_grants = 0
                               AND (SELECT applied FROM slot)
                              THEN 'check: OK' ELSE 'check: FAIL' END FROM counts
) x ORDER BY o;
