-- count-private-report-claim-reuse.sql - rw-private-report-claims round 2, the OPERATOR DECISION P2 (tester F6).
-- READ-ONLY (it creates three pg_temp helpers, gone with the session). Counts only: never a claim's text, id or title.
--   psql -X -A -t -q -f count-private-report-claim-reuse.sql
-- Works before slot 570 (the claims are still in public.claims) and after it (in the owner's store).
-- The question: how many SHARED outputs carry the text of a claim drawn from a PRIVATE report (a "generated series" in
-- the operator's words)? Operator decision P2 (2026-11-22, fix item rw-private-report-claims-fix): slot 570 moves every
-- one of these private to the claim's owner, or withholds it when it restated claims of several owners (or of nobody),
-- so after 570 lines 2-5 read 0 (run it BEFORE 570 for the live figures - the deploy window's first step):
--   mixed claims        - a private-report claim a shared synthesis ALSO filed (claims.synthesis_id set; 570 moves it
--                         like every other private-report claim);
--   shared syntheses    - a shared research_synthesis source whose content carries a private-report claim's sentence
--                         (the claim was recalled and restated, or the same sentence came out of a shared run);
--   shared job reports  - a shared research job (no private report owns its tree) whose result synthesis / prose / the
--                         line credibility carries one (the job reused it);
--   gap-branch reports  - of those, the ones that are a gap branch asking to verify such a claim (its own research
--                         about the private sentence);
--   threads             - (round 2) a thread whose name or description carries one (minted / refreshed from a report);
--   other shared claims - (round 2) a shared claim, not a private report's own, carrying one (a synthesis filed it).
--   notebook-tree pages - (slot 575, review r-rprc R1) a wiki page of class 'note' that is not a person's note (its slug
--                         is not under notes/: a notebook hub, the notebooks index, an AI note) carrying one; 570 left
--                         them out, 575 withholds them;
--   fragment claims     - (slot 575, R2) a shared claim a synthesis 570 moved had filed, holding a fragment of a claim that
--                         synthesis restated, and a shared claim carrying such a fragment's sentence; 575 moves them.
-- A sentence counts after 570's normalisation (case, whitespace, citation markers, emphasis); sentences under 24
-- characters are not matched.
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
-- slot 575 (R2): the FRAGMENT rule, as init-private-report-claims-scope.sql moves them - a SHARED claim a synthesis slot
-- 570 moved had filed (570's archive: the synthesis's 's' row, the claim's 'd' row for the synthesis_id it set NULL), not
-- a private report's own, whose skeleton (24+ letters) is inside the skeleton of a private-report claim that synthesis
-- restated (its text carried it, or it filed it: 570's k / x row); and a shared claim carrying such a fragment's
-- sentence. Nothing before 570 (no archive). The same text in check-private-report-claims.sql,
-- count-private-report-claim-reuse.sql and check-private-report-claims-scope.sql.
CREATE OR REPLACE FUNCTION pg_temp.prc_frag() RETURNS TABLE (id UUID)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    q TEXT := $q$
    WITH p AS (
        SELECT x.id, x.n FROM (
            SELECT c.id, pg_temp.prc_norm(c.text) AS n FROM public.inlet_private_claims c
             WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
            UNION ALL
            SELECT c.id, pg_temp.prc_norm(c.text) FROM public.claims c
             WHERE EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
            UNION ALL
            SELECT a.ref::uuid, pg_temp.prc_norm(a.row_data ->> 'text') FROM public.private_report_claims_archive a
             WHERE a.action = 'x' AND a.restored_at IS NULL) x
         WHERE length(x.n) >= 24),
    s AS (
        SELECT DISTINCT ON (a.ref) a.ref AS sid,
               pg_temp.prc_norm(coalesce(a.row_data ->> 'title', '') || ' ' || coalesce(a.row_data ->> 'content', '')) AS n
          FROM public.private_report_claims_archive a
         WHERE a.action = 's' AND a.tbl = 'public.sources' AND a.restored_at IS NULL
         ORDER BY a.ref, a.id DESC),
    sp AS (
        SELECT s.sid, p.n FROM s JOIN p ON position(p.n IN s.n) > 0
        UNION
        SELECT a.row_data ->> 'synthesis_id', p.n FROM public.private_report_claims_archive a JOIN p ON p.id::text = a.ref
         WHERE a.action IN ('k', 'x') AND a.restored_at IS NULL AND a.row_data ->> 'synthesis_id' IN (SELECT sid FROM s)),
    f AS (
        SELECT DISTINCT cn.id, cn.n FROM (
            SELECT c.id, a.ref AS sid, pg_temp.prc_norm(c.text) AS n
              FROM public.private_report_claims_archive a JOIN public.claims c ON c.id::text = a.row_data ->> 'id'
             WHERE a.action = 'd' AND a.tbl IN ('public.claims', 'claims') AND a.row_data ->> '_col' = 'synthesis_id' AND a.restored_at IS NULL
               AND a.ref IN (SELECT sid FROM s)
               AND NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)) cn
          JOIN sp ON sp.sid = cn.sid
         WHERE length(cn.n) >= 24 AND position(cn.n IN sp.n) > 0)
    $q$;
BEGIN
    IF to_regclass('public.private_report_claims_archive') IS NULL THEN RETURN; END IF;
    RETURN QUERY EXECUTE q || ' SELECT f.id FROM f';
    IF NOT FOUND THEN RETURN; END IF;
    -- a shared claim carrying a fragment's sentence (only when there is a fragment: this reads every shared claim)
    RETURN QUERY EXECUTE q || $d$
    SELECT c.id FROM public.claims c
     WHERE c.id NOT IN (SELECT f.id FROM f)
       AND NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)
       AND EXISTS (SELECT 1 FROM f WHERE position(f.n IN pg_temp.prc_norm(c.text)) > 0)$d$;
END;
$$;
WITH
linked AS (SELECT DISTINCT pc.claim_id AS id FROM public.research_private_report_claims pc),
mixed AS (SELECT c.id FROM public.claims c JOIN linked l ON l.id = c.id WHERE c.synthesis_id IS NOT NULL),
texts AS (
    SELECT DISTINCT pg_temp.prc_norm(x.text) AS n FROM (
        SELECT c.text FROM public.claims c JOIN linked l ON l.id = c.id
        UNION ALL
        SELECT c.text FROM public.inlet_private_claims c JOIN linked l ON l.id = c.id) x
     WHERE length(pg_temp.prc_norm(x.text)) >= 24),
syn AS (
    SELECT DISTINCT s.id FROM public.sources s, texts t
     WHERE s.content_type = 'research_synthesis'
       AND position(t.n IN pg_temp.prc_norm(coalesce(s.title, '') || ' ' || coalesce(s.content, ''))) > 0),
shared_jobs AS (
    SELECT j.id, j.gap_ref,
           pg_temp.prc_norm(coalesce(j.result ->> 'synthesis', '') || ' ' || coalesce(j.result ->> 'prose', '') || ' '
                            || coalesce(j.result -> 'line_credibility', '[]'::jsonb)::text) AS body
      FROM public.research_jobs j
     WHERE jsonb_typeof(j.result) = 'object'
       AND NOT EXISTS (SELECT 1 FROM public.research_job_report_owner(coalesce(j.root_job_id, j.id)))),
jobs AS (SELECT DISTINCT j.id, j.gap_ref FROM shared_jobs j, texts t WHERE position(t.n IN j.body) > 0),
-- fix item round 2: threads whose name / description carries one, and other shared claims (not a private report's
-- own) carrying one (a synthesis filed its sentence into another thread)
threads AS (
    SELECT DISTINCT th.id FROM public.threads th, texts t
     WHERE position(t.n IN pg_temp.prc_norm(coalesce(th.name, '') || ' ' || coalesce(th.description, '') || ' ' || coalesce(th.slug, ''))) > 0),
-- round 3: notebook labels (a thread's name on each filed source) and the thread names in job curator answers
notebooks AS (
    SELECT DISTINCT s.id FROM public.sources s, texts t
     WHERE coalesce(s.notebook, '') <> '' AND position(t.n IN pg_temp.prc_norm(s.notebook)) > 0),
curator AS (
    SELECT DISTINCT j.id FROM public.research_jobs j, texts t
     WHERE jsonb_typeof(j.result -> 'curator') = 'object'
       AND position(t.n IN pg_temp.prc_norm(coalesce(j.result -> 'curator' ->> 'thread_name', '') || ' ' || coalesce((
               SELECT string_agg(x ->> 'name', ' ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result -> 'curator' -> 'shortlist') = 'array'
                                                                                  THEN j.result -> 'curator' -> 'shortlist' ELSE '[]'::jsonb END) x), ''))) > 0),
dup_claims AS (
    SELECT DISTINCT c.id FROM public.claims c, texts t
     WHERE c.id NOT IN (SELECT id FROM linked) AND position(t.n IN pg_temp.prc_norm(c.text)) > 0),
-- slot 575 (R1): the class-'note' pages that are not a person's note, against every private-report claim and every
-- withheld one (570's page predicate)
note_pages AS (
    SELECT DISTINCT w.slug FROM public.wiki_pages w,
           (SELECT n FROM texts UNION SELECT pg_temp.prc_norm(x.text) FROM pg_temp.prc_withheld() x WHERE length(pg_temp.prc_norm(x.text)) >= 24) t
     WHERE coalesce(w.page_class, '') = 'note' AND left(coalesce(w.slug, ''), 6) <> 'notes/'
       AND position(t.n IN pg_temp.prc_norm(coalesce(w.slug, '') || ' ' || coalesce(w.title, '') || ' ' || coalesce(w.body, ''))) > 0),
frag AS (SELECT DISTINCT f.id FROM pg_temp.prc_frag() f),
claims_reused AS (
    SELECT DISTINCT t.n FROM texts t
     WHERE EXISTS (SELECT 1 FROM syn s JOIN public.sources x ON x.id = s.id WHERE position(t.n IN pg_temp.prc_norm(coalesce(x.title, '') || ' ' || coalesce(x.content, ''))) > 0)
        OR EXISTS (SELECT 1 FROM jobs j JOIN shared_jobs b ON b.id = j.id WHERE position(t.n IN b.body) > 0))
SELECT line FROM (
    SELECT 1 AS o, 'reuse: private-report claims (any store)=' || (SELECT count(*) FROM linked) AS line
    UNION ALL SELECT 2, 'reuse: mixed claims (a shared synthesis also filed them, still in the shared table)=' || (SELECT count(*) FROM mixed)
    UNION ALL SELECT 3, 'reuse: shared syntheses carrying a private-report claim''s sentence=' || (SELECT count(*) FROM syn)
    UNION ALL SELECT 4, 'reuse: shared job reports carrying one=' || (SELECT count(*) FROM jobs)
    UNION ALL SELECT 5, 'reuse: of those, gap branches verifying a claim=' || (SELECT count(*) FROM jobs WHERE gap_ref LIKE 'claim:%')
    UNION ALL SELECT 6, 'reuse: distinct private-report sentences restated in a shared output=' || (SELECT count(*) FROM claims_reused)
    UNION ALL SELECT 7, 'reuse: threads whose name, description or slug carries one=' || (SELECT count(*) FROM threads)
    UNION ALL SELECT 8, 'reuse: other shared claims carrying one (another thread, or a superseded synthesis)=' || (SELECT count(*) FROM dup_claims)
    UNION ALL SELECT 9, 'reuse: shared sources whose notebook label carries one=' || (SELECT count(*) FROM notebooks)
    UNION ALL SELECT 10, 'reuse: job curator answers naming a thread by one=' || (SELECT count(*) FROM curator)
    UNION ALL SELECT 11, 'reuse: notebook hub / index / AI-note pages (class note, not under notes/) carrying one=' || (SELECT count(*) FROM note_pages)
    UNION ALL SELECT 12, 'reuse: shared claims holding a fragment of one (filed by a moved synthesis) or its sentence=' || (SELECT count(*) FROM frag)
) x ORDER BY o;
